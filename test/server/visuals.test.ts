import { describe, expect, it } from "vitest";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { createApp } from "../../src/server/app.js";
import { addVersion } from "../../src/core/project.js";

// §25.5 and §25.7: registering visuals over HTTP, the notes on them, and what the agent and the media route see.
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
/** The start of a real png: the signature and an IHDR with this size. Enough for the server to read the size and to serve. */
const png = (w: number, h: number) => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...be32(13), 73, 72, 68, 82, ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0]);

async function setup() {
  const { root, store } = await tmpProject("lumen");
  const server = createApp(store, {});
  const call = async (method: string, path: string, json?: unknown) => {
    const res = await server.request(path, { method, headers: json === undefined ? undefined : { "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, json: type.includes("json") ? ((await res.json()) as any) : null, res };
  };
  const put = async (rel: string, w: number, h: number) => {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), png(w, h));
  };
  return { root, store, call, put };
}

const pages = (n: number, ext = "4x5") => Array.from({ length: n }, (_, i) => ({ files: [`visuals/launch/p${i + 1}-${ext}.png`] }));

describe("POST /api/visuals", () => {
  it("registers a carousel, reading each picture's size, and unlocks the tab", async () => {
    const { call, put } = await setup();
    for (let i = 1; i <= 3; i++) await put(`visuals/launch/p${i}-4x5.png`, 1080, 1350);
    const r = await call("POST", "/api/visuals", { name: "Launch carousel", label: "First pass", pages: pages(3) });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ visual: { id: "launch-carousel", name: "Launch carousel", kind: "carousel" }, version: { id: "v1", label: "First pass" }, pages: 3, ratios: ["4:5"] });
    const state = await call("GET", "/api/state");
    expect(state.json.visuals.visuals).toHaveLength(1);
    expect(state.json.visuals.visuals[0].versions[0].pages[0].images[0]).toEqual({ ratio: "4x5", file: "visuals/launch/p1-4x5.png", width: 1080, height: 1350 });
    const tabs = await call("GET", "/api/tabs");
    expect(tabs.json.tabs.find((t: { stage: string }) => t.stage === "visuals")).toMatchObject({ unlocked: true, todo: 0 });
  });

  it("registers a new version that sends only what changed, and says so in the Change Log", async () => {
    const { call, put } = await setup();
    for (let i = 1; i <= 3; i++) await put(`visuals/launch/p${i}-4x5.png`, 1080, 1350);
    await call("POST", "/api/visuals", { name: "Launch carousel", pages: pages(3) });
    await put("visuals/launch/p3-v2.png", 1080, 1350);
    const r = await call("POST", "/api/visuals", { visual: "launch-carousel", label: "Shorter headline", pages: [{ n: 3, files: ["visuals/launch/p3-v2.png"] }] });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ version: { id: "v2" }, pages: 3 });
    const state = await call("GET", "/api/state");
    expect(state.json.visuals.visuals[0].versions[1].pages.map((p: { images: { file: string }[] }) => p.images[0].file)).toEqual(["visuals/launch/p1-4x5.png", "visuals/launch/p2-4x5.png", "visuals/launch/p3-v2.png"]);
    const log = await call("GET", "/api/log?area=visuals");
    expect(JSON.stringify(log.json)).toContain("Launch carousel");
  });

  it("refuses a picture outside the project, a non-picture, a missing file, a link and a bad request, and writes nothing", async () => {
    const { call, put, root, store } = await setup();
    await put("visuals/a.png", 1080, 1350);
    await writeFile(join(root, "visuals", "notes.png"), "this is text, not a png");
    await writeFile(join(root, "visuals", "doc.txt"), "hello");
    await symlink(join(root, "visuals", "a.png"), join(root, "visuals", "link.png"));
    const refuse = async (files: string[], code: string, status = 400) => {
      const r = await call("POST", "/api/visuals", { name: "X", pages: [{ files }] });
      expect([r.status, r.json.error]).toEqual([status, code]);
    };
    await refuse(["/etc/hosts.png"], "not_in_project");
    await refuse(["../outside.png"], "not_in_project");
    await refuse(["visuals/notes.png"], "not_an_image");
    await refuse(["visuals/doc.txt"], "not_an_image");
    await refuse(["visuals/missing.png"], "unreadable");
    await refuse(["visuals/link.png"], "not_in_project");
    expect((await call("POST", "/api/visuals", { pages: [{ files: ["visuals/a.png"] }] })).status).toBe(400);
    expect((await call("POST", "/api/visuals", { name: "X", visual: "Y", pages: [{ files: ["visuals/a.png"] }] })).status).toBe(400);
    expect(await stat(store.path("visuals")).catch(() => null)).toBeNull();
  });

  // Deferred minor: a refusal names the first bad picture in the order given, not whichever one fails first in time.
  it("names the first bad picture in the order given, within a page and across pages", async () => {
    const { call, put, root } = await setup();
    await put("visuals/a.png", 1080, 1350);
    await writeFile(join(root, "visuals", "doc.txt"), "hello");
    const within = await call("POST", "/api/visuals", { name: "X", pages: [{ files: ["visuals/missing.png", "visuals/doc.txt"] }] });
    expect([within.json.error, within.json.file]).toEqual(["unreadable", "visuals/missing.png"]);
    const across = await call("POST", "/api/visuals", { name: "Y", pages: [{ files: ["visuals/a.png"] }, { files: ["visuals/missing.png"] }, { files: ["visuals/doc.txt"] }] });
    expect([across.json.error, across.json.file]).toEqual(["unreadable", "visuals/missing.png"]);
  });

  // Deferred minor: a file at the project's top level whose name starts with two dots is inside the project, not outside it.
  it("takes a picture whose name starts with two dots, and still refuses one outside the project", async () => {
    const { call, put } = await setup();
    await put("..cover.png", 1080, 1350);
    expect((await call("POST", "/api/visuals", { name: "Cover", pages: [{ files: ["..cover.png"] }] })).status).toBe(201);
    expect((await call("POST", "/api/visuals", { name: "Out", pages: [{ files: ["../cover.png"] }] })).json.error).toBe("not_in_project");
    expect((await call("POST", "/api/visuals", { name: "Up", pages: [{ files: [".."] }] })).json.error).toBe("not_in_project");
  });

  it("names the core's refusals: a duplicate name, a missing cell, an unknown visual", async () => {
    const { call, put } = await setup();
    await put("visuals/a.png", 1080, 1350);
    await put("visuals/w.png", 1600, 900);
    expect((await call("POST", "/api/visuals", { name: "Quote", pages: [{ files: ["visuals/a.png"] }] })).status).toBe(201);
    expect((await call("POST", "/api/visuals", { name: "quote", pages: [{ files: ["visuals/a.png"] }] })).json.error).toBe("duplicate_name");
    expect((await call("POST", "/api/visuals", { visual: "nope", pages: [{ n: 1, files: ["visuals/a.png"] }] })).json.error).toBe("no_such_visual");
    const grid = await call("POST", "/api/visuals", { visual: "quote", pages: [{ n: 2, files: ["visuals/w.png"] }] });
    expect(grid.json.error).toBe("bad_pages");
  });
});

describe("a registered visual's pictures", () => {
  it("are served by /media, and nothing else in the folder is", async () => {
    const { call, put } = await setup();
    await put("visuals/a.png", 1080, 1350);
    await put("visuals/other.png", 1080, 1350);
    await call("POST", "/api/visuals", { name: "Quote", pages: [{ files: ["visuals/a.png"] }] });
    const ok = await call("GET", "/media?path=visuals/a.png");
    expect(ok.status).toBe(200);
    expect(ok.res.headers.get("content-type")).toBe("image/png");
    expect((await call("GET", "/media?path=visuals/other.png")).status).toBe(404);
  });

  // Review (whole branch): a cut's byte-range seeks hit /media over and over; they must not read, or depend on, visuals.json.
  it("does not stand between a registered cut and /media: a damaged visuals.json leaves the cut playing", async () => {
    const { root, store, call } = await setup();
    await mkdir(join(root, "renders"), { recursive: true });
    await writeFile(join(root, "renders/hero.mp4"), Buffer.from("not really a video"));
    await store.update("project", (p) => {
      addVersion(p, { video: "Hero", file: "renders/hero.mp4" });
    });
    await writeFile(join(root, ".rushes", "visuals.json"), "{ damaged");
    const r = await call("GET", "/media?path=renders/hero.mp4");
    expect(r.status).toBe(200);
  });
});

describe("notes on a visual", () => {
  async function withVisual() {
    const s = await setup();
    await s.put("visuals/a1.png", 1080, 1350);
    await s.put("visuals/a2.png", 1080, 1350);
    await s.put("visuals/w1.png", 1600, 900);
    await s.put("visuals/w2.png", 1600, 900);
    await s.call("POST", "/api/visuals", { name: "Quote carousel", pages: [{ files: ["visuals/a1.png", "visuals/w1.png"] }, { files: ["visuals/a2.png", "visuals/w2.png"] }] });
    return s;
  }
  const note = (over: object) => ({ stage: "visuals", scope: "whole", version: "v1", on: "quote-carousel/2", format: "4x5", box: { x: 0.1, y: 0.05, w: 0.3, h: 0.2 }, text: "Shorten the headline.", ...over });

  it("takes a region, a point and a whole-image note", async () => {
    const { call } = await withVisual();
    expect((await call("POST", "/api/notes", note({}))).status).toBe(201);
    expect((await call("POST", "/api/notes", note({ box: undefined, pin: { x: 0.5, y: 0.5 } }))).status).toBe(201);
    expect((await call("POST", "/api/notes", note({ box: undefined, format: null }))).status).toBe(201);
  });

  it("refuses a page, a version, a ratio or a visual that is not there, and a region with no ratio", async () => {
    const { call } = await withVisual();
    const code = async (over: object) => (await call("POST", "/api/notes", note(over))).json.error;
    expect(await code({ on: "quote-carousel/9" })).toBe("no_such_page");
    expect(await code({ version: "v9" })).toBe("no_such_version");
    expect(await code({ format: "1x1" })).toBe("unknown_format");
    expect(await code({ on: "nope/1" })).toBe("no_such_visual");
    expect(await code({ format: null })).toBe("shape_needs_format");
    expect((await call("POST", "/api/notes", note({ pin: { x: 0.5, y: 0.5 } }))).status).toBe(400);
  });

  it("goes to the agent in a batch with where it is, in words, and the picture to open", async () => {
    const { call } = await withVisual();
    await call("POST", "/api/notes", note({}));
    await call("POST", "/api/notes", note({ box: undefined, format: null, text: "Feels flat.", on: "quote-carousel/1" }));
    const sent = await call("POST", "/api/batches", { stage: "visuals" });
    expect(sent.status).toBe(201);
    expect(sent.json.batch.prompt).toContain("rushes_add_visual");
    const got = await call("GET", `/api/batches/${sent.json.batch.id}`);
    const region = got.json.notes.find((n: { text: string }) => n.text === "Shorten the headline.");
    expect(region.visual).toEqual({
      visual: { id: "quote-carousel", name: "Quote carousel" }, version: "v1", page: 2, ratio: "4:5", shape: "region",
      region: { x: 0.1, y: 0.05, w: 0.3, h: 0.2 }, pin: null, words: "left third, top third", file: "visuals/a2.png",
    });
    expect(got.json.notes.find((n: { text: string }) => n.text === "Feels flat.").visual).toMatchObject({ shape: "image", ratio: null, file: null });
  });

  it("is in Export notes under Visuals", async () => {
    const { call, root } = await withVisual();
    await call("POST", "/api/notes", note({}));
    const r = await call("POST", "/api/exports/notes", {});
    expect(r.status).toBe(201);
    const md = await readFile(join(root, r.json.path), "utf8");
    expect(md).toContain("## Visuals");
    expect(md).toContain("### Quote carousel · v1");
    expect(md).toContain("**Page 2** · 4:5 · region (left third, top third) · to do — Shorten the headline.");
  });

  it("is listed with its picture when the agent lists notes", async () => {
    const { call } = await withVisual();
    await call("POST", "/api/notes", note({}));
    const list = await call("GET", "/api/notes?stage=visuals");
    expect(list.json.notes[0].visual.file).toBe("visuals/a2.png");
  });
});
