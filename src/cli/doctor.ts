import { access, readFile, statfs as nodeStatfs } from "node:fs/promises";
import { join } from "node:path";
import { RUSHES_DIR, Store } from "../core/store.js";
import { FILES, type FileKey } from "../core/schema.js";
import { harnesses, mcpLaunch, mergeJson, mergeToml, type Harness } from "../setup/harnesses.js";
import { realSetupEnv } from "../setup/env.js";
import type { SetupEnv } from "../setup/setup.js";
import { canonicalRoot } from "../server/lock.js";
import { hasFpsMode, parseFfmpegVersion } from "../server/proxy.js";

// §19.3: `rushes doctor` and the `rushes_doctor` MCP tool. Read-only: every check only looks,
// it never writes a config, starts a server or changes a project file.

export interface Check {
  id: string;
  ok: boolean;
  /** A failing required check makes the CLI exit non-zero. ffmpeg, agents and the server are recommended, not required. */
  required: boolean;
  label: string;
  detail: string;
  /** A plain instruction to fix it, shown when `ok` is false. */
  fix?: string;
}

/**
 * What `runDoctor` needs from the world, so tests can fake a Node version, PATH and home folder
 * without touching the real machine. Shares `which`/`exec`/`home`/`platform`/`appData` with
 * `setup`'s `SetupEnv`, since both query the same harnesses -- `realDoctorEnv` is `realSetupEnv`
 * plus the extra bits doctor needs.
 */
export interface DoctorEnv extends SetupEnv {
  /** `process.version`, e.g. "v22.12.0". */
  nodeVersion: string;
  /** The project folder to check (where ".rushes" would live). */
  cwd: string;
  /** Free bytes available at `path`, or null when it can't be read. Defaults to `fs.statfs`. */
  statfs(path: string): Promise<{ free: number } | null>;
}

export function realDoctorEnv(cwd: string): DoctorEnv {
  return {
    ...realSetupEnv(),
    nodeVersion: process.version,
    cwd,
    statfs: async (path) => {
      try {
        const s = await nodeStatfs(path);
        return { free: s.bavail * s.bsize };
      } catch {
        return null;
      }
    },
  };
}

const exists = (p: string) => access(p).then(() => true, () => false);

/** "v22.12.0" -> {major: 22, minor: 12}. Null for anything that doesn't start with a version. */
function parseNodeVersion(v: string): { major: number; minor: number } | null {
  const m = /^v?(\d+)\.(\d+)/.exec(v);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/** Matches package.json's engines field exactly: "^20.19.0 || >=22.12.0" (21.x is not supported). */
function nodeSupported(major: number, minor: number): boolean {
  return (major === 20 && minor >= 19) || major > 22 || (major === 22 && minor >= 12);
}

function nodeCheck(env: DoctorEnv): Check {
  const v = parseNodeVersion(env.nodeVersion);
  const ok = v !== null && nodeSupported(v.major, v.minor);
  return {
    id: "node",
    label: "Node.js",
    ok,
    required: true,
    detail: ok ? `${env.nodeVersion} is supported.` : `${env.nodeVersion} is too old. Rushes needs Node 20.19 or newer (or 22.12+ on the 22 line).`,
    fix: ok ? undefined : "Install a current Node LTS: https://nodejs.org, or with nvm: nvm install --lts",
  };
}

/** Plain install instructions by platform (global constraint: ffmpeg degrades gracefully, with a plain message). */
const FFMPEG_INSTALL: Record<string, string> = {
  darwin: "brew install ffmpeg",
  win32: "winget install Gyan.FFmpeg",
  linux: "sudo apt install ffmpeg, or your distribution's package manager",
};

function installFix(platform: NodeJS.Platform): string {
  return FFMPEG_INSTALL[platform] ?? FFMPEG_INSTALL.linux;
}

async function ffmpegCheck(env: DoctorEnv): Promise<Check> {
  if (!(await env.which("ffmpeg"))) {
    return {
      id: "ffmpeg",
      label: "ffmpeg",
      ok: false,
      required: false,
      detail: "ffmpeg isn't on PATH. Proxies and full-quality frame grabs need it.",
      fix: installFix(env.platform),
    };
  }
  let out = "";
  try {
    out = (await env.exec("ffmpeg", ["-version"], env.cwd)).out;
  } catch {
    out = "";
  }
  const version = parseFfmpegVersion(out);
  // Controller ruling: ffmpeg below 5.1 still works (-vsync stands in for -fps_mode), so this is
  // a warning, not a failure.
  if (version && !hasFpsMode(version)) {
    return {
      id: "ffmpeg",
      label: "ffmpeg",
      ok: true,
      required: false,
      detail: `ffmpeg ${version.major}.${version.minor} works, but proxies use an older frame-rate option. Updating to 5.1 or newer is recommended.`,
    };
  }
  return {
    id: "ffmpeg",
    label: "ffmpeg",
    ok: true,
    required: false,
    detail: version ? `ffmpeg ${version.major}.${version.minor} is on PATH.` : "ffmpeg is on PATH.",
  };
}

/** "ffprobe version 6.1.1 Copyright ..." -> {major: 6, minor: 1}. Generic over the tool name, unlike parseFfmpegVersion. */
function parseToolVersion(text: string): { major: number; minor: number } | null {
  const m = /version n?(\d+)\.(\d+)/.exec(text);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

async function ffprobeCheck(env: DoctorEnv): Promise<Check> {
  if (!(await env.which("ffprobe"))) {
    return {
      id: "ffprobe",
      label: "ffprobe",
      ok: false,
      required: false,
      detail: "ffprobe isn't on PATH. It ships with ffmpeg.",
      fix: installFix(env.platform),
    };
  }
  let out = "";
  try {
    out = (await env.exec("ffprobe", ["-version"], env.cwd)).out;
  } catch {
    out = "";
  }
  const version = parseToolVersion(out);
  return { id: "ffprobe", label: "ffprobe", ok: true, required: false, detail: version ? `ffprobe ${version.major}.${version.minor} is on PATH.` : "ffprobe is on PATH." };
}

/** Is this harness installed at all (its marker folder exists, or its CLI is on PATH)? Mirrors setup.ts's own check, read-only. */
async function installed(h: Harness, env: DoctorEnv): Promise<boolean> {
  return (await exists(h.marker)) || (h.bin ? await env.which(h.bin) : false);
}

/** Whether `h` has the Rushes MCP server registered, without changing anything -- reuses setup's own mergers as a dry-run diff. */
async function harnessCheck(h: Harness, env: DoctorEnv): Promise<Check> {
  const base = { id: `agent:${h.id}`, label: h.name, required: false };
  if (h.kind === "claude-cli") {
    if (!(await env.which("claude"))) {
      return { ...base, ok: false, detail: "the claude command isn't on PATH, so registration can't be checked.", fix: `Install Claude Code, then run: rushes setup --only ${h.id}` };
    }
    // Run from home, like setup does, so a project's own .mcp.json can't make it look registered.
    const got = await env.exec("claude", ["mcp", "get", "rushes"], env.home);
    const ok = got.code === 0;
    return { ...base, ok, detail: ok ? "the Rushes MCP server is registered." : "the Rushes MCP server isn't registered.", fix: ok ? undefined : `rushes setup --only ${h.id}` };
  }
  const path = h.config!;
  const text = await readFile(path, "utf8").catch(() => null);
  try {
    const launch = mcpLaunch(env.platform);
    const { changed } = h.kind === "toml" ? mergeToml(text, launch) : mergeJson(text, launch);
    const ok = !changed;
    return { ...base, ok, detail: ok ? "the Rushes MCP server is registered." : "the Rushes MCP server isn't registered.", fix: ok ? undefined : `rushes setup --only ${h.id}` };
  } catch {
    return { ...base, ok: false, detail: `${path} exists but isn't valid, so registration can't be checked.`, fix: `Fix ${path}, then run: rushes setup --only ${h.id}` };
  }
}

/**
 * Whether a Rushes server is running for this folder: a health request to its port, checked
 * against this project's own canonical root (the same check `isRushesFor` in server/lock.ts
 * makes), falling back to a pid check when nothing answers. A server answering for a *different*
 * project is reported as a failure -- a stale server.json left behind when the project moved or
 * its folder was reused -- everything else here is informational.
 */
async function serverCheck(cwd: string): Promise<Check> {
  const base = { id: "server", label: "Rushes server", required: false };
  let lock: { port?: unknown; pid?: unknown } | null = null;
  try {
    lock = JSON.parse(await readFile(join(cwd, RUSHES_DIR, "server.json"), "utf8"));
  } catch {
    lock = null;
  }
  if (!lock || typeof lock.port !== "number" || typeof lock.pid !== "number") {
    return { ...base, ok: true, detail: "No server is running for this folder." };
  }
  const { port, pid } = lock as { port: number; pid: number };
  const root = await canonicalRoot(cwd);
  type Health = { app?: string; id?: string; root?: string };
  let health: Health | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    if (res.ok) health = (await res.json()) as Health;
  } catch {
    health = null; // The port didn't answer in time; fall back to a pid check below.
  }
  if (health?.app === "rushes") {
    if (health.root !== root) {
      return {
        ...base,
        ok: false,
        detail: `server.json points at another project's server (port ${port}).`,
        fix: "Run rushes stop here, then rushes open",
      };
    }
    return { ...base, ok: true, detail: `running on port ${port}${health.id ? `, project ${health.id}` : ""}.` };
  }
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  return { ...base, ok: true, detail: alive ? `running on port ${port}.` : `not running (a stale lock names pid ${pid}; it clears on the next start).` };
}

/** Free space where proxies live, only reported when a proxies/ folder exists. */
async function diskSpaceCheck(env: DoctorEnv): Promise<Check | null> {
  const dir = join(env.cwd, "proxies");
  if (!(await exists(dir))) return null;
  const info = await env.statfs(dir);
  if (!info) return null;
  const gb = info.free / 1e9;
  const ok = gb >= 1;
  return {
    id: "disk",
    label: "Disk space",
    ok,
    required: false,
    detail: `${gb.toFixed(1)} GB free where proxies are stored.`,
    fix: ok ? undefined : "Free up disk space before rendering more proxies.",
  };
}

/**
 * Every doctor check, in order: Node, ffmpeg, ffprobe, which agent harnesses have Rushes
 * registered, then this project's own state (files, server, disk). Outside a project folder
 * (Review Focus 5), the project checks collapse into one line saying so, read: true, required:
 * false -- the environment checks above it still run in full.
 */
export async function runDoctor(env: DoctorEnv): Promise<Check[]> {
  const checks: Check[] = [nodeCheck(env), await ffmpegCheck(env), await ffprobeCheck(env)];

  const all = harnesses(env.home, env.platform, env.appData);
  const present: Harness[] = [];
  for (const h of all) if (await installed(h, env)) present.push(h);
  if (!present.length) {
    checks.push({ id: "agents", label: "Agent harnesses", ok: true, required: false, detail: "No supported agent harness found on this machine." });
  } else {
    const harnessChecks: Check[] = [];
    for (const h of present) harnessChecks.push(await harnessCheck(h, env));
    checks.push(...harnessChecks);
    // Controller ruling: when every installed harness is unregistered, say so once in plain words
    // rather than making the reader infer it from a run of individual crosses.
    if (harnessChecks.every((c) => !c.ok)) {
      checks.push({ id: "agents", label: "Agent harnesses", ok: false, required: false, detail: "No agent has Rushes yet.", fix: "Run rushes setup" });
    }
  }

  if (!(await exists(join(env.cwd, RUSHES_DIR)))) {
    checks.push({ id: "project", label: "Rushes project", ok: true, required: false, detail: "No Rushes project in this folder." });
    return checks;
  }

  const store = new Store(env.cwd);
  for (const key of Object.keys(FILES) as FileKey[]) {
    const name = FILES[key].name;
    try {
      await store.read(key);
      checks.push({ id: `file:${key}`, label: name, ok: true, required: true, detail: "valid." });
    } catch (e) {
      checks.push({ id: `file:${key}`, label: name, ok: false, required: true, detail: (e as Error).message, fix: `Fix or restore ${name}, or delete the ${RUSHES_DIR} folder and run rushes init to start over.` });
    }
  }

  checks.push(await serverCheck(env.cwd));
  const disk = await diskSpaceCheck(env);
  if (disk) checks.push(disk);
  return checks;
}
