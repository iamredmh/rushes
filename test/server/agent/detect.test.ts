import { beforeEach, describe, expect, it } from "vitest";
import { clearDetectCache, defaultRunner, detectAgents, olderThan, parseVersion, type CommandRunner } from "../../../src/server/agent/detect.js";

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

const finder = (table: Record<string, string>) => (bin: string) => table[bin] ?? null;

describe("detectAgents", () => {
  it("signed in when installed and the status command exits 0, with its version", async () => {
    const run = fakeRunner({ "/usr/local/bin/claude auth status": ok(""), "/usr/local/bin/claude --version": ok("2.1.328 (Claude Code)\n") });
    expect(await detectAgents(run, finder({ claude: "/usr/local/bin/claude" }))).toEqual([
      { id: "claude", name: "Claude Code", installed: true, signedIn: true, path: "/usr/local/bin/claude", signIn: "claude auth login", version: "2.1.328", outdated: false },
      { id: "codex", name: "Codex", installed: false, signedIn: false, path: null, signIn: "codex login", version: null, outdated: false },
    ]);
  });

  it("not signed in when the status command exits non-zero or times out", async () => {
    const run = fakeRunner({ "/a/claude auth status": fail(1), "/a/codex login status": missing() });
    const [claude, codex] = await detectAgents(run, finder({ claude: "/a/claude", codex: "/a/codex" }));
    expect(claude).toMatchObject({ installed: true, signedIn: false, path: "/a/claude" });
    expect(codex).toMatchObject({ installed: true, signedIn: false, path: "/a/codex" });
  });

  it("runs the resolved path, never the bare name or which (§34: on Windows that is a .cmd)", async () => {
    const run = fakeRunner({});
    await detectAgents(run, finder({ claude: "C:\\Users\\Red\\AppData\\Roaming\\npm\\claude.cmd" }));
    expect(run.calls.every((c) => c.startsWith("C:\\Users\\Red\\AppData\\Roaming\\npm\\claude.cmd "))).toBe(true);
    expect(run.calls.some((c) => c.startsWith("which"))).toBe(false);
  });

  it("does not run anything for a missing agent", async () => {
    const run = fakeRunner({});
    await detectAgents(run, finder({}));
    expect(run.calls).toEqual([]);
  });

  it("§34: outdated below the tested minimum, never on a version it couldn't read", async () => {
    const run = fakeRunner({
      "/a/claude auth status": ok(), "/a/claude --version": ok("1.0.44 (Claude Code)"),
      "/a/codex login status": ok(), "/a/codex --version": ok("codex-cli 0.163.0"),
    });
    const [claude, codex] = await detectAgents(run, finder({ claude: "/a/claude", codex: "/a/codex" }));
    expect(claude).toMatchObject({ version: "1.0.44", outdated: true });
    expect(codex).toMatchObject({ version: "0.163.0", outdated: false });
    clearDetectCache();
    const unread = await detectAgents(fakeRunner({ "/a/claude auth status": ok(), "/a/claude --version": ok("weird") }), finder({ claude: "/a/claude" }));
    expect(unread[0]).toMatchObject({ version: null, outdated: false, signedIn: true });
  });

  it("caches for 30 s per process", async () => {
    const run = fakeRunner({ "/a/claude auth status": ok() });
    const find = finder({ claude: "/a/claude" });
    await detectAgents(run, find);
    const n = run.calls.length;
    await detectAgents(run, find);
    expect(run.calls.length).toBe(n);
    clearDetectCache();
    await detectAgents(run, find);
    expect(run.calls.length).toBe(n * 2);
  });
});

describe("§34: versions", () => {
  it("reads the first x.y.z and compares numerically", () => {
    expect(parseVersion("2.1.328 (Claude Code)")).toBe("2.1.328");
    expect(parseVersion("codex-cli 0.163.0")).toBe("0.163.0");
    expect(parseVersion("none")).toBeNull();
    expect(olderThan("0.99.0", "0.163.0")).toBe(true);
    expect(olderThan("2.0.0", "2.0.0")).toBe(false);
    expect(olderThan("10.0.0", "9.9.9")).toBe(false);
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
