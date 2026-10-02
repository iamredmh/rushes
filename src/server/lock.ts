import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { RUSHES_DIR } from "../core/store.js";
import { RushesError } from "../core/errors.js";

export interface Lock {
  port: number;
  pid: number;
  startedAt: string;
}

/** A server for this project is already running at `url`. */
export class AlreadyRunningError extends RushesError {
  constructor(readonly url: string) {
    super(`Rushes is already running for this project at ${url}`, 409, "already_running", { url });
  }
}

/**
 * The one name a project folder goes by: its real path, so a symlinked path
 * and the real one share a server. When the folder doesn't exist yet, its
 * nearest existing parent is resolved instead and the rest is kept as given,
 * which is the path the server will have once it creates the folder.
 */
export async function canonicalRoot(dir: string): Promise<string> {
  const abs = resolve(dir);
  const missing: string[] = [];
  for (let at = abs; ; at = dirname(at)) {
    try {
      return join(await realpath(at), ...missing);
    } catch {
      if (dirname(at) === at) return abs;
      missing.unshift(basename(at));
    }
  }
}

export function lockPath(root: string): string {
  return join(root, RUSHES_DIR, "server.json");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The running server's lock, or null when there is none or its process has gone. */
export async function readLock(root: string): Promise<Lock | null> {
  try {
    const lock = JSON.parse(await readFile(lockPath(root), "utf8")) as Lock;
    if (typeof lock.port !== "number" || typeof lock.pid !== "number") return null;
    return alive(lock.pid) ? lock : null;
  } catch {
    return null;
  }
}

/** Does the server on this port answer as Rushes for exactly this root? */
export async function isRushesFor(port: number, root: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const health = (await res.json()) as { app?: string; root?: string };
    return health.app === "rushes" && health.root === root;
  } catch {
    return false;
  }
}

/**
 * Claim the project's lock. The file is created exclusively, so two servers
 * can't both win. If a lock is already there and its server is alive and
 * serving this root, throw AlreadyRunningError; otherwise the lock is stale
 * and is replaced.
 */
export async function writeLock(root: string, port: number): Promise<Lock> {
  const lock: Lock = { port, pid: process.pid, startedAt: new Date().toISOString() };
  const text = JSON.stringify(lock, null, 2) + "\n";
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(lockPath(root), text, { encoding: "utf8", flag: "wx" });
      return lock;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 2) throw e;
    }
    const existing = await readLock(root);
    if (existing && (await isRushesFor(existing.port, root))) throw new AlreadyRunningError(`http://127.0.0.1:${existing.port}`);
    // Stale: its process has gone, or its port now belongs to something else.
    await rm(lockPath(root));
  }
}

/** Remove the lock only if it is ours, so a newer server's lock survives. */
export async function removeLock(root: string): Promise<void> {
  try {
    const lock = JSON.parse(await readFile(lockPath(root), "utf8")) as Lock;
    if (lock.pid === process.pid) await rm(lockPath(root), { force: true });
  } catch {
    // nothing to remove
  }
}
