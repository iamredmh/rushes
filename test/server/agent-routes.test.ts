import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpProject } from "../helpers/tmp.js";
import { sse } from "../helpers/sse.js";
import { createApp, type AppOptions } from "../../src/server/app.js";
import { startServer, type Running } from "../../src/server/start.js";
import { AgentRunner, type AgentStatus, type RunnerOptions } from "../../src/server/agent/runner.js";
import type { AgentInfo } from "../../src/server/agent/detect.js";
import type { AgentRules, AgentSettings } from "../../src/core/schema.js";
import { agentRulesFor } from "../../src/server/agent/rules.js";
import type { Store } from "../../src/core/store.js";

const FAKE = resolve(__dirname, "../helpers/fake-acp.mjs");

const runners: AgentRunner[] = [];
const servers: Running[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const r of runners.splice(0)) await r.close();
  vi.restoreAllMocks();
});

const claude = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  id: "claude", name: "Claude Code", installed: true, signedIn: true, path: "/usr/local/bin/claude", signIn: "claude auth login", ...over,
});
const codex = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  id: "codex", name: "Codex", installed: true, signedIn: true, path: "/usr/local/bin/codex", signIn: "codex login", ...over,
});

/** Runner options that start the fake agent with `scenarioPath`. */
function fakeAgent(store: Store, agents: () => AgentInfo[]): { opts: RunnerOptions; scenario: (s: object) => Promise<void>; log: () => any[] } {
  const scenarioPath = join(store.dir, "scenario.json");
  const logPath = join(store.dir, "fake-log.jsonl");
  return {
    opts: {
      detect: async () => agents(),
      spec: (_a, r) => ({ command: process.execPath, args: [FAKE], env: { FAKE_ACP_SCENARIO: scenarioPath, FAKE_ACP_LOG: logPath }, cwd: r }),
      mcp: (root) => ({ name: "rushes", command: process.execPath, args: ["-e", "", root], env: [] }),
    },
    scenario: (s) => writeFile(scenarioPath, JSON.stringify(s)),
    log: () => {
      let text = "";
      try { text = readFileSync(logPath, "utf8"); } catch { /* not written yet */ }
      return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}

async function waitFor<T>(what: string, check: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const v = await check();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function rig(o: { settings?: Partial<AgentSettings>; rules?: Partial<AgentRules>; agents?: AgentInfo[]; scenario?: object; runner?: Partial<RunnerOptions>; app?: Partial<AppOptions> } = {}) {
  const { root, store } = await tmpProject("lumen");
  let agents = o.agents ?? [claude(), codex()];
  const fake = fakeAgent(store, () => agents);
  await fake.scenario(o.scenario ?? { turns: [] });
  if (o.settings) await store.update("agent", (f) => void Object.assign(f, o.settings));
  if (o.rules) await agentRulesFor(store).update((f) => void Object.assign(f, o.rules));
  const runner = new AgentRunner(store, { ...fake.opts, ...o.runner });
  runners.push(runner);
  const wantOn = o.settings?.on ?? false;
  await waitFor("the runner to read agent.json", () => runner.status().on === wantOn);
  const opened: string[] = [];
  const app = createApp(store, { agent: runner, detect: async () => agents, terminal: async (command) => void opened.push(command), ...o.app });
  const call = async (method: string, path: string, json?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as any };
  };
  const note = async (text: string) => (await call("POST", "/api/notes", { stage: "picture", scope: "whole", text })).json.note.id as string;
  return { root, store, runner, call, note, opened, log: fake.log, setAgents: (next: AgentInfo[]) => { agents = next; } };
}

describe("Send hands the batch to the agent", () => {
  it("Send with Send to AI off files the batch and hands nothing over", async () => {
    const r = await rig();
    await r.note("Tighten the opening");
    const res = await r.call("POST", "/api/batches", {});
    expect(res.status).toBe(201);
    expect(res.json.batch.noteIds).toHaveLength(1);
    expect(res.json.agent).toEqual({ handedTo: null, why: "Send to AI is off" });
  });

  it("Send with Send to AI on hands the batch to the runner", async () => {
    const r = await rig({ settings: { on: true, agent: "claude" } });
    await r.note("Tighten the opening");
    const res = await r.call("POST", "/api/batches", {});
    expect(res.status).toBe(201);
    expect(res.json.agent).toEqual({ handedTo: "claude" });
    expect((await r.store.read("batches")).batches.map((b) => b.id)).toEqual([res.json.batch.id]);
    await waitFor("the run to finish", () => !r.runner.busy());
  });

  it("Send answers within its bound while the agent is still starting, and a later failure shows in the status", async () => {
    const r = await rig({ settings: { on: true, agent: "claude" }, scenario: { hangOnInitialize: true, turns: [] }, runner: { startMs: 1500 }, app: { sendWaitMs: 200 } });
    const id = await r.note("Tighten the opening");
    const t0 = Date.now();
    const res = await r.call("POST", "/api/batches", {});
    expect(Date.now() - t0).toBeLessThan(1200);
    expect(res.status).toBe(201);
    expect(res.json.agent).toEqual({ handedTo: "claude", starting: true });
    expect(res.json.batch.noteIds).toEqual([id]);
    await waitFor("the start to fail", () => r.runner.status().phase === "failed");
    expect(r.runner.status().error).toBe("Claude Code did not start within 1.5 seconds");
    await waitFor("the note to come back", async () => (await r.store.read("notes")).notes[0].batch === null);
  });

  it("Send passes a Stop's refusal on as it is, stopped flag included", async () => {
    const r = await rig();
    vi.spyOn(r.runner, "send").mockResolvedValue({ handedTo: null, why: "Stopped before the agent started", stopped: true });
    await r.note("Tighten the opening");
    const res = await r.call("POST", "/api/batches", {});
    expect(res.status).toBe(201);
    expect(res.json.agent).toEqual({ handedTo: null, why: "Stopped before the agent started", stopped: true });
  });

  it("Send still succeeds when the runner throws", async () => {
    const r = await rig();
    vi.spyOn(r.runner, "send").mockRejectedValue(new Error("The adapter fell over"));
    await r.note("Tighten the opening");
    const res = await r.call("POST", "/api/batches", {});
    expect(res.status).toBe(201);
    expect(res.json.agent).toEqual({ handedTo: null, why: "The adapter fell over" });
    expect(res.json.batch.noteIds).toHaveLength(1);
    expect((await r.store.read("notes")).notes[0].batch).toBe(res.json.batch.id);
  });

  it("two Sends at once reach the runner in the order they were filed", async () => {
    const r = await rig();
    const order: string[] = [];
    vi.spyOn(r.runner, "send").mockImplementation(async (b) => {
      order.push(b.id);
      return { handedTo: null, why: "Send to AI is off" };
    });
    await r.note("One");
    const a = r.call("POST", "/api/batches", {});
    await new Promise((ok) => setImmediate(ok));
    await r.note("Two");
    const b = r.call("POST", "/api/batches", {});
    const [ra, rb] = await Promise.all([a, b]);
    expect(order).toEqual([ra.json.batch.id, rb.json.batch.id]);
  });
});

describe("agent routes", () => {
  it("GET /api/agent gives the status and /api/agent/detect the agents found", async () => {
    const r = await rig({ agents: [claude(), codex({ installed: false, signedIn: false, path: null })] });
    const s = await r.call("GET", "/api/agent");
    expect(s.status).toBe(200);
    expect(s.json.status).toMatchObject({ on: false, agent: null, phase: "off", asks: [], session: null });
    const d = await r.call("GET", "/api/agent/detect");
    expect(d.json.agents.map((a: AgentInfo) => [a.id, a.signedIn])).toEqual([["claude", true], ["codex", false]]);
  });

  it("setup turns Send to AI on for a signed-in agent, with the permissions asked for", async () => {
    const r = await rig();
    const res = await r.call("POST", "/api/agent/setup", { on: true, agent: "claude", permissions: "ask-all" });
    expect(res.status).toBe(200);
    expect(res.json.status).toMatchObject({ on: true, agent: "claude", permissions: "ask-all" });
    expect(await r.store.read("agent")).toMatchObject({ on: true, agent: "claude" });
    // R10: permissions are kept in the user's rules file, never in the project.
    expect(await r.store.read("agent")).not.toHaveProperty("permissions");
    expect((await agentRulesFor(r.store).read()).permissions).toBe("ask-all");
  });

  it("setup refuses an agent that is not signed in with agent_not_signed_in, and one not installed with agent_not_installed", async () => {
    const r = await rig({ agents: [claude({ signedIn: false }), codex({ installed: false, signedIn: false, path: null })] });
    const res = await r.call("POST", "/api/agent/setup", { on: true, agent: "claude" });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: "agent_not_signed_in", message: "Claude Code is not signed in. Choose Sign in in Terminal, then try again." });
    const notInstalled = await r.call("POST", "/api/agent/setup", { on: true, agent: "codex" });
    expect(notInstalled.status).toBe(409);
    expect(notInstalled.json).toMatchObject({ error: "agent_not_installed", message: "Codex is not installed." });
    expect(await r.store.read("agent")).toMatchObject({ on: false, agent: null });
    // Turning off is always allowed.
    const off = await r.call("POST", "/api/agent/setup", { on: false, agent: "claude" });
    expect(off.status).toBe(200);
    expect(await r.store.read("agent")).toMatchObject({ on: false, agent: "claude" });
  });

  it("setup refuses a bad body and turning on with no agent chosen", async () => {
    const r = await rig();
    expect((await r.call("POST", "/api/agent/setup", { on: "yes" })).status).toBe(400);
    expect((await r.call("POST", "/api/agent/setup", { on: true, agent: "gemini" })).status).toBe(400);
    expect((await r.call("POST", "/api/agent/setup", { on: true, permissions: "anything" })).status).toBe(400);
    expect((await r.call("POST", "/api/agent/setup", { on: true })).status).toBe(400);
  });

  it("setup refuses to turn on when the agent changed while it was being checked", async () => {
    const r = await rig({ settings: { on: false, agent: "claude" } });
    const app = createApp(r.store, {
      agent: r.runner,
      detect: async () => {
        await r.store.update("agent", (f) => { f.agent = "codex"; });
        return [claude(), codex({ signedIn: false })];
      },
    });
    const res = await app.request("/api/agent/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: true }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "agent_changed", message: "The agent changed. Try again." });
    expect(await r.store.read("agent")).toMatchObject({ on: false, agent: "codex" });
  });

  it("setup with a new agent clears the kept session; the same agent keeps it", async () => {
    const session = { id: "fake-session-9", agent: "claude" as const, startedAt: "2026-11-17T09:00:00.000Z" };
    const r = await rig({ settings: { on: true, agent: "claude", session } });
    const same = await r.call("POST", "/api/agent/setup", { on: true, agent: "claude", permissions: "ask-all" });
    expect(same.json.status.session).toBe("fake-session-9");
    const other = await r.call("POST", "/api/agent/setup", { on: true, agent: "codex" });
    expect(other.json.status).toMatchObject({ on: true, agent: "codex", session: null });
    expect((await r.store.read("agent")).session).toBeNull();
  });

  it("fresh clears the kept session", async () => {
    const session = { id: "fake-session-9", agent: "claude" as const, startedAt: "2026-11-17T09:00:00.000Z" };
    const r = await rig({ settings: { on: true, agent: "claude", session } });
    const res = await r.call("POST", "/api/agent/fresh", {});
    expect(res.status).toBe(200);
    expect(res.json.status).toMatchObject({ on: true, agent: "claude", session: null });
    expect(await r.store.read("agent")).toMatchObject({ on: true, agent: "claude", session: null });
  });

  it("stop stops a run and gives the notes back", async () => {
    const r = await rig({ settings: { on: true, agent: "claude" }, scenario: { turns: [[{ sleep: 60000 }]] } });
    const id = await r.note("Tighten the opening");
    expect((await r.call("POST", "/api/batches", {})).json.agent).toEqual({ handedTo: "claude" });
    await waitFor("the turn to start", () => r.runner.status().phase === "working");
    const res = await r.call("POST", "/api/agent/stop", {});
    expect(res.status).toBe(200);
    expect(res.json.status.phase).toBe("idle");
    expect((await r.store.read("notes")).notes.find((n) => n.id === id)!.batch).toBeNull();
  });

  it("permission/:id answers an ask; an unknown id is 404", async () => {
    const exec = { permission: { toolCall: { toolCallId: "t1", title: "Run npm test", kind: "execute", rawInput: { command: "npm test" } } } };
    const r = await rig({ settings: { on: true, agent: "claude" }, scenario: { turns: [[exec]] } });
    await r.note("Tighten the opening");
    await r.call("POST", "/api/batches", {});
    const ask = await waitFor("an ask", () => r.runner.status().asks[0]);
    expect((await r.call("POST", "/api/agent/permission/nope", { choice: "once" })).status).toBe(404);
    expect((await r.call("POST", `/api/agent/permission/${ask.id}`, { choice: "maybe" })).status).toBe(400);
    const res = await r.call("POST", `/api/agent/permission/${ask.id}`, { choice: "once" });
    expect(res.status).toBe(200);
    expect(res.json.status.asks).toEqual([]);
  });

  it("permission/:id with always on an ask that offers no Always allows once and keeps no rule", async () => {
    const untyped = { permission: { toolCall: { toolCallId: "u1", title: "Do something" } }, record: "untyped" };
    const r = await rig({ settings: { on: true, agent: "claude" }, scenario: { turns: [[untyped]] } });
    await r.note("Tighten the opening");
    await r.call("POST", "/api/batches", {});
    const ask = await waitFor("an ask", () => r.runner.status().asks[0]);
    expect(ask.always).toBe("");
    const res = await r.call("POST", `/api/agent/permission/${ask.id}`, { choice: "always" });
    expect(res.status).toBe(200);
    await waitFor("the answer to reach the agent", () => r.log().find((m) => m.recorded === "untyped"));
    expect(r.log().find((m) => m.recorded === "untyped").outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect((await agentRulesFor(r.store).read()).always).toEqual([]);
  });

  it("DELETE always removes a kept rule by kind and command; an unknown one is 404 (T6)", async () => {
    const always = [{ kind: "execute", command: "git commit" }, { kind: "execute", command: "npx hyperframes" }, { kind: "fetch", command: null }];
    const r = await rig({ settings: { on: true, agent: "claude" }, rules: { always } });
    const res = await r.call("DELETE", "/api/agent/always", { kind: "execute", command: "git commit" });
    expect(res.status).toBe(200);
    expect(res.json.status.always).toEqual([always[1], always[2]]);
    expect((await agentRulesFor(r.store).read()).always).toEqual([always[1], always[2]]);
    expect((await r.call("DELETE", "/api/agent/always", { kind: "fetch", command: null })).status).toBe(200);
    expect((await agentRulesFor(r.store).read()).always).toEqual([always[1]]);
    expect((await r.call("DELETE", "/api/agent/always", { kind: "execute", command: "git commit" })).status).toBe(404);
    expect((await r.call("DELETE", "/api/agent/always", { kind: "execute" })).status).toBe(400);
    expect((await r.call("DELETE", "/api/agent/always", {})).status).toBe(400);
    // Rules are no longer addressed by index.
    const app = createApp(r.store, { agent: r.runner });
    expect((await app.request("/api/agent/always/0", { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    expect((await agentRulesFor(r.store).read()).always).toEqual([always[1]]);
  });

  it("working-on marks a sent note, is refused for a note that is not sent, and 404s an unknown one", async () => {
    const r = await rig();
    const sent = await r.note("Tighten the opening");
    await r.call("POST", "/api/batches", {});
    const todo = await r.note("Not sent yet");
    const refused = await r.call("POST", "/api/agent/working-on", { note: todo, doing: "Moving the title" });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe("note_not_sent");
    expect((await r.call("POST", "/api/agent/working-on", { note: "n_nope", doing: "Moving the title" })).status).toBe(404);
    expect((await r.call("POST", "/api/agent/working-on", { note: sent, doing: "" })).status).toBe(400);
    expect((await r.call("POST", "/api/agent/working-on", { note: sent, doing: "x".repeat(201) })).status).toBe(400);
    const ok = await r.call("POST", "/api/agent/working-on", { note: sent, doing: "Moving the title" });
    expect(ok.status).toBe(204);
    // M2: no turn is in flight (the batch was copied, not handed over), so nothing shows.
    expect(r.runner.status().current).toEqual({ note: null, doing: null });
    expect(r.runner.status().lines).toEqual([]);
  });

  it("sign-in opens Terminal with the agent's own login command and nothing else", async () => {
    const r = await rig({ agents: [claude({ signedIn: false }), codex({ signedIn: false })] });
    expect((await r.call("POST", "/api/agent/sign-in", { agent: "claude", command: "touch /tmp/owned" })).status).toBe(204);
    expect((await r.call("POST", "/api/agent/sign-in", { agent: "codex" })).status).toBe(204);
    expect(r.opened).toEqual(["claude auth login", "codex login"]);
    expect((await r.call("POST", "/api/agent/sign-in", { agent: "touch /tmp/owned" })).status).toBe(400);
    expect((await r.call("POST", "/api/agent/sign-in", {})).status).toBe(400);
    expect(r.opened).toEqual(["claude auth login", "codex login"]);
  });
});

describe("an app made without a runner", () => {
  it("subscribes nothing to the store, files Sends with Send to AI off, and has no agent to drive", async () => {
    const { store } = await tmpProject("lumen");
    const before = { change: store.listenerCount("change"), reply: store.listenerCount("user-reply") };
    const app = createApp(store);
    expect({ change: store.listenerCount("change"), reply: store.listenerCount("user-reply") }).toEqual(before);
    const call = async (method: string, path: string, json?: unknown) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });
      return { status: res.status, json: (await res.json()) as any };
    };
    await call("POST", "/api/notes", { stage: "picture", scope: "whole", text: "Tighten the opening" });
    expect((await call("POST", "/api/batches", {})).json.agent).toEqual({ handedTo: null, why: "Send to AI is off" });
    expect((await call("GET", "/api/agent")).json.status).toMatchObject({ on: false, phase: "off" });
    expect((await call("POST", "/api/agent/working-on", { note: "n_1", doing: "x" })).status).toBe(503);
  });
});

describe("live agent status", () => {
  it("the events stream carries agent status", async () => {
    const { root, store } = await tmpProject("lumen");
    const fake = fakeAgent(store, () => [claude(), codex()]);
    await fake.scenario({ turns: [] });
    const s = await startServer(root, { port: 0, agent: fake.opts });
    servers.push(s);
    const before = s.store.listenerCount("agent");
    const events = await sse(s.url);
    await events.until("event: hello");
    expect(s.store.listenerCount("agent")).toBe(before + 1);
    await fetch(`${s.url}/api/agent/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: true, agent: "claude" }) });
    const text = await events.until("event: agent");
    const line = text.split("\n").find((l, i, all) => all[i - 1] === "event: agent" && l.startsWith("data: "))!;
    const status = JSON.parse(line.slice("data: ".length)) as AgentStatus;
    expect(status).toMatchObject({ on: true, agent: "claude" });
    events.stop();
    // The stream's listener goes when it closes.
    await waitFor("the agent listener to go", () => s.store.listenerCount("agent") === before);
  });
});
