import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { access, writeFile } from "node:fs/promises";
import { tmpProject } from "../helpers/tmp.js";
import { startServer } from "../../src/server/start.js";
import { lockPath, readLock } from "../../src/server/lock.js";

describe("startServer", () => {
  it("serves the API, writes a lockfile and removes it on close", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const health = await (await fetch(`${s.url}/api/health`)).json();
    expect(health).toMatchObject({ ok: true, root });
    expect(await readLock(root)).toMatchObject({ port: s.port, pid: process.pid });
    await s.close();
    await expect(access(lockPath(root))).rejects.toThrow();
  });

  it("moves to the next port when the first is taken", async () => {
    const { root } = await tmpProject();
    const blocker = createServer();
    await new Promise<void>((ok) => blocker.listen(0, "127.0.0.1", () => ok()));
    const taken = (blocker.address() as { port: number }).port;
    const s = await startServer(root, { port: taken });
    expect(s.port).toBeGreaterThan(taken);
    expect(s.port).toBeLessThanOrEqual(taken + 10);
    await s.close();
    await new Promise<void>((ok) => blocker.close(() => ok()));
  });

  it("treats a lock left by a dead process as no lock", async () => {
    const { root } = await tmpProject();
    await writeFile(lockPath(root), JSON.stringify({ port: 4999, pid: 999999, startedAt: "2026-01-01T00:00:00Z" }), "utf8");
    expect(await readLock(root)).toBeNull();
  });

  it("streams a change event over SSE after a write", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const ctrl = new AbortController();
    const res = await fetch(`${s.url}/api/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await until("event: hello");
    await fetch(`${s.url}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "picture", scope: "point", t: 1, text: "x" }),
    });
    await until("event: change");
    expect(text).toContain('"file":"notes"');
    ctrl.abort();
    await s.close();
  });
});
