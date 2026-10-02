import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readLock } from "../server/lock.js";
import { RushesClient } from "./client.js";

/** URL of a live Rushes server for exactly this project root, or null. */
export async function findServer(rootDir: string): Promise<string | null> {
  const root = resolve(rootDir);
  const lock = await readLock(root);
  if (!lock) return null;
  const url = `http://127.0.0.1:${lock.port}`;
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    const health = (await res.json()) as { app?: string; root?: string };
    // A reused port or pid can point at something else, so check it's ours.
    return health.app === "rushes" && health.root === root ? url : null;
  } catch {
    return null;
  }
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

/** Find the project's server, starting one in the background if needed. */
export async function ensureServer(rootDir: string, opts: EnsureOptions = {}): Promise<RushesClient> {
  const root = resolve(rootDir);
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
