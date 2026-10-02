import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { createApp } from "../../src/server/app.js";
import { parseRange, inside } from "../../src/server/files.js";

// The smallest valid PNG (1×1, transparent).
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function setup() {
  const { root, store } = await tmpProject("files");
  const webDir = join(root, "web");
  await mkdir(join(webDir, "assets"), { recursive: true });
  await writeFile(join(webDir, "index.html"), "<!doctype html><title>Rushes</title><div id=app></div>");
  await writeFile(join(webDir, "assets", "app-abc123.js"), "console.log('hi')");
  const app = createApp(store, { webDir });
  const call = (path: string, init: RequestInit = {}) => app.request(path, init);
  const post = (path: string, json: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });
  return { root, store, call, post };
}

describe("parseRange", () => {
  it("reads start-end, open-ended and suffix ranges", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });
  it("rejects ranges it can't satisfy", () => {
    expect(parseRange("bytes=2000-", 1000)).toBeNull();
    expect(parseRange("bytes=5-1", 1000)).toBeNull();
    expect(parseRange("bytes=-", 1000)).toBeNull();
    expect(parseRange("items=0-1", 1000)).toBeNull();
    expect(parseRange(undefined, 1000)).toBeNull();
  });
});

describe("inside", () => {
  it("keeps paths inside the folder and refuses escapes", () => {
    expect(inside("/web", "assets/a.js")).toBe("/web/assets/a.js");
    expect(inside("/web", "../etc/passwd")).toBeNull();
    expect(inside("/web", "assets/../../etc/passwd")).toBeNull();
  });
});

describe("dashboard files", () => {
  it("serves the built index.html at /p/<id>/ and its assets", async () => {
    const { call } = await setup();
    const id = ((await (await call("/api/health")).json()) as { id: string }).id;
    const page = await call(`/p/${id}/`);
    expect(await page.text()).toContain("<div id=app>");
    const js = await call("/assets/app-abc123.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toBe("console.log('hi')");
  });
  it("404s for missing assets and refuses to leave the folder", async () => {
    const { call } = await setup();
    expect((await call("/assets/nope.js")).status).toBe(404);
    expect((await call("/assets/..%2F..%2Fpackage.json")).status).toBe(404);
  });
  it("404s rather than 500s on a path with bad percent-encoding", async () => {
    const { call } = await setup();
    expect((await call("/assets/%")).status).toBe(404);
  });
});

describe("media", () => {
  async function withClip() {
    const s = await setup();
    await mkdir(join(s.root, "renders"), { recursive: true });
    await writeFile(join(s.root, "renders", "hero v1.mp4"), Buffer.alloc(1000, 7));
    await s.post("/api/versions", { video: "Hero", file: "renders/hero v1.mp4" });
    return s;
  }

  it("streams a registered file, whole or by byte range", async () => {
    const { call } = await withClip();
    const whole = await call(`/media?path=${encodeURIComponent("renders/hero v1.mp4")}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(whole.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect((await whole.arrayBuffer()).byteLength).toBe(1000);
    const part = await call(`/media?path=${encodeURIComponent("renders/hero v1.mp4")}`, { headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    const bad = await call(`/media?path=${encodeURIComponent("renders/hero v1.mp4")}`, { headers: { range: "bytes=5000-" } });
    expect(bad.status).toBe(416);
  });

  it("refuses any path the project didn't register", async () => {
    const { call, root } = await withClip();
    await writeFile(join(root, "secret.txt"), "no");
    expect((await call("/media?path=secret.txt")).status).toBe(404);
    expect((await call("/media?path=..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await call("/media?path=.rushes%2Fnotes.json")).status).toBe(404);
  });

  it("says when a registered file has gone missing", async () => {
    const { post, call } = await setup();
    await post("/api/versions", { video: "Hero", file: "renders/gone.mp4" });
    const r = await call("/media?path=renders%2Fgone.mp4");
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: "missing_file" });
  });
});

describe("frame grabs", () => {
  it("saves a PNG under .rushes/grabs and serves it back", async () => {
    const { post, call, root } = await setup();
    const r = await post("/api/grabs", { video: "hero-60s", version: "v3", frame: 744, png: `data:image/png;base64,${PNG_1PX}` });
    expect(r.status).toBe(201);
    const { grab } = (await r.json()) as { grab: string };
    expect(grab).toBe(".rushes/grabs/hero-60s_v3_f744.png");
    expect((await readFile(join(root, grab))).subarray(1, 4).toString()).toBe("PNG");
    const back = await call(`/media?path=${encodeURIComponent(grab)}`);
    expect(back.status).toBe(200);
    expect(back.headers.get("content-type")).toBe("image/png");
  });

  it("rejects anything that isn't a PNG, and unsafe names", async () => {
    const { post } = await setup();
    expect((await post("/api/grabs", { video: "hero", version: "v1", frame: 1, png: Buffer.from("hello").toString("base64") })).status).toBe(400);
    expect((await post("/api/grabs", { video: "../x", version: "v1", frame: 1, png: PNG_1PX })).status).toBe(400);
    expect((await post("/api/grabs", { video: "hero", version: "latest", frame: 1, png: PNG_1PX })).status).toBe(400);
  });
  it("rejects a frame number so large it would print in exponent form", async () => {
    const { post } = await setup();
    expect((await post("/api/grabs", { video: "hero", version: "v1", frame: 10_000_001, png: PNG_1PX })).status).toBe(400);
  });
});
