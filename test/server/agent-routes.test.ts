import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeModesEnv } from "../helpers/fakeModes.js";
import { tmpProject } from "../helpers/tmp.js";
import { sse } from "../helpers/sse.js";
import { createApp, type AppOptions } from "../../src/server/app.js";
import { startServer, type Running } from "../../src/server/start.js";
import { AgentRunner, type AgentStatus, type RunnerOptions } from "../../src/server/agent/runner.js";
import type { AgentInfo } from "../../src/server/agent/detect.js";
import type { AgentRules, AgentSettings } from "../../src/core/schema.js";
import { agentDefaultsFile, agentRulesFor, defaultsPath } from "../../src/server/agent/rules.js";
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
      spec: (a, r) => ({ command: process.execPath, args: [FAKE], env: { FAKE_ACP_SCENARIO: scenarioPath, FAKE_ACP_LOG: logPath, ...fakeModesEnv(a) }, cwd: r }),
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

async function rig(o: { settings?: Partial<AgentSettings>; rules?: Partial<AgentRules>; agents?: AgentInfo[]; scenario?: object; runner?: Partial<RunnerOptions>; app?: Partial<AppOptions>; consent?: boolean } = {}) {
  const { root, store } = await tmpProject("lumen");
  let agents = o.agents ?? [claude(), codex()];
  const fake = fakeAgent(store, () => agents);
  await fake.scenario(o.scenario ?? { turns: [] });
  if (o.settings) await store.update("agent", (f) => void Object.assign(f, o.settings));
  // I1: a project turned on was set up by the user for its agent (their own rules file says so), unless a test says otherwise.
  const consent = o.consent ?? o.settings?.on === true;
  if (o.rules || consent) await agentRulesFor(store).update((f) => void Object.assign(f, consent ? { setUp: true, agent: o.settings?.agent ?? null } : {}, o.rules));
  const runner = new AgentRunner(store, { ...fake.opts, ...o.runner });
  runners.push(runner);
  // The switch reads on only for the agent the user chose (consent fix).
  const wantOn = (o.settings?.on ?? false) && consent && !!o.settings?.agent;
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

describe("the user's consent lives in their own rules file, never in the project (I1)", () => {
  it("a project arriving with agent.json set up and on opens the sheet and hands nothing over; setup through the route does", async () => {
    const r = await rig({ settings: { on: true, agent: "claude" }, consent: false, scenario: { turns: [[{ stop: "end_turn" }]] } });
    // The project's switch is not the user's: it reads off on the desk.
    expect((await r.call("GET", "/api/agent")).json.status).toMatchObject({ on: false, agent: "claude", asked: false });
    await r.note("Tighten the opening");
    const res = await r.call("POST", "/api/batches", {});
    expect(res.status).toBe(201);
    // The desk's copy dialog with Set up: nothing started, nothing handed over.
    expect(res.json.agent).toEqual({ handedTo: null, why: "Send to AI is not set up" });
    expect(r.log()).toEqual([]);
    expect(r.runner.busy()).toBe(false);
    // The user sets it up: their own file holds the consent, 0600, and the next Send goes to the agent.
    const set = await r.call("POST", "/api/agent/setup", { on: true, agent: "claude" });
    expect(set.json.status).toMatchObject({ on: true, agent: "claude", asked: true });
    const file = agentRulesFor(r.store).path;
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ setUp: true, agent: "claude" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await r.note("Then the end card");
    const again = await r.call("POST", "/api/batches", {});
    expect(again.json.agent).toEqual({ handedTo: "claude" });
    await waitFor("the agent to be handed the batch", () => r.log().some((m) => m.method === "session/prompt"));
    await waitFor("the run to finish", () => !r.runner.busy());
  });
});

describe("the agent the user chose is kept in their rules file; the project's switch alone hands nothing over (consent fix)", () => {
  /** What the project's agent.json could be made to say by anything that writes the project (a pull, an allowed command). */
  const forge = (r: Awaited<ReturnType<typeof rig>>, over: Partial<AgentSettings>) => r.store.update("agent", (f) => void Object.assign(f, over));
  const handsNothing = async (r: Awaited<ReturnType<typeof rig>>) => {
    expect((await r.call("GET", "/api/agent")).json.status.on).toBe(false);
    await r.note("Tighten the opening");
    expect((await r.call("POST", "/api/batches", {})).json.agent).toEqual({ handedTo: null, why: "Send to AI is not set up" });
    await new Promise((ok) => setTimeout(ok, 100));
    expect(r.log()).toEqual([]);
    expect(r.runner.busy()).toBe(false);
  };

  it("(b) Copy a prompt answers the sheet but chooses no agent: a switch turned on in agent.json afterwards hands nothing over", async () => {
    const r = await rig();
    const copy = await r.call("POST", "/api/agent/setup", { on: false });
    expect(copy.json.status).toMatchObject({ on: false, asked: true });
    expect(await agentRulesFor(r.store).read()).toMatchObject({ setUp: true, agent: null });
    await forge(r, { on: true, agent: "claude" });
    expect((await r.call("GET", "/api/agent")).json.status).toMatchObject({ on: false, agent: "claude", asked: true });
    await handsNothing(r);
  });

  it("(c) switched off, then switched on again in agent.json: nothing is handed over", async () => {
    const r = await rig();
    await r.call("POST", "/api/agent/setup", { on: true, agent: "claude" });
    expect(await agentRulesFor(r.store).read()).toMatchObject({ agent: "claude" });
    await r.call("POST", "/api/agent/setup", { on: false });
    expect(await agentRulesFor(r.store).read()).toMatchObject({ setUp: true, agent: null });
    await forge(r, { on: true });
    await handsNothing(r);
  });

  it("(c) the other agent written into agent.json is not the one the user chose: off on the desk, nothing handed over", async () => {
    const r = await rig();
    await r.call("POST", "/api/agent/setup", { on: true, agent: "claude" });
    await forge(r, { agent: "codex" });
    expect((await r.call("GET", "/api/agent")).json.status).toMatchObject({ on: false, agent: "codex" });
    await handsNothing(r);
  });

  it("(a) a prepared project: the menu's permission change chooses no agent, so nothing is handed over", async () => {
    const r = await rig({ settings: { on: true, agent: "claude" }, consent: false });
    // As the row posts it: the switch as the desk shows it (off now), and the level.
    const asShown = await r.call("POST", "/api/agent/setup", { on: false, permissions: "ask-all" });
    expect(asShown.status).toBe(200);
    // As an older desk would post it, with the project's switch on and no agent named.
    const asOn = await r.call("POST", "/api/agent/setup", { on: true, permissions: "ask-all" });
    expect(asOn.status).toBe(200);
    expect(await agentRulesFor(r.store).read()).toMatchObject({ permissions: "ask-all", agent: null });
    await forge(r, { on: true, agent: "claude" });
    await handsNothing(r);
  });

  it("a permission change keeps the agent the user chose, and Send still goes to it", async () => {
    const r = await rig({ scenario: { turns: [[{ stop: "end_turn" }]] } });
    await r.call("POST", "/api/agent/setup", { on: true, agent: "claude" });
    const level = await r.call("POST", "/api/agent/setup", { on: true, permissions: "ask-all" });
    expect(level.json.status).toMatchObject({ on: true, agent: "claude", permissions: "ask-all" });
    expect(await agentRulesFor(r.store).read()).toMatchObject({ agent: "claude", permissions: "ask-all" });
    await r.note("Tighten the opening");
    expect((await r.call("POST", "/api/batches", {})).json.agent).toEqual({ handedTo: "claude" });
    await waitFor("the run to finish", () => !r.runner.busy());
  });

  it("a setup refused with 409 (the agent changed) leaves the user's file as it was", async () => {
    const r = await rig({ settings: { on: false, agent: "claude" } });
    // The user answered the sheet before (Copy a prompt); the file is written here as it stands, never through a setup.
    const path = agentRulesFor(r.store).path;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ permissions: "project-edits", always: [], setUp: true, agent: null }), { mode: 0o600 });
    const before = readFileSync(path, "utf8");
    const app = createApp(r.store, {
      agent: r.runner,
      detect: async () => {
        await r.store.update("agent", (f) => { f.agent = "codex"; });
        return [claude(), codex()];
      },
    });
    const res = await app.request("/api/agent/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: true }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "agent_changed" });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("switching off clears the user's agent first: a failed write of agent.json still leaves nothing chosen", async () => {
    const r = await rig();
    await r.call("POST", "/api/agent/setup", { on: true, agent: "claude" });
    expect(await agentRulesFor(r.store).read()).toMatchObject({ agent: "claude" });
    const update = r.store.update.bind(r.store);
    vi.spyOn(r.store, "update").mockImplementation(((file: string, fn: never) =>
      file === "agent" ? Promise.reject(new Error("The disk is full")) : update(file as never, fn)) as typeof r.store.update);
    const off = await r.call("POST", "/api/agent/setup", { on: false });
    expect(off.status).toBe(500);
    expect(await agentRulesFor(r.store).read()).toMatchObject({ setUp: true, agent: null });
    // agent.json still says on for Claude Code, but that is not the user's choice any more.
    expect(await r.store.read("agent")).toMatchObject({ on: true, agent: "claude" });
    expect((await r.call("GET", "/api/agent")).json.status.on).toBe(false);
  });

  it("the switch can't skip the sheet: turning on with no agent named is refused until the user has answered it", async () => {
    const r = await rig({ settings: { on: true, agent: "codex" }, consent: false });
    const res = await r.call("POST", "/api/agent/setup", { on: true });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: "agent_not_set_up", message: "Choose who should get the notes first: Set up Send to AI." });
    expect(existsSync(agentRulesFor(r.store).path)).toBe(false);
    // Once the sheet is answered (here, Copy a prompt), the switch turns on the agent it names.
    await r.call("POST", "/api/agent/setup", { on: false });
    const on = await r.call("POST", "/api/agent/setup", { on: true });
    expect(on.status).toBe(200);
    expect(on.json.status).toMatchObject({ on: true, agent: "codex" });
  });

  it("agent.json no longer carries the legacy asked", async () => {
    const r = await rig();
    await writeFile(join(r.store.dir, "agent.json"), JSON.stringify({ schema: 1, rev: 1, on: false, agent: null, session: null, asked: true }));
    await r.call("POST", "/api/agent/setup", { on: false });
    expect(JSON.parse(readFileSync(join(r.store.dir, "agent.json"), "utf8"))).not.toHaveProperty("asked");
  });
});

describe("setup hands over the batch the copy dialog was opened for (I3)", () => {
  it("a batch refused for want of sign-in goes to the agent once setup goes through, and only once", async () => {
    const r = await rig({ settings: { on: true, agent: "claude" }, agents: [claude({ signedIn: false }), codex()], scenario: { turns: [[{ stop: "end_turn" }]] } });
    await r.note("Tighten the opening");
    const sent = await r.call("POST", "/api/batches", {});
    expect(sent.json.agent).toEqual({ handedTo: null, why: "Claude Code is not signed in" });
    const batch = sent.json.batch.id as string;
    // The user signs in, then confirms the sheet opened from the dialog's Set up.
    r.setAgents([claude(), codex()]);
    const set = await r.call("POST", "/api/agent/setup", { on: true, agent: "claude", batch });
    expect(set.status).toBe(200);
    expect(set.json.agent).toEqual({ handedTo: "claude" });
    await waitFor("the agent to be handed the batch", () => r.log().some((m) => m.method === "session/prompt" && JSON.stringify(m).includes(batch)));
    await waitFor("the run to finish", () => !r.runner.busy());
    // Its notes are no longer waiting with it: setup again hands nothing over.
    const again = await r.call("POST", "/api/agent/setup", { on: true, agent: "claude", batch });
    expect(again.json.agent).toBeUndefined();
    expect(r.log().filter((m) => m.method === "session/prompt")).toHaveLength(1);
  });

  it("two setup posts with the same refused batch at once hand it over once", async () => {
    const r = await rig({ settings: { on: true, agent: "claude" }, agents: [claude({ signedIn: false }), codex()], scenario: { turns: [[{ sleep: 300 }, { stop: "end_turn" }]] } });
    await r.note("Tighten the opening");
    const batch = (await r.call("POST", "/api/batches", {})).json.batch.id as string;
    r.setAgents([claude(), codex()]);
    // Both posts are in flight at once (the slowed reload holds each answer back, so neither has finished before the
    // other starts). The runner takes the id from its refused set inside its send lock, so only one hands it over, and
    // the fake is prompted once.
    const reload = r.runner.reload.bind(r.runner);
    vi.spyOn(r.runner, "reload").mockImplementation(async () => {
      await new Promise((ok) => setTimeout(ok, 100));
      return reload();
    });
    const [a, b] = await Promise.all([
      r.call("POST", "/api/agent/setup", { on: true, agent: "claude", batch }),
      r.call("POST", "/api/agent/setup", { on: true, agent: "claude", batch }),
    ]);
    expect([a.json.agent, b.json.agent].filter((x) => x !== undefined)).toEqual([{ handedTo: "claude" }]);
    await waitFor("the run to finish", () => !r.runner.busy() && r.log().some((m) => m.method === "session/prompt"));
    expect(r.log().filter((m) => m.method === "session/prompt")).toHaveLength(1);
  });

  it("a batch refused while Send to AI only looked on (not set up, no agent chosen) is not kept for a later hand-over", async () => {
    const r = await rig({ settings: { on: true, agent: "claude" }, consent: false, scenario: { turns: [[{ stop: "end_turn" }]] } });
    await r.note("Forged on");
    const forged = await r.call("POST", "/api/batches", {});
    expect(forged.json.agent).toEqual({ handedTo: null, why: "Send to AI is not set up" });
    expect((await r.call("POST", "/api/agent/setup", { on: true, agent: "claude", batch: forged.json.batch.id })).json.agent).toBeUndefined();
    await r.call("POST", "/api/agent/setup", { on: false });
    await r.store.update("agent", (f) => void Object.assign(f, { on: true, agent: null }));
    await r.note("No agent");
    const none = await r.call("POST", "/api/batches", {});
    expect(none.json.agent).toEqual({ handedTo: null, why: "No agent chosen" });
    expect((await r.call("POST", "/api/agent/setup", { on: true, agent: "claude", batch: none.json.batch.id })).json.agent).toBeUndefined();
    await new Promise((ok) => setTimeout(ok, 100));
    expect(r.log().filter((m) => m.method === "session/prompt")).toEqual([]);
  });

  it("a batch whose hand-over was never refused is not handed over: one handed already, or one copied while Send to AI was off", async () => {
    const r = await rig({ scenario: { turns: [[{ stop: "end_turn" }], [{ stop: "end_turn" }]] } });
    // Copied while off: the user chose to paste it themselves.
    await r.note("Copied one");
    const copied = (await r.call("POST", "/api/batches", {})).json.batch.id as string;
    expect((await r.call("POST", "/api/agent/setup", { on: true, agent: "claude", batch: copied })).json.agent).toBeUndefined();
    // Handed over, and its run left a question, so its note is still with the agent.
    const handedNote = await r.note("Handed one");
    const sent = await r.call("POST", "/api/batches", {});
    expect(sent.json.agent).toEqual({ handedTo: "claude" });
    await waitFor("the run to finish", () => !r.runner.busy());
    await r.store.update("notes", (f) => {
      const n = f.notes.find((x) => x.id === handedNote)!;
      n.status = "todo";
      n.batch = sent.json.batch.id;
    });
    expect((await r.call("POST", "/api/agent/setup", { on: true, agent: "claude", batch: sent.json.batch.id })).json.agent).toBeUndefined();
    expect(r.log().filter((m) => m.method === "session/prompt")).toHaveLength(1);
  });

  it("a batch is handed over only when Send to AI goes on; an unknown one is refused before anything is written", async () => {
    const r = await rig({ settings: { on: true, agent: "claude" }, agents: [claude({ signedIn: false }), codex()] });
    await r.note("Tighten the opening");
    const batch = (await r.call("POST", "/api/batches", {})).json.batch.id as string;
    const off = await r.call("POST", "/api/agent/setup", { on: false, batch });
    expect(off.status).toBe(200);
    expect(off.json.agent).toBeUndefined();
    expect(r.log()).toEqual([]);
    const unknown = await r.call("POST", "/api/agent/setup", { on: false, batch: "b_99" });
    expect(unknown.status).toBe(404);
  });
});

describe("Send again: a refused batch is kept in batches.json, so a restart can't strand its notes (I3)", () => {
  it("a batch refused for want of sign-in is marked, and after a restart Send again hands it over once", async () => {
    const r = await rig({ settings: { on: true, agent: "claude" }, agents: [claude({ signedIn: false }), codex()], scenario: { turns: [[{ stop: "end_turn" }]] } });
    await r.note("Tighten the opening");
    const sent = await r.call("POST", "/api/batches", {});
    expect(sent.json.agent).toEqual({ handedTo: null, why: "Claude Code is not signed in" });
    const batch = sent.json.batch.id as string;
    expect((await r.store.read("batches")).batches.find((b) => b.id === batch)?.undelivered).toMatchObject({ why: "Claude Code is not signed in" });
    // The desk's state carries the mark, so it can offer Send again.
    expect((await r.call("GET", "/api/state")).json.batches.batches.find((b: { id: string }) => b.id === batch).undelivered).toMatchObject({ why: "Claude Code is not signed in" });

    // Rushes restarts (a new runner and app on the same project, nothing in memory), and the user has signed in meanwhile.
    await r.runner.close();
    const agents = [claude(), codex()];
    const fake = fakeAgent(r.store, () => agents);
    const runner = new AgentRunner(r.store, fake.opts);
    runners.push(runner);
    await waitFor("the new runner to read agent.json", () => runner.status().on);
    const app = createApp(r.store, { agent: runner, detect: async () => agents });
    const post = async (path: string) => {
      const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const text = await res.text();
      return { status: res.status, json: (text ? JSON.parse(text) : null) as any };
    };

    const again = await post(`/api/batches/${batch}/resend`);
    expect(again.status).toBe(200);
    expect(again.json.agent).toEqual({ handedTo: "claude" });
    expect(again.json.batch.undelivered).toBeNull();
    await waitFor("the agent to be handed the batch", () => fake.log().some((m) => m.method === "session/prompt" && JSON.stringify(m).includes(batch)));
    expect((await r.store.read("batches")).batches.find((b) => b.id === batch)?.undelivered).toBeNull();
    await waitFor("the run to finish", () => !runner.busy());
    // Gone once: a second Send again hands nothing over.
    expect((await post(`/api/batches/${batch}/resend`)).status).toBe(409);
    expect(fake.log().filter((m) => m.method === "session/prompt")).toHaveLength(1);
  });

  it("refused again, Send again says why and keeps the mark; a batch never refused, or unknown, is refused before anything is handed over", async () => {
    const r = await rig({ settings: { on: true, agent: "claude" }, agents: [claude({ signedIn: false }), codex()] });
    await r.note("Tighten the opening");
    const batch = (await r.call("POST", "/api/batches", {})).json.batch.id as string;
    const still = await r.call("POST", `/api/batches/${batch}/resend`);
    expect(still.status).toBe(200);
    expect(still.json.agent).toEqual({ handedTo: null, why: "Claude Code is not signed in" });
    expect((await r.store.read("batches")).batches.find((b) => b.id === batch)?.undelivered).toMatchObject({ why: "Claude Code is not signed in" });
    expect((await r.call("POST", "/api/batches/b_99/resend")).status).toBe(404);
    // Copied while Send to AI was off: the user chose to paste it themselves, so it carries no mark.
    await r.call("POST", "/api/agent/setup", { on: false });
    await r.note("Copied one");
    const copied = (await r.call("POST", "/api/batches", {})).json.batch.id as string;
    expect((await r.store.read("batches")).batches.find((b) => b.id === copied)?.undelivered ?? null).toBeNull();
    const refused = await r.call("POST", `/api/batches/${copied}/resend`);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe("batch_delivered");
    expect(r.log().filter((m) => m.method === "session/prompt")).toEqual([]);
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
    // The sheet was answered before (Copy a prompt), so the switch may turn on: there is just no agent to turn on.
    const r = await rig({ rules: { setUp: true } });
    expect((await r.call("POST", "/api/agent/setup", { on: "yes" })).status).toBe(400);
    expect((await r.call("POST", "/api/agent/setup", { on: true, agent: "gemini" })).status).toBe(400);
    expect((await r.call("POST", "/api/agent/setup", { on: true, permissions: "anything" })).status).toBe(400);
    expect((await r.call("POST", "/api/agent/setup", { on: true })).status).toBe(400);
  });

  it("setup refuses to turn on when the agent changed while it was being checked", async () => {
    const r = await rig({ settings: { on: false, agent: "claude" }, rules: { setUp: true } });
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

  it("asked starts false and turns true after any setup, {on:false} included; a refused setup leaves it false", async () => {
    const r = await rig({ agents: [claude({ signedIn: false }), codex()] });
    expect((await r.call("GET", "/api/agent")).json.status.asked).toBe(false);
    expect((await agentRulesFor(r.store).read()).setUp).toBe(false);
    // A refusal settles nothing: the first Send still asks.
    expect((await r.call("POST", "/api/agent/setup", { on: true, agent: "claude" })).status).toBe(409);
    expect((await r.call("GET", "/api/agent")).json.status.asked).toBe(false);
    const off = await r.call("POST", "/api/agent/setup", { on: false });
    expect(off.json.status).toMatchObject({ on: false, asked: true });
    // I1: the answer is kept in the user's own rules file, not in the project.
    expect((await agentRulesFor(r.store).read()).setUp).toBe(true);
    expect(await r.store.read("agent")).toMatchObject({ on: false });
    expect(await r.store.read("agent")).not.toHaveProperty("asked");
    // Another project's first setup turning Send to AI on says so too.
    const s = await rig();
    expect((await s.call("POST", "/api/agent/setup", { on: true, agent: "codex" })).json.status).toMatchObject({ on: true, agent: "codex", asked: true });
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
    // agent.json changes first, then the user's rules file (consent fix): the status reads on once both have.
    const text = await events.until(`"on":true`);
    const line = text.split("\n").find((l, i, all) => all[i - 1] === "event: agent" && l.startsWith("data: ") && l.includes(`"on":true`))!;
    const status = JSON.parse(line.slice("data: ".length)) as AgentStatus;
    expect(status).toMatchObject({ on: true, agent: "claude" });
    events.stop();
    // The stream's listener goes when it closes.
    await waitFor("the agent listener to go", () => s.store.listenerCount("agent") === before);
  });
});

describe("the macOS notification when no desk is open (spec §5.4)", () => {
  const exec = (command: string, record: string) => ({
    permission: { toolCall: { toolCallId: record, title: `Run ${command}`, kind: "execute", rawInput: { command } } },
    record,
  });

  async function server() {
    const { root, store } = await tmpProject("lumen");
    const fake = fakeAgent(store, () => [claude(), codex()]);
    await fake.scenario({ turns: [[exec("npm test", "t")]] });
    await store.update("agent", (f) => void Object.assign(f, { on: true, agent: "claude" }));
    await agentRulesFor(store).update((f) => void Object.assign(f, { setUp: true, agent: "claude" }));
    const told: Array<[string, string]> = [];
    const s = await startServer(root, { port: 0, agent: fake.opts, notify: async (title, body) => void told.push([title, body]) });
    servers.push(s);
    const post = (path: string, json: unknown) =>
      fetch(`${s.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) }).then((r) => r.json() as Promise<any>);
    const status = async () => (await (await fetch(`${s.url}/api/agent`)).json() as any).status as AgentStatus;
    /** A note the agent asks on before its turn ends, so the run ends in question. */
    const sendAsked = async () => {
      const note = (await post("/api/notes", { stage: "picture", scope: "whole", text: "Tighten the opening" })).note.id as string;
      await store.update("notes", (f) => {
        const n = f.notes.find((x) => x.id === note)!;
        n.replies.push({ by: "agent", text: "Which part?", at: new Date().toISOString() });
      });
      expect((await post("/api/batches", {})).agent).toMatchObject({ handedTo: "claude" });
    };
    return { s, told, post, status, sendAsked };
  }

  it("tells the Mac when an ask arrives and when a run ends in a question, with no desk open", async () => {
    const r = await server();
    await r.sendAsked();
    const ask = await waitFor("an ask", async () => (await r.status()).asks[0]);
    await waitFor("the first notification", () => r.told.length === 1);
    expect(r.told[0]).toEqual(["Rushes", "Claude Code is waiting for you in My Project"]);
    await r.post(`/api/agent/permission/${ask.id}`, { choice: "once" });
    await waitFor("the question", async () => (await r.status()).phase === "question");
    await waitFor("the second notification", () => r.told.length === 2);
    expect(r.told[1]).toEqual(["Rushes", "Claude Code is waiting for you in My Project"]);
    // Never the command.
    expect(r.told.flat().some((t) => t.includes("npm test"))).toBe(false);
  });

  it("stays quiet while a desk is open", async () => {
    const r = await server();
    const events = await sse(r.s.url);
    await events.until("event: hello");
    await r.sendAsked();
    const ask = await waitFor("an ask", async () => (await r.status()).asks[0]);
    await r.post(`/api/agent/permission/${ask.id}`, { choice: "once" });
    await waitFor("the question", async () => (await r.status()).phase === "question");
    await new Promise((ok) => setTimeout(ok, 100));
    expect(r.told).toEqual([]);
    events.stop();
  });
});

describe("Send to AI is set up once per Mac (§32)", () => {
  const defaults = () => agentDefaultsFile();
  const readDefault = () => JSON.parse(readFileSync(defaultsPath(), "utf8"));

  it("§33: Auto picked in the menu is the default, and a second project starts in Auto", async () => {
    const a = await rig({ settings: { on: true, agent: "claude" } });
    await a.call("POST", "/api/agent/setup", { on: true, agent: "claude" });
    await a.call("POST", "/api/agent/setup", { on: true, permissions: "auto" });
    expect(readDefault()).toEqual({ agent: "claude", permissions: "auto" });
    const b = await rig();
    expect((await b.call("GET", "/api/agent")).json.status).toMatchObject({ on: true, agent: "claude", asked: true, permissions: "auto" });
  });

  it("§33: Bypass picked in the menu is kept for that project, but a second project starts in Accept edits", async () => {
    const a = await rig({ settings: { on: true, agent: "claude" } });
    await a.call("POST", "/api/agent/setup", { on: true, agent: "claude" });
    await a.call("POST", "/api/agent/setup", { on: true, permissions: "bypass" });
    expect((await a.call("GET", "/api/agent")).json.status).toMatchObject({ permissions: "bypass" });
    const b = await rig();
    expect((await b.call("GET", "/api/agent")).json.status).toMatchObject({ on: true, agent: "claude", asked: true, permissions: "project-edits" });
  });

  it("with no default yet the sheet asks once, and its answer becomes the default (0600 in a 0700 folder)", async () => {
    expect(existsSync(defaultsPath())).toBe(false);
    const a = await rig();
    expect((await a.call("GET", "/api/agent")).json.status).toMatchObject({ on: false, asked: false });
    await a.call("POST", "/api/agent/setup", { on: true, agent: "claude", permissions: "ask-all" });
    expect(readDefault()).toEqual({ agent: "claude", permissions: "ask-all" });
    expect(statSync(defaultsPath()).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(defaultsPath())).mode & 0o777).toBe(0o700);
  });

  it("a new project starts from the default: set up, on for that agent, its permissions, no Always rules, and Send goes straight to the agent", async () => {
    const a = await rig({ settings: { on: true, agent: "claude" } });
    await a.call("POST", "/api/agent/setup", { on: true, agent: "claude", permissions: "ask-all" });
    await agentRulesFor(a.store).update((f) => void f.always.push({ kind: "execute", command: "ffmpeg" }));
    const b = await rig({ scenario: { turns: [[{ stop: "end_turn" }]] } });
    expect(existsSync(agentRulesFor(b.store).path)).toBe(false);
    expect((await b.call("GET", "/api/agent")).json.status).toMatchObject({ on: true, agent: "claude", asked: true, permissions: "ask-all", always: [] });
    expect(await agentRulesFor(b.store).read()).toEqual({ setUp: true, agent: "claude", permissions: "ask-all", always: [] });
    expect(await b.store.read("agent")).toMatchObject({ on: true, agent: "claude" });
    // Always rules stay per project: A keeps its own.
    expect((await agentRulesFor(a.store).read()).always).toHaveLength(1);
    await b.note("Tighten the opening");
    expect((await b.call("POST", "/api/batches", {})).json.agent).toEqual({ handedTo: "claude" });
    await waitFor("the agent to be handed the batch", () => b.log().some((m) => m.method === "session/prompt"));
    await waitFor("the run to finish", () => !b.runner.busy());
  });

  it("a Send before the desk has loaded still starts from the default", async () => {
    const a = await rig();
    await a.call("POST", "/api/agent/setup", { on: true, agent: "claude" });
    const b = await rig({ scenario: { turns: [[{ stop: "end_turn" }]] } });
    await b.note("Tighten the opening");
    expect((await b.call("POST", "/api/batches", {})).json.agent).toEqual({ handedTo: "claude" });
    await waitFor("the run to finish", () => !b.runner.busy());
  });

  it("Copy a prompt sets no agent: a new project is set up (no sheet) with Send to AI off", async () => {
    const a = await rig();
    await a.call("POST", "/api/agent/setup", { on: true, agent: "claude" });
    await a.call("POST", "/api/agent/setup", { on: false, prompt: true });
    expect(readDefault()).toMatchObject({ agent: null });
    const b = await rig();
    expect((await b.call("GET", "/api/agent")).json.status).toMatchObject({ on: false, asked: true });
    expect((await b.store.read("agent")).on).toBe(false);
  });

  it("turning Send to AI off on one project leaves the default as it is", async () => {
    const a = await rig();
    await a.call("POST", "/api/agent/setup", { on: true, agent: "codex" });
    await a.call("POST", "/api/agent/setup", { on: false });
    expect(readDefault()).toMatchObject({ agent: "codex" });
    const b = await rig();
    expect((await b.call("GET", "/api/agent")).json.status).toMatchObject({ on: true, agent: "codex", asked: true });
  });

  it("the agent menu and the switch turned on are the default too: last choice wins", async () => {
    const a = await rig();
    await a.call("POST", "/api/agent/setup", { on: true, agent: "claude" });
    await a.call("POST", "/api/agent/setup", { on: true, permissions: "ask-all" });
    expect(readDefault()).toEqual({ agent: "claude", permissions: "ask-all" });
    await a.call("POST", "/api/agent/setup", { on: true, agent: "codex", permissions: "project-edits" });
    expect(readDefault()).toEqual({ agent: "codex", permissions: "project-edits" });
    // Off, then the switch on again (no agent named): the agent agent.json names, kept as the default.
    await a.call("POST", "/api/agent/setup", { on: false });
    await a.call("POST", "/api/agent/setup", { on: true });
    expect(readDefault()).toEqual({ agent: "codex", permissions: "project-edits" });
  });

  it("a project that has rules of its own keeps them; the default is only for a project with none", async () => {
    const a = await rig({ rules: { setUp: true, agent: null, permissions: "ask-all" } });
    await defaults().set({ agent: "claude", permissions: "project-edits" }, { agent: null, permissions: "project-edits" });
    expect((await a.call("GET", "/api/agent")).json.status).toMatchObject({ on: false, asked: true, permissions: "ask-all" });
    expect(await agentRulesFor(a.store).read()).toMatchObject({ agent: null, permissions: "ask-all" });
  });

  it("nothing in a project can fake consent: a default or rules file written inside it, with agent.json on, hands nothing over (R10)", async () => {
    const r = await rig({ settings: { on: true, agent: "claude" }, consent: false });
    const own = join(r.root, ".rushes");
    await writeFile(join(own, "agent-defaults.json"), JSON.stringify({ agent: "claude", permissions: "project-edits" }));
    await mkdir(join(own, "rushes", "agent-rules"), { recursive: true });
    await writeFile(join(own, "rushes", "agent-rules", "x.json"), JSON.stringify({ setUp: true, agent: "claude" }));
    expect((await r.call("GET", "/api/agent")).json.status).toMatchObject({ on: false, asked: false });
    expect(existsSync(defaultsPath())).toBe(false);
    await r.note("Tighten the opening");
    expect((await r.call("POST", "/api/batches", {})).json.agent).toEqual({ handedTo: null, why: "Send to AI is not set up" });
    expect(r.log()).toEqual([]);
  });

  it("a project whose agent.json names another agent goes to the user's default agent, never the project's", async () => {
    await defaults().set({ agent: "claude" }, { agent: null, permissions: "project-edits" });
    const r = await rig({ settings: { on: true, agent: "codex", session: { id: "s1", agent: "codex", startedAt: "2026-11-19T10:00:00Z" } }, consent: false });
    expect((await r.call("GET", "/api/agent")).json.status).toMatchObject({ on: true, agent: "claude", session: null });
  });

  it("a default agent that isn't signed in is not swapped for another: Send is refused and waits for Send again", async () => {
    await defaults().set({ agent: "claude" }, { agent: null, permissions: "project-edits" });
    const r = await rig({ agents: [claude({ signedIn: false }), codex()] });
    expect((await r.call("GET", "/api/agent")).json.status).toMatchObject({ on: true, agent: "claude" });
    await r.note("Tighten the opening");
    const sent = await r.call("POST", "/api/batches", {});
    expect(sent.json.agent).toEqual({ handedTo: null, why: "Claude Code is not signed in" });
    expect((await r.store.read("batches")).batches[0].undelivered).toBeTruthy();
    expect(r.log()).toEqual([]);
  });

  it("a damaged default is no default: the sheet asks", async () => {
    await mkdir(dirname(defaultsPath()), { recursive: true });
    await writeFile(defaultsPath(), "{ not json");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await rig();
    expect((await r.call("GET", "/api/agent")).json.status).toMatchObject({ on: false, asked: false });
    expect(existsSync(agentRulesFor(r.store).path)).toBe(false);
  });
});
