import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpConnection, type AdapterSpec } from "../../../src/server/agent/acp.js";

const FAKE = resolve(__dirname, "../../helpers/fake-acp.mjs");
const dirs: string[] = [];
const conns: AcpConnection[] = [];

afterEach(async () => {
  const all = conns.splice(0);
  const gone = all.map((c) => new Promise<void>((r) => (c.hasExited ? r() : c.once("exit", () => r()))));
  for (const c of all) c.kill();
  await Promise.all(gone);
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
/** Polls the fake's log until `find` matches, up to 3 s. */
async function waitLog(log: () => Promise<any[]>, find: (m: any) => boolean): Promise<any> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const hit = (await log()).find(find);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error("timed out waiting for a line in the fake log");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const exitOf = (c: AcpConnection) => new Promise<{ code: number | null; stderr: string }>((r) => c.once("exit", r));

describe("AcpConnection", () => {
  it("initialize reports loadSession from the agent", async () => {
    const { c } = await start({ loadSession: true, turns: [] });
    expect(await c.initialize()).toEqual({ loadSession: true });
    const { c: c2 } = await start({ turns: [] });
    expect(await c2.initialize()).toEqual({ loadSession: false });
  });

  it("newSession and loadSession return the available mode ids and the current one", async () => {
    const { c, log } = await start({ loadSession: true, modes: ["default", "plan"], turns: [] });
    await c.initialize();
    expect(await c.newSession("/tmp", [])).toEqual({ sessionId: "fake-session-1", modes: ["default", "plan"], current: "default" });
    expect(await c.loadSession("old-1", "/tmp", [], { configOptions: [{ configId: "mode", value: "plan" }] })).toEqual({ modes: ["default", "plan"], current: "plan" });
    await c.setMode("fake-session-1", "plan");
    expect((await log()).some((m) => m.loaded === "old-1")).toBe(true);
    const { c: c2 } = await start({ turns: [] });
    await c2.initialize();
    expect(await c2.newSession("/tmp", [])).toEqual({ sessionId: "fake-session-1", modes: [], current: null });
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
    expect((await waitLog(log, (m) => m.recorded === "ask")).outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
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
    await waitLog(log, (m) => m.method === "session/cancel");
    // our reply to the agent's request was the cancelled outcome
    expect((await waitLog(log, (m) => m.result?.outcome)).result.outcome).toEqual({ outcome: "cancelled" });
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
    await waitLog(log, (m) => m.result?.outcome);
    await new Promise((r) => setTimeout(r, 100)); // room for a (wrong) second answer
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

  it("exit carries the stderr text", async () => {
    const { c } = await start({ turns: [[{ stderr: "adapter said: boom\n" }, { crash: 2 }]] });
    await c.initialize();
    const { sessionId } = await c.newSession("/tmp", []);
    const exit = exitOf(c);
    await expect(c.prompt(sessionId, "go")).rejects.toThrow();
    const e = await exit;
    expect(e.code).toBe(2);
    expect(e.stderr).toBe("adapter said: boom\n");
  });

  it("stderr beyond 4 KB is trimmed to its last 4096 characters", async () => {
    const text = "a".repeat(3000) + "b".repeat(3000) + "END";
    const { c } = await start({ turns: [[{ stderr: text }, { crash: 1 }]] });
    await c.initialize();
    const { sessionId } = await c.newSession("/tmp", []);
    const exit = exitOf(c);
    await expect(c.prompt(sessionId, "go")).rejects.toThrow();
    const e = await exit;
    expect(e.stderr).toHaveLength(4096);
    expect(e.stderr).toBe(text.slice(-4096));
  });

  it("kill ends an agent that ignores SIGTERM through SIGKILL, with one exit event", { timeout: 10000 }, async () => {
    const { c } = await start({ ignoreSigterm: true, turns: [] });
    await c.initialize();
    let exits = 0;
    c.on("exit", () => exits++);
    const exit = exitOf(c);
    const t0 = Date.now();
    c.kill();
    c.kill();
    const e = await exit;
    const took = Date.now() - t0;
    // §34: Windows has no SIGTERM to ignore: taskkill /T /F ends the tree at once, with exit code 1.
    if (process.platform !== "win32") {
      expect(took).toBeGreaterThanOrEqual(1800);
      expect(e.code).toBeNull(); // killed by a signal
    }
    expect(took).toBeLessThan(6000);
    await new Promise((r) => setTimeout(r, 200));
    expect(exits).toBe(1);
  });

  it("kill ends a normal agent at once", async () => {
    const { c } = await start({ turns: [] });
    await c.initialize();
    const exit = exitOf(c);
    c.kill();
    await exit;
  });

  it("a throwing update listener does not crash the process and a later prompt completes", async () => {
    const { c } = await start({
      turns: [[{ update: { sessionUpdate: "x" } }, { stop: "end_turn" }], [{ update: { sessionUpdate: "y" } }, { stop: "end_turn" }]],
    });
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
    try {
      let n = 0;
      c.on("update", () => {
        n++;
        throw new Error("listener bug");
      });
      await c.initialize();
      const { sessionId } = await c.newSession("/tmp", []);
      expect((await c.prompt(sessionId, "one")).stopReason).toBe("end_turn");
      expect((await c.prompt(sessionId, "two")).stopReason).toBe("end_turn");
      expect(n).toBe(2);
      expect(errors.some((e) => e.includes("listener bug"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("a permission handler that throws or rejects answers the agent cancelled", async () => {
    for (const handler of [
      () => { throw new Error("sync bug"); },
      async () => { throw new Error("async bug"); },
    ]) {
      const { c, log } = await start({ turns: [[{ permission: { toolCall: { toolCallId: "t" } }, record: "ask" }, { stop: "end_turn" }]] });
      c.onPermission(handler as any);
      await c.initialize();
      const { sessionId } = await c.newSession("/tmp", []);
      await c.prompt(sessionId, "go");
      expect((await waitLog(log, (m) => m.recorded === "ask")).outcome).toEqual({ outcome: "cancelled" });
    }
  });

  it("an unanswered permission ask is settled when the agent exits", async () => {
    const { c } = await start({ turns: [[{ permission: { toolCall: { toolCallId: "t" } } }, { sleep: 60000 }]] });
    let asked!: () => void;
    const askedP = new Promise<void>((r) => (asked = r));
    c.onPermission(() => { asked(); return new Promise(() => {}); });
    await c.initialize();
    const { sessionId } = await c.newSession("/tmp", []);
    const prompt = c.prompt(sessionId, "go").catch((e) => e);
    await askedP;
    const exit = exitOf(c);
    c.kill();
    await exit;
    expect(await prompt).toBeInstanceOf(Error);
    expect((c as any).openAsks.size).toBe(0);
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
