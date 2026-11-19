// §34: the ACP adapters ("connectors") are fetched once, ahead of time, into the user's cache folder, never at Send time.
// Installed with --omit=optional, so the native agent each adapter bundles (about 350 MB each) is left out: the adapter
// runs the user's own claude or codex instead (CLAUDE_CODE_EXECUTABLE, CODEX_PATH). Run from the cache folder with the
// npm that came with this Node, so a project's own .npmrc can't send the download elsewhere.
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { renameRetry } from "../../core/fsRetry.js";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AgentId } from "../../core/schema.js";
import { findOnPath, npmCliScript, spawnEnv, spawnProgram } from "./spawn.js";

/*
 * Checked 17 Nov 2026 with `npm view <pkg> version`:
 *   @agentclientprotocol/claude-agent-acp 0.107.3   (used; engines node >=22)
 *   @agentclientprotocol/codex-acp        2.7.0     (used)
 *   older names, not used: @zed-industries/claude-code-acp 0.16.2, @zed-industries/claude-agent-acp 0.23.1,
 *                          @zed-industries/codex-acp 0.16.0
 * The Claude adapter's README says to set CLAUDE_CODE_EXECUTABLE to use a Claude CLI you already have.
 * The Codex adapter's README names CODEX_PATH for the same purpose.
 * §34, checked 19 Nov 2026 on the Mac mini: installed with --omit=optional (77 MB and 21 MB, against about 700 MB with the
 * bundled agents), both start, open a session and answer a prompt with the user's own claude 2.1.328 and codex 0.163.0.
 */
export const ADAPTERS: Record<AgentId, { pkg: string; version: string }> = {
  claude: { pkg: "@agentclientprotocol/claude-agent-acp", version: "0.107.3" },
  codex: { pkg: "@agentclientprotocol/codex-acp", version: "2.7.0" },
};

/** How long one fetch may take before it's given up (a slow link, a proxy that never answers). */
export const FETCH_MS = 15 * 60_000;

/** The user's cache folder for Rushes: $XDG_CACHE_HOME/rushes, else the platform's own. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const x = env.XDG_CACHE_HOME;
  if (x && isAbsolute(x)) return join(x, "rushes");
  if (platform === "darwin") return join(home, "Library", "Caches", "rushes");
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "rushes", "Cache");
  return join(home, ".cache", "rushes");
}

/** This adapter version's own folder. */
export function connectorDir(agent: AgentId, base = cacheDir()): string {
  return join(base, "connectors", `${agent}-${ADAPTERS[agent].version}`);
}

/** Written last, after the install: a folder without it is never used. */
const READY = ".rushes-ready";

/** The adapter's JS entry (its package's bin), when its folder is complete. */
export function connectorEntry(agent: AgentId, base = cacheDir()): string | null {
  const dir = connectorDir(agent, base);
  const pkgDir = join(dir, "node_modules", ...ADAPTERS[agent].pkg.split("/"));
  try {
    readFileSync(join(dir, READY));
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin ? Object.values(pkg.bin)[0] : undefined;
    return bin ? join(pkgDir, bin) : null;
  } catch {
    return null;
  }
}

export type ConnectorState = "ready" | "fetching" | "missing" | "failed";
export interface ConnectorStatus {
  state: ConnectorState;
  /** Why the last fetch failed, in plain words. */
  error?: string;
}

/** How a fetch runs npm. Tests inject a fake. */
export type NpmRunner = (args: string[], cwd: string) => Promise<{ code: number | null; out: string }>;

/** npm from this Node (`node npm-cli.js`), else `npm` on the search path. Output kept for the error message. */
export const defaultNpm: NpmRunner = (args, cwd) =>
  new Promise((resolve) => {
    const script = npmCliScript();
    const file = script ? process.execPath : findOnPath("npm");
    if (!file) return resolve({ code: null, out: "npm isn't installed with this Node" });
    const child = spawnProgram(file, script ? [script, ...args] : args, { cwd, env: spawnEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    const keep = (d: Buffer) => { out = (out + d.toString()).slice(-8192); };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGKILL"), FETCH_MS);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, out: e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });

/** The last line of npm's output that says what went wrong, for the desk. */
function npmError(out: string): string {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const err = lines.filter((l) => /^npm (error|ERR!)/.test(l)).map((l) => l.replace(/^npm (error|ERR!)\s*/, ""));
  return (err.find((l) => /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|network|proxy|E404|EACCES|ENOSPC/i.test(l)) ?? err[0] ?? lines.at(-1) ?? "npm failed").slice(0, 300);
}

let pending = new Map<string, Promise<string>>();
let failures = new Map<string, string>();

/** Forget fetches in flight and past failures (tests). */
export function resetConnectors(): void {
  pending = new Map();
  failures = new Map();
}

export function connectorStatus(agent: AgentId, base = cacheDir()): ConnectorStatus {
  const dir = connectorDir(agent, base);
  if (connectorEntry(agent, base)) return { state: "ready" };
  if (pending.has(dir)) return { state: "fetching" };
  const error = failures.get(dir);
  return error ? { state: "failed", error } : { state: "missing" };
}

/**
 * The adapter's entry, fetching it first when it isn't there. One fetch per adapter version at a time: a second call
 * waits for the first. Rejects with plain words when npm fails; the next call tries again.
 */
export function ensureConnector(agent: AgentId, o: { base?: string; npm?: NpmRunner; onStart?: () => void } = {}): Promise<string> {
  const base = o.base ?? cacheDir();
  const ready = connectorEntry(agent, base);
  if (ready) return Promise.resolve(ready);
  const dir = connectorDir(agent, base);
  const running = pending.get(dir);
  if (running) return running;
  o.onStart?.();
  const job = fetchConnector(agent, base, o.npm ?? defaultNpm).finally(() => pending.delete(dir));
  pending.set(dir, job);
  failures.delete(dir);
  job.catch((e: Error) => failures.set(dir, e.message));
  return job;
}

async function fetchConnector(agent: AgentId, base: string, npm: NpmRunner): Promise<string> {
  const { pkg, version } = ADAPTERS[agent];
  const dir = connectorDir(agent, base);
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(tmp, { recursive: true });
  // A package.json of its own, so npm treats the folder as the project and never climbs to a parent's.
  await writeFile(join(tmp, "package.json"), JSON.stringify({ name: "rushes-connector", private: true }) + "\n");
  try {
    const r = await npm(
      ["install", "--no-save", "--no-package-lock", "--no-audit", "--no-fund", "--omit=optional", "--omit=dev", "--ignore-scripts", "--loglevel=error", "--prefix", tmp, `${pkg}@${version}`],
      tmp,
    );
    if (r.code !== 0) throw new Error(`Couldn't download the ${agent === "claude" ? "Claude Code" : "Codex"} connector: ${npmError(r.out)}`);
    await writeFile(join(tmp, READY), `${pkg}@${version}\n`);
    // Another desk on this computer may have finished the same fetch meanwhile: keep its folder.
    if (connectorEntry(agent, base)) {
      await rm(tmp, { recursive: true, force: true });
    } else {
      await rm(dir, { recursive: true, force: true });
      try {
        await renameRetry(tmp, dir);
      } catch (e) {
        if (!connectorEntry(agent, base)) throw e;
        await rm(tmp, { recursive: true, force: true });
      }
    }
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  const entry = connectorEntry(agent, base);
  if (!entry) throw new Error(`The ${agent === "claude" ? "Claude Code" : "Codex"} connector downloaded but its start file is missing`);
  return entry;
}

export { renameRetry } from "../../core/fsRetry.js";

/** Reads the marker (the doctor shows which version is ready). */
export async function connectorVersion(agent: AgentId, base = cacheDir()): Promise<string | null> {
  try {
    return (await readFile(join(connectorDir(agent, base), READY), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

/**
 * §34: fetches the connector of every installed agent in the background, so the first Send never waits on a download.
 * The desk server calls it once it is listening. Never under the test runner (NODE_ENV=test), which would reach npm.
 */
export async function prepareConnectors(
  detect: () => Promise<{ id: AgentId; installed: boolean }[]>,
  o: { env?: NodeJS.ProcessEnv; ensure?: (agent: AgentId) => Promise<string>; log?: (line: string) => void } = {},
): Promise<void> {
  const env = o.env ?? process.env;
  if (env.NODE_ENV === "test" && env.RUSHES_FETCH_CONNECTORS !== "1") return;
  const ensure = o.ensure ?? ((a: AgentId) => ensureConnector(a));
  const log = o.log ?? ((l: string) => console.error(l));
  let agents: { id: AgentId; installed: boolean }[];
  try {
    agents = await detect();
  } catch {
    return;
  }
  await Promise.all(
    agents
      .filter((a) => a.installed)
      .map((a) => ensure(a.id).then(() => undefined, (e: Error) => log(`Rushes: ${e.message}. Send to AI tries again on the next Send.`))),
  );
}
