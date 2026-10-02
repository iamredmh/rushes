import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUSHES_DIR } from "../core/store.js";

export interface Lock {
  port: number;
  pid: number;
  startedAt: string;
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

export async function writeLock(root: string, port: number): Promise<Lock> {
  const lock: Lock = { port, pid: process.pid, startedAt: new Date().toISOString() };
  await writeFile(lockPath(root), JSON.stringify(lock, null, 2) + "\n", "utf8");
  return lock;
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
