// The RUSHES_TEST_AGENT hook (plan 2, task 1): a server started for the browser tests drives the fake agent, never
// a real adapter. It is read only under NODE_ENV=test or RUSHES_E2E=1; anywhere else the server detects as usual.
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpProject } from "../helpers/tmp.js";
import { startServer, type Running } from "../../src/server/start.js";

// Detection on this Mac must never decide a test: with the hook ignored, the server finds no agent at all.
vi.mock("../../src/server/agent/detect.js", async (original) => ({
  ...(await original<typeof import("../../src/server/agent/detect.js")>()),
  detectAgents: async () => [
    { id: "claude", name: "Claude Code", installed: false, signedIn: false, path: null, signIn: "claude auth login" },
    { id: "codex", name: "Codex", installed: false, signedIn: false, path: null, signIn: "codex login" },
  ],
}));

const FAKE = resolve(__dirname, "../helpers/fake-acp.mjs");
const servers: Running[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  vi.unstubAllEnvs();
});

/** A project, a scenario for the fake agent, and the hook's JSON pointing at it. */
async function project(extra: object = {}) {
  const { root, store } = await tmpProject();
  const scenario = join(store.dir, "scenario.json");
  const log = join(store.dir, "fake-log.jsonl");
  // The modes in which each agent asks Rushes: "default" (Claude Code) and "read-only" (Codex).
  await writeFile(scenario, JSON.stringify({ modes: ["default", "read-only"], turns: [] }));
  const hook = JSON.stringify({ command: process.execPath, args: [FAKE], env: { FAKE_ACP_SCENARIO: scenario, FAKE_ACP_LOG: log }, ...extra });
  const readLog = () => {
    let text = "";
    try { text = readFileSync(log, "utf8"); } catch { /* not written yet */ }
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
  };
  return { root, hook, readLog };
}

async function start(root: string): Promise<Running> {
  const s = await startServer(root, { port: 0 });
  servers.push(s);
  return s;
}

const call = async (s: Running, method: string, path: string, json?: unknown) => {
  const res = await fetch(`${s.url}${path}`, { method, headers: { "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });
  return { status: res.status, json: (await res.json()) as any };
};

async function waitFor<T>(what: string, check: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const v = await check();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe("RUSHES_TEST_AGENT", () => {
  it("under NODE_ENV=test, Send hands the batch to the fake agent", async () => {
    const p = await project();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RUSHES_E2E", "");
    vi.stubEnv("RUSHES_TEST_AGENT", p.hook);
    const s = await start(p.root);

    expect((await call(s, "POST", "/api/agent/setup", { on: true, agent: "claude" })).status).toBe(200);
    expect((await call(s, "POST", "/api/notes", { stage: "picture", scope: "whole", text: "Tighten the opening" })).status).toBe(201);
    const sent = await call(s, "POST", "/api/batches", {});
    expect(sent.status).toBe(201);
    expect(sent.json.agent.handedTo).toBe("claude");

    // It really was the fake that took it, started in the project folder, and its prompt ran in the ask mode.
    await waitFor("the fake agent's prompt", () => p.readLog().find((m) => m.method === "session/prompt"));
    expect(p.readLog().find((m) => m.method === "session/new")?.params.cwd).toBe(s.store.root);
    expect(p.readLog().find((m) => "promptMode" in m)?.promptMode).toBe("default");
    await waitFor("the run to finish", async () => ["finished", "question"].includes((await call(s, "GET", "/api/agent")).json.status.phase));
  });

  it("under RUSHES_E2E=1 it works with Codex too", async () => {
    const p = await project();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RUSHES_E2E", "1");
    vi.stubEnv("RUSHES_TEST_AGENT", p.hook);
    const s = await start(p.root);

    expect((await call(s, "POST", "/api/agent/setup", { on: true, agent: "codex" })).status).toBe(200);
    await call(s, "POST", "/api/notes", { stage: "picture", scope: "whole", text: "Tighten the opening" });
    const sent = await call(s, "POST", "/api/batches", {});
    expect(sent.json.agent.handedTo).toBe("codex");
    await waitFor("the fake agent's prompt", () => p.readLog().find((m) => "promptMode" in m));
    expect(p.readLog().find((m) => "promptMode" in m)?.promptMode).toBe("read-only");
    await waitFor("the run to finish", async () => ["finished", "question"].includes((await call(s, "GET", "/api/agent")).json.status.phase));
  });

  it("without agents, both agents are installed and signed in, as detection would say", async () => {
    const p = await project();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RUSHES_TEST_AGENT", p.hook);
    const s = await start(p.root);
    const { agents: listed } = (await call(s, "GET", "/api/agent/detect")).json;
    // §34: the fake agent needs no connector, so each reads ready.
    expect(listed.map((a: { connector: unknown }) => a.connector)).toEqual([{ state: "ready" }, { state: "ready" }]);
    const agents = listed.map(({ connector: _c, ...a }: { connector: unknown }) => a);
    expect(agents).toEqual([
      { id: "claude", name: "Claude Code", installed: true, signedIn: true, path: expect.any(String), signIn: "claude auth login" },
      { id: "codex", name: "Codex", installed: true, signedIn: true, path: expect.any(String), signIn: "codex login" },
    ]);
    for (const a of agents) expect(a.path).not.toBe("");
  });

  it("agents overrides detection: one not installed, one not signed in", async () => {
    const p = await project({ agents: [{ id: "claude", installed: true, signedIn: false }, { id: "codex", installed: false, signedIn: false }] });
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RUSHES_TEST_AGENT", p.hook);
    const s = await start(p.root);
    const { agents: listed } = (await call(s, "GET", "/api/agent/detect")).json;
    // §34: the fake agent needs no connector, so each reads ready.
    expect(listed.map((a: { connector: unknown }) => a.connector)).toEqual([{ state: "ready" }, { state: "ready" }]);
    const agents = listed.map(({ connector: _c, ...a }: { connector: unknown }) => a);
    expect(agents).toEqual([
      { id: "claude", name: "Claude Code", installed: true, signedIn: false, path: expect.any(String), signIn: "claude auth login" },
      { id: "codex", name: "Codex", installed: false, signedIn: false, path: null, signIn: "codex login" },
    ]);
    const claude = await call(s, "POST", "/api/agent/setup", { on: true, agent: "claude" });
    expect(claude.status).toBe(409);
    expect(claude.json.error).toBe("agent_not_signed_in");
    const codex = await call(s, "POST", "/api/agent/setup", { on: true, agent: "codex" });
    expect(codex.status).toBe(409);
    expect(codex.json.error).toBe("agent_not_installed");
  });

  it("agentsFile is read at every detection, so a test can sign an agent in while the server runs", async () => {
    const { root: dir } = await tmpProject();
    const file = join(dir, "agents.json");
    await writeFile(file, JSON.stringify([{ id: "claude", installed: true, signedIn: false }]));
    const p = await project({ agentsFile: file });
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RUSHES_TEST_AGENT", p.hook);
    const s = await start(p.root);
    const signedIn = async () => (await call(s, "GET", "/api/agent/detect")).json.agents.map((a: { id: string; signedIn: boolean }) => [a.id, a.signedIn]);
    expect(await signedIn()).toEqual([["claude", false], ["codex", false]]);
    expect((await call(s, "POST", "/api/agent/setup", { on: true, agent: "claude" })).status).toBe(409);
    await writeFile(file, JSON.stringify([{ id: "claude", installed: true, signedIn: true }]));
    expect(await signedIn()).toEqual([["claude", true], ["codex", false]]);
    expect((await call(s, "POST", "/api/agent/setup", { on: true, agent: "claude" })).status).toBe(200);
  });

  it("is ignored outside NODE_ENV=test and RUSHES_E2E=1: the server detects as usual", async () => {
    const p = await project();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RUSHES_E2E", "");
    vi.stubEnv("RUSHES_TEST_AGENT", p.hook);
    const s = await start(p.root);
    // Detection (mocked above to find nothing) answers, not the hook's two signed-in agents.
    const { agents } = (await call(s, "GET", "/api/agent/detect")).json;
    expect(agents.map((a: { installed: boolean }) => a.installed)).toEqual([false, false]);
    const setup = await call(s, "POST", "/api/agent/setup", { on: true, agent: "claude" });
    expect(setup.status).toBe(409);
    expect(setup.json.error).toBe("agent_not_installed");
    expect(p.readLog()).toEqual([]);
  });

  it("RUSHES_E2E must be exactly 1", async () => {
    const p = await project();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RUSHES_E2E", "true");
    vi.stubEnv("RUSHES_TEST_AGENT", p.hook);
    const s = await start(p.root);
    const { agents } = (await call(s, "GET", "/api/agent/detect")).json;
    expect(agents.map((a: { installed: boolean }) => a.installed)).toEqual([false, false]);
  });
});
