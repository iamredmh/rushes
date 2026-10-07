import { describe, expect, it, vi } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { sizedProbe } from "../helpers/probe.js";
import { createApp, type AppOptions } from "../../src/server/app.js";
import { addVersion } from "../../src/core/project.js";
import { ProxyJobs } from "../../src/server/proxy.js";
import type { Store } from "../../src/core/store.js";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const WIDE = "renders/hero_1920x1080.mp4";
const TALL = "renders/hero_1080x1920.mp4";
const SQUARE = "renders/hero_1080x1080.mp4";

async function setup(files: string[] = [], opts: AppOptions | ((store: Store) => AppOptions) = {}) {
  const { root, store } = await tmpProject("formats");
  for (const f of files) {
    const abs = join(root, f);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, "bytes");
  }
  const app = createApp(store, { formatProbe: sizedProbe, ...(typeof opts === "function" ? opts(store) : opts) });
  const call = async (method: string, path: string, json?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: json === undefined ? undefined : { "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, json: parsed, text };
  };
  return { root, store, app, call };
}

describe("POST /api/formats (§21.4)", () => {
  it("registers a 9:16 render on the newest cut and says the id and label it settled on", async () => {
    const { call } = await setup([WIDE, TALL]);
    expect((await call("POST", "/api/versions", { video: "Hero", file: WIDE })).json.version).toMatchObject({ width: 1920, height: 1080, formats: [] });
    const r = await call("POST", "/api/formats", { file: TALL });
    expect(r.status).toBe(201);
    expect(r.json.video).toEqual({ id: "hero", name: "Hero" });
    expect(r.json.format).toMatchObject({ id: "9x16", label: "9:16", file: TALL, width: 1080, height: 1920, duration: 8 });
    expect(r.json.warning).toBeUndefined();
  });

  // Review Focus 4.
  it("refuses a second render of a ratio the cut has, however it is spelled", async () => {
    const { root, call } = await setup([WIDE, TALL, "renders/hero_720x1280.mp4"]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE });
    await call("POST", "/api/formats", { file: TALL });
    for (const file of ["renders/hero_720x1280.mp4", join(root, TALL)]) {
      const r = await call("POST", "/api/formats", { file });
      expect(r.status).toBe(409);
      expect(r.json).toMatchObject({ error: "same_ratio", message: "v1 already has 9:16. Register a re-render as a new version." });
    }
    expect((await call("POST", "/api/formats", { file: join(root, WIDE) })).json.message).toBe("v1 already has 16:9. Register a re-render as a new version.");
  });

  it("two registrations of one ratio at once: one lands, the other is refused", async () => {
    const { call, store } = await setup([WIDE, SQUARE, "renders/alt_1080x1080.mp4"]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE });
    const both = await Promise.all([call("POST", "/api/formats", { file: SQUARE }), call("POST", "/api/formats", { file: "renders/alt_1080x1080.mp4" })]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await store.read("project")).videos[0].versions[0].formats).toHaveLength(1);
  });

  it("refuses a non-video, a missing file, an unreadable one and one with no video stream, each with its reason (§21.6)", async () => {
    const audioOnly = async (abs: string) => (abs.endsWith("voice.mp4") ? { ok: false as const, code: "not_video" as const, reason: "it has no video stream" } : sizedProbe(abs));
    const { call } = await setup([WIDE, "brief.pdf", "renders/broken.mp4", "renders/voice.mp4"], { formatProbe: audioOnly });
    await call("POST", "/api/versions", { video: "Hero", file: WIDE });
    expect((await call("POST", "/api/formats", { file: "brief.pdf" })).json).toMatchObject({ error: "not_video", message: "brief.pdf isn't a video file." });
    const gone = await call("POST", "/api/formats", { file: "renders/gone_1080x1920.mp4" });
    expect(gone.status).toBe(404);
    expect(gone.json).toMatchObject({ error: "missing_file", message: "File not found: renders/gone_1080x1920.mp4" });
    const broken = await call("POST", "/api/formats", { file: "renders/broken.mp4" });
    expect(broken.status).toBe(422);
    expect(broken.json.message).toBe("ffprobe couldn't read renders/broken.mp4: Invalid data found when processing input");
    expect((await call("POST", "/api/formats", { file: "renders/voice.mp4" })).json).toMatchObject({ error: "not_video", message: "renders/voice.mp4 isn't a video: it has no video stream." });
  });

  it("without ffprobe a format says why it can't be registered, and a cut still goes in (§21.6)", async () => {
    const none = async () => ({ ok: false as const, code: "no_ffprobe" as const, reason: "needs ffprobe to read the ratio" });
    const { call } = await setup([WIDE, TALL], { formatProbe: none });
    const cut = await call("POST", "/api/versions", { video: "Hero", file: WIDE });
    expect(cut.status).toBe(201);
    expect(cut.json.version).toMatchObject({ width: null, height: null });
    const r = await call("POST", "/api/formats", { file: TALL });
    expect(r.status).toBe(501);
    expect(r.json).toMatchObject({ error: "no_ffprobe", message: expect.stringContaining("needs ffprobe to read the ratio") });
  });

  it("registers a format more than 0.1 s off the cut's length, with a warning", async () => {
    const { call } = await setup([WIDE, "renders/hero_1080x1920@8.4.mp4", "renders/hero_1080x1080@8.05.mp4"]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE });
    expect((await call("POST", "/api/formats", { file: "renders/hero_1080x1920@8.4.mp4" })).json.warning).toBe("9:16 is 8.4 s; the cut is 8.0 s");
    expect((await call("POST", "/api/formats", { file: "renders/hero_1080x1080@8.05.mp4" })).json.warning).toBeUndefined();
  });

  it("reads a cut's own size when it has none (a cut from before formats); refuses when that can't be read", async () => {
    const { call, store } = await setup(["renders/old_1920x1080.mp4", "renders/older.mp4", TALL]);
    await store.update("project", (p) => {
      addVersion(p, { video: "Hero", file: "renders/old_1920x1080.mp4", duration: 8 });
      addVersion(p, { video: "Teaser", file: "renders/older.mp4", duration: 8 });
    });
    expect((await call("POST", "/api/formats", { video: "Hero", file: TALL })).status).toBe(201);
    expect((await store.read("project")).videos[0].versions[0]).toMatchObject({ width: 1920, height: 1080 });
    const r = await call("POST", "/api/formats", { video: "Teaser", file: TALL });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe("no_primary_size");
  });

  it("adds a format to a locked cut (§21.6), and refuses a ninth shape", async () => {
    const sizes = ["1080x1920", "1080x1080", "1080x1350", "1440x1080", "1620x1080", "1080x1620", "2520x1080", "1080x2520"];
    const { call } = await setup([WIDE, ...sizes.map((s) => `renders/f_${s}.mp4`)]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE });
    await call("PUT", "/api/videos/hero/lock", { version: "v1" });
    for (const s of sizes.slice(0, 7)) expect((await call("POST", "/api/formats", { file: `renders/f_${s}.mp4` })).status).toBe(201);
    expect((await call("POST", "/api/formats", { file: "renders/f_1080x2520.mp4" })).json.error).toBe("too_many_formats");
  });

  it("uses a label hint only for an unusual ratio, and says when it didn't (R10)", async () => {
    const { call } = await setup([WIDE, "renders/scope_1920x804.mp4", TALL]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE });
    expect((await call("POST", "/api/formats", { file: "renders/scope_1920x804.mp4", label: "2.4:1" })).json.format).toMatchObject({ id: "2.4x1", label: "2.4:1" });
    expect((await call("POST", "/api/formats", { file: TALL, label: "4:5" })).json).toMatchObject({ format: { id: "9x16" }, labelNote: expect.stringContaining("standard ratio") });
  });
});

describe("POST /api/versions with formats (§21.4)", () => {
  it("registers a re-render in all its shapes in one call", async () => {
    const { call } = await setup([WIDE, TALL, SQUARE]);
    const r = await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }, { file: SQUARE }] });
    expect(r.status).toBe(201);
    expect(r.json.version.formats.map((f: any) => f.id)).toEqual(["9x16", "1x1"]);
  });
  it("bounds what a request may carry: at most 7 formats beside the cut, a path of 1024 characters, a label of 16", async () => {
    const { call, store } = await setup([WIDE]);
    const eight = Array.from({ length: 8 }, (_, i) => ({ file: `renders/f${i}_1080x1920.mp4` }));
    expect((await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: eight })).status).toBe(400);
    expect((await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: `${"a".repeat(1021)}.mp4` }] })).status).toBe(400);
    expect((await store.read("project")).videos).toEqual([]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE });
    expect((await call("POST", "/api/formats", { file: `${"a".repeat(1021)}.mp4` })).status).toBe(400);
    expect((await call("POST", "/api/formats", { file: TALL, label: "1".repeat(17) })).status).toBe(400);
  });
  it("refuses the whole call when one file is refused, and registers nothing (R11)", async () => {
    const { call, store } = await setup([WIDE, TALL]);
    const r = await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }, { file: "renders/gone_1080x1080.mp4" }] });
    expect(r.status).toBe(404);
    expect((await store.read("project")).videos).toEqual([]);
  });
});

describe("serving format files (§21.6, §15.5)", () => {
  // Review Focus 5.
  it("/media serves a format file, including one outside the project, and refuses a link out to a non-media file", async () => {
    const { root, app, call } = await setup([WIDE, TALL]);
    const outside = join(root, "..", "hf", "renders", "hero_1080x1080.mp4");
    await mkdir(dirname(outside), { recursive: true });
    await writeFile(outside, "square bytes");
    await writeFile(join(root, "..", "secret.key"), "key");
    await symlink(join(root, "..", "secret.key"), join(root, "renders", "link_1350x1080.mp4"));
    await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }, { file: outside }, { file: "renders/link_1350x1080.mp4" }] });
    expect((await app.request(`/media?path=${encodeURIComponent(TALL)}`)).status).toBe(200);
    const out = await app.request(`/media?path=${encodeURIComponent(outside)}`);
    expect(out.status).toBe(200);
    expect(await out.text()).toBe("square bytes");
    expect((await app.request(`/media?path=${encodeURIComponent("renders/link_1350x1080.mp4")}`)).status).toBe(404);
  });

  it("the frame route reads a format's own file with ?format= (R12)", async () => {
    let jobs!: ProxyJobs;
    const { call } = await setup([WIDE, TALL], (store) => {
      jobs = new ProxyJobs(store, { available: async () => true });
      return { proxyJobs: jobs };
    });
    const seen: string[] = [];
    vi.spyOn(jobs, "frame").mockImplementation(async (orig: string) => {
      seen.push(orig);
      return Buffer.from(PNG_1PX, "base64");
    });
    await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }] });
    expect((await call("GET", "/api/videos/hero/versions/v1/frame?t=0&format=9x16")).status).toBe(200);
    expect(seen.pop()).toMatch(/hero_1080x1920\.mp4$/);
    expect((await call("GET", "/api/videos/hero/versions/v1/frame?t=0&format=16x9")).status).toBe(200);
    expect(seen.pop()).toMatch(/hero_1920x1080\.mp4$/);
    expect((await call("GET", "/api/videos/hero/versions/v1/frame?t=0&format=4x5")).status).toBe(404);
    expect((await call("GET", "/api/videos/hero/versions/v1/frame?t=0&format=tall")).status).toBe(400);
  });

  it("GET /api/assets lists a cut's formats right after it, in chip order, with their ratio; reveal accepts them", async () => {
    const { call } = await setup([WIDE, TALL, SQUARE]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: SQUARE }, { file: TALL }] });
    const cuts = (await call("GET", "/api/assets?kind=cut")).json.assets;
    expect(cuts.map((a: any) => [a.path, a.format ?? null, a.formatLabel ?? null])).toEqual([[WIDE, null, "16:9"], [TALL, "9x16", "9:16"], [SQUARE, "1x1", "1:1"]]);
    expect((await call("POST", "/api/reveal", { path: TALL })).status).toBe(200);
  });

  it("GET /api/state carries each version's size and formats", async () => {
    const { call } = await setup([WIDE, TALL]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }] });
    const v = (await call("GET", "/api/state")).json.project.videos[0].versions[0];
    expect(v).toMatchObject({ width: 1920, height: 1080, formats: [{ id: "9x16", label: "9:16" }] });
  });
});

describe("notes and formats on the server (§21.3, R7)", () => {
  const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
  async function withNotes() {
    const s = await setup([WIDE, TALL, "renders/solo_1920x1080.mp4"]);
    await s.call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }] });
    await s.call("POST", "/api/versions", { video: "Solo", file: "renders/solo_1920x1080.mp4" });
    const note = (over: Record<string, unknown>) => s.call("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "x", ...over });
    return { ...s, note };
  }

  it("a format must be the note's own cut's; a box needs one; a boxed note keeps its format", async () => {
    const { call, note } = await withNotes();
    expect((await note({ format: "4x5" })).json).toMatchObject({ error: "unknown_format", message: "v1 has no 4:5 format." });
    expect((await note({ box })).json.error).toBe("box_needs_format");
    const boxed = await note({ box, format: "9x16" });
    expect(boxed.status).toBe(201);
    const id = boxed.json.note.id;
    expect((await call("PATCH", `/api/notes/${id}`, { format: null })).json.error).toBe("box_needs_format");
    expect((await call("PATCH", `/api/notes/${id}`, { format: "16x9" })).json.error).toBe("box_fixes_format");
    const plain = (await note({ format: "9x16", t: 2 })).json.note.id;
    expect((await call("PATCH", `/api/notes/${plain}`, { format: null })).json.note.format).toBeNull();
    expect((await call("PATCH", `/api/notes/${plain}`, { format: "9x16" })).json.note.format).toBe("9x16");
    expect((await call("POST", "/api/notes", { stage: "music", scope: "whole", text: "x", format: "9x16" })).json.error).toBe("format_not_picture");
    // A one-format cut keeps today's rule: a box with no format is fine.
    expect((await call("POST", "/api/notes", { stage: "picture", video: "solo", version: "v1", scope: "point", t: 1, text: "x", box })).status).toBe(201);
  });

  it("GET /api/notes filters by format, with the all-format notes unless onlyThisFormat", async () => {
    const { call, note } = await withNotes();
    await note({ text: "all" });
    await note({ text: "tall", format: "9x16", t: 2 });
    await note({ text: "wide", format: "16x9", t: 3 });
    expect((await call("GET", "/api/notes?format=9x16")).json.notes.map((n: any) => n.text)).toEqual(["all", "tall"]);
    expect((await call("GET", "/api/notes?format=9x16&onlyThisFormat=true")).json.notes.map((n: any) => n.text)).toEqual(["tall"]);
    expect((await call("GET", "/api/notes?format=portrait")).status).toBe(400);
  });
});
