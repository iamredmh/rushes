import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { AgentId } from "../../core/schema.js";

export type CommandRunner = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** The user's PATH plus the usual install folders, which a server started from a desktop shortcut may lack. */
export function searchPath(): string {
  const parts = [...(process.env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin")];
  return [...new Set(parts.filter(Boolean))].join(delimiter);
}

/** execFile (never a shell). A missing command, or one that outlives the timeout (killed), resolves `code: null`. */
export const defaultRunner: CommandRunner = (cmd, args, { timeoutMs }) =>
  new Promise((resolve) => {
    execFile(
      cmd, args,
      { timeout: timeoutMs, env: { ...process.env, PATH: searchPath() }, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        const e = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        if (!e) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
        if (e.killed || typeof e.code !== "number") return resolve({ code: null, stdout: "", stderr: "" });
        resolve({ code: e.code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

export interface AgentInfo {
  id: AgentId;
  name: "Claude Code" | "Codex";
  installed: boolean;
  signedIn: boolean;
  path: string | null;
  /** The command to type in Terminal to sign in. */
  signIn: string;
}

const TIMEOUT_MS = 5000;
const CACHE_MS = 30_000;

const SPECS: { id: AgentId; name: AgentInfo["name"]; bin: string; status: string[]; signIn: string }[] = [
  { id: "claude", name: "Claude Code", bin: "claude", status: ["auth", "status"], signIn: "claude auth login" },
  { id: "codex", name: "Codex", bin: "codex", status: ["login", "status"], signIn: "codex login" },
];

let cache: { at: number; value: AgentInfo[] } | null = null;
/** Forget the 30 s cache (tests, and after the user signs in). */
export function clearDetectCache(): void { cache = null; }

async function detectOne(spec: (typeof SPECS)[number], run: CommandRunner): Promise<AgentInfo> {
  const which = await run("which", [spec.bin], { timeoutMs: TIMEOUT_MS });
  const path = which.code === 0 ? (which.stdout.split("\n")[0] ?? "").trim() : "";
  if (!path) return { id: spec.id, name: spec.name, installed: false, signedIn: false, path: null, signIn: spec.signIn };
  const status = await run(spec.bin, spec.status, { timeoutMs: TIMEOUT_MS });
  return { id: spec.id, name: spec.name, installed: true, signedIn: status.code === 0, path, signIn: spec.signIn };
}

/** Which agents are installed and signed in on this Mac. Signed in = the status command exits 0. */
export async function detectAgents(run: CommandRunner = defaultRunner): Promise<AgentInfo[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = await Promise.all(SPECS.map((s) => detectOne(s, run)));
  cache = { at: Date.now(), value };
  return value;
}
