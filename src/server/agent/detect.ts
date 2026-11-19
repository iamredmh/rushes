import { AGENT_HELP } from "../../core/agentHelp.js";
import type { AgentId } from "../../core/schema.js";
import { findOnPath, killTree, spawnEnv, spawnProgram } from "./spawn.js";

export { searchPath } from "./spawn.js";
export { AGENT_HELP } from "../../core/agentHelp.js";

export type CommandRunner = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** Finds a program on the search path (§34: in Node, never `which`). */
export type Finder = (bin: string) => string | null;

const MAX_OUTPUT = 1024 * 1024;

/**
 * Runs a program with no shell (a Windows `.cmd` through cmd.exe, quoted by cross-spawn). A missing command, or one
 * that outlives the timeout (its tree is killed), resolves `code: null`.
 */
export const defaultRunner: CommandRunner = (cmd, args, { timeoutMs }) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r: { code: number | null; stdout: string; stderr: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawnProgram>;
    try {
      child = spawnProgram(cmd, args, { env: spawnEnv(), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    } catch {
      return resolve({ code: null, stdout: "", stderr: "" });
    }
    const timer = setTimeout(() => {
      killTree(child, "SIGKILL");
      finish({ code: null, stdout: "", stderr: "" });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });
    child.on("error", () => finish({ code: null, stdout: "", stderr: "" }));
    child.on("close", (code) => finish({ code: typeof code === "number" ? code : null, stdout, stderr }));
  });

export interface AgentInfo {
  id: AgentId;
  name: "Claude Code" | "Codex";
  installed: boolean;
  signedIn: boolean;
  path: string | null;
  /** The command to type in a terminal to sign in. */
  signIn: string;
  /** §34: what `--version` printed (x.y.z), or null when it couldn't be read. */
  version?: string | null;
  /** §34: installed, but older than the tested minimum: Send refuses it until it's updated. */
  outdated?: boolean;
  /** §34: the detect route adds whether its connector is downloaded (connectors.ts). */
  connector?: { state: "ready" | "fetching" | "missing" | "failed"; error?: string };
}

const TIMEOUT_MS = 5000;
const CACHE_MS = 30_000;

const SPECS: { id: AgentId; name: AgentInfo["name"]; bin: string; status: string[]; signIn: string }[] = [
  { id: "claude", name: "Claude Code", bin: "claude", status: ["auth", "status"], signIn: "claude auth login" },
  { id: "codex", name: "Codex", bin: "codex", status: ["login", "status"], signIn: "codex login" },
];

/** The first x.y.z in a `--version` line ("2.1.328 (Claude Code)", "codex-cli 0.163.0"), or null. */
export function parseVersion(text: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

/** a < b, comparing x.y.z numerically. */
export function olderThan(a: string, b: string): boolean {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

let cache: { at: number; value: AgentInfo[] } | null = null;
/** Forget the 30 s cache (tests, and after the user signs in). */
export function clearDetectCache(): void { cache = null; }

async function detectOne(spec: (typeof SPECS)[number], run: CommandRunner, find: Finder): Promise<AgentInfo> {
  const path = find(spec.bin);
  if (!path) return { id: spec.id, name: spec.name, installed: false, signedIn: false, path: null, signIn: spec.signIn, version: null, outdated: false };
  // The resolved path, never the bare name: on Windows that is a .cmd, which only runs through cmd.exe.
  const [status, ver] = await Promise.all([run(path, spec.status, { timeoutMs: TIMEOUT_MS }), run(path, ["--version"], { timeoutMs: TIMEOUT_MS })]);
  const version = ver.code === 0 ? parseVersion(ver.stdout + ver.stderr) : null;
  // A version that couldn't be read is not called outdated on a guess.
  const outdated = version !== null && olderThan(version, AGENT_HELP[spec.id].min);
  return { id: spec.id, name: spec.name, installed: true, signedIn: status.code === 0, path, signIn: spec.signIn, version, outdated };
}

/** Which agents are installed and signed in on this computer. Signed in = the status command exits 0. */
export async function detectAgents(run: CommandRunner = defaultRunner, find: Finder = (bin) => findOnPath(bin)): Promise<AgentInfo[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = await Promise.all(SPECS.map((s) => detectOne(s, run, find)));
  cache = { at: Date.now(), value };
  return value;
}
