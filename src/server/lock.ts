import { link, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { RUSHES_DIR } from "../core/store.js";
import { RushesError } from "../core/errors.js";

export interface Lock {
  port: number;
  pid: number;
  startedAt: string;
  /** Unique per server start, so a server can tell its own lock from a newer one in the same process. */
  token?: string;
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

/** The lock file as written, whether or not its process is alive. Null when missing or unreadable. */
async function readLockFile(root: string): Promise<Lock | null> {
  try {
    const lock = JSON.parse(await readFile(lockPath(root), "utf8")) as Lock;
    return typeof lock.port === "number" && typeof lock.pid === "number" ? lock : null;
  } catch {
    return null;
  }
}

/** The running server's lock, or null when there is none or its process has gone. */
export async function readLock(root: string): Promise<Lock | null> {
  const lock = await readLockFile(root);
  return lock && alive(lock.pid) ? lock : null;
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
 * Claim the project's lock. The lock is written to a temporary file and then
 * hard-linked into place, so it appears complete or not at all, and only one
 * claimant can win the link. A lock whose server is alive and serving this
 * root wins over us (AlreadyRunningError). A stale one is removed, but only if
 * it is still the same lock we judged stale. After winning, we re-read the
 * lock once: if a racing claimant replaced it, we go round again and defer to
 * that server.
 */
export async function writeLock(root: string, port: number): Promise<Lock> {
  const lock: Lock = { port, pid: process.pid, startedAt: new Date().toISOString(), token: randomUUID() };
  const path = lockPath(root);
  const tmp = `${path}.${lock.token}.tmp`;
  await writeFile(tmp, JSON.stringify(lock, null, 2) + "\n", "utf8");
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await link(tmp, path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const existing = await readLockFile(root);
        if (existing && alive(existing.pid) && (await isRushesFor(existing.port, root))) {
          throw new AlreadyRunningError(`http://127.0.0.1:${existing.port}`);
        }
        // Stale: remove it only if it's still the lock we just judged.
        const again = await readLockFile(root);
        if (!existing || (again && again.token === existing.token && again.pid === existing.pid && again.startedAt === existing.startedAt)) {
          await rm(path, { force: true });
        }
        continue;
      }
      await new Promise((r) => setTimeout(r, 25));
      if ((await readLockFile(root))?.token === lock.token) return lock;
    }
    throw new Error(`Couldn't claim ${path}: other servers kept replacing it`);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Remove the lock only if it is ours (same token, or same pid for locks without one), so a newer server's lock survives. */
export async function removeLock(root: string, token?: string): Promise<void> {
  const lock = await readLockFile(root);
  if (!lock) return;
  const ours = token !== undefined && lock.token !== undefined ? lock.token === token : lock.pid === process.pid;
  if (ours) await rm(lockPath(root), { force: true });
}
