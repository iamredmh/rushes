import { describe, expect, it } from "vitest";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { startServer, type Running } from "../../src/server/start.js";
import { lockPath, readLock, removeLock, writeLock } from "../../src/server/lock.js";

describe("one server per project", () => {
  it("lets exactly one of several racing starts win, even over a stale lock", async () => {
    const { root } = await tmpProject();
    await writeFile(lockPath(root), JSON.stringify({ port: 4999, pid: 999999, startedAt: "x", token: "stale" }), "utf8");
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => startServer(root, { port: 0 })));
    const winners = results.filter((r): r is PromiseFulfilledResult<Running> => r.status === "fulfilled").map((r) => r.value);
    expect(winners).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as { code?: string }).code).toBe("already_running");
    expect((await readLock(root))?.port).toBe(winners[0].port);
    await winners[0].close();
    expect(await readLock(root)).toBeNull();
  });

  it("still claims the lock on a volume that can't hard-link (exFAT, some network shares)", async () => {
    const { root } = await tmpProject();
    const noLinks = async () => { throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" }); };
    const lock = await writeLock(root, 4999, { link: noLinks as never });
    expect(await readLock(root)).toMatchObject({ port: 4999, token: lock.token });
    expect((await readdir(join(root, ".rushes"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("removeLock leaves a newer server's lock alone, even in the same process", async () => {
    const { root } = await tmpProject();
    const older = await writeLock(root, 4999);
    await writeFile(lockPath(root), JSON.stringify({ port: 5000, pid: process.pid, startedAt: "y", token: "newer" }), "utf8");
    await removeLock(root, older.token);
    expect((await readLock(root))?.token).toBe("newer");
  });
});
