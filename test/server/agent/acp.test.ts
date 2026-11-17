import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpConnection, type AdapterSpec } from "../../../src/server/agent/acp.js";

const FAKE = resolve(__dirname, "../../helpers/fake-acp.mjs");
const dirs: string[] = [];
const conns: AcpConnection[] = [];

afterEach(async () => {
  for (const c of conns.splice(0)) c.kill();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function fake(scenario: object): Promise<{ spec: AdapterSpec; log: () => Promise<any[]> }> {
  const dir = await mkdtemp(join(tmpdir(), "fake-acp-"));
  dirs.push(dir);
  const scenarioPath = join(dir, "scenario.json");
  const logPath = join(dir, "log.jsonl");
  await writeFile(scenarioPath, JSON.stringify(scenario));
  return {
    spec: { command: process.execPath, args: [FAKE], env: { FAKE_ACP_SCENARIO: scenarioPath, FAKE_ACP_LOG: logPath }, cwd: dir },
    log: async () => (await readFile(logPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}
async function start(scenario: object) {
  const f = await fake(scenario);
  const c = AcpConnection.start(f.spec);
  conns.push(c);
  return { c, ...f };
}
const exitOf = (c: AcpConnection) => new Promise<{ code: number | null; stderr: string }>((r) => c.once("exit", r));

describe("AcpConnection", () => {
  it("initialize reports loadSession from the agent", async () => {
    const { c } = await start({ loadSession: true, turns: [] });
    expect(await c.initialize()).toEqual({ loadSession: true });
    const { c: c2 } = await start({ turns: [] });
    expect(await c2.initialize()).toEqual({ loadSession: false });
  });

  it("newSession and loadSession return the available mode ids", async () => {
    const { c, log } = await start({ loadSession: true, modes: ["default", "plan"], turns: [] });
    await c.initialize();
    expect(await c.newSession("/tmp", [])).toEqual({ sessionId: "fake-session-1", modes: ["default", "plan"] });
    expect(await c.loadSession("old-1", "/tmp", [])).toEqual({ modes: ["default", "plan"] });
    await c.setMode("fake-session-1", "plan");
    expect((await log()).some((m) => m.loaded === "old-1")).toBe(true);
    const { c: c2 } = await start({ turns: [] });
    await c2.initialize();
    expect(await c2.newSession("/tmp", [])).toEqual({ sessionId: "fake-session-1", modes: [] });
  });

  it("a prompt streams updates and ends with the stop reason", async () => {
    const { c, log } = await start({
      turns: [[{ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } } }, { stop: "end_turn" }]],
    });
    const heard: any[] = [];
    c.on("update", (u) => heard.push(u));
    await c.initialize();
    const { sessionId } = await c.newSession("/tmp", []);
    const result = await c.prompt(sessionId, "Fix it");
    expect(heard).toHaveLength(1);
    expect(result.stopReason).toBe("end_turn");
    const prompt = (await log()).find((m) => m.method === "session/prompt");
    expect(prompt.params.prompt).toEqual([{ type: "text", text: "Fix it" }]);
    // a prompt beyond the scripted turns ends at once
    expect((await c.prompt(sessionId, "again")).stopReason).toBe("end_turn");
  });

  it("a permission request reaches onPermission and its answer reaches the agent", async () => {
    const { c, log } = await start({
      turns: [[{ permission: { toolCall: { toolCallId: "t1", title: "Edit" } }, record: "ask" }, { stop: "end_turn" }]],
    });
    let seen: any;
    c.onPermission(async (p) => {
      seen = p;
      return { outcome: "selected", optionId: "allow-once" };
    });
    await c.initialize();
    const { sessionId } = await c.newSession("/tmp", []);
    await c.prompt(sessionId, "go");
    expect(seen.toolCall.toolCallId).toBe("t1");
    expect(seen.options.map((o: any) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
    expect((await log()).find((m) => m.recorded === "ask").outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
  });

  it("cancel answers the open permission request cancelled and the prompt ends cancelled", async () => {
    const { c, log } = await start({
      turns: [[{ permission: { toolCall: { toolCallId: "t1" } }, record: "ask" }, { update: { sessionUpdate: "never" } }]],
    });
    let asked!: () => void;
    const askedP = new Promise<void>((r) => (asked = r));
    c.onPermission(() => {
      asked();
      return new Promise(() => {}); // the handler never answers
    });
    await c.initialize();
    const { sessionId } = await c.newSession("/tmp", []);
    const prompt = c.prompt(sessionId, "go");
    await askedP;
    c.cancel(sessionId);
    expect((await prompt).stopReason).toBe("cancelled");
    const entries = await log();
    expect(entries.some((m) => m.method === "session/cancel")).toBe(true);
    // our reply to the agent's request was the cancelled outcome
    expect(entries.find((m) => m.result?.outcome)?.result.outcome).toEqual({ outcome: "cancelled" });
  });

  it("a late handler answer after cancel does not replace the cancelled outcome", async () => {
    const { c, log } = await start({ turns: [[{ permission: { toolCall: { toolCallId: "t1" } } }]] });
    let release!: (o: any) => void;
    let asked!: () => void;
    const askedP = new Promise<void>((r) => (asked = r));
    c.onPermission(() => new Promise((r) => { release = r; asked(); }));
    await c.initialize();
    const { sessionId } = await c.newSession("/tmp", []);
    const prompt = c.prompt(sessionId, "go");
    await askedP;
    c.cancel(sessionId);
    release({ outcome: "selected", optionId: "allow-once" });
    await prompt;
    const answers = (await log()).filter((m) => m.result?.outcome);
    expect(answers).toHaveLength(1);
    expect(answers[0].result.outcome).toEqual({ outcome: "cancelled" });
  });

  it("exit is emitted with the code and the stderr tail when the agent crashes", async () => {
    const { c } = await start({ turns: [[{ crash: 3 }]] });
    const exits: any[] = [];
    c.on("exit", (e) => exits.push(e));
    await c.initialize();
    const { sessionId } = await c.newSession("/tmp", []);
    const exit = exitOf(c);
    await expect(c.prompt(sessionId, "go")).rejects.toThrow(/code 3/);
    expect((await exit).code).toBe(3);
    expect(exits).toHaveLength(1);
  });

  it("exitOnStart exits before reading and in-flight requests reject", async () => {
    const { c } = await start({ exitOnStart: 7, turns: [] });
    await expect(c.initialize()).rejects.toThrow(/code 7/);
  });

  it("kill stops the child and emits exit once", async () => {
    const { c } = await start({ turns: [] });
    await c.initialize();
    const exit = exitOf(c);
    c.kill();
    c.kill();
    const e = await exit;
    expect(e.code === null || typeof e.code === "number").toBe(true);
  });

  it("http steps call FAKE_ACP_BASE and wait", async () => {
    const http = await import("node:http");
    const got: any[] = [];
    const server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => { got.push({ url: req.url, body: JSON.parse(b) }); res.end("{}"); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const f = await fake({ turns: [[{ http: { method: "POST", path: "/x", body: { a: 1 } } }]] });
      const c = AcpConnection.start({ ...f.spec, env: { ...f.spec.env, FAKE_ACP_BASE: `http://127.0.0.1:${(server.address() as any).port}` } });
      conns.push(c);
      await c.initialize();
      const { sessionId } = await c.newSession("/tmp", []);
      expect((await c.prompt(sessionId, "go")).stopReason).toBe("end_turn");
      expect(got).toEqual([{ url: "/x", body: { a: 1 } }]);
    } finally {
      server.close();
    }
  });
});
