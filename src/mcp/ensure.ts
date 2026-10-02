import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalRoot, isRushesFor, readLock } from "../server/lock.js";
import { RushesClient } from "./client.js";

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

function defaultSpawn(root: string): void {
  const cli = fileURLToPath(new URL("../cli/index.js", import.meta.url));
  const child = spawn(process.execPath, [cli, "serve", root], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
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
  throw new Error(`Rushes server did not start for ${root}. Try running "npx rushes open" in that folder.`);
}
