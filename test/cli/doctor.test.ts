import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { runDoctor, realDoctorEnv, type DoctorEnv } from "../../src/cli/doctor.js";
import { main, type Io } from "../../src/cli/main.js";
import { startServer } from "../../src/server/start.js";
import { lockPath } from "../../src/server/lock.js";
import { RUSHES_DIR } from "../../src/core/store.js";

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }); });

async function tmpHome() {
  const home = await mkdtemp(join(tmpdir(), "rushes doctor home "));
  dirs.push(home);
  return home;
}

/** A DoctorEnv with nothing installed: no agent harnesses, no ffmpeg, a fresh home, in `cwd`. Overridden per test. */
function fakeEnv(cwd: string, home: string, overrides: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    nodeVersion: "v22.12.0",
    platform: "darwin",
    home,
    appData: join(home, "AppData", "Roaming"),
    cwd,
    which: async () => false,
    exec: async () => ({ code: 1, out: "" }),
    statfs: async () => null,
    ...overrides,
  };
}

function find(checks: Awaited<ReturnType<typeof runDoctor>>, id: string) {
  return checks.find((c) => c.id === id);
}

describe("runDoctor", () => {
  it("fails Node 18 with a fix, and passes a supported version", async () => {
    const home = await tmpHome();
    const old = await runDoctor(fakeEnv(home, home, { nodeVersion: "v18.19.0" }));
    expect(find(old, "node")).toMatchObject({ ok: false, required: true });
    expect(find(old, "node")!.detail).toContain("v18.19.0");
    expect(find(old, "node")!.fix).toBeTruthy();

    const current = await runDoctor(fakeEnv(home, home, { nodeVersion: "v22.12.0" }));
    expect(find(current, "node")).toMatchObject({ ok: true, required: true });

    const lts = await runDoctor(fakeEnv(home, home, { nodeVersion: "v20.19.1" }));
    expect(find(lts, "node")).toMatchObject({ ok: true, required: true });

    // 21.x is between the two supported lines and isn't covered by engines.
    const between = await runDoctor(fakeEnv(home, home, { nodeVersion: "v21.5.0" }));
    expect(find(between, "node")).toMatchObject({ ok: false, required: true });
  });

  it("missing ffmpeg is not required, with an install fix per platform", async () => {
    const home = await tmpHome();
    for (const [platform, fix] of [
      ["darwin", "brew install ffmpeg"],
      ["win32", "winget install Gyan.FFmpeg"],
      ["linux", "sudo apt install ffmpeg"],
    ] as const) {
      const checks = await runDoctor(fakeEnv(home, home, { platform }));
      const ffmpeg = find(checks, "ffmpeg")!;
      expect(ffmpeg.ok).toBe(false);
      expect(ffmpeg.required).toBe(false);
      expect(ffmpeg.fix).toContain(fix);
      const ffprobe = find(checks, "ffprobe")!;
      expect(ffprobe.ok).toBe(false);
      expect(ffprobe.required).toBe(false);
    }
  });

  it("ffmpeg below 5.1 passes with a warning about the frame-rate option", async () => {
    const home = await tmpHome();
    const env = fakeEnv(home, home, {
      which: async (cmd) => cmd === "ffmpeg" || cmd === "ffprobe",
      exec: async (cmd) => (cmd === "ffmpeg" ? { code: 0, out: "ffmpeg version 4.4.2-0ubuntu0 Copyright (c) 2000-2021\n" } : { code: 1, out: "" }),
    });
    const checks = await runDoctor(env);
    const ffmpeg = find(checks, "ffmpeg")!;
    expect(ffmpeg.ok).toBe(true);
    expect(ffmpeg.detail).toBe("ffmpeg 4.4 works, but proxies use an older frame-rate option. Updating to 5.1 or newer is recommended.");
    expect(find(checks, "ffprobe")).toMatchObject({ ok: true });
  });

  it("ffmpeg 5.1 and newer passes with no warning", async () => {
    const home = await tmpHome();
    const env = fakeEnv(home, home, {
      which: async (cmd) => cmd === "ffmpeg",
      exec: async () => ({ code: 0, out: "ffmpeg version 6.1.1 Copyright (c) 2000-2023\n" }),
    });
    const ffmpeg = find(await runDoctor(env), "ffmpeg")!;
    expect(ffmpeg).toMatchObject({ ok: true, detail: "ffmpeg 6.1 is on PATH." });
  });

  it("reports no agent harness found when nothing is installed", async () => {
    const home = await tmpHome();
    const checks = await runDoctor(fakeEnv(home, home));
    expect(find(checks, "agents")).toMatchObject({ ok: true, required: false });
    expect(checks.some((c) => c.id.startsWith("agent:"))).toBe(false);
  });

  it("reports an installed harness as registered or not, without changing its config", async () => {
    const home = await tmpHome();
    await mkdir(join(home, ".cursor"), { recursive: true });
    const configPath = join(home, ".cursor", "mcp.json");

    const unregistered = await runDoctor(fakeEnv(home, home));
    const before = find(unregistered, "agent:cursor")!;
    expect(before).toMatchObject({ ok: false, required: false, label: "Cursor" });
    expect(before.fix).toContain("rushes setup");
    await expect(rm(configPath)).rejects.toThrow(); // doctor never created it

    await writeFile(configPath, JSON.stringify({ mcpServers: { rushes: { command: "npx", args: ["-y", "github:iamredmh/rushes", "mcp"] } } }), "utf8");
    const beforeText = await readFile(configPath, "utf8");
    const registered = await runDoctor(fakeEnv(home, home));
    expect(find(registered, "agent:cursor")).toMatchObject({ ok: true, required: false });
    // doctor is read-only: the config is untouched.
    expect(await readFile(configPath, "utf8")).toBe(beforeText);
  });

  it("a corrupt notes.json fails that file check by name, other files still pass", async () => {
    const { root, store } = await tmpProject();
    await writeFile(store.path("notes"), "{ not json", "utf8");
    const home = await tmpHome();
    const checks = await runDoctor(fakeEnv(root, home));
    const notes = find(checks, "file:notes")!;
    expect(notes.ok).toBe(false);
    expect(notes.required).toBe(true);
    expect(notes.detail).toContain("notes.json");
    expect(find(checks, "file:project")).toMatchObject({ ok: true, required: true });
    expect(find(checks, "project")).toBeUndefined();
  });

  it("outside a project, the project checks collapse into one line and nothing else project-shaped runs", async () => {
    const empty = await mkdtemp(join(tmpdir(), "rushes doctor empty "));
    dirs.push(empty);
    const home = await tmpHome();
    const checks = await runDoctor(fakeEnv(empty, home));
    expect(find(checks, "project")).toEqual({ id: "project", label: "Rushes project", ok: true, required: false, detail: "No Rushes project in this folder." });
    expect(checks.some((c) => c.id.startsWith("file:"))).toBe(false);
    expect(find(checks, "server")).toBeUndefined();
    expect(find(checks, "disk")).toBeUndefined();
    // The environment checks above it still ran.
    expect(find(checks, "node")).toBeTruthy();
  });

  it("reports no server running when there's no lock, and alive with its project id when there is", async () => {
    const { root } = await tmpProject();
    const home = await tmpHome();
    const idle = await runDoctor(fakeEnv(root, home));
    expect(find(idle, "server")).toMatchObject({ ok: true, detail: "No server is running for this folder." });

    const s = await startServer(root, { port: 0 });
    const running = await runDoctor(fakeEnv(root, home));
    const server = find(running, "server")!;
    expect(server.ok).toBe(true);
    expect(server.detail).toMatch(/^running on port \d+, project [a-z2-9]{8}\.$/);
    await s.close();
  });

  it("reports a stale lock as not running, without crashing", async () => {
    const { root } = await tmpProject();
    const home = await tmpHome();
    await writeFile(lockPath(root), JSON.stringify({ port: 59999, pid: 999999999 }), "utf8");
    const checks = await runDoctor(fakeEnv(root, home));
    expect(find(checks, "server")).toMatchObject({ ok: true });
    expect(find(checks, "server")!.detail).toContain("not running");
  });

  it("reports disk space only when proxies/ exists, using the injected statfs", async () => {
    const { root } = await tmpProject();
    const home = await tmpHome();
    expect(find(await runDoctor(fakeEnv(root, home)), "disk")).toBeUndefined();

    await mkdir(join(root, "proxies"), { recursive: true });
    const roomy = await runDoctor(fakeEnv(root, home, { statfs: async () => ({ free: 5_000_000_000 }) }));
    expect(find(roomy, "disk")).toMatchObject({ ok: true, detail: "5.0 GB free where proxies are stored." });

    const tight = await runDoctor(fakeEnv(root, home, { statfs: async () => ({ free: 100_000_000 }) }));
    expect(find(tight, "disk")).toMatchObject({ ok: false, required: false });
    expect(find(tight, "disk")!.fix).toBeTruthy();
  });

  it("realDoctorEnv reads the real Node version and platform", () => {
    const env = realDoctorEnv(process.cwd());
    expect(env.nodeVersion).toBe(process.version);
    expect(env.platform).toBe(process.platform);
    expect(env.cwd).toBe(process.cwd());
  });
});

function io(cwd: string, doctorEnv?: DoctorEnv) {
  const out: string[] = [];
  const err: string[] = [];
  const x: Io = { out: (l) => out.push(l), err: (l) => err.push(l), cwd, doctorEnv };
  return { x, out, err };
}

describe("rushes doctor (CLI)", () => {
  it("prints a checkmark line per check, and 'Fix:' only on a failing one", async () => {
    const home = await tmpHome();
    const { root } = await tmpProject();
    const env = fakeEnv(root, home, { nodeVersion: "v18.0.0" });
    const a = io(root, env);
    const code = await main(["doctor"], a.x);
    expect(code).toBe(1); // Node is required and fails.
    const nodeLine = a.out.find((l) => l.includes("Node.js"))!;
    expect(nodeLine.startsWith("✗ Node.js — ")).toBe(true);
    expect(nodeLine).toContain("Fix: ");
    const ffmpegLine = a.out.find((l) => l.includes("ffmpeg —"))!;
    expect(ffmpegLine.startsWith("✗")).toBe(true); // not required, but still shown as a cross
  });

  it("--json prints an array that parses back to the same checks, and exits 0 when nothing required fails", async () => {
    const home = await tmpHome();
    const { root } = await tmpProject();
    const env = fakeEnv(root, home, { which: async (cmd) => cmd === "ffmpeg" || cmd === "ffprobe", exec: async () => ({ code: 0, out: "ffmpeg version 6.0 Copyright\n" }) });
    const a = io(root, env);
    const code = await main(["doctor", "--json"], a.x);
    expect(code).toBe(0);
    expect(a.out).toHaveLength(1);
    const parsed = JSON.parse(a.out[0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.find((c: any) => c.id === "node")).toMatchObject({ ok: true });
  });

  it("accepts a directory argument, like status", async () => {
    const home = await tmpHome();
    const { root } = await tmpProject();
    const a = io("/does/not/matter", fakeEnv(root, home));
    const code = await main(["doctor", root, "--json"], a.x);
    expect(code).toBe(0);
    const parsed = JSON.parse(a.out[0]);
    expect(parsed.find((c: any) => c.id === "file:project")).toMatchObject({ ok: true });
  });

  it("falls back to the real environment when no doctorEnv is injected", async () => {
    const empty = await mkdtemp(join(tmpdir(), "rushes doctor cli empty "));
    dirs.push(empty);
    const a = io(empty);
    const code = await main(["doctor", "--json"], a.x);
    const parsed = JSON.parse(a.out[0]);
    expect(parsed.find((c: any) => c.id === "project").detail).toBe("No Rushes project in this folder.");
    expect(code === 0 || code === 1).toBe(true);
  });
});
