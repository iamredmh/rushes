import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { tmpProject } from "../helpers/tmp.js";
import { startServer, type Running } from "../../src/server/start.js";
import { lockPath, readLock } from "../../src/server/lock.js";

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
});
