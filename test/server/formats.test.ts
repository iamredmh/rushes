import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { probeVideo, type VideoProbe } from "../../src/core/media.js";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { sizedProbe } from "../helpers/probe.js";
import { createApp, type AppOptions } from "../../src/server/app.js";
import { addVersion } from "../../src/core/project.js";
import { ProxyJobs } from "../../src/server/proxy.js";
import { screenshotName } from "../../src/server/assets.js";
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
  it("a second cut whose formats repeat a shape names the files, never the v2 it didn't create; the cut itself counts (final review M7)", async () => {
    const { call, store } = await setup([WIDE, TALL, SQUARE, "renders/hero2_1920x1080.mp4", "renders/hero2_1280x720.mp4", "renders/hero2_1920x804.mp4", "renders/hero2_1920x800.mp4"]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }] });
    const before = await store.read("project");
    const same = await call("POST", "/api/versions", { video: "Hero", file: "renders/hero2_1920x1080.mp4", formats: [{ file: SQUARE }, { file: "renders/hero2_1280x720.mp4" }] });
    expect(same.status).toBe(409);
    expect(same.json.message).toBe("renders/hero2_1280x720.mp4 has the same shape as renders/hero2_1920x1080.mp4 (16:9). Register one render of each shape.");
    expect(same.json.message).not.toMatch(/\bv\d/);
    // Near-identical unusual ratios (M1) are the same shape here too.
    const near = await call("POST", "/api/versions", { video: "Hero", file: "renders/hero2_1920x1080.mp4", formats: [{ file: "renders/hero2_1920x800.mp4" }, { file: "renders/hero2_1920x804.mp4" }] });
    expect(near.json.message).toBe("renders/hero2_1920x804.mp4 has the same shape as renders/hero2_1920x800.mp4 (12:5). Register one render of each shape.");
    expect(await store.read("project")).toEqual(before);
  });

  it("refuses the whole call when one file is refused, and registers nothing (R11)", async () => {
    const { call, store } = await setup([WIDE, TALL]);
    const r = await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }, { file: "renders/gone_1080x1080.mp4" }] });
    expect(r.status).toBe(404);
    expect((await store.read("project")).videos).toEqual([]);
  });

  // Review I3: a refusal raised while saving (two files of one ratio) leaves nothing behind either.
  it("refuses two formats of one ratio in one call, saving nothing and starting nothing (R11)", async () => {
    let jobs!: ProxyJobs;
    const { root, call, store } = await setup([WIDE, TALL, "renders/alt_720x1280.mp4"], (s) => {
      jobs = new ProxyJobs(s, { available: async () => true });
      return { proxyJobs: jobs };
    });
    await store.update("project", (p) => {
      p.autoProxy = true;
    });
    const r = await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }, { file: "renders/alt_720x1280.mp4" }] });
    expect(r.status).toBe(409);
    // Final review M7: the refusal names the two files, never a version that was never created.
    expect(r.json).toMatchObject({ error: "same_ratio", message: "renders/alt_720x1280.mp4 has the same shape as renders/hero_1080x1920.mp4 (9:16). Register one render of each shape." });
    expect((await store.read("project")).videos).toEqual([]);
    expect(jobs.list()).toEqual([]);
    expect(existsSync(join(root, "proxies"))).toBe(false);
    expect(existsSync(join(root, ".rushes", "peaks"))).toBe(false);
  });

  it("says when a format is off the cut's length (review M1)", async () => {
    const { call } = await setup([WIDE, "renders/hero_1080x1920@8.4.mp4", SQUARE]);
    const r = await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: "renders/hero_1080x1920@8.4.mp4" }, { file: SQUARE }] });
    expect(r.status).toBe(201);
    expect(r.json.formatWarnings).toEqual(["9:16 is 8.4 s; the cut is 8.0 s"]);
    expect((await call("POST", "/api/versions", { video: "Hero", file: WIDE })).json.formatWarnings).toBeUndefined();
  });

  it("stores a cut's own size only when it's a picture size, and only when it's a file (review M1)", async () => {
    const { root, call } = await setup(["renders/huge_200000x1080.mp4"]);
    expect((await call("POST", "/api/versions", { video: "Hero", file: "renders/huge_200000x1080.mp4" })).json.version).toMatchObject({ width: null, height: null });
    await mkdir(join(root, "renders", "folder_1920x1080.mp4"), { recursive: true });
    expect((await call("POST", "/api/versions", { video: "Teaser", file: "renders/folder_1920x1080.mp4" })).json.version).toMatchObject({ width: null, height: null });
  });

  it("refuses a folder named like a render as a format, as a missing file (review M1)", async () => {
    const { root, call } = await setup([WIDE]);
    await mkdir(join(root, "renders", "folder_1080x1920.mp4"), { recursive: true });
    await call("POST", "/api/versions", { video: "Hero", file: WIDE });
    expect((await call("POST", "/api/formats", { file: "renders/folder_1080x1920.mp4" })).json).toMatchObject({ error: "missing_file" });
  });

  // Review M2: the cut's own file is judged the same with formats as without.
  it("takes a cut in any container with formats, as it does without, and says plainly when its size is nonsense", async () => {
    const { call, store } = await setup(["renders/hero_1920x1080.mxf", TALL, "renders/huge_200000x1080.mp4"]);
    expect((await call("POST", "/api/versions", { video: "Hero", file: "renders/hero_1920x1080.mxf", formats: [{ file: TALL }] })).status).toBe(201);
    const r = await call("POST", "/api/versions", { video: "Teaser", file: "renders/huge_200000x1080.mp4", formats: [{ file: TALL }] });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ error: "no_primary_size", message: "renders/huge_200000x1080.mp4 measures 200000×1080, which isn't a picture size, so Rushes can't tell its formats' shapes from it." });
    expect((await store.read("project")).videos.map((v) => v.id)).toEqual(["hero"]);
  });

  // CI run 37724786490: the refusal names the first refused file in request order, never whichever
  // read happened to finish first, so the same call always gives the same message.
  it("names the first refused file in the order given, whatever finishes first", async () => {
    // The cut's own read gives up (slowly); the 9:16 is refused at once. The cut is named.
    const slowFirst = async (abs: string): Promise<VideoProbe> =>
      abs.endsWith("hero_1920x1080.mp4") ? new Promise<VideoProbe>(() => undefined) : { ok: false, code: "not_video", reason: "it has no video stream" };
    const a = await setup([WIDE, TALL], { formatProbe: slowFirst, formatProbeTimeoutMs: 100 });
    const r1 = await a.call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }] });
    expect(r1.json).toMatchObject({ error: "unreadable", message: "ffprobe couldn't read renders/hero_1920x1080.mp4: ffprobe took too long" });
    // The cut reads; the 9:16 is refused after a moment and the 1:1 at once. The 9:16 comes first.
    const middle = async (abs: string): Promise<VideoProbe> => {
      if (abs.endsWith("hero_1080x1920.mp4")) return new Promise((res) => setTimeout(() => res({ ok: false, code: "not_video", reason: "it has no video stream" }), 80));
      if (abs.endsWith("hero_1080x1080.mp4")) return { ok: false, code: "unreadable", reason: "Invalid data found when processing input" };
      return sizedProbe(abs);
    };
    const b = await setup([WIDE, TALL, SQUARE], { formatProbe: middle, formatProbeTimeoutMs: 60_000 });
    const r2 = await b.call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }, { file: SQUARE }] });
    expect(r2.json).toMatchObject({ error: "not_video", message: "renders/hero_1080x1920.mp4 isn't a video: it has no video stream." });
    expect((await b.store.read("project")).videos).toEqual([]);
  });

  // Review M6: the reads after a refused file can't change the answer, so they are stopped.
  it("stops reading the files after one that is refused", async () => {
    const signals: AbortSignal[] = [];
    const waits = async (abs: string, signal?: AbortSignal): Promise<VideoProbe> => {
      // The voice file is refused a moment after the reads have started.
      if (abs.endsWith("voice.mp4")) return new Promise((res) => setTimeout(() => res({ ok: false, code: "not_video", reason: "it has no video stream" }), 50));
      if (!abs.endsWith("hero_1080x1920.mp4")) return sizedProbe(abs);
      signals.push(signal!);
      return new Promise<VideoProbe>((res) => signal?.addEventListener("abort", () => res({ ok: false, code: "unreadable", reason: "stopped" })));
    };
    const { call } = await setup([WIDE, TALL, "renders/voice.mp4"], { formatProbe: waits, formatProbeTimeoutMs: 60_000 });
    const r = await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: "renders/voice.mp4" }, { file: TALL }] });
    expect(r.json.error).toBe("not_video");
    await vi.waitFor(() => expect(signals.length === 1 && signals[0].aborted).toBe(true));
  });
});

describe("a read that never answers (review I2)", () => {
  const never = () => new Promise<VideoProbe>(() => undefined);

  it("gives up: the cut goes in with no size, and a format is refused with the reason", async () => {
    const { call } = await setup([WIDE, TALL], { formatProbe: never, formatProbeTimeoutMs: 50 });
    const started = Date.now();
    const cut = await call("POST", "/api/versions", { video: "Hero", file: WIDE });
    expect(cut.status).toBe(201);
    expect(cut.json.version).toMatchObject({ width: null, height: null });
    const r = await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }] });
    expect(r.status).toBe(422);
    expect(r.json.message).toBe("ffprobe couldn't read renders/hero_1920x1080.mp4: ffprobe took too long");
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 15_000);

  it("stops when the server closes", async () => {
    let jobs!: ProxyJobs;
    const { call, store } = await setup([WIDE, TALL], (s) => {
      jobs = new ProxyJobs(s, { available: async () => true });
      return { proxyJobs: jobs, formatProbe: never, formatProbeTimeoutMs: 60_000 };
    });
    await store.update("project", (p) => void addVersion(p, { video: "Hero", file: WIDE, width: 1920, height: 1080, duration: 8 }));
    const pending = call("POST", "/api/formats", { file: TALL });
    setTimeout(() => void jobs.close(), 50);
    const r = await pending;
    expect(r.status).toBe(422);
    expect(r.json.message).toBe("ffprobe couldn't read renders/hero_1080x1920.mp4: ffprobe was stopped");
  }, 10_000);
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

  // Final review M2: a cut or a format whose real file lies outside the project is served only as
  // video (or audio); the library's other kinds (text, images, PDFs) are never served for one.
  it("serves a cut or format that resolves outside only as video or audio; inside the project nothing changes", async () => {
    const { root, app, call, store } = await setup([WIDE, TALL]);
    const out = join(root, "..", "hf");
    await mkdir(out, { recursive: true });
    for (const [name, bytes] of [["notes.txt", "private notes"], ["square.mkv", "mkv bytes"], ["portrait.mov", "mov bytes"], ["still.png", "png bytes"], ["bed.wav", "wav bytes"]]) {
      await writeFile(join(out, name), bytes);
    }
    // A format registered as a link into the project, later swapped to point at a text file outside.
    await symlink(join(out, "square.mkv"), join(root, "renders", "sq_1080x1080.mp4"));
    await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }, { file: "renders/sq_1080x1080.mp4" }] });
    const media = (p: string) => app.request(`/media?path=${encodeURIComponent(p)}`);
    const served = await media("renders/sq_1080x1080.mp4");
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("mkv bytes");
    await rm(join(root, "renders", "sq_1080x1080.mp4"));
    await symlink(join(out, "notes.txt"), join(root, "renders", "sq_1080x1080.mp4"));
    expect((await media("renders/sq_1080x1080.mp4")).status).toBe(404);
    // The same for a cut, and for a format or cut named by its outside path in a hand edit.
    await store.update("project", (p) => {
      addVersion(p, { video: "Teaser", file: join(out, "notes.txt") });
      addVersion(p, { video: "Still", file: join(out, "still.png") });
      addVersion(p, { video: "Portrait", file: join(out, "portrait.mov") });
      addVersion(p, { video: "Bed", file: join(out, "bed.wav") });
      p.videos[0].versions[0].formats.push({ id: "4x5", label: "4:5", file: join(out, "notes.txt"), width: 1080, height: 1350, duration: 8, fps: 30, addedAt: "2026-10-08T00:00:00Z" });
    });
    expect((await media(join(out, "notes.txt"))).status).toBe(404);
    expect((await media(join(out, "still.png"))).status).toBe(404);
    expect((await media(join(out, "portrait.mov"))).status).toBe(200);
    expect((await media(join(out, "bed.wav"))).status).toBe(200);
    // A library file outside keeps its own rules: a registered text file there is still served.
    await call("POST", "/api/files", { kind: "doc", file: join(out, "notes.txt") });
    expect((await media(join(out, "notes.txt"))).status).toBe(200);
    // Inside the project nothing changes: a cut is served whatever its extension.
    await writeFile(join(root, "renders", "cut.txt"), "inside");
    await store.update("project", (p) => void addVersion(p, { video: "Inside", file: "renders/cut.txt" }));
    expect((await media("renders/cut.txt")).status).toBe(200);
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

  it("a box drawn again belongs to the format it's drawn on now (review M1)", async () => {
    const { call, note } = await withNotes();
    const id = (await note({ box, format: "9x16" })).json.note.id;
    const moved = await call("PATCH", `/api/notes/${id}`, { box: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, format: "16x9" });
    expect(moved.status).toBe(200);
    expect(moved.json.note).toMatchObject({ format: "16x9", box: { x: 0.2 } });
  });

  it("GET /api/notes filters by format, with the all-format notes unless onlyThisFormat", async () => {
    const { call, note } = await withNotes();
    await note({ text: "all" });
    await note({ text: "tall", format: "9x16", t: 2 });
    await note({ text: "wide", format: "16x9", t: 3 });
    expect((await call("GET", "/api/notes?format=9x16")).json.notes.map((n: any) => n.text)).toEqual(["all", "tall"]);
    expect((await call("GET", "/api/notes?format=9x16&onlyThisFormat=false")).json.notes.map((n: any) => n.text)).toEqual(["all", "tall"]);
    expect((await call("GET", "/api/notes?format=9x16&onlyThisFormat=true")).json.notes.map((n: any) => n.text)).toEqual(["tall"]);
    expect((await call("GET", "/api/notes?format=portrait")).status).toBe(400);
  });
});

describe("grabs by format (§21.5)", () => {
  it("names a grab with its ratio, and parses the name back", async () => {
    expect(screenshotName("hero", "v1", 30, 30, "9x16")).toBe("hero_v1_9x16_00m01.00s_f30.png");
    expect(screenshotName("hero", "v1", 30, 30)).toBe("hero_v1_00m01.00s_f30.png");
    const { call } = await setup([WIDE, TALL]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }] });
    const r = await call("POST", "/api/grabs", { video: "hero", version: "v1", frame: 30, format: "9x16", png: PNG_1PX });
    expect(r.json.grab).toBe("screenshots/hero_v1_9x16_00m01.00s_f30.png");
    expect((await call("POST", "/api/grabs", { video: "hero", version: "v1", frame: 30, format: "4x5", png: PNG_1PX })).status).toBe(404);
    const shot = (await call("GET", "/api/assets?kind=screenshot")).json.assets[0];
    expect(shot).toMatchObject({ video: "hero", version: "v1", frame: 30, format: "9x16", formatLabel: "9:16" });
  });

  it("a decimal ratio round-trips through the name too", async () => {
    expect(screenshotName("hero", "v1", 30, 30, "2.39x1")).toBe("hero_v1_2.39x1_00m01.00s_f30.png");
    const { call } = await setup([WIDE, "renders/hero_2390x1000.mp4"]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: "renders/hero_2390x1000.mp4" }] });
    expect((await call("POST", "/api/grabs", { video: "hero", version: "v1", frame: 45, format: "2.39x1", png: PNG_1PX })).json.grab).toBe("screenshots/hero_v1_2.39x1_00m01.50s_f45.png");
    expect((await call("GET", "/api/assets?kind=screenshot")).json.assets[0]).toMatchObject({ frame: 45, t: 1.5, format: "2.39x1", formatLabel: "2.39:1" });
  });

  it("the primary's grab carries its ratio once the cut has formats, with or without `format` (carried ruling: the dashboard sends none for it)", async () => {
    const { call } = await setup([WIDE, TALL]);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }] });
    expect((await call("POST", "/api/grabs", { video: "hero", version: "v1", frame: 30, png: PNG_1PX })).json.grab).toBe("screenshots/hero_v1_16x9_00m01.00s_f30.png");
    expect((await call("POST", "/api/grabs", { video: "hero", version: "v1", frame: 60, format: "16x9", png: PNG_1PX })).json.grab).toBe("screenshots/hero_v1_16x9_00m02.00s_f60.png");
  });

  it("a one-format cut, an older cut with formats but no stored size, and a bad format keep today's rules", async () => {
    const { call, store } = await setup([WIDE, TALL, "renders/solo_1920x1080.mp4"]);
    await call("POST", "/api/versions", { video: "Solo", file: "renders/solo_1920x1080.mp4" });
    expect((await call("POST", "/api/grabs", { video: "solo", version: "v1", frame: 30, png: PNG_1PX })).json.grab).toBe("screenshots/solo_v1_00m01.00s_f30.png");
    // A one-format cut has only its primary: naming it with `format` is refused, as on the frame route.
    expect((await call("POST", "/api/grabs", { video: "solo", version: "v1", frame: 30, format: "9x16", png: PNG_1PX })).status).toBe(404);
    await call("POST", "/api/versions", { video: "Hero", file: WIDE, formats: [{ file: TALL }] });
    await store.update("project", (p) => {
      const v = p.videos.find((x) => x.id === "hero")!.versions[0];
      v.width = null;
      v.height = null;
    });
    // The primary's shape is unknown (a hand edit): its grab keeps the plain name, and its id is not a format.
    expect((await call("POST", "/api/grabs", { video: "hero", version: "v1", frame: 30, png: PNG_1PX })).json.grab).toBe("screenshots/hero_v1_00m01.00s_f30.png");
    expect((await call("POST", "/api/grabs", { video: "hero", version: "v1", frame: 30, format: "16x9", png: PNG_1PX })).status).toBe(404);
    expect((await call("POST", "/api/grabs", { video: "hero", version: "v1", frame: 30, format: "9x16", png: PNG_1PX })).json.grab).toBe("screenshots/hero_v1_9x16_00m01.00s_f30.png");
    expect((await call("POST", "/api/grabs", { video: "hero", version: "v9", frame: 30, format: "9x16", png: PNG_1PX })).status).toBe(404);
    expect((await call("POST", "/api/grabs", { video: "hero", version: "v1", frame: 30, format: "9:16", png: PNG_1PX })).status).toBe(400);
    expect((await call("POST", "/api/grabs", { video: "hero", version: "v1", frame: 30, format: "../x", png: PNG_1PX })).status).toBe(400);
  });
});

const hasFf = ["ffmpeg", "ffprobe"].every((b) => spawnSync(b, ["-version"], { stdio: "ignore" }).status === 0);

// Final review I1: ffprobe reads a file by its content, so a playlist or a GIF named .mp4 is refused
// by container, as a format and as a cut; ordinary containers still come in.
describe.skipIf(!hasFf)("a playlist or a GIF named .mp4, with the real ffprobe (final review I1)", () => {
  const realProbe = { formatProbe: (abs: string, signal?: AbortSignal) => probeVideo(abs, { signal }) };
  const render = (root: string, name: string, size: string, args: string[] = ["-c:v", "libx264", "-pix_fmt", "yuv420p"]) => {
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=30:duration=1`, ...args, join(root, name)]);
    if (r.status !== 0) throw new Error(String(r.stderr));
    return name;
  };
  const traps = async (root: string) => {
    await mkdir(join(root, "renders"), { recursive: true });
    render(root, "renders/inner.mp4", "64x36");
    await writeFile(join(root, "renders", "cat.mp4"), "ffconcat version 1.0\nfile inner.mp4\n");
    render(root, "renders/gif.mp4", "64x36", ["-f", "gif"]);
  };

  it("refuses them as a format, and as a cut on its own or with formats; nothing is registered", async () => {
    const { root, call, store } = await setup([], realProbe);
    await traps(root);
    render(root, "renders/wide.mp4", "64x36");
    render(root, "renders/tall.mp4", "36x64");
    for (const bad of ["renders/cat.mp4", "renders/gif.mp4"]) {
      const kind = bad.includes("cat") ? "concat" : "gif";
      const cut = await call("POST", "/api/versions", { video: "Hero", file: bad });
      expect(cut.status, bad).toBe(400);
      expect(cut.json).toMatchObject({ error: "not_video", message: `${bad} isn't a video: it's a ${kind} file.` });
      expect((await call("POST", "/api/versions", { video: "Hero", file: bad, formats: [{ file: "renders/tall.mp4" }] })).json.error).toBe("not_video");
      expect((await call("POST", "/api/versions", { video: "Hero", file: "renders/wide.mp4", formats: [{ file: bad }] })).json.error).toBe("not_video");
    }
    expect((await store.read("project")).videos).toEqual([]);
    await call("POST", "/api/versions", { video: "Hero", file: "renders/wide.mp4" });
    for (const bad of ["renders/cat.mp4", "renders/gif.mp4"]) expect((await call("POST", "/api/formats", { file: bad })).json.error).toBe("not_video");
    expect((await store.read("project")).videos[0].versions).toHaveLength(1);
    expect((await store.read("project")).videos[0].versions[0].formats).toEqual([]);
  });

  it("still registers mp4, mov, webm and mkv as cuts and formats, and avi, mpegts and junk bytes as cuts (no new gate by extension)", async () => {
    const { root, call } = await setup([], realProbe);
    await mkdir(join(root, "renders"), { recursive: true });
    const h264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p"];
    const cuts: [string, string[]][] = [["a.mp4", h264], ["a.mov", h264], ["a.webm", ["-c:v", "libvpx-vp9", "-b:v", "200k"]], ["a.mkv", h264], ["a.avi", ["-c:v", "mpeg4"]], ["a.ts", ["-c:v", "mpeg2video"]]];
    for (const [name, args] of cuts) {
      const r = await call("POST", "/api/versions", { video: `Film ${name}`, file: render(root, `renders/${name}`, "64x36", args) });
      expect(r.status, name).toBe(201);
      expect(r.json.version, name).toMatchObject({ width: 64, height: 36 });
    }
    // Junk bytes stay as they were: unreadable, so the cut comes in with no size.
    await writeFile(join(root, "renders", "junk.mp4"), "not a video at all");
    expect((await call("POST", "/api/versions", { video: "Junk", file: "renders/junk.mp4" })).json.version).toMatchObject({ width: null, height: null });
    const shapes: [string, string, string[]][] = [["t.mp4", "36x64", h264], ["s.mov", "64x64", h264], ["p.webm", "64x80", ["-c:v", "libvpx-vp9", "-b:v", "200k"]], ["c.mkv", "48x36", h264]];
    for (const [name, size, args] of shapes) {
      const r = await call("POST", "/api/formats", { video: "Film a.mp4", file: render(root, `renders/${name}`, size, args) });
      expect(r.status, name).toBe(201);
    }
  });
});
