import { describe, expect, it, vi } from "vitest";
import { access, mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";

// Counts the folders a walk opens, so a test can tell a walk that stopped from one that ran on.
const fsSpy = vi.hoisted(() => ({ opendirs: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    opendir: ((...args: Parameters<typeof actual.opendir>) => {
      fsSpy.opendirs++;
      return actual.opendir(...args);
    }) as typeof actual.opendir,
  };
});
import { dirname, isAbsolute, join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { createApp } from "../../src/server/app.js";
import { FoundScanner, roundName, type FoundEntry } from "../../src/server/found.js";
import { startServer } from "../../src/server/start.js";
import { addFormat, addVariant, addVersion, ensureProjectIdOnce } from "../../src/core/project.js";
import type { Store } from "../../src/core/store.js";
import type { ScanLimits } from "../../src/core/found.js";

type ProbeFn = (abs: string, signal?: AbortSignal) => Promise<number | null>;

/** A probe that answers from a table of file names (anything else is unknown). */
const byName = (table: Record<string, number> = {}): ProbeFn => async (abs) => table[abs.split("/").pop()!] ?? null;

/** A probe that never answers: nothing may wait on it. */
const never: ProbeFn = () => new Promise<number | null>(() => undefined);

async function put(root: string, rel: string, text = "bytes") {
  const abs = join(root, ...rel.split("/"));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, text);
  return abs;
}

async function setup(opts: { files?: string[]; probe?: ProbeFn; limits?: Partial<ScanLimits>; adoptWaitMs?: number; waitMs?: number } = {}) {
  const { root, store } = await tmpProject("found");
  for (const f of opts.files ?? []) await put(root, f);
  let announced = 0;
  const scanner = new FoundScanner({ store, probe: opts.probe ?? byName(), announce: () => void announced++, limits: opts.limits, adoptWaitMs: opts.adoptWaitMs });
  const app = createApp(store, { found: scanner, foundWaitMs: opts.waitMs });
  const call = (path: string, init: RequestInit = {}) => app.request(path, init);
  const post = (path: string, json: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(json) });
  return { root, store, scanner, app, call, post, announced: () => announced };
}

const paths = (files: FoundEntry[]) => files.map((f) => f.path).sort();

async function registerVariant(store: Store, file: string, stage: "voice" | "music" | "sfx" = "music") {
  await store.update("project", (p) => addVariant(p, { stage, name: `take ${p.lanes.reduce((n, l) => n + l.variants.length, 0) + 1}`, file }));
}

async function isCaseInsensitive(dir: string): Promise<boolean> {
  await writeFile(join(dir, "CaseProbe.tmp"), "");
  try {
    await access(join(dir, "caseprobe.TMP"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(join(dir, "CaseProbe.tmp"), { force: true });
  }
}

describe("FoundScanner", () => {
  it("never offers a file that is registered as another format of a cut (§21)", async () => {
    const { store, scanner, post } = await setup({ files: ["renders/hero_1920x1080.mp4", "renders/hero_1080x1920.mp4", "renders/teaser.mov"] });
    await store.update("project", (p) => {
      addVersion(p, { video: "Hero", file: "renders/hero_1920x1080.mp4", width: 1920, height: 1080 });
      addFormat(p, { file: "renders/hero_1080x1920.mp4", width: 1080, height: 1920, duration: 8, fps: 30 });
    });
    await scanner.scan();
    expect(paths(await scanner.list())).toEqual(["renders/teaser.mov"]);
    expect(scanner.has("renders/hero_1080x1920.mp4")).toBe(false);
    // Bringing it in by hand says it's already in, rather than registering it again as a cut.
    const r = (await (await post("/api/found/bring-in", { files: [{ path: "renders/hero_1080x1920.mp4", kind: "cut" }] })).json()) as { added: unknown[]; failed: { code: string }[] };
    expect(r.added).toEqual([]);
    expect(r.failed.map((f) => f.code)).toEqual(["already"]);
    expect((await store.read("project")).videos[0].versions).toHaveLength(1);
  });

  it("lists the folder's audio and cuts with their kinds, and leaves out a file once it's registered", async () => {
    const { store, scanner } = await setup({ files: ["vo_jules/line 1.wav", "bed/theme a.mp3", "sfx/whoosh.wav", "stems/drums.wav", "renders/alt cut.mov", "notes.txt"] });
    await scanner.scan();
    const files = await scanner.list();
    expect(files.map((f) => [f.path, f.kind])).toEqual(
      expect.arrayContaining([
        ["vo_jules/line 1.wav", "voice"],
        ["bed/theme a.mp3", "music"],
        ["sfx/whoosh.wav", "sfx"],
        ["stems/drums.wav", "other"],
        ["renders/alt cut.mov", "cut"],
      ]),
    );
    expect(files).toHaveLength(5);
    expect(scanner.has("bed/theme a.mp3")).toBe(true);

    // Registered after the scan, by path: gone from the list straight away, without a rescan.
    await registerVariant(store, "bed/theme a.mp3");
    expect(paths(await scanner.list())).not.toContain("bed/theme a.mp3");
    expect(scanner.has("bed/theme a.mp3")).toBe(false);
    expect((await scanner.summary()).counts).toEqual({ voice: 1, music: 0, sfx: 1, cut: 1, other: 1 });
  });

  it("leaves out every kind of registered file: cuts, variants, takes and library files", async () => {
    const { store, scanner } = await setup({ files: ["renders/hero v1.mov", "vo/a.wav", "takes/t1.wav", "music/b.wav", "keep/c.wav"] });
    await store.update("project", (p) => {
      addVersion(p, { video: "hero", file: "renders/hero v1.mov", duration: null, fps: null });
      addVariant(p, { stage: "voice", name: "a", file: "vo/a.wav" });
      p.files.push({ id: "f1", kind: "doc", file: "music/b.wav", name: "b", note: "", video: null, addedAt: new Date().toISOString() });
    });
    await store.update("script", (s) => {
      s.sections.push({ id: "s1", start: 0, end: 2, current: "Hi", proposed: null, direction: "", status: "draft", takes: [{ id: "t1", file: "takes/t1.wav", duration: null, forText: "Hi" }] });
    });
    await scanner.scan();
    expect(paths(await scanner.list())).toEqual(["keep/c.wav"]);
  });

  it("matches a registered file by its real path, whatever its spelling (absolute, a case-different symlink)", async () => {
    const { root, store, scanner } = await setup({ files: ["music/Theme Song.wav", "music/other.wav", "vo/line.wav"] });
    // Absolute spelling of a real file.
    await registerVariant(store, join(root, "vo", "line.wav"), "voice");
    // A symlink to the real file, registered under a case-different spelling of the link.
    await mkdir(join(root, "links"));
    await symlink(join(root, "music", "Theme Song.wav"), join(root, "links", "theme-link.wav"));
    const insensitive = await isCaseInsensitive(root);
    await registerVariant(store, insensitive ? "LINKS/Theme-Link.WAV" : "links/theme-link.wav");
    await scanner.scan();
    const listed = paths(await scanner.list());
    expect(listed).toEqual(["music/other.wav"]);
    expect(listed).not.toContain("links/theme-link.wav"); // a symlink is never listed in any case
  });

  it.runIf(process.platform === "darwin")("on macOS, a case-different spelling of a registered file doesn't slip through", async () => {
    const { root, store, scanner } = await setup({ files: ["Bed/Main Theme.WAV", "bed2/x.wav"] });
    if (!(await isCaseInsensitive(root))) return;
    await registerVariant(store, "bed/main theme.wav");
    await scanner.scan();
    expect(paths(await scanner.list())).toEqual(["bed2/x.wav"]);
  });

  it("probes two files at a time, caches by path, size and mtime, and announces when results land", async () => {
    const gates: { abs: string; resolve: (d: number | null) => void }[] = [];
    let running = 0;
    let most = 0;
    let calls = 0;
    const probe: ProbeFn = (abs) => {
      calls++;
      running++;
      most = Math.max(most, running);
      return new Promise((resolve) => gates.push({ abs, resolve: (d) => { running--; resolve(d); } }));
    };
    const files = ["a/1.wav", "a/2.wav", "a/3.wav", "a/4.wav", "a/5.wav"];
    const { scanner, announced } = await setup({ files, probe });
    await scanner.scan();
    const before = announced();
    expect(running).toBe(2);
    while (gates.length) {
      gates.shift()!.resolve(12);
      await new Promise((r) => setImmediate(r));
      expect(running).toBeLessThanOrEqual(2);
    }
    await scanner.settled();
    expect(most).toBe(2);
    expect(calls).toBe(5);
    expect(announced()).toBeGreaterThan(before);
    expect((await scanner.list()).every((f) => f.duration === 12)).toBe(true);

    // A second scan of the same, unchanged files probes nothing again.
    await scanner.scan();
    await scanner.settled();
    expect(calls).toBe(5);
  });

  it("dismisses and restores paths, keeping the dismissed manifest paths in found.json", async () => {
    const { root, store, scanner } = await setup({ files: ["vo/take 1.wav", "vo/take 2.wav"] });
    await scanner.scan();
    await scanner.dismiss([join(root, "vo", "take 2.wav")]);
    expect(paths(await scanner.list())).toEqual(["vo/take 1.wav"]);
    expect(scanner.has("vo/take 2.wav")).toBe(false);
    expect((await store.read("found")).dismissed).toEqual(["vo/take 2.wav"]);
    // Still dismissed after a rescan, and after a fresh scanner reads found.json.
    await scanner.scan();
    expect(paths(await scanner.list())).toEqual(["vo/take 1.wav"]);
    const again = new FoundScanner({ store, probe: byName(), announce: () => undefined });
    await again.scan();
    expect(paths(await again.list())).toEqual(["vo/take 1.wav"]);

    await scanner.restore(["vo/take 2.wav"]);
    expect(paths(await scanner.list())).toEqual(["vo/take 1.wav", "vo/take 2.wav"]);
    expect(scanner.has("vo/take 2.wav")).toBe(true);
    expect((await store.read("found")).dismissed).toEqual([]);
  });

  it("reports complete: false when the scan stops at its limits", async () => {
    const files = Array.from({ length: 12 }, (_, i) => `many/clip ${String(i).padStart(2, "0")}.wav`);
    const { scanner } = await setup({ files, limits: { maxExamined: 5 } });
    await scanner.scan();
    await scanner.settled();
    const s = await scanner.summary();
    expect(s.complete).toBe(false);
    expect(s.scanning).toBe(false);
    expect(s.scannedAt).not.toBeNull();
  });

  it("when the first pass runs out of time, carries on in the background and completes", async () => {
    const { scanner, announced } = await setup({ files: ["vo/a.wav", "bed/b.wav"], limits: { budgetMs: 0 } });
    await scanner.scan();
    expect((await scanner.summary()).complete).toBe(false);
    await scanner.settled();
    const s = await scanner.summary();
    expect(s.complete).toBe(true);
    expect(s.scanning).toBe(false);
    expect(paths(await scanner.list())).toEqual(["bed/b.wav", "vo/a.wav"]);
    expect(announced()).toBeGreaterThan(0);
  });

  it("with no registered cut, nothing is scored or suggested", async () => {
    const { scanner } = await setup({ files: ["bed/hero v3 music.wav", "vo/hero v3 read.wav"], probe: byName({ "hero v3 music.wav": 60, "hero v3 read.wav": 60 }) });
    await scanner.scan();
    await scanner.settled();
    const files = await scanner.list();
    expect(files).toHaveLength(2);
    for (const f of files) expect(f).toMatchObject({ score: null, reasons: [], suggested: false });
  });

  it("scores audio against the film's newest cut and suggests the clear winner per kind", async () => {
    const { root, store, scanner } = await setup({
      files: ["renders/hero v2.mov", "renders/hero v3.mov", "bed/hero v3 music.wav", "vo/old read.wav"],
      probe: byName({ "hero v3 music.wav": 60, "old read.wav": 5 }),
    });
    const old = new Date(Date.now() - 30 * 24 * 3600e3);
    await utimes(join(root, "vo", "old read.wav"), old, old);
    await store.update("project", (p) => {
      addVersion(p, { video: "hero", file: "renders/hero v2.mov", duration: 30, fps: 25 });
      addVersion(p, { video: "hero", file: "renders/hero v3.mov", duration: 60, fps: 25 });
    });
    await scanner.scan({ film: "hero" });
    await scanner.settled();
    const files = await scanner.list();
    const music = files.find((f) => f.path === "bed/hero v3 music.wav")!;
    expect(music.suggested).toBe(true);
    expect(music.score).toBeGreaterThanOrEqual(4);
    expect(music.reasons[0]).toBe("same length as the cut (60.0 s vs 60.0 s)");
    const vo = files.find((f) => f.path === "vo/old read.wav")!;
    expect(vo.suggested).toBe(false);
    expect(files[0].path).toBe("bed/hero v3 music.wav"); // best score first
  });

  it("close() stops probing: nothing queued is started and nothing is announced afterwards", async () => {
    let calls = 0;
    const probe: ProbeFn = () => {
      calls++;
      return never("");
    };
    const { scanner, announced } = await setup({ files: ["a/1.wav", "a/2.wav", "a/3.wav", "a/4.wav"], probe });
    await scanner.scan();
    expect(calls).toBe(2);
    const before = announced();
    scanner.close();
    await scanner.settled();
    expect(calls).toBe(2);
    await scanner.scan();
    expect(calls).toBe(2);
    expect(announced()).toBe(before);
  });

  it("close() during a scan stops the walk between folders, and nothing is announced afterwards", async () => {
    const files = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, "0")}/sub/a.wav`);
    const { scanner, announced } = await setup({ files });
    const first = scanner.scan();
    const opened = fsSpy.opendirs;
    const before = announced();
    scanner.close();
    await first;
    await scanner.settled();
    // The root at most: none of the 80 folders below it is opened once the walk is stopped.
    expect(fsSpy.opendirs - opened).toBeLessThanOrEqual(1);
    expect(announced()).toBe(before);
    expect((await scanner.summary()).scanning).toBe(false);
  });

  it("a probe that rejects, or throws before returning a promise, leaves the duration unknown and the scan finished", async () => {
    let n = 0;
    const probe: ProbeFn = (abs) => {
      n++;
      if (abs.endsWith("throws.wav")) throw new Error("ffprobe blew up synchronously");
      return Promise.reject(new Error("ffprobe failed"));
    };
    const { scanner } = await setup({ files: ["vo/rejects.wav", "vo/throws.wav", "vo/also.wav"], probe });
    await scanner.scan();
    await scanner.settled();
    expect(n).toBe(3);
    const s = await scanner.summary();
    expect(s.scanning).toBe(false);
    expect(s.counts.voice).toBe(3);
    expect((await scanner.list()).map((f) => f.duration)).toEqual([null, null, null]);
  });

  it("drops dismiss paths that aren't plain files inside the project, and keeps no duplicates", async () => {
    const { root, store, scanner } = await setup({ files: ["vo/a.wav", "vo/b.wav", "bed/real.wav"] });
    await symlink(join(root, "bed"), join(root, "bedlink"));
    await scanner.scan();
    await scanner.dismiss([
      "nonsense",
      "vo/missing.wav",
      "vo//a.wav",
      "./vo/a.wav",
      "vo",
      "bedlink/real.wav", // reached through a symlinked folder
      "../outside.wav",
      join(dirname(root), "elsewhere.wav"),
      "vo/b.wav",
      "vo/b.wav",
    ]);
    expect((await store.read("found")).dismissed).toEqual(["vo/b.wav"]);
    // A repeat dismiss adds nothing.
    await scanner.dismiss(["vo/b.wav"]);
    expect((await store.read("found")).dismissed).toEqual(["vo/b.wav"]);
    // Nothing but junk: found.json isn't touched.
    const rev = (await store.read("found")).rev;
    await scanner.dismiss(["nonsense", "vo//a.wav"]);
    expect((await store.read("found")).rev).toBe(rev);
    expect(paths(await scanner.list())).toEqual(["bed/real.wav", "vo/a.wav"]);
  });

  it("a summary() racing a dismiss never brings the dismissed path back into has()", async () => {
    const { store, scanner } = await setup({ files: ["vo/a.wav", "vo/b.wav"] });
    await scanner.scan();
    // The summary's read of found.json takes the old contents, then is held until the dismiss lands.
    const read = store.read.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    let armed = true;
    const spyRead = vi.spyOn(store, "read").mockImplementation((async (key: Parameters<Store["read"]>[0]) => {
      const data = await read(key);
      if (key === "found" && armed) {
        armed = false;
        entered();
        await gate;
      }
      return data;
    }) as Store["read"]);
    const racing = scanner.summary();
    await inside;
    await scanner.dismiss(["vo/a.wav"]);
    expect(scanner.has("vo/a.wav")).toBe(false);
    release();
    const s = await racing;
    spyRead.mockRestore();
    expect(scanner.has("vo/a.wav")).toBe(false);
    expect(s.counts.voice).toBe(1);
    expect(paths(await scanner.list())).toEqual(["vo/b.wav"]);
  });

  it("joins a scan already running rather than starting a second", async () => {
    const { scanner } = await setup({ files: ["vo/a.wav"] });
    const a = scanner.scan();
    const b = scanner.scan();
    expect(b).toBe(a);
    await a;
  });
});

describe("found routes", () => {
  it("GET /api/state never waits on a probe, and carries the found summary", async () => {
    const { scanner, call } = await setup({ files: ["vo/a.wav", "bed/b.wav", "renders/c.mov"], probe: never });
    await scanner.scan();
    const started = Date.now();
    const res = await call("/api/state");
    expect(Date.now() - started).toBeLessThan(500);
    expect(res.status).toBe(200);
    const { found } = await res.json();
    expect(found).toMatchObject({ scanning: false, complete: true, counts: { voice: 1, music: 1, sfx: 0, cut: 1, other: 0 }, broughtIn: [] });
    expect(typeof found.scannedAt).toBe("string");
    // The list route doesn't wait on the probes either.
    const t2 = Date.now();
    const list = await (await call("/api/found")).json();
    expect(Date.now() - t2).toBeLessThan(500);
    expect(list.files).toHaveLength(3);
    expect(list.files[0]).not.toHaveProperty("abs");
    expect(Object.keys(list.files[0]).sort()).toEqual(["duration", "folder", "kind", "modified", "path", "reasons", "score", "size", "suggested"]);
    scanner.close();
  });

  it("GET /api/state before any scan says nothing has been scanned", async () => {
    const { call } = await setup();
    const { found } = await (await call("/api/state")).json();
    expect(found).toEqual({ scanning: false, scannedAt: null, complete: false, counts: { voice: 0, music: 0, sfx: 0, cut: 0, other: 0 }, broughtIn: [], digest: expect.any(String) });
  });

  it("POST /api/found/scan answers at once and scans in the background", async () => {
    const { scanner, post, call } = await setup({ files: ["vo/a.wav"], probe: never });
    const started = Date.now();
    const res = await post("/api/found/scan", {});
    expect(Date.now() - started).toBeLessThan(500);
    expect(await res.json()).toEqual({ ok: true });
    await scanner.scan(); // joins the running scan, or finds it done
    expect(paths((await (await call("/api/found")).json()).files)).toEqual(["vo/a.wav"]);
    expect((await post("/api/found/scan", { film: 5 })).status).toBe(400);
    scanner.close();
  });

  it("POST /api/found/dismiss and /restore change the list, and validate their bodies", async () => {
    const { scanner, post, call } = await setup({ files: ["vo/a.wav", "vo/b.wav"] });
    await scanner.scan();
    expect((await post("/api/found/dismiss", { paths: ["vo/a.wav"] })).status).toBe(200);
    expect(paths((await (await call("/api/found")).json()).files)).toEqual(["vo/b.wav"]);
    expect((await post("/api/found/restore", { paths: ["vo/a.wav"] })).status).toBe(200);
    expect(paths((await (await call("/api/found")).json()).files)).toEqual(["vo/a.wav", "vo/b.wav"]);
    const tooMany = Array.from({ length: 501 }, (_, i) => `x/${i}.wav`);
    expect((await post("/api/found/dismiss", { paths: tooMany })).status).toBe(400);
    expect((await post("/api/found/restore", { paths: tooMany })).status).toBe(400);
    expect((await post("/api/found/dismiss", { nope: true })).status).toBe(400);
  });

  it("GET /api/found lists the hidden files too, with no abs, so the dashboard can restore them", async () => {
    const { scanner, post, call, store } = await setup({ files: ["vo/a.wav", "vo/b.wav", "bed/c.wav"], probe: byName({ "a.wav": 3 }) });
    await scanner.scan();
    await scanner.settled();
    expect((await (await call("/api/found")).json()).hidden).toEqual([]);
    await post("/api/found/dismiss", { paths: ["vo/a.wav", "bed/c.wav"] });
    const { files, hidden } = await (await call("/api/found")).json();
    expect(paths(files)).toEqual(["vo/b.wav"]);
    expect(hidden.map((h: { path: string }) => h.path)).toEqual(["bed/c.wav", "vo/a.wav"]);
    expect(Object.keys(hidden[0]).sort()).toEqual(["duration", "folder", "kind", "modified", "path", "size"]);
    expect(hidden.find((h: { path: string }) => h.path === "vo/a.wav")).toMatchObject({ kind: "voice", folder: "vo", duration: 3 });
    // A restored file is back in the list and gone from the hidden ones.
    await post("/api/found/restore", { paths: ["vo/a.wav"] });
    const again = await (await call("/api/found")).json();
    expect(paths(again.files)).toEqual(["vo/a.wav", "vo/b.wav"]);
    expect(again.hidden.map((h: { path: string }) => h.path)).toEqual(["bed/c.wav"]);
    // A hidden file that has since been brought in by hand is not listed as hidden.
    await store.update("project", (p) => addVariant(p, { stage: "music", name: "c", file: "bed/c.wav" }));
    expect((await (await call("/api/found")).json()).hidden).toEqual([]);
    scanner.close();
  });

  it("the state's digest names the files, not just how many: it changes when one file is swapped for another", async () => {
    const { scanner, call, root } = await setup({ files: ["vo/a.wav", "bed/b.wav"] });
    await scanner.scan();
    const digest = async () => (await (await call("/api/state")).json()).found.digest as string;
    const first = await digest();
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(await digest()).toBe(first);
    // The same two files, the same counts: one is replaced by another of the same kind.
    await rm(`${root}/vo/a.wav`);
    await put(root, "vo/c.wav");
    await scanner.scan();
    const second = await digest();
    const counts = (await (await call("/api/state")).json()).found.counts;
    expect(counts).toMatchObject({ voice: 1, music: 1 });
    expect(second).not.toBe(first);
    // Bringing one in changes it too, and a new scan that finds nothing new leaves it be.
    await scanner.scan();
    expect(await digest()).toBe(second);
    scanner.close();
  });

  it("POST /api/found/bring-in gives each refusal a code, so no caller matches the words", async () => {
    const { scanner, post, store, root } = await setup({ files: ["vo/a.wav", "vo/b.wav", "stems/pad.wav"] });
    await scanner.scan();
    await store.update("project", (p) => addVariant(p, { stage: "voice", name: "b", file: "vo/b.wav" }));
    await rm(`${root}/vo/a.wav`);
    // A voice round called "Music" would take the music lane's name: refused in words that are not one of the fixed lines.
    const res = await (
      await post("/api/found/bring-in", {
        files: [{ path: "../x.wav" }, { path: "vo/a.wav" }, { path: "vo/b.wav" }, { path: "stems/pad.wav" }, { path: "vo/.hidden.wav" }, { path: "stems/pad.wav", kind: "voice", round: "Music" }],
      })
    ).json();
    expect(res.failed.map((f: { code: string }) => f.code)).toEqual(["outside", "gone", "already", "chooseKind", "hiddenFile", "other"]);
    expect(res.failed[2]).toEqual({ path: "vo/b.wav", reason: "Already in the project.", code: "already" });
    scanner.close();
  });

  it("every found route keeps the project identity guard (a different project is 409)", async () => {
    const { store, scanner, call, post } = await setup({ files: ["vo/a.wav"] });
    const id = await ensureProjectIdOnce(store);
    await scanner.scan();
    const wrong = { "x-rushes-project": "zzzzzzzz" };
    expect((await call("/api/found", { headers: wrong })).status).toBe(409);
    expect((await post("/api/found/scan", {}, wrong)).status).toBe(409);
    expect((await post("/api/found/dismiss", { paths: ["vo/a.wav"] }, wrong)).status).toBe(409);
    expect((await post("/api/found/restore", { paths: ["vo/a.wav"] }, wrong)).status).toBe(409);
    expect((await call("/media?path=vo%2Fa.wav&project=zzzzzzzz")).status).toBe(409);
    expect((await call("/api/found", { headers: { "x-rushes-project": id } })).status).toBe(200);
    expect(paths(await scanner.list())).toEqual(["vo/a.wav"]); // the refused dismiss changed nothing
  });
});

describe("/media and found files", () => {
  const media = (path: string) => `/media?path=${encodeURIComponent(path)}`;

  it("serves a current found candidate with the sandbox headers", async () => {
    const { scanner, call } = await setup({ files: ["vo_jules/line 1 é.wav"] });
    // Not served before a scan has recorded it.
    expect((await call(media("vo_jules/line 1 é.wav"))).status).toBe(404);
    await scanner.scan();
    const res = await call(media("vo_jules/line 1 é.wav"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(await res.text()).toBe("bytes");
    const ranged = await call(media("vo_jules/line 1 é.wav"), { headers: { range: "bytes=1-2" } });
    expect(ranged.status).toBe(206);
  });

  it("serves exactly the file the scan recorded when a name's NFC and NFD spellings differ", async () => {
    const nfd = "vo/Café line.wav"; // decomposed é
    const nfc = "vo/Café line.wav"; // composed é
    const { root, scanner, call } = await setup();
    await put(root, nfd, "decomposed");
    await scanner.scan();
    const listed = paths(await scanner.list());
    expect(listed).toHaveLength(1);
    const recorded = listed[0];
    const res = await call(media(recorded));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("decomposed");
    // The other spelling isn't what the scan recorded, so it isn't a candidate.
    const other = recorded === nfd ? nfc : nfd;
    expect(scanner.has(other)).toBe(false);
    expect((await call(media(other))).status).toBe(404);
  });

  it("refuses a dismissed, an unknown, an outside and a symlinked path", async () => {
    const { root, scanner, call } = await setup({ files: ["vo/a.wav", "vo/b.wav", "vo/c.wav"] });
    const outside = await put(dirname(root), "outside.wav", "secret");
    await symlink(outside, join(root, "vo", "escape.wav"));
    await symlink(join(root, "vo", "a.wav"), join(root, "vo", "inside-link.wav"));
    await scanner.scan();
    await scanner.dismiss(["vo/b.wav"]);
    expect((await call(media("vo/a.wav"))).status).toBe(200);
    expect((await call(media("vo/b.wav"))).status).toBe(404); // dismissed
    expect((await call(media("vo/nothing.wav"))).status).toBe(404); // unknown
    expect((await call(media("../outside.wav"))).status).toBe(404); // outside the root
    expect((await call(media(outside))).status).toBe(404); // absolute, outside
    expect((await call(media("vo/escape.wav"))).status).toBe(404); // symlink out
    expect((await call(media("vo/inside-link.wav"))).status).toBe(404); // symlink in
    expect((await call(media("vo/../vo/a.wav"))).status).toBe(404); // a different spelling of a candidate

    // A candidate swapped for a symlink after the scan recorded it is refused too.
    await rm(join(root, "vo", "c.wav"));
    await symlink(outside, join(root, "vo", "c.wav"));
    expect(scanner.has("vo/c.wav")).toBe(true);
    const res = await call(media("vo/c.wav"));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("secret");
  });

  it("refuses a candidate whose folder was swapped for a symlink leading outside", async () => {
    const { root, scanner, call } = await setup({ files: ["deep/x/a.wav"] });
    await scanner.scan();
    const elsewhere = join(dirname(root), "elsewhere");
    await put(elsewhere, "a.wav", "secret");
    await rm(join(root, "deep", "x"), { recursive: true });
    await symlink(elsewhere, join(root, "deep", "x"));
    expect((await call(media("deep/x/a.wav"))).status).toBe(404);
  });
});

describe("start-up scan", () => {
  it("runs a first scan without delaying start-up, and close() stops it", async () => {
    const { root } = await tmpProject("startup");
    for (const f of ["vo/a.wav", "bed/b.wav"]) await put(root, f);
    let calls = 0;
    const started = Date.now();
    const s = await startServer(root, {
      port: 0,
      found: {
        probe: () => {
          calls++;
          return never("");
        },
      },
    });
    expect(Date.now() - started).toBeLessThan(2000);
    // The state answers while the probes hang.
    const t = Date.now();
    const state = await (await fetch(`${s.url}/api/state`)).json();
    expect(Date.now() - t).toBeLessThan(500);
    expect(state.found).toBeDefined();
    // The first scan lands in the background.
    for (let i = 0; i < 100 && (await (await fetch(`${s.url}/api/found`)).json()).files.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(paths((await (await fetch(`${s.url}/api/found`)).json()).files)).toEqual(["bed/b.wav", "vo/a.wav"]);
    expect(calls).toBe(2);
    await s.close();
    expect(calls).toBe(2);
    // found.json is not written by a scan alone.
    await expect(readFile(join(root, ".rushes", "found.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("adopts the current set once the start-up scan has landed", async () => {
    const { root, store } = await tmpProject("startup adopt");
    for (const f of ["renders/hero v3.mov", "bed/hero v3 theme.wav", "misc/one.wav", "misc/two.wav"]) await put(root, f);
    await store.update("project", (p) => addVersion(p, { video: "hero", file: "renders/hero v3.mov", duration: 60, fps: 25 }));
    const s = await startServer(root, { port: 0, found: { probe: byName({ "hero v3 theme.wav": 60 }) } });
    try {
      let lanes: { id: string; variants: { file: string }[] }[] = [];
      for (let i = 0; i < 150 && lanes.length === 0; i++) {
        lanes = (await store.read("project")).lanes;
        if (lanes.length === 0) await new Promise((r) => setTimeout(r, 20));
      }
      expect(lanes.map((l) => [l.id, l.variants.map((v) => v.file)])).toEqual([["music", ["bed/hero v3 theme.wav"]]]);
      const { found } = await (await fetch(`${s.url}/api/state`)).json();
      expect(found.broughtIn).toEqual(["bed/hero v3 theme.wav"]);
    } finally {
      await s.close();
    }
  });
});

/** Registers the film "hero" with one cut, `renders/hero v3.mov`, 60 s long. */
async function heroCut(store: Store, file = "renders/hero v3.mov", duration: number | null = 60) {
  await store.update("project", (p) => addVersion(p, { video: "hero", file, duration, fps: 25 }));
}

const lanesOf = async (store: Store) =>
  (await store.read("project")).lanes.map((l) => ({ id: l.id, name: l.name, stage: l.stage, files: l.variants.map((v) => v.file) }));

const ALREADY = "Already in the project.";
const OUTSIDE = "That file isn't in the project folder";
const GONE = "That file has gone";
const CAP = "Up to 12 at a time, so the tabs stay quick.";

describe("bringing found files in", () => {
  it("brings a voice file in as an unpicked variant in a round named from its folder, described by its reasons", async () => {
    const { store, scanner, announced } = await setup({ files: ["vo_jules/hero read.wav", "bed/other.wav"] });
    await scanner.scan();
    const picksBefore = await store.read("picks");
    const before = announced();
    const res = await scanner.bringIn([{ path: "vo_jules/hero read.wav" }], { reasons: new Map([["vo_jules/hero read.wav", ["made 12 min before it", "name shares “hero”"]]]) });
    expect(res).toEqual({ added: [{ path: "vo_jules/hero read.wav", kind: "voice", lane: "vo-jules", variant: "hero-read" }], failed: [] });
    const project = await store.read("project");
    expect(project.lanes).toHaveLength(1);
    expect(project.lanes[0]).toMatchObject({ id: "vo-jules", name: "Vo Jules", stage: "voice" });
    expect(project.lanes[0].variants).toEqual([
      { id: "hero-read", name: "hero read", file: "vo_jules/hero read.wav", meta: { description: "made 12 min before it · name shares “hero”" }, cues: [] },
    ]);
    // Nothing is picked.
    expect(await store.read("picks")).toEqual(picksBefore); // same rev, same picks
    // Gone from the list, has() and the counts at once, and the tabs hear about it.
    expect(scanner.has("vo_jules/hero read.wav")).toBe(false);
    expect(paths(await scanner.list())).toEqual(["bed/other.wav"]);
    expect(announced()).toBeGreaterThan(before);
    expect((await scanner.summary()).broughtIn).toEqual(["vo_jules/hero read.wav"]);
  });

  it("puts music and sfx in their lanes, a cut on the anchor film, and a doc in the library, in one write", async () => {
    const { store, scanner } = await setup({
      files: ["renders/hero v3.mov", "renders/hero v4.mov", "bed/theme.wav", "sfx/whoosh.wav", "notes/script.md", "vo/line.wav"],
      probe: byName({ "hero v4.mov": 61.5 }),
    });
    await heroCut(store);
    await store.update("project", (p) => void addVersion(p, { video: "other film", file: "renders/other.mov", duration: null }));
    await scanner.scan({ film: "hero" });
    await scanner.settled();
    const rev = (await store.read("project")).rev;
    const res = await scanner.bringIn([
      { path: "bed/theme.wav" },
      { path: "sfx/whoosh.wav" },
      { path: "renders/hero v4.mov" },
      { path: "notes/script.md", kind: "doc" },
      { path: "vo/line.wav", round: "Round 2 · warmer" },
    ]);
    expect(res.failed).toEqual([]);
    expect(res.added).toEqual([
      { path: "bed/theme.wav", kind: "music", lane: "music", variant: "theme" },
      { path: "sfx/whoosh.wav", kind: "sfx", lane: "sfx", variant: "whoosh" },
      { path: "renders/hero v4.mov", kind: "cut", video: "hero", version: "v2" },
      { path: "notes/script.md", kind: "doc" },
      { path: "vo/line.wav", kind: "voice", lane: "round-2-warmer", variant: "line" },
    ]);
    const project = await store.read("project");
    expect(project.rev).toBe(rev + 1); // one write for the whole request
    expect(await lanesOf(store)).toEqual([
      { id: "music", name: "Music", stage: "music", files: ["bed/theme.wav"] },
      { id: "sfx", name: "Sound effects", stage: "sfx", files: ["sfx/whoosh.wav"] },
      { id: "round-2-warmer", name: "Round 2 · warmer", stage: "voice", files: ["vo/line.wav"] },
    ]);
    const hero = project.videos.find((v) => v.id === "hero")!;
    expect(hero.versions.map((v) => [v.id, v.file, v.duration])).toEqual([
      ["v1", "renders/hero v3.mov", 60],
      ["v2", "renders/hero v4.mov", 61.5],
    ]);
    expect(project.files.map((f) => [f.kind, f.file])).toEqual([["doc", "notes/script.md"]]);
    expect(await store.read("picks")).toMatchObject({ lanes: {}, sections: {} });
  });

  it("with no film yet, a cut starts one named after it", async () => {
    const { store, scanner } = await setup({ files: ["renders/first edit.mov"] });
    await scanner.scan();
    const res = await scanner.bringIn([{ path: "renders/first edit.mov" }]);
    expect(res.added).toEqual([{ path: "renders/first edit.mov", kind: "cut", video: "first-edit", version: "v1" }]);
    expect((await store.read("project")).videos.map((v) => v.name)).toEqual(["first edit"]);
  });

  it("brings in 12 of a kind per request: the 13th fails with the cap line, and other kinds still go in", async () => {
    const voice = Array.from({ length: 13 }, (_, i) => `vo/line ${String(i + 1).padStart(2, "0")}.wav`);
    const { store, scanner } = await setup({ files: [...voice, "bed/theme.wav"] });
    await scanner.scan();
    const res = await scanner.bringIn([...voice, "bed/theme.wav"].map((path) => ({ path })));
    expect(res.added.map((a) => a.path)).toEqual([...voice.slice(0, 12), "bed/theme.wav"]);
    expect(res.failed).toEqual([{ path: "vo/line 13.wav", reason: CAP, code: "cap" }]);
    expect((await lanesOf(store)).map((l) => l.files.length)).toEqual([12, 1]);
  });

  it("refuses a path outside the project, a symlink out, a file that has gone and a folder, while the rest go in", async () => {
    const { root, store, scanner } = await setup({ files: ["vo/ok.wav", "vo/vanishes.wav", "vo/real.wav"] });
    const outside = await put(dirname(root), "x.wav", "secret");
    await symlink(outside, join(root, "vo", "escape.wav"));
    await symlink(join(root, "vo", "real.wav"), join(root, "vo", "inside-link.wav"));
    await mkdir(join(root, "elsewhere"));
    await symlink(dirname(root), join(root, "elsewhere", "up"));
    await scanner.scan();
    // Listed by the scan, then gone before "Bring in".
    await rm(join(root, "vo", "vanishes.wav"));
    const res = await scanner.bringIn([
      { path: "../x.wav", kind: "voice" },
      { path: outside, kind: "voice" },
      { path: "vo/escape.wav", kind: "voice" },
      { path: "elsewhere/up/x.wav", kind: "voice" },
      { path: "vo/vanishes.wav" },
      { path: "vo/never-was.wav", kind: "voice" },
      { path: "vo/inside-link.wav", kind: "voice" },
      { path: "vo", kind: "voice" },
      { path: "vo/ok.wav" },
    ]);
    expect(res.added.map((a) => a.path)).toEqual(["vo/ok.wav"]);
    expect(res.failed).toEqual([
      { path: "../x.wav", reason: OUTSIDE, code: "outside" },
      { path: outside, reason: OUTSIDE, code: "outside" },
      { path: "vo/escape.wav", reason: OUTSIDE, code: "outside" },
      { path: "elsewhere/up/x.wav", reason: OUTSIDE, code: "outside" },
      { path: "vo/vanishes.wav", reason: GONE, code: "gone" },
      { path: "vo/never-was.wav", reason: GONE, code: "gone" },
      { path: "vo/inside-link.wav", reason: "That file is a link. Bring in the file it points to", code: "link" },
      { path: "vo", reason: "That's a folder, not a file", code: "folder" },
    ]);
    const files = (await lanesOf(store)).flatMap((l) => l.files);
    expect(files).toEqual(["vo/ok.wav"]);
  });

  it("checks the kind against the file: an unsorted audio file needs a kind, and a kind must suit the file", async () => {
    const { store, scanner } = await setup({ files: ["stems/drums.wav", "stems/bass.wav", "notes/todo.txt", "renders/alt.mov", "keys/id.pem"] });
    await scanner.scan();
    const res = await scanner.bringIn([
      { path: "stems/drums.wav" },
      { path: "stems/bass.wav", kind: "music" },
      { path: "notes/todo.txt", kind: "voice" },
      { path: "renders/alt.mov", kind: "music" },
      { path: "stems/drums.wav", kind: "cut" },
      { path: "keys/id.pem", kind: "doc" },
      { path: "keys/id.pem" },
    ]);
    expect(res.added).toEqual([{ path: "stems/bass.wav", kind: "music", lane: "music", variant: "bass" }]);
    expect(res.failed).toEqual([
      { path: "stems/drums.wav", reason: "Choose a kind for this file", code: "chooseKind" },
      { path: "notes/todo.txt", reason: "That isn't an audio file", code: "notAudio" },
      { path: "renders/alt.mov", reason: "That isn't an audio file", code: "notAudio" },
      { path: "stems/drums.wav", reason: "That isn't a video file", code: "notVideo" },
      { path: "keys/id.pem", reason: "That isn't a script or document (md, txt or pdf)", code: "notDoc" },
      { path: "keys/id.pem", reason: "That isn't an audio, video or document file", code: "unknownType" },
    ]);
    expect((await store.read("project")).files).toEqual([]);
  });

  it("skips a file already registered under another spelling (relative or absolute, U+202F, the same request)", async () => {
    const nnbsp = "vo/Recording 2026-10-06 at 10.15.32\u202FAM.wav";
    const { root, store, scanner } = await setup({ files: ["vo/Take One.wav", "vo/plain.wav", nnbsp] });
    await registerVariant(store, join(root, "vo", "Take One.wav"), "voice"); // absolute
    await scanner.scan();

    // The U+202F name comes in under its own name, then never again under its absolute spelling.
    const first = await scanner.bringIn([{ path: nnbsp }, { path: "vo/Take One.wav" }]);
    expect(first.added).toEqual([{ path: nnbsp, kind: "voice", lane: "vo", variant: expect.any(String) }]);
    expect(first.failed).toEqual([{ path: "vo/Take One.wav", reason: ALREADY, code: "already" }]);
    const vo = (await store.read("project")).lanes.find((l) => l.id === "vo")!;
    expect(vo.variants[0].name).toBe("Recording 2026-10-06 at 10.15.32\u202FAM");
    const absolute = join(root, ...nnbsp.split("/"));
    expect((await scanner.bringIn([{ path: absolute }])).failed).toEqual([{ path: absolute, reason: ALREADY, code: "already" }]);

    // The same file three ways in one request goes in once.
    const twice = await scanner.bringIn([{ path: "vo/plain.wav" }, { path: join(root, "vo", "plain.wav") }, { path: "vo/./plain.wav" }]);
    expect(twice.added.map((a) => a.path)).toEqual(["vo/plain.wav"]);
    expect(twice.failed.map((f) => f.reason)).toEqual([ALREADY, ALREADY]);
  });

  // Each spelling pair is checked both ways round: the file on disk under one spelling and
  // registered under the other. Where the file system keeps the spellings apart, the other
  // spelling is simply a file that isn't there, and that is asserted instead.
  const NFD = "vo/Cafe\u0301 read.wav"; // e + combining acute
  const NFC = "vo/Caf\u00e9 read.wav"; // precomposed é
  const spellingPairs: [string, string, string][] = [
    ["Unicode: on disk decomposed, registered composed", NFD, NFC],
    ["Unicode: on disk composed, registered decomposed", NFC, NFD],
    ["case: on disk mixed case, registered upper case", "vo/Take One.wav", "VO/TAKE ONE.WAV"],
    ["case: on disk upper case, registered lower case", "VO/TAKE ONE.WAV", "vo/take one.wav"],
  ];
  it.each(spellingPairs)("never doubles a file registered under another spelling (%s)", async (_label, onDisk, other) => {
    expect(onDisk).not.toBe(other);
    const { root, store, scanner } = await setup();
    await put(root, onDisk, "the one file");
    const folds = await access(join(root, ...other.split("/"))).then(() => true, () => false);
    await registerVariant(store, other, "voice");
    await scanner.scan();
    const res = await scanner.bringIn([{ path: onDisk }, { path: other }]);
    if (folds) {
      // One file under two names: already in, both ways.
      expect(res.added).toEqual([]);
      expect(res.failed).toEqual([
        { path: onDisk, reason: ALREADY, code: "already" },
        { path: other, reason: ALREADY, code: "already" },
      ]);
      expect(paths(await scanner.list())).toEqual([]);
    } else {
      // Two names, and only one file: the file comes in, the other spelling has gone.
      expect(res.added.map((a) => a.path)).toEqual([onDisk]);
      expect(res.failed).toEqual([{ path: other, reason: GONE, code: "gone" }]);
    }
    // Nothing on disk is ever registered twice.
    const files = (await store.read("project")).lanes.flatMap((l) => l.variants.map((v) => v.file));
    const real = await Promise.all(files.map((f) => realpath(isAbsolute(f) ? f : join(root, ...f.split("/"))).catch(() => `missing:${f}`)));
    expect(new Set(real).size).toBe(real.length);
  });

  it("a cut registered as a library file or a script take is already in the project too", async () => {
    const { store, scanner } = await setup({ files: ["takes/t1.wav", "renders/alt.mov"] });
    await store.update("script", (s) => {
      s.sections.push({ id: "s1", start: 0, end: 2, current: "Hi", proposed: null, direction: "", status: "draft", takes: [{ id: "t1", file: "takes/t1.wav", duration: null, forText: "Hi" }] });
    });
    await store.update("project", (p) => {
      p.files.push({ id: "f1", kind: "export", file: "renders/alt.mov", name: "alt", note: "", video: null, addedAt: new Date().toISOString() });
    });
    await scanner.scan();
    const res = await scanner.bringIn([{ path: "takes/t1.wav", kind: "voice" }, { path: "renders/alt.mov" }]);
    expect(res.added).toEqual([]);
    expect(res.failed.map((f) => f.reason)).toEqual([ALREADY, ALREADY]);
  });

  it("two requests at once never add the same file twice", async () => {
    const { store, scanner } = await setup({ files: ["bed/theme.wav"] });
    await scanner.scan();
    const [a, b] = await Promise.all([scanner.bringIn([{ path: "bed/theme.wav" }]), scanner.bringIn([{ path: "bed/theme.wav" }])]);
    expect(a.added.length + b.added.length).toBe(1);
    expect((await lanesOf(store)).flatMap((l) => l.files)).toEqual(["bed/theme.wav"]);
  });
});

describe("adopting the current set", () => {
  // The cut is "hero v3" (60 s). The theme and the read match its length, time and name; the
  // others are old, the wrong length, or effects (which get no length score).
  const FILES = ["renders/hero v3.mov", "bed/hero v3 theme.wav", "vo_jules/hero v3 read.wav", "sfx/whoosh.wav", "bed/old bed.wav", "vo_jules/pickup.wav"];
  const LENGTHS = { "hero v3 theme.wav": 60, "hero v3 read.wav": 60.4, "old bed.wav": 200, "pickup.wav": 5 };

  async function aged(root: string, rel: string) {
    const old = new Date(Date.now() - 30 * 24 * 3600e3);
    await utimes(join(root, ...rel.split("/")), old, old);
  }

  it("adds the suggested file per kind, unpicked and described, and a second call adds nothing", async () => {
    const { root, store, scanner } = await setup({ files: FILES, probe: byName(LENGTHS) });
    await aged(root, "bed/old bed.wav");
    await aged(root, "vo_jules/pickup.wav");
    await heroCut(store);
    await scanner.scan({ film: "hero" });
    const picks = await store.read("picks");
    const res = await scanner.adoptCurrentSet({ film: "hero" });
    expect(res.failed).toEqual([]);
    expect(res.added.map((a) => [a.path, a.kind]).sort()).toEqual([
      ["bed/hero v3 theme.wav", "music"],
      ["vo_jules/hero v3 read.wav", "voice"],
    ]);
    const project = await store.read("project");
    const music = project.lanes.find((l) => l.id === "music")!;
    expect(music.variants[0].meta.description).toMatch(/^same length as the cut \(60\.0 s vs 60\.0 s\) · made /);
    expect(project.lanes.find((l) => l.id === "vo-jules")!.name).toBe("Vo Jules");
    expect(await store.read("picks")).toEqual(picks);
    expect((await scanner.summary()).broughtIn.sort()).toEqual(["bed/hero v3 theme.wav", "vo_jules/hero v3 read.wav"]);

    const again = await scanner.adoptCurrentSet({ film: "hero" });
    expect(again).toEqual({ added: [], failed: [] });
    expect((await store.read("project")).rev).toBe(project.rev);
  });

  it("never adopts the runner-up once the winner is in, even after a restart", async () => {
    // The theme scores 8 and "hero alt" 6: the theme wins by 2. With the theme registered, "hero
    // alt" would win alone, but the theme is still the current set's music, so nothing is added.
    const files = ["renders/hero v3.mov", "bed/hero v3 theme.wav", "bed/hero alt.wav", "misc/a.wav", "misc/b.wav", "misc/c.wav"];
    const probe = byName({ "hero v3 theme.wav": 60, "hero alt.wav": 60 });
    const { store, scanner } = await setup({ files, probe });
    await heroCut(store);
    await scanner.scan();
    expect((await scanner.adoptCurrentSet()).added.map((a) => a.path)).toEqual(["bed/hero v3 theme.wav"]);
    await scanner.scan();
    expect(await scanner.adoptCurrentSet()).toEqual({ added: [], failed: [] });
    expect((await scanner.list()).find((f) => f.path === "bed/hero alt.wav")!.suggested).toBe(false);

    // A fresh server: the registered theme still competes, with its probed length.
    const fresh = new FoundScanner({ store, probe, announce: () => undefined });
    await fresh.scan();
    expect(await fresh.adoptCurrentSet()).toEqual({ added: [], failed: [] });
    expect((await lanesOf(store)).flatMap((l) => l.files)).toEqual(["bed/hero v3 theme.wav"]);
  });

  it("a file's score doesn't shift when other files are brought in (common words count the whole folder)", async () => {
    // "hero" is in 3 of the 6 files, so it isn't common and earns its point. Counted over what's
    // left to bring in, it would become common once the misc files are in.
    const files = ["renders/hero v3.mov", "bed/hero one.wav", "bed/hero two.wav", "misc/c.wav", "misc/d.wav", "misc/e.wav"];
    const { store, scanner } = await setup({ files });
    await heroCut(store);
    await scanner.scan();
    const before = (await scanner.list()).find((f) => f.path === "bed/hero one.wav")!;
    expect(before.reasons).toContain("name shares “hero”");
    await scanner.bringIn(["misc/c.wav", "misc/d.wav", "misc/e.wav"].map((path) => ({ path, kind: "sfx" as const })));
    const after = (await scanner.list()).find((f) => f.path === "bed/hero one.wav")!;
    expect(after.score).toBe(before.score);
    expect(after.reasons).toEqual(before.reasons);
  });

  it("adds nothing for a kind with a tie, and nothing at all without a cut", async () => {
    const files = ["bed/hero v3 one.wav", "bed/hero v3 two.wav", "misc/a.wav", "misc/b.wav", "misc/c.wav", "misc/d.wav"];
    const probe = byName({ "hero v3 one.wav": 60, "hero v3 two.wav": 60 });
    const { root, store, scanner } = await setup({ files, probe });
    await scanner.scan();
    expect(await scanner.adoptCurrentSet()).toEqual({ added: [], failed: [] }); // no cut yet
    await put(root, "renders/hero v3.mov");
    await heroCut(store);
    await scanner.scan();
    expect(await scanner.adoptCurrentSet()).toEqual({ added: [], failed: [] });
    expect((await store.read("project")).lanes).toEqual([]);
  });

  it("waits for the durations before scoring, but not forever", async () => {
    // Only the length lifts "theme" to 4 or more (2 for the time, 3 for the length).
    const gates: (() => void)[] = [];
    const gated: ProbeFn = (abs) => new Promise((resolve) => gates.push(() => resolve(abs.endsWith("theme.wav") ? 60 : null)));
    const { store, scanner } = await setup({ files: ["renders/hero v3.mov", "bed/theme.wav", "misc/a.wav"], probe: gated });
    await heroCut(store);
    await scanner.scan();
    let done = false;
    const adopting = scanner.adoptCurrentSet().then((r) => ((done = true), r));
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false);
    while (gates.length) gates.shift()!();
    expect((await adopting).added.map((a) => a.path)).toEqual(["bed/theme.wav"]);

  });

  it("settled() waits for an adoption in flight", async () => {
    const gates: (() => void)[] = [];
    const gated: ProbeFn = (abs) => new Promise((resolve) => gates.push(() => resolve(abs.endsWith("theme.wav") ? 60 : null)));
    const { store, scanner } = await setup({ files: ["renders/hero v3.mov", "bed/theme.wav"], probe: gated });
    await heroCut(store);
    await scanner.scan();
    void scanner.adoptCurrentSet();
    const settled = scanner.settled();
    while (gates.length) gates.shift()!();
    await settled;
    expect((await lanesOf(store)).map((l) => l.files)).toEqual([["bed/theme.wav"]]);
  });

  it("POST /api/found/scan adopts the current set once the scan lands", async () => {
    const { root, store, scanner, post } = await setup({ files: FILES, probe: byName(LENGTHS) });
    await aged(root, "bed/old bed.wav");
    await aged(root, "vo_jules/pickup.wav");
    await heroCut(store);
    expect((await post("/api/found/scan", { film: "hero" })).status).toBe(200);
    let lanes: string[] = [];
    for (let i = 0; i < 150 && lanes.length < 2; i++) {
      lanes = (await lanesOf(store)).map((l) => l.id);
      if (lanes.length < 2) await new Promise((r) => setTimeout(r, 20));
    }
    expect(lanes.sort()).toEqual(["music", "vo-jules"]);
    await scanner.settled();
  });
});

describe("POST /api/found/bring-in", () => {
  it("brings files in and returns the result, and GET /api/state shows them as brought in", async () => {
    const { scanner, post, call } = await setup({ files: ["bed/theme.wav", "vo/a.wav"] });
    await scanner.scan();
    const res = await post("/api/found/bring-in", { files: [{ path: "bed/theme.wav" }, { path: "../nope.wav", kind: "music" }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      added: [{ path: "bed/theme.wav", kind: "music", lane: "music", variant: "theme" }],
      failed: [{ path: "../nope.wav", reason: OUTSIDE, code: "outside" }],
    });
    const { found } = await (await call("/api/state")).json();
    expect(found.broughtIn).toEqual(["bed/theme.wav"]);
    expect(found.counts.music).toBe(0);
    expect(paths((await (await call("/api/found")).json()).files)).toEqual(["vo/a.wav"]);
  });

  it("describes a file by its current reasons when the request doesn't give them", async () => {
    const { store, scanner, post } = await setup({ files: ["renders/hero v3.mov", "bed/theme.wav"], probe: byName({ "theme.wav": 60 }) });
    await heroCut(store);
    await scanner.scan();
    await scanner.settled();
    await post("/api/found/bring-in", { files: [{ path: "bed/theme.wav" }] });
    const lane = (await store.read("project")).lanes[0];
    expect(lane.variants[0].meta.description).toMatch(/^same length as the cut \(60\.0 s vs 60\.0 s\) · made /);
  });

  it("validates the body: 1 to 60 files, known kinds, a round of at most 64 characters", async () => {
    const { scanner, post } = await setup({ files: ["vo/a.wav"] });
    await scanner.scan();
    const many = Array.from({ length: 61 }, (_, i) => ({ path: `vo/${i}.wav` }));
    expect((await post("/api/found/bring-in", { files: many })).status).toBe(400);
    expect((await post("/api/found/bring-in", { files: [] })).status).toBe(400);
    expect((await post("/api/found/bring-in", { files: [{ path: "vo/a.wav", kind: "other" }] })).status).toBe(400);
    expect((await post("/api/found/bring-in", { files: [{ path: "vo/a.wav", round: "x".repeat(65) }] })).status).toBe(400);
    expect((await post("/api/found/bring-in", { files: [{ path: "" }] })).status).toBe(400);
    expect((await post("/api/found/bring-in", { nope: true })).status).toBe(400);
    const sixty = Array.from({ length: 60 }, (_, i) => ({ path: `vo/${i}.wav` }));
    expect((await post("/api/found/bring-in", { files: sixty })).status).toBe(200);
  });

  it("keeps the project identity guard (a different project is 409, and nothing is added)", async () => {
    const { store, scanner, post } = await setup({ files: ["bed/theme.wav"] });
    const id = await ensureProjectIdOnce(store);
    await scanner.scan();
    expect((await post("/api/found/bring-in", { files: [{ path: "bed/theme.wav" }] }, { "x-rushes-project": "zzzzzzzz" })).status).toBe(409);
    expect((await store.read("project")).lanes).toEqual([]);
    expect((await post("/api/found/bring-in", { files: [{ path: "bed/theme.wav" }] }, { "x-rushes-project": id })).status).toBe(200);
  });
});

describe("adoption when lengths are slow (fix round 1)", () => {
  it("on a timeout, skips a kind whose lengths are still pending rather than scoring on partial data", async () => {
    // The registered theme is music's real winner, but its probe never answers. Scored without its
    // length, "hero alt" (6) would beat it (5) and come in as a second music file. The read's
    // length is known, so voice is still decided.
    const files = ["renders/hero v3.mov", "bed/hero v3 theme.wav", "bed/hero alt.wav", "vo/hero v3 read.wav", "misc/a.wav", "misc/b.wav", "misc/c.wav"];
    const probe: ProbeFn = (abs) => (abs.endsWith("hero v3 theme.wav") ? never(abs) : Promise.resolve(abs.endsWith("hero alt.wav") || abs.endsWith("read.wav") ? 60 : null));
    const { store, scanner } = await setup({ files, probe, adoptWaitMs: 150 });
    await heroCut(store);
    await registerVariant(store, "bed/hero v3 theme.wav", "music");
    await scanner.scan();
    const started = Date.now();
    const res = await scanner.adoptCurrentSet();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.added.map((a) => a.path)).toEqual(["vo/hero v3 read.wav"]);
    expect((await store.read("project")).lanes.find((l) => l.stage === "music")!.variants.map((v) => v.file)).toEqual(["bed/hero v3 theme.wav"]);
    scanner.close();
  });

  it("after a restart with slow probes and many other files, never adds a second music file", async () => {
    const others = Array.from({ length: 20 }, (_, i) => `misc/other ${String(i).padStart(2, "0")}.wav`);
    const files = ["renders/hero v3.mov", "bed/hero v3 theme.wav", "bed/hero alt.wav", ...others];
    const lengths = byName({ "hero v3 theme.wav": 60, "hero alt.wav": 60 });
    const { store, scanner } = await setup({ files, probe: lengths });
    await heroCut(store);
    await scanner.scan();
    expect((await scanner.adoptCurrentSet()).added.map((a) => a.path)).toEqual(["bed/hero v3 theme.wav"]);
    scanner.close();

    // A fresh server whose probes take 30 ms each, with a 200 ms window: the registered theme is
    // probed before the 20 others, so music is decided correctly, and nothing is added.
    const slow: ProbeFn = (abs) => new Promise((r) => setTimeout(() => r(lengths(abs)), 30));
    const fresh = new FoundScanner({ store, probe: slow, announce: () => undefined, adoptWaitMs: 200 });
    await fresh.scan();
    expect(await fresh.adoptCurrentSet()).toEqual({ added: [], failed: [] });
    fresh.close();

    // Many music files and a window too short for them: music is skipped, not guessed.
    const { root } = { root: store.root };
    for (let i = 0; i < 20; i++) await put(root, `bed/hero take ${i}.wav`);
    const hurried = new FoundScanner({ store, probe: slow, announce: () => undefined, adoptWaitMs: 40 });
    await hurried.scan();
    expect(await hurried.adoptCurrentSet()).toEqual({ added: [], failed: [] });
    hurried.close();
    expect((await store.read("project")).lanes.flatMap((l) => l.variants.map((v) => v.file))).toEqual(["bed/hero v3 theme.wav"]);
  });

  it("probes the anchor first, then registered voice and music, then voice and music candidates, then the rest", async () => {
    const order: string[] = [];
    const probe: ProbeFn = async (abs) => {
      order.push(abs.slice(abs.indexOf("My Project/") + "My Project/".length));
      return null;
    };
    const files = ["renders/hero v3.mov", "renders/alt cut.mov", "sfx/whoosh.wav", "misc/a.wav", "bed/theme.wav", "vo/read.wav", "bed/kept.wav"];
    const { store, scanner } = await setup({ files, probe });
    await heroCut(store, "renders/hero v3.mov", null);
    await registerVariant(store, "bed/kept.wav", "music");
    await scanner.scan();
    await scanner.settled();
    expect(order[0]).toBe("renders/hero v3.mov");
    expect(order[1]).toBe("bed/kept.wav");
    expect(order.slice(2, 4).sort()).toEqual(["bed/theme.wav", "vo/read.wav"]);
    expect(order.slice(4, 6).sort()).toEqual(["misc/a.wav", "sfx/whoosh.wav"]);
    expect(order.slice(6)).toEqual(["renders/alt cut.mov"]);
  });

  it("on a rescan, newly needed lengths go ahead of the ones already queued, by tier", async () => {
    const started: string[] = [];
    const gates: (() => void)[] = [];
    const probe: ProbeFn = (abs) => {
      started.push(abs.slice(abs.indexOf("My Project/") + "My Project/".length));
      return new Promise((r) => gates.push(() => r(null)));
    };
    const music = ["bed/m1.wav", "bed/m2.wav", "bed/m3.wav", "bed/m4.wav", "bed/m5.wav"];
    const { root, store, scanner } = await setup({ files: ["renders/hero v3.mov", ...music, "sfx/s1.wav", "sfx/s2.wav", "renders/alt.mov"], probe });
    await heroCut(store);
    await scanner.scan();
    expect(started.sort()).toEqual(["bed/m1.wav", "bed/m2.wav"]); // two at a time; m3-m5, sfx, the cut queued
    // m5 is registered (now a competitor) and a new music file appears; then a rescan.
    await registerVariant(store, "bed/m5.wav", "music");
    await put(root, "bed/new.wav");
    await scanner.scan();
    started.length = 0;
    for (let i = 0; i < 7; i++) {
      gates.shift()!();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(started).toEqual(["bed/m5.wav", "bed/m3.wav", "bed/m4.wav", "bed/new.wav", "sfx/s1.wav", "sfx/s2.wav", "renders/alt.mov"]);
    while (gates.length) gates.shift()!();
    scanner.close();
  });

  it("settled() never waits longer than its bound", async () => {
    const { scanner } = await setup({ files: ["vo/a.wav"], probe: never });
    await scanner.scan();
    const started = Date.now();
    await scanner.settled(50);
    expect(Date.now() - started).toBeLessThan(1000);
    scanner.close();
  });
});

describe("the anchor is the newest cut (fix round 1)", () => {
  it("with no film named, scores against the newest cut of any film, and a found cut joins that film", async () => {
    const { store, scanner } = await setup({ files: ["renders/beta v1.mov", "renders/hero v3.mov", "bed/theme.wav", "renders/next.mov"], probe: byName({ "theme.wav": 60 }) });
    const hourAgo = new Date(Date.now() - 3600e3);
    await store.update("project", (p) => {
      addVersion(p, { video: "beta", file: "renders/beta v1.mov", duration: 30, fps: 25 }, hourAgo); // first in the list, older
      addVersion(p, { video: "hero", file: "renders/hero v3.mov", duration: 60, fps: 25 }, new Date());
    });
    await scanner.scan();
    await scanner.settled();
    const theme = (await scanner.list()).find((f) => f.path === "bed/theme.wav")!;
    expect(theme.reasons[0]).toBe("same length as the cut (60.0 s vs 60.0 s)");
    expect((await scanner.bringIn([{ path: "renders/next.mov" }])).added).toEqual([{ path: "renders/next.mov", kind: "cut", video: "hero", version: "v2" }]);
  });
});

describe("rounds, lanes and limits (fix round 1)", () => {
  it("roundName humanises a folder's name, splitting separators and camel case", () => {
    expect(roundName("vo_jules")).toBe("Vo Jules");
    expect(roundName("audio/voJules")).toBe("Vo Jules");
    expect(roundName("VOJules")).toBe("VO Jules");
    expect(roundName("narration--take.2")).toBe("Narration Take 2");
    expect(roundName("élan vital")).toBe("Élan Vital");
    expect(roundName("")).toBeUndefined();
    expect(roundName("___")).toBeUndefined();
    expect([...roundName("x".repeat(100))!].length).toBe(64);
  });

  it("keeps different folders as different rounds, and a folder's files together", async () => {
    const { store, scanner } = await setup({ files: ["vo_jules/a.wav", "vo-jules/b.wav", "x/vo/c.wav", "y/vo/d.wav", "z/vo/e.wav", "x/vo/f.wav"] });
    await scanner.scan();
    const res = await scanner.bringIn(["vo_jules/a.wav", "vo-jules/b.wav", "x/vo/c.wav", "y/vo/d.wav"].map((path) => ({ path })));
    expect(res.failed).toEqual([]);
    await scanner.bringIn([{ path: "z/vo/e.wav" }, { path: "x/vo/f.wav" }]);
    const lanes = (await store.read("project")).lanes.map((l) => [l.name, l.variants.map((v) => v.file)]);
    expect(lanes).toEqual([
      ["Vo Jules", ["vo_jules/a.wav"]],
      ["Vo Jules 2", ["vo-jules/b.wav"]], // no parent folder to tell it apart, so a number
      ["Vo", ["x/vo/c.wav", "x/vo/f.wav"]],
      ["Vo · Y", ["y/vo/d.wav"]],
      ["Vo · Z", ["z/vo/e.wav"]],
    ]);
  });

  it("a voice file in a folder named music/ or sfx/ goes to the voiceover lane, and music still has its lane", async () => {
    const { store, scanner } = await setup({ files: ["music/vo take.wav", "sfx/vo pickup.wav", "bed/theme.wav", "fx/hit.wav"] });
    await scanner.scan();
    const res = await scanner.bringIn(["music/vo take.wav", "sfx/vo pickup.wav", "bed/theme.wav", "fx/hit.wav"].map((path) => ({ path })));
    expect(res.failed).toEqual([]);
    expect(await lanesOf(store)).toEqual([
      { id: "voice", name: "Voiceover", stage: "voice", files: ["music/vo take.wav", "sfx/vo pickup.wav"] },
      { id: "music", name: "Music", stage: "music", files: ["bed/theme.wav"] },
      { id: "sfx", name: "Sound effects", stage: "sfx", files: ["fx/hit.wav"] },
    ]);
  });

  it("explains in plain words when a lane's name is taken by another kind, and writes nothing", async () => {
    const { store, scanner } = await setup({ files: ["vo/a.wav", "bed/theme.wav"] });
    await store.update("project", (p) => void addVariant(p, { stage: "voice", round: "Music", name: "odd", file: "elsewhere.wav" }));
    await scanner.scan();
    const rev = (await store.read("project")).rev;
    const res = await scanner.bringIn([{ path: "vo/a.wav", round: "Sfx" }, { path: "bed/theme.wav" }]);
    expect(res.added).toEqual([]);
    expect(res.failed).toEqual([
      { path: "vo/a.wav", reason: "“Sfx” is kept for the sound effects lane. Choose another round name", code: "other" },
      { path: "bed/theme.wav", reason: "The music lane's name is taken by the voiceover round “Music”", code: "other" },
    ]);
    expect((await store.read("project")).rev).toBe(rev); // nothing written
  });

  it("an item refused inside the write doesn't use one of the 12 places", async () => {
    const voice = Array.from({ length: 12 }, (_, i) => `vo/line ${String(i + 1).padStart(2, "0")}.wav`);
    const { store, scanner } = await setup({ files: ["vo/odd.wav", ...voice] });
    await scanner.scan();
    const res = await scanner.bringIn([{ path: "vo/odd.wav", round: "Music" }, ...voice.map((path) => ({ path }))]);
    expect(res.added.map((a) => a.path)).toEqual(voice);
    expect(res.failed.map((f) => f.path)).toEqual(["vo/odd.wav"]);
    expect((await lanesOf(store))[0].files).toHaveLength(12);
  });

  it("refuses hidden files and the folders the scan leaves alone", async () => {
    const hidden = [".rushes/zz.md", "node_modules/pkg/a.wav", ".private/notes.txt", "vo/.secret.wav", "exports/cut.mp4", "proxies/hero.mp4", "a/Screenshots/b.wav"];
    const { store, scanner } = await setup({ files: [...hidden, "vo/ok.wav"] });
    await scanner.scan();
    const res = await scanner.bringIn([...hidden, "vo/ok.wav"].map((path) => ({ path, kind: path.endsWith(".mp4") ? ("cut" as const) : path.endsWith(".wav") ? ("voice" as const) : ("doc" as const) })));
    expect(res.added.map((a) => a.path)).toEqual(["vo/ok.wav"]);
    expect(res.failed).toEqual(
      hidden.map((path) => (path === "vo/.secret.wav"
        ? { path, reason: "That's a hidden file", code: "hiddenFile" }
        : { path, reason: "Rushes leaves that folder alone", code: "skippedFolder" })),
    );
    expect((await store.read("project")).files).toEqual([]);
  });

  it("takes at most 60 items in one call", async () => {
    const { scanner } = await setup({ files: ["vo/a.wav"] });
    await scanner.scan();
    const many = Array.from({ length: 61 }, (_, i) => ({ path: `vo/${i}.wav` }));
    await expect(scanner.bringIn(many)).rejects.toMatchObject({ status: 400 });
  });

  it("a registration under another spelling that lands mid-request is caught by the rev check", async () => {
    const { root, store, scanner } = await setup({ files: ["bed/theme.wav"] });
    await scanner.scan();
    const read = store.read.bind(store);
    let armed = true;
    const spy = vi.spyOn(store, "read").mockImplementation((async (key: Parameters<Store["read"]>[0]) => {
      const data = await read(key);
      if (key === "project" && armed) {
        armed = false;
        // Another writer registers the same file by its absolute path after bringIn has read the project.
        await store.update("project", (p) => void addVariant(p, { stage: "music", name: "theme", file: join(root, "bed", "theme.wav") }));
      }
      return data;
    }) as Store["read"]);
    const res = await scanner.bringIn([{ path: "bed/theme.wav" }], { reasons: new Map() });
    spy.mockRestore();
    expect(res).toEqual({ added: [], failed: [{ path: "bed/theme.wav", reason: ALREADY, code: "already" }] });
    expect((await lanesOf(store)).flatMap((l) => l.files)).toEqual([join(root, "bed", "theme.wav")]);
  });
});

describe("POST /api/found/scan with wait (the agent surface, §20.7)", () => {
  const FILES = ["renders/hero v3.mov", "bed/hero v3 theme.wav", "vo_jules/hero v3 read.wav", "stems/other pad.wav", "sfx/whoosh.wav"];
  const LENGTHS = { "hero v3 theme.wav": 60, "hero v3 read.wav": 60.4, "other pad.wav": 31 };

  it("answers at once without wait, as before", async () => {
    const { post } = await setup({ files: FILES, probe: byName(LENGTHS) });
    const res = await post("/api/found/scan", {});
    expect(await res.json()).toEqual({ ok: true });
  });

  it("waits for the scan and the adoption, then says what is in and what is left", async () => {
    const { store, post } = await setup({ files: FILES, probe: byName(LENGTHS) });
    await heroCut(store);
    const res = await post("/api/found/scan", { film: "hero", wait: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.failed).toEqual([]);
    expect(body.added.map((a: { path: string; kind: string }) => [a.path, a.kind]).sort()).toEqual([
      ["bed/hero v3 theme.wav", "music"],
      ["vo_jules/hero v3 read.wav", "voice"],
    ]);
    // Each carries the reasons it was chosen for.
    for (const a of body.added) expect(a.reasons.join(" ")).toMatch(/same length as the cut/);
    // What is left: the pad (other, un-kinded: "stems" has no kind), the effect and no cut.
    expect(body.found).toEqual({ voice: 0, music: 0, sfx: 1, cut: 0, other: 1 });
  });

  it("lists what was brought in earlier this session, so a racing start-up adoption is never missed", async () => {
    const { store, scanner, post } = await setup({ files: FILES, probe: byName(LENGTHS) });
    await heroCut(store);
    await scanner.scan({ film: "hero" });
    await scanner.adoptCurrentSet({ film: "hero" });
    const body = await (await post("/api/found/scan", { film: "hero", wait: true })).json();
    expect(body.added.map((a: { path: string }) => a.path).sort()).toEqual(["bed/hero v3 theme.wav", "vo_jules/hero v3 read.wav"]);
  });

  it("include wins over the scoring: an included file's kind is not also adopted", async () => {
    const { store, post } = await setup({ files: FILES, probe: byName(LENGTHS) });
    await heroCut(store);
    const res = await post("/api/found/scan", { film: "hero", wait: true, include: [{ path: "stems/other pad.wav", kind: "music" }] });
    const body = await res.json();
    expect(body.failed).toEqual([]);
    expect(body.added.map((a: { path: string; kind: string }) => [a.path, a.kind]).sort()).toEqual([
      ["stems/other pad.wav", "music"],
      ["vo_jules/hero v3 read.wav", "voice"],
    ]);
    const music = (await store.read("project")).lanes.find((l) => l.id === "music")!;
    expect(music.variants.map((v) => v.file)).toEqual(["stems/other pad.wav"]);
    // The scoring's pick is still there to be brought in by hand.
    expect(body.found.music).toBe(1);
  });

  it("reports an included file that can't come in, and still adopts the rest", async () => {
    const { store, post } = await setup({ files: FILES, probe: byName(LENGTHS) });
    await heroCut(store);
    const body = await (await post("/api/found/scan", { film: "hero", wait: true, include: [{ path: "../elsewhere.wav", kind: "music" }, { path: "gone.wav" }] })).json();
    expect(body.failed).toEqual([
      { path: "../elsewhere.wav", reason: OUTSIDE, code: "outside" },
      { path: "gone.wav", reason: "That file has gone", code: "gone" },
    ]);
    expect(body.added.map((a: { kind: string }) => a.kind).sort()).toEqual(["music", "voice"]);
  });

  it("an included file already in the project is listed as alreadyIn, not failed, and still covers its kind", async () => {
    const { store, post } = await setup({ files: FILES, probe: byName(LENGTHS) });
    await heroCut(store);
    await registerVariant(store, "stems/other pad.wav", "music");
    const body = await (await post("/api/found/scan", { film: "hero", wait: true, include: [{ path: "stems/other pad.wav", kind: "music" }] })).json();
    expect(body.failed).toEqual([]);
    expect(body.alreadyIn).toEqual(["stems/other pad.wav"]);
    expect(body.added.map((a: { path: string }) => a.path)).toEqual(["vo_jules/hero v3 read.wav"]);
  });

  it("an already-registered include with no kind settles the kind it is registered as (by its lane)", async () => {
    const { store, post } = await setup({ files: FILES, probe: byName(LENGTHS) });
    await heroCut(store);
    await registerVariant(store, "stems/other pad.wav", "music"); // "stems" says no kind: only its lane does
    const body = await (await post("/api/found/scan", { film: "hero", wait: true, include: [{ path: "stems/other pad.wav" }] })).json();
    expect(body.alreadyIn).toEqual(["stems/other pad.wav"]);
    const music = (await store.read("project")).lanes.find((l) => l.id === "music")!;
    expect(music.variants.map((v) => v.file)).toEqual(["stems/other pad.wav"]);
  });

  it("an already-registered include with no kind settles the kind its name says", async () => {
    const { store, post } = await setup({ files: [...FILES, "bed/mine.wav"], probe: byName(LENGTHS) });
    await heroCut(store);
    await registerVariant(store, "bed/mine.wav", "music");
    await post("/api/found/scan", { film: "hero", wait: true, include: [{ path: "bed/mine.wav" }] });
    const music = (await store.read("project")).lanes.find((l) => l.id === "music")!;
    expect(music.variants.map((v) => v.file)).toEqual(["bed/mine.wav"]);
  });

  describe("an include keeps winning (the settled kinds are kept in found.json)", () => {
    const include = [{ path: "stems/other pad.wav", kind: "music" }];
    const musicFiles = async (store: Store) => (await store.read("project")).lanes.find((l) => l.id === "music")!.variants.map((v) => v.file);

    it("on a later waiting scan that carries no include, with or without a film", async () => {
      const { store, post } = await setup({ files: FILES, probe: byName(LENGTHS) });
      await heroCut(store);
      await post("/api/found/scan", { film: "hero", wait: true, include });
      expect(await musicFiles(store)).toEqual(["stems/other pad.wav"]);
      const again = await (await post("/api/found/scan", { film: "hero", wait: true })).json();
      expect(await musicFiles(store)).toEqual(["stems/other pad.wav"]);
      expect(again.found.music).toBe(1);
      await post("/api/found/scan", { wait: true });
      await post("/api/found/scan", {});
      await new Promise((r) => setTimeout(r, 30));
      expect(await musicFiles(store)).toEqual(["stems/other pad.wav"]);
    });

    it("after a restart (a new scanner on the same folder), by adoption or a waiting scan", async () => {
      const probe = byName(LENGTHS);
      const { store, post } = await setup({ files: FILES, probe });
      await heroCut(store);
      await post("/api/found/scan", { film: "hero", wait: true, include });
      const fresh = new FoundScanner({ store, probe, announce: () => undefined });
      await fresh.scan();
      expect(await fresh.adoptCurrentSet()).toEqual({ added: [], failed: [] });
      const app2 = createApp(store, { found: fresh });
      const res = await app2.request("/api/found/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wait: true }) });
      expect((await res.json()).ok).toBe(true);
      expect(await musicFiles(store)).toEqual(["stems/other pad.wav"]);
    });

    it("is kept in found.json, keyed by the cut, and only for the kind that was included", async () => {
      const { store, post } = await setup({ files: FILES, probe: byName(LENGTHS) });
      await heroCut(store);
      await post("/api/found/scan", { film: "hero", wait: true, include });
      expect((await store.read("found")).settled).toEqual([{ video: "hero", version: "v1", kinds: ["music"] }]);
    });

    it("applies to that cut only: a newer cut is a fresh decision", async () => {
      const { root, store, post } = await setup({ files: FILES, probe: byName(LENGTHS) });
      await heroCut(store);
      await post("/api/found/scan", { film: "hero", wait: true, include });
      await put(root, "renders/hero v4.mov");
      await store.update("project", (p) => addVersion(p, { video: "hero", file: "renders/hero v4.mov", duration: 60, fps: 25 }));
      await post("/api/found/scan", { film: "hero", wait: true });
      expect(await musicFiles(store)).toEqual(["stems/other pad.wav", "bed/hero v3 theme.wav"]);
    });

    it("an include outside the project settles nothing", async () => {
      const { store, post } = await setup({ files: FILES, probe: byName(LENGTHS) });
      await heroCut(store);
      await post("/api/found/scan", { film: "hero", wait: true, include: [{ path: "../elsewhere.wav", kind: "music" }] });
      expect((await store.read("found")).settled).toEqual([]);
      expect(await musicFiles(store)).toEqual(["bed/hero v3 theme.wav"]);
    });

    it("never removes what is already registered", async () => {
      const { store, post } = await setup({ files: FILES, probe: byName(LENGTHS) });
      await heroCut(store);
      await registerVariant(store, "bed/hero v3 theme.wav", "music"); // the scoring's pick is already in
      await post("/api/found/scan", { film: "hero", wait: true, include });
      expect(await musicFiles(store)).toEqual(["bed/hero v3 theme.wav", "stems/other pad.wav"]);
    });
  });

  describe("an include that carries a new cut still wins", () => {
    const musicFiles = async (store: Store) => (await store.read("project")).lanes.find((l) => l.id === "music")?.variants.map((v) => v.file) ?? [];

    it("when a cut is registered already and the include brings a newer one", async () => {
      const { store, post } = await setup({ files: [...FILES, "renders/hero v4.mov"], probe: byName({ ...LENGTHS, "hero v4.mov": 60 }) });
      await heroCut(store);
      const body = await (
        await post("/api/found/scan", { film: "hero", wait: true, include: [{ path: "stems/other pad.wav", kind: "music" }, { path: "renders/hero v4.mov" }] })
      ).json();
      expect(body.failed).toEqual([]);
      expect(await musicFiles(store)).toEqual(["stems/other pad.wav"]);
      // Settled for the cut it now scores against, so a later scan keeps leaving the scoring's music out.
      const found = await store.read("found");
      expect(found.settled.map((e) => [e.version, e.kinds])).toEqual(expect.arrayContaining([["v2", ["music"]]]));
      await post("/api/found/scan", { wait: true });
      expect(await musicFiles(store)).toEqual(["stems/other pad.wav"]);
    });

    it("on a fresh project with no cut, where the include is what makes the cut", async () => {
      const { store, post } = await setup({ files: FILES, probe: byName(LENGTHS) });
      const body = await (
        await post("/api/found/scan", { wait: true, include: [{ path: "stems/other pad.wav", kind: "music" }, { path: "renders/hero v3.mov" }] })
      ).json();
      expect(body.failed).toEqual([]);
      expect(await musicFiles(store)).toEqual(["stems/other pad.wav"]);
      expect((await store.read("found")).settled.flatMap((e) => e.kinds)).toEqual(["music"]);
      await post("/api/found/scan", { wait: true });
      expect(await musicFiles(store)).toEqual(["stems/other pad.wav"]);
    });
  });

  it("tags each file with where it came from: the scoring, the agent's include, or by hand", async () => {
    const { store, scanner, post } = await setup({ files: [...FILES, "bed/by hand.wav"], probe: byName(LENGTHS) });
    await heroCut(store);
    await scanner.scan({ film: "hero" });
    await scanner.bringIn([{ path: "bed/by hand.wav", kind: "sfx" }]);
    const body = await (await post("/api/found/scan", { film: "hero", wait: true, include: [{ path: "stems/other pad.wav", kind: "music" }] })).json();
    const origin = Object.fromEntries(body.added.map((a: { path: string; origin: string }) => [a.path, a.origin]));
    expect(origin).toEqual({ "bed/by hand.wav": "hand", "stems/other pad.wav": "include", "vo_jules/hero v3 read.wav": "auto" });
  });

  it("stops waiting after its cap, says it is still scanning, and finishes adopting in the background", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const table = byName(LENGTHS);
    const { store, scanner, post } = await setup({ files: FILES, probe: async (abs) => (await gate, table(abs)), waitMs: 60 });
    await heroCut(store);
    const started = Date.now();
    const res = await post("/api/found/scan", { film: "hero", wait: true });
    expect(Date.now() - started).toBeLessThan(5000);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, scanning: true, added: [], failed: [] });
    expect(body.found).toEqual(expect.objectContaining({ voice: expect.any(Number) }));
    release();
    await scanner.settled();
    expect((await store.read("project")).lanes.map((l) => l.stage).sort()).toEqual(["music", "voice"]);
  });

  it("doesn't say scanning when it finished inside the cap", async () => {
    const { store, post } = await setup({ files: FILES, probe: byName(LENGTHS) });
    await heroCut(store);
    expect(await (await post("/api/found/scan", { film: "hero", wait: true })).json()).not.toHaveProperty("scanning");
  });

  it("refuses include without wait, and bad include items", async () => {
    const { post } = await setup({ files: FILES });
    expect((await post("/api/found/scan", { include: [{ path: "a.wav" }] })).status).toBe(400);
    expect((await post("/api/found/scan", { wait: true, include: [{ path: "" }] })).status).toBe(400);
    expect((await post("/api/found/scan", { wait: true, include: [{ path: "a.wav", kind: "other" }] })).status).toBe(400);
    expect((await post("/api/found/scan", { wait: true, include: Array.from({ length: 61 }, () => ({ path: "a.wav" })) })).status).toBe(400);
    expect((await post("/api/found/scan", { wait: "yes" })).status).toBe(400);
  });

  it("works without a cut: nothing is adopted, an included file still comes in", async () => {
    const { post } = await setup({ files: FILES });
    const body = await (await post("/api/found/scan", { wait: true, include: [{ path: "bed/hero v3 theme.wav" }] })).json();
    expect(body.added.map((a: { path: string }) => a.path)).toEqual(["bed/hero v3 theme.wav"]);
  });

  it("adoptCurrentSet leaves out the kinds it is told to", async () => {
    const { store, scanner } = await setup({ files: FILES, probe: byName(LENGTHS) });
    await heroCut(store);
    await scanner.scan({ film: "hero" });
    const res = await scanner.adoptCurrentSet({ film: "hero", skipKinds: ["voice"] });
    expect(res.added.map((a) => a.kind)).toEqual(["music"]);
  });
});
