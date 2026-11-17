import { beforeEach, describe, expect, it } from "vitest";
import { clearDetectCache, defaultRunner, detectAgents, type CommandRunner } from "../../../src/server/agent/detect.js";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (code = 1) => ({ code, stdout: "", stderr: "" });
const missing = () => ({ code: null, stdout: "", stderr: "" });
function fakeRunner(table: Record<string, { code: number | null; stdout: string; stderr: string }>): CommandRunner & { calls: string[] } {
  const calls: string[] = [];
  const run = (async (cmd: string, args: string[]) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    return table[key] ?? missing();
  }) as unknown as CommandRunner & { calls: string[] };
  run.calls = calls;
  return run;
}

beforeEach(() => clearDetectCache());

describe("detectAgents", () => {
  it("signed in when installed and the status command exits 0", async () => {
    const run = fakeRunner({ "which claude": ok("/usr/local/bin/claude\n"), "claude auth status": ok(""), "which codex": missing() });
    expect(await detectAgents(run)).toEqual([
      { id: "claude", name: "Claude Code", installed: true, signedIn: true, path: "/usr/local/bin/claude", signIn: "claude auth login" },
      { id: "codex", name: "Codex", installed: false, signedIn: false, path: null, signIn: "codex login" },
    ]);
  });

  it("not signed in when the status command exits non-zero or times out", async () => {
    const run = fakeRunner({
      "which claude": ok("/a/claude\n"), "claude auth status": fail(1),
      "which codex": ok("/a/codex\nother\n"), "codex login status": missing(),
    });
    const [claude, codex] = await detectAgents(run);
    expect(claude).toMatchObject({ installed: true, signedIn: false, path: "/a/claude" });
    expect(codex).toMatchObject({ installed: true, signedIn: false, path: "/a/codex" });
  });

  it("does not run the status command for a missing agent", async () => {
    const run = fakeRunner({});
    await detectAgents(run);
    expect(run.calls).toEqual(["which claude", "which codex"]);
  });

  it("caches for 30 s per process", async () => {
    const run = fakeRunner({ "which claude": ok("/a/claude\n"), "claude auth status": ok() });
    await detectAgents(run);
    const n = run.calls.length;
    await detectAgents(run);
    expect(run.calls.length).toBe(n);
    clearDetectCache();
    await detectAgents(run);
    expect(run.calls.length).toBe(n * 2);
  });
});

describe("defaultRunner", () => {
  it("captures output and exit code, with no shell", async () => {
    const r = await defaultRunner(process.execPath, ["-e", "console.log('a b'); process.exit(3)"], { timeoutMs: 5000 });
    expect(r).toMatchObject({ code: 3, stdout: "a b\n" });
  });
  it("resolves code null for a missing command", async () => {
    expect(await defaultRunner("rushes-no-such-command-xyz", [], { timeoutMs: 5000 })).toEqual({ code: null, stdout: "", stderr: "" });
  });
  it("kills the child and resolves code null on timeout", async () => {
    const t = Date.now();
    const r = await defaultRunner(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], { timeoutMs: 200 });
    expect(r.code).toBeNull();
    expect(Date.now() - t).toBeLessThan(5000);
  });
});
