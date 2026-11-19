// §34 smoke test, on every OS CI runs (macOS, Linux, Windows): a fake `claude` and `codex` on PATH, installed the way npm
// installs them (a .cmd on Windows, an executable script elsewhere), in a folder whose name has a space. Detection must
// find them in Node, run their status and version checks, and a .cmd-launched adapter must answer an ACP handshake.
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AcpConnection } from "../../../src/server/agent/acp.js";
import { clearDetectCache, defaultRunner, detectAgents } from "../../../src/server/agent/detect.js";
import { findOnPath } from "../../../src/server/agent/spawn.js";

const FAKE_ACP = resolve(__dirname, "../../helpers/fake-acp.mjs");
const win = process.platform === "win32";
let dir: string;
let oldPath: string | undefined;
const pathKey = win ? (Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "Path") : "PATH";

/** A program on PATH that runs `node <script>` with its arguments, as npm's shims do. */
async function shim(name: string, script: string): Promise<string> {
  const js = join(dir, `${name}.js`);
  await writeFile(js, script);
  if (win) {
    const file = join(dir, `${name}.cmd`);
    await writeFile(file, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
    return file;
  }
  const file = join(dir, name);
  await writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  await chmod(file, 0o755);
  return file;
}

// Answers --version, and the status check (exit 0 = signed in); echoes its arguments otherwise.
const CLI = (version: string) => `
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }
if (a.join(" ") === "auth status" || a.join(" ") === "login status") process.exit(0);
console.log(JSON.stringify(a));
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "rushes smoke "));
  await shim("claude", CLI("2.1.328 (Claude Code)"));
  await shim("codex", CLI("codex-cli 0.170.0"));
  await shim("fake-adapter", `await import(${JSON.stringify(new URL(`file:///${FAKE_ACP.replace(/\\/g, "/")}`).href)});`);
  await writeFile(join(dir, "scenario.json"), JSON.stringify({ modes: ["default", "read-only"], turns: [] }));
  oldPath = process.env[pathKey];
  process.env[pathKey] = dir;
  clearDetectCache();
});
afterAll(async () => {
  process.env[pathKey] = oldPath;
  clearDetectCache();
  await rm(dir, { recursive: true, force: true });
});

describe("§34 smoke: a fake claude and codex on PATH", () => {
  it("detection finds both in Node, signed in, with their versions", { timeout: 30_000 }, async () => {
    const [claude, codex] = await detectAgents();
    expect(claude).toMatchObject({ installed: true, signedIn: true, version: "2.1.328", outdated: false });
    expect(codex).toMatchObject({ installed: true, signedIn: true, version: "0.170.0", outdated: false });
    expect(claude.path).toBe(join(dir, win ? "claude.cmd" : "claude"));
  });

  it("arguments with spaces and cmd's own characters arrive intact through the shim", { timeout: 30_000 }, async () => {
    const r = await defaultRunner(findOnPath("claude")!, ["a b", "x&y", "50%", 'q"t', "^"], { timeoutMs: 20_000 });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual(["a b", "x&y", "50%", 'q"t', "^"]);
  });

  it("an adapter started through a shim answers initialize and session/new, and Stop ends it", { timeout: 30_000 }, async () => {
    const c = AcpConnection.start({ command: findOnPath("fake-adapter")!, args: [], env: { FAKE_ACP_SCENARIO: join(dir, "scenario.json") }, cwd: dir });
    const exited = new Promise<void>((r) => c.once("exit", () => r()));
    try {
      await c.initialize();
      const s = await c.newSession(dir, []);
      expect(s.modes).toEqual(["default", "read-only"]);
    } finally {
      c.kill();
    }
    await exited;
    expect(c.hasExited).toBe(true);
  });
});
