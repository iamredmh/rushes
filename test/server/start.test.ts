import { describe, expect, it } from "vitest";
import { createServer, request } from "node:http";
import { Server } from "node:net";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { startServer, DEFAULT_PORT } from "../../src/server/start.js";
import { AlreadyRunningError, canonicalRoot, lockPath, readLock, removeLock } from "../../src/server/lock.js";
import { ensureServer, findServer } from "../../src/mcp/ensure.js";
import { ProjectIdSchema } from "../../src/core/schema.js";

/** Servers in this process that are still listening. */
const listeningServers = () =>
  ((process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles()).filter((h) => h instanceof Server && h.listening).length;

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
    // Waits for the note's own change: the start-up scan (§20.1) may announce one of its own first.
    await until('"file":"notes"');
    expect(text).toMatch(/event: change\ndata: \{"file":"notes"/);
    ctrl.abort();
    await s.close();
  });

  it("counts open event streams for tests, on /api/health?test=1 only", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const health = async (q = "?test=1") => (await (await fetch(`${s.url}/api/health${q}`)).json()) as { sse?: number };
    expect(await health()).toMatchObject({ sse: 0 });
    expect(await health("")).not.toHaveProperty("sse");
    const ctrl = new AbortController();
    const res = await fetch(`${s.url}/api/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    await reader.read();
    expect(await health()).toMatchObject({ sse: 1 });
    ctrl.abort();
    await expect.poll(async () => (await health()).sse).toBe(0);
    await s.close();
  });

  it("uses the real path as the root, so a symlinked path finds the same server", async () => {
    const { root } = await tmpProject();
    const link = join(dirname(root), "Linked Project");
    await symlink(root, link);
    const s = await startServer(link, { port: 0 });
    expect(s.store.root).toBe(root);
    expect((await (await fetch(`${s.url}/api/health`)).json()).root).toBe(root);
    expect(await readLock(root)).toMatchObject({ port: s.port });
    expect(await findServer(link)).toBe(s.url);
    expect(await findServer(root)).toBe(s.url);
    const c = await ensureServer(link, { spawnServer: () => { throw new Error("should not spawn"); } });
    expect(c.baseUrl).toBe(s.url);
    await s.close();
  });

  it("canonicalRoot resolves the nearest existing parent of a folder that isn't there yet", async () => {
    const { root } = await tmpProject();
    const link = join(dirname(root), "Linked Project");
    await symlink(root, link);
    expect(await canonicalRoot(link)).toBe(root);
    expect(await canonicalRoot(join(link, "Not Yet", "Deeper"))).toBe(join(root, "Not Yet", "Deeper"));
  });

  it("creates a project folder that doesn't exist yet", async () => {
    const { root } = await tmpProject();
    const fresh = join(root, "New Film");
    expect(await findServer(fresh)).toBeNull();
    const s = await startServer(fresh, { port: 0 });
    expect(s.store.root).toBe(fresh);
    await s.close();
  });

  it("a second server for the same root refuses to start, and the first one's lock survives", async () => {
    const { root } = await tmpProject();
    const first = await startServer(root, { port: 0 });
    const before = await readFile(lockPath(root), "utf8");
    const second = startServer(root, { port: 0 });
    await expect(second).rejects.toBeInstanceOf(AlreadyRunningError);
    await expect(second).rejects.toMatchObject({ code: "already_running", url: first.url });
    expect(await readFile(lockPath(root), "utf8")).toBe(before);
    expect((await fetch(`${first.url}/api/health`)).status).toBe(200);
    await first.close();
  });

  it("closes its listening socket when the lock can't be written", async () => {
    const { root } = await tmpProject();
    // A directory where server.json should be makes the write fail with something other than EEXIST.
    await mkdir(lockPath(root));
    const before = listeningServers();
    await expect(startServer(root, { port: 0 })).rejects.toThrow();
    expect(listeningServers()).toBe(before);
  });

  it("takes over a stale lock whose pid is alive but whose port isn't this project's server", async () => {
    const { root } = await tmpProject();
    await writeFile(lockPath(root), JSON.stringify({ port: 1, pid: process.pid, startedAt: "x" }), "utf8");
    const s = await startServer(root, { port: 0 });
    expect(await readLock(root)).toMatchObject({ port: s.port });
    await s.close();
  });

  it("refuses a DNS-rebound request whose Host header names another site", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const status = await new Promise<number>((ok, fail) => {
      const req = request({ host: "127.0.0.1", port: s.port, path: "/api/state", headers: { host: `evil.example:${s.port}` } }, (res) => {
        res.resume();
        ok(res.statusCode!);
      });
      req.on("error", fail);
      req.end();
    });
    expect(status).toBe(403);
    await s.close();
  });

  it("does not remove a lock that belongs to another live process", async () => {
    const { root } = await tmpProject();
    await writeFile(lockPath(root), JSON.stringify({ port: 4999, pid: process.ppid, startedAt: "x" }), "utf8");
    await removeLock(root);
    expect(await readLock(root)).toMatchObject({ pid: process.ppid });
    await expect(access(lockPath(root))).resolves.toBeUndefined();
  });

  it("treats EPERM from process.kill as alive", async () => {
    const { root } = await tmpProject();
    await writeFile(lockPath(root), JSON.stringify({ port: 4999, pid: 1, startedAt: "x" }), "utf8");
    expect(await readLock(root)).not.toBeNull();
    expect(await readLock(root)).toMatchObject({ pid: 1 });
  });

  it("DEFAULT_PORT is 4580", () => {
    expect(DEFAULT_PORT).toBe(4580);
  });

  it("a project without an id gets one on start, and running.dashboardUrl ends with /p/<id>/", async () => {
    const { root, store } = await tmpProject();
    expect((await store.read("project")).id).toBeUndefined();
    const s = await startServer(root, { port: 0 });
    expect(ProjectIdSchema.safeParse(s.id).success).toBe(true);
    expect(s.dashboardUrl).toBe(`${s.url}/p/${s.id}/`);
    expect((await s.store.read("project")).id).toBe(s.id);
    await s.close();
  });

  it("a health request fired the instant the port opens still only bumps the project's rev by 1", async () => {
    const { root, store } = await tmpProject();
    const before = (await store.read("project")).rev;
    // Grab a free port, then release it immediately: startServer binds the exact same port
    // next, and a retry loop below hammers it from the moment it's free, so a request has the
    // best chance of landing in the gap between the socket opening and the server's own id
    // ensure finishing — the gap where a second, independent ensure used to sneak in and bump
    // the rev twice.
    const probe = createServer();
    await new Promise<void>((ok) => probe.listen(0, "127.0.0.1", () => ok()));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((ok) => probe.close(() => ok()));
    let healthOk = false;
    const hammer = (async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !healthOk) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`);
          if (res.ok) healthOk = true;
        } catch {
          // Not listening yet.
        }
      }
    })();
    const s = await startServer(root, { port });
    await hammer;
    expect(healthOk).toBe(true);
    const after = await store.read("project");
    expect(after.rev).toBe(before + 1);
    await s.close();
  });

  it("a second start of the same folder keeps the same id and the same project rev", async () => {
    const { root } = await tmpProject();
    const first = await startServer(root, { port: 0 });
    const { id, rev } = await first.store.read("project");
    await first.close();
    const second = await startServer(root, { port: 0 });
    const again = await second.store.read("project");
    expect(second.id).toBe(id);
    expect(again.rev).toBe(rev);
    await second.close();
  });
});
