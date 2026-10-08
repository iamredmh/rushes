import { describe, expect, it, vi } from "vitest";
import { readdir, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tmpProject } from "../helpers/tmp.js";

// A racer that has judged the lock stale can be held up (a busy machine, a descheduled process)
// before it removes it. Held up long enough, its removal lands after another racer has put a fresh
// lock there, deletes that one, and a second server believes it owns the project. Here the lock
// file's removal is held up by a different amount on each call, as a real stall would be.
const STALLS = [0, 90, 20, 110, 45, 70];
let removals = 0;

vi.mock("node:fs/promises", async (orig) => {
  const real = (await orig()) as typeof import("node:fs/promises");
  return {
    ...real,
    rm: async (...args: Parameters<typeof real.rm>) => {
      if (String(args[0]).endsWith("server.json")) {
        await new Promise((r) => setTimeout(r, STALLS[removals++ % STALLS.length]));
      }
      return real.rm(...args);
    },
  };
});

const { startServer } = await import("../../src/server/start.js");
const { lockPath, readLock } = await import("../../src/server/lock.js");

describe("one server per project, with a stalled stale-lock removal", () => {
  it("lets exactly one of several racing starts win over a stale lock, every round", async () => {
    for (let round = 1; round <= 4; round++) {
      const { root } = await tmpProject();
      await writeFile(lockPath(root), JSON.stringify({ port: 4999, pid: 999999, startedAt: "x", token: "stale" }), "utf8");
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => startServer(root, { port: 0 })));
      const winners = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof startServer>>> => r.status === "fulfilled").map((r) => r.value);
      const losers = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => (r.reason as { code?: string }).code ?? String(r.reason));
      try {
        expect({ round, winners: winners.length, losers }).toEqual({ round, winners: 1, losers: Array(5).fill("already_running") });
        expect((await readLock(root))?.port).toBe(winners[0].port);
      } finally {
        await Promise.all(winners.map((w) => w.close()));
      }
      // The guard that serialises removals is never left behind by a race.
      expect((await readdir(dirname(lockPath(root)))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    }
  });

  it("isn't blocked by a guard a claimant left behind when it died", async () => {
    const { root } = await tmpProject();
    await writeFile(lockPath(root), JSON.stringify({ port: 4999, pid: 999999, startedAt: "x", token: "stale" }), "utf8");
    const guard = `${lockPath(root)}.break.tmp`;
    await writeFile(guard, "", "utf8");
    const tenSecondsAgo = new Date(Date.now() - 10_000);
    await utimes(guard, tenSecondsAgo, tenSecondsAgo);
    const running = await startServer(root, { port: 0 });
    try {
      expect((await readLock(root))?.port).toBe(running.port);
    } finally {
      await running.close();
    }
    expect((await readdir(dirname(lockPath(root)))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
