import { describe, expect, it } from "vitest";
import { tmpProject } from "../helpers/tmp.js";
import { sse } from "../helpers/sse.js";
import { startServer } from "../../src/server/start.js";
import { readLock } from "../../src/server/lock.js";
import { createApp } from "../../src/server/app.js";

describe("idle shutdown", () => {
  it("closes after the idle time with no requests, and removes its lock", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0, idleMs: 200 });
    await fetch(`${s.url}/api/health`).then((r) => r.json());
    await s.closed;
    expect(await readLock(root)).toBeNull();
    await expect(fetch(`${s.url}/api/health`)).rejects.toThrow();
  });

  it("stays up while a dashboard is connected", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0, idleMs: 150 });
    const events = await sse(s.url);
    await events.until("event: hello");
    await new Promise((r) => setTimeout(r, 500));
    expect((await (await fetch(`${s.url}/api/health`)).json()).ok).toBe(true);
    events.stop();
    await s.close();
  });
});

describe("shutdown", () => {
  it("replies, then calls the shutdown hook", async () => {
    const { store } = await tmpProject();
    let shutdowns = 0;
    const app = createApp(store, { onShutdown: () => { shutdowns++; } });
    const r = await app.request("/api/shutdown", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(await r.json()).toEqual({ ok: true, stopping: true });
    await new Promise((ok) => setImmediate(ok));
    expect(shutdowns).toBe(1);
  });

  it("closes a running server, which removes its lock", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    await fetch(`${s.url}/api/shutdown`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await s.closed;
    expect(await readLock(root)).toBeNull();
  });
});
