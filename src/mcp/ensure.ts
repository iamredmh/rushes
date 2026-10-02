import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalRoot, isRushesFor, readLock } from "../server/lock.js";
import { RushesClient } from "./client.js";
import { SOURCE } from "../setup/harnesses.js";
import { RUSHES_DIR } from "../core/store.js";

/** URL of a live Rushes server for exactly this project root, or null. */
export async function findServer(rootDir: string): Promise<string | null> {
  const root = await canonicalRoot(rootDir);
  const lock = await readLock(root);
  if (!lock) return null;
  // A reused port or pid can point at something else, so check it's ours.
  return (await isRushesFor(lock.port, root)) ? `http://127.0.0.1:${lock.port}` : null;
}

export interface EnsureOptions {
  /** Command that starts a server in the foreground, given the project root. Defaults to this package's CLI. */
  spawnServer?: (root: string) => void;
  timeoutMs?: number;
}

/** Background servers started for an agent stop after this long with nothing connected. */
export const BACKGROUND_IDLE_MINUTES = 120;

/** Where a background server's output goes, so a failed start leaves evidence. */
export function serverLogPath(root: string): string {
  return join(root, RUSHES_DIR, "server.log");
}

function defaultSpawn(root: string): void {
  const cli = fileURLToPath(new URL("../cli/index.js", import.meta.url));
  let log: number | "ignore" = "ignore";
  try {
    mkdirSync(join(root, RUSHES_DIR), { recursive: true });
    log = openSync(serverLogPath(root), "a");
  } catch {
    // No log if the folder can't be written; the start may still work.
  }
  try {
    const child = spawn(process.execPath, [cli, "serve", root, "--idle-minutes", String(BACKGROUND_IDLE_MINUTES)], { detached: true, stdio: ["ignore", log, log], windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
  } finally {
    if (typeof log === "number") closeSync(log);
  }
}

/** One in-flight ensure per root, so parallel tool calls share a single spawn. */
const pending = new Map<string, Promise<RushesClient>>();

/** Find the project's server, starting one in the background if needed. */
export async function ensureServer(rootDir: string, opts: EnsureOptions = {}): Promise<RushesClient> {
  const root = await canonicalRoot(rootDir);
  const inFlight = pending.get(root);
  if (inFlight) return inFlight;
  const run = ensure(root, opts).finally(() => pending.delete(root));
  pending.set(root, run);
  return run;
}

async function ensure(root: string, opts: EnsureOptions): Promise<RushesClient> {
  const found = await findServer(root);
  if (found) return new RushesClient(found);
  (opts.spawnServer ?? defaultSpawn)(root);
  const deadline = Date.now() + (opts.timeoutMs ?? 8000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const url = await findServer(root);
    if (url) return new RushesClient(url);
  }
  throw new Error(
    `Rushes server did not start for ${root}. Its output is in ${serverLogPath(root)}. Try running "npx -y ${SOURCE} open" in that folder.`,
  );
}
