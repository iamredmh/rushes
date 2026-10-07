import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LIMITS,
  commonWordsOf,
  kindOf,
  pickCurrentSet,
  scanFolder,
  scoreCandidate,
  wordsOf,
  type Anchor,
  type FoundFile,
  type Scored,
} from "../../src/core/found.js";

/**
 * Thin wrappers over the real fs and timers, so the tests can count what the scan reads and yields
 * and can stage states a real folder can't easily be put in (a file swapped for a symlink between
 * readdir and lstat, a folder whose real path leads outside, a Dirent that says "symlink").
 */
const spy = vi.hoisted(() => ({
  reads: 0,
  readdirCalls: 0,
  yields: 0,
  direntOverride: null as null | ((e: Dirent) => Dirent),
  realpathLies: [] as Array<[suffix: string, lie: string]>,
  lstatLies: [] as Array<[suffix: string, target: string]>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: ((...args: unknown[]) => {
      spy.readdirCalls++;
      return (actual.readdir as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.readdir,
    opendir: (async (...args: Parameters<typeof actual.opendir>) => {
      const dir = await actual.opendir(...args);
      const read = dir.read.bind(dir);
      dir.read = (async () => {
        const entry = await read();
        if (entry === null) return null;
        spy.reads++;
        return spy.direntOverride ? spy.direntOverride(entry) : entry;
      }) as typeof dir.read;
      return dir;
    }) as typeof actual.opendir,
    realpath: (async (p: string, ...rest: unknown[]) => {
      for (const [suffix, lie] of spy.realpathLies) if (String(p).endsWith(suffix)) return lie;
      return (actual.realpath as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.realpath,
    lstat: (async (p: string, ...rest: unknown[]) => {
      for (const [suffix, target] of spy.lstatLies) if (String(p).endsWith(suffix)) return (actual.lstat as (...a: unknown[]) => unknown)(target, ...rest);
      return (actual.lstat as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.lstat,
  };
});

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...actual,
    setImmediate: ((...args: unknown[]) => {
      spy.yields++;
      return (actual.setImmediate as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.setImmediate,
  };
});

const MIN = 60e3;
const HOUR = 3600e3;

async function touch(root: string, rel: string, content = "x"): Promise<void> {
  const abs = join(root, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

const file = (p: Partial<FoundFile> & { path: string }): FoundFile => ({
  abs: `/x/${p.path}`,
  kind: "voice",
  folder: "",
  size: 1,
  modified: 0,
  duration: null,
  ...p,
});

describe("kindOf (§20.3)", () => {
  it("reads the nearest folder name or file-name word", () => {
    expect(kindOf("vo/line-03.wav")).toBe("voice");
    expect(kindOf("bed/bed-A.wav")).toBe("music");
    expect(kindOf("vo/bed-A.wav")).toBe("music"); // the file-name word is nearer than the folder
    expect(kindOf("sfx/whoosh-1.wav")).toBe("sfx");
    expect(kindOf("audition/take-01.wav")).toBe("other");
    expect(kindOf("render.mp4")).toBe("cut");
    expect(kindOf("Narration Take 2.wav")).toBe("voice");
  });

  it("finds a keyword in a folder name split on non-letters", () => {
    expect(kindOf("vo_jules/jules-read.wav")).toBe("voice");
    expect(kindOf("vo_jules/part-two.wav")).toBe("voice");
    expect(kindOf("score/v2/final.wav")).toBe("music");
    expect(kindOf("stems/kick.wav")).toBe("other");
  });

  it("matches whole words only, never part of a longer word", () => {
    expect(kindOf("bedroom.wav")).toBe("other"); // "bed"
    expect(kindOf("white.wav")).toBe("other"); // "hit"
    expect(kindOf("already.wav")).toBe("other"); // "read"
    expect(kindOf("foxtrot/scorecard.wav")).toBe("other"); // "fx", "score"
    expect(kindOf("BedRoom.wav")).toBe("music"); // camel case makes "bed" a word of its own
  });

  it("reads accented names", () => {
    expect(kindOf("Thème/clip.wav")).toBe("music");
    expect(kindOf("th\u0065\u0300me/clip.wav")).toBe("music"); // the same, typed as e + combining grave
  });

  it("prefers the nearer folder over a farther one", () => {
    expect(kindOf("vo/sfx/hit.wav")).toBe("sfx");
    expect(kindOf("music/vo/line.wav")).toBe("voice");
  });
});

describe("wordsOf", () => {
  it("lower-cases, splits on non-letters and keeps a version word whole", () => {
    expect(wordsOf("harbour-launch-reel-v20J-jules-phone")).toEqual(["harbour", "launch", "reel", "v20j", "jules", "phone"]);
  });

  it("splits camel case", () => {
    expect(wordsOf("GreatVoice")).toEqual(["great", "voice"]);
    expect(wordsOf("juLesRead")).toEqual(["ju", "les", "read"]);
  });

  it("keeps accented letters in their words, without the accents", () => {
    expect(wordsOf("Thème")).toEqual(["theme"]);
    expect(wordsOf("narración")).toEqual(["narracion"]);
    expect(wordsOf("Über-Mix")).toEqual(["uber", "mix"]);
  });

  it("reads the NFC and NFD spellings of a name alike", () => {
    const nfc = "Caf\u00e9-Scene".normalize("NFC");
    const nfd = "Caf\u00e9-Scene".normalize("NFD");
    expect(nfc).not.toBe(nfd);
    expect(wordsOf(nfc)).toEqual(["cafe", "scene"]);
    expect(wordsOf(nfd)).toEqual(wordsOf(nfc));
    expect(wordsOf("CaféScene")).toEqual(["cafe", "scene"]); // camel case still splits after the accent
  });

  it("does not treat digits as words", () => {
    expect(wordsOf("Narration Take 2")).toEqual(["narration", "take"]);
  });
});

describe("scanFolder (§20.2)", () => {
  let tmp: string;
  let root: string;
  let outside: string;
  let realRoot: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "rushes-found-"));
    root = join(tmp, "project");
    outside = join(tmp, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    realRoot = await realpath(root);

    for (let i = 1; i <= 6; i++) await touch(root, `vo/line-0${i}.wav`);
    await touch(root, "vo_jules/jules-full-read.wav");
    await touch(root, "vo_jules/jules-line-01.wav");
    await touch(root, "vo_jules/jules-line-02.wav");
    for (const n of ["bed-A", "bed-B", "bed-C"]) await touch(root, `bed/${n}.wav`);
    await touch(root, "audition/take-01.wav");
    await touch(root, "audition/take-02.wav");
    await touch(root, "audition/old/take-00.wav");
    await touch(root, "sfx/whoosh-1.wav");
    await touch(root, "sfx/hit-2.wav");
    await touch(root, "hyperframes/out/film-v1.mp4");
    await touch(root, "hyperframes/out/film-v2.mp4");
    await touch(root, ".git/x.wav");
    await touch(root, "node_modules/y.wav");
    await touch(root, "Proxies/p.mp4"); // skipped whatever the case
    await touch(root, "EXPORTS/e.mp4");
    await touch(root, "vo/proxies/q.mp4"); // skipped at any depth
    await touch(root, "bed/exports/q.wav");
    await touch(root, ".rushes/z.wav");
    await touch(root, "screenshots/s.wav");
    await touch(root, "vo/.cache/a.wav");
    await touch(root, "bed/node_modules/a.wav");
    await touch(root, "._bed.wav"); // macOS companion files
    await touch(root, "bed/._bed-A.wav");
    await touch(root, ".hidden.wav");
    await touch(root, "notes.md");
    await touch(root, "photo.png");
    await touch(root, "Uppercase.WAV");
    await touch(root, "Screen Recording 2026-10-02 at 3.04.05 PM.mov");

    await touch(outside, "secret.wav");
    await touch(outside, "deep/also-secret.wav");
    await symlink(join(outside, "secret.wav"), join(root, "link.wav"));
    await symlink(join(tmp, "outside"), join(root, "out-link"));
    await symlink("../outside", join(root, "vo", "up-link"));
    await symlink(root, join(root, "loop")); // a loop back into the project
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("finds the right files with the right kinds, as manifest paths", async () => {
    const { files, complete } = await scanFolder(root);
    expect(complete).toBe(true);
    const byPath = new Map(files.map((f) => [f.path, f]));

    expect(byPath.get("vo/line-03.wav")?.kind).toBe("voice");
    expect(byPath.get("vo_jules/jules-full-read.wav")?.kind).toBe("voice");
    expect(byPath.get("bed/bed-B.wav")?.kind).toBe("music");
    expect(byPath.get("audition/take-02.wav")?.kind).toBe("other");
    expect(byPath.get("sfx/hit-2.wav")?.kind).toBe("sfx");
    expect(byPath.get("hyperframes/out/film-v2.mp4")?.kind).toBe("cut");
    expect(byPath.get("Uppercase.WAV")?.kind).toBe("other"); // extensions are case-insensitive

    const line = byPath.get("vo/line-03.wav")!;
    expect(line.folder).toBe("vo");
    expect(line.abs).toBe(join(realRoot, "vo", "line-03.wav"));
    expect(line.size).toBe(1);
    expect(line.duration).toBeNull();
    expect(line.modified).toBeGreaterThan(0);
    expect(byPath.get("Uppercase.WAV")?.folder).toBe("");
    // vo 6, vo_jules 3, bed 3, audition 3 (one in old/), sfx 2, hyperframes/out 2, Uppercase, the U+202F recording
    expect(files).toHaveLength(6 + 3 + 3 + 3 + 2 + 2 + 1 + 1);
  });

  it("skips hidden and project folders, other extensions and every symlink", async () => {
    const { files } = await scanFolder(root);
    const paths = files.map((f) => f.path);
    for (const skipped of [
      ".git/x.wav",
      "node_modules/y.wav",
      "Proxies/p.mp4",
      "EXPORTS/e.mp4",
      "vo/proxies/q.mp4",
      "bed/exports/q.wav",
      ".rushes/z.wav",
      "screenshots/s.wav",
      "vo/.cache/a.wav",
      "bed/node_modules/a.wav",
      "._bed.wav",
      "bed/._bed-A.wav",
      ".hidden.wav",
      "notes.md",
      "photo.png",
    ]) {
      expect(paths).not.toContain(skipped);
    }
    expect(paths.some((p) => /(^|\/)(\.|node_modules|proxies|exports|screenshots)/i.test(p))).toBe(false);
    expect(paths).not.toContain("link.wav");
    expect(paths.some((p) => p.startsWith("out-link") || p.startsWith("loop") || p.includes("up-link"))).toBe(false);
  });

  it("never lists a path outside the root", async () => {
    const { files } = await scanFolder(root);
    for (const f of files) {
      expect(f.path.startsWith("..")).toBe(false);
      expect(f.path.startsWith("/")).toBe(false);
      expect(f.abs.startsWith(realRoot + "/")).toBe(true);
      expect(f.path).not.toContain("secret");
    }
  });

  it("scans and registers a macOS file name with a narrow no-break space (U+202F)", async () => {
    const name = "Screen Recording 2026-10-02 at 3.04.05 PM.mov";
    const { files } = await scanFolder(root);
    const found = files.find((f) => f.path === name);
    expect(found).toBeDefined();
    expect(found?.kind).toBe("cut");
    expect(found?.path).toContain(" ");
    expect(found?.abs).toBe(join(realRoot, name));
  });

  it("visits siblings in sorted order, so results are deterministic", async () => {
    const a = await scanFolder(root);
    const b = await scanFolder(root);
    expect(a.files.map((f) => f.path)).toEqual(b.files.map((f) => f.path));
    const sameFolder = a.files.filter((f) => f.folder === "vo").map((f) => f.path);
    expect(sameFolder).toEqual([...sameFolder].sort());
  });

  it("stops between folder reads once its signal aborts, and says it is not complete", async () => {
    const before = new AbortController();
    before.abort();
    const none = await scanFolder(root, { signal: before.signal });
    expect(none).toMatchObject({ files: [], complete: false, examined: 0 });

    // Aborted while the first folder is being looked at (the skip check runs per entry): no
    // further folder is read, so nothing below the root is listed.
    const mid = new AbortController();
    const r = await scanFolder(root, {
      signal: mid.signal,
      skip: () => {
        mid.abort();
        return false;
      },
    });
    expect(r.complete).toBe(false);
    expect(r.files.every((f) => !f.path.includes("/"))).toBe(true);
    const full = await scanFolder(root);
    expect(r.examined).toBeLessThan(full.examined);
  });

  it("respects maxDepth", async () => {
    const shallow = await scanFolder(root, { limits: { maxDepth: 1 } });
    const paths = shallow.files.map((f) => f.path);
    expect(paths).toContain("vo/line-01.wav"); // one level down
    expect(paths).not.toContain("hyperframes/out/film-v1.mp4"); // two levels down
    const none = await scanFolder(root, { limits: { maxDepth: 0 } });
    expect(none.files.every((f) => !f.path.includes("/"))).toBe(true);
    const deep = await scanFolder(root, { limits: { maxDepth: 2 } });
    expect(deep.files.map((f) => f.path)).toContain("hyperframes/out/film-v1.mp4");
  });

  it("stops at maxExamined and says it is not complete", async () => {
    const r = await scanFolder(root, { limits: { maxExamined: 10 } });
    expect(r.complete).toBe(false);
    expect(r.examined).toBe(10);
  });

  it("is complete when the limit is exactly the number of entries", async () => {
    const full = await scanFolder(root);
    const exact = await scanFolder(root, { limits: { maxExamined: full.examined } });
    expect(exact.complete).toBe(true);
    expect(exact.files).toHaveLength(full.files.length);
  });

  it("stops at maxKept and says it is not complete", async () => {
    const r = await scanFolder(root, { limits: { maxKept: 5 } });
    expect(r.complete).toBe(false);
    expect(r.files).toHaveLength(5);
  });

  it("stops at the time budget, using the injected clock", async () => {
    let t = 0;
    const now = () => (t += 1000); // every look at the clock costs one second
    const r = await scanFolder(root, { limits: { budgetMs: 5000 }, now });
    expect(r.complete).toBe(false);
    expect(r.examined).toBeLessThan(10);
    // A frozen clock never runs out.
    const frozen = await scanFolder(root, { limits: { budgetMs: 5000 }, now: () => 0 });
    expect(frozen.complete).toBe(true);
  });

  it("lets the caller skip paths", async () => {
    const r = await scanFolder(root, { skip: (rel) => rel === "bed" || rel === "vo/line-01.wav" });
    const paths = r.files.map((f) => f.path);
    expect(paths.some((p) => p.startsWith("bed/"))).toBe(false);
    expect(paths).not.toContain("vo/line-01.wav");
    expect(paths).toContain("vo/line-02.wav");
  });

  it("applies a skip predicate to a nested folder, with a forward-slash path", async () => {
    const seen: string[] = [];
    const r = await scanFolder(root, {
      skip: (rel) => {
        seen.push(rel);
        return rel === "audition/old";
      },
    });
    const paths = r.files.map((f) => f.path);
    expect(seen).toContain("audition/old");
    expect(paths).not.toContain("audition/old/take-00.wav");
    expect(paths).toContain("audition/take-01.wav");
    expect((await scanFolder(root)).files.map((f) => f.path)).toContain("audition/old/take-00.wav");
  });

  it("returns nothing, completely, for an empty folder", async () => {
    const empty = join(tmp, "empty");
    await mkdir(empty);
    expect(await scanFolder(empty)).toEqual({ files: [], complete: true, examined: 0 });
  });

  it("exports the default limits from the spec", () => {
    expect(DEFAULT_LIMITS).toEqual({ maxDepth: 8, maxExamined: 5000, maxKept: 2000, budgetMs: 3000 });
  });
});

describe("scanFolder containment, proved one guard at a time", () => {
  async function inTree(files: string[], run: (root: string, tmp: string) => Promise<void>): Promise<void> {
    const tmp = await mkdtemp(join(tmpdir(), "rushes-found-guard-"));
    try {
      const root = join(tmp, "project");
      await mkdir(root);
      for (const f of files) await touch(root, f);
      await run(await realpath(root), tmp);
    } finally {
      spy.direntOverride = null;
      spy.realpathLies = [];
      spy.lstatLies = [];
      await rm(tmp, { recursive: true, force: true });
    }
  }

  it("skips an entry the directory reports as a symlink, whatever else it says", async () => {
    await inTree(["real.wav", "faux.wav"], async (root) => {
      // A Dirent that claims to be both: the explicit symlink guard must win.
      spy.direntOverride = (e) =>
        e.name === "faux.wav" ? ({ name: e.name, isSymbolicLink: () => true, isFile: () => true, isDirectory: () => false } as Dirent) : e;
      const r = await scanFolder(root);
      expect(r.files.map((f) => f.path)).toEqual(["real.wav"]);
    });
  });

  it("asks the file system when the directory doesn't say what an entry is (some network and FUSE drives)", async () => {
    await inTree(["real.wav", "vo/take.wav", "vo/deeper/more.wav", "target/x.wav"], async (root, tmp) => {
      await symlink(join(root, "real.wav"), join(root, "link.wav"));
      await symlink(join(root, "target"), join(root, "linked-folder"));
      spy.direntOverride = (e) => ({ name: e.name, isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false }) as Dirent;
      const r = await scanFolder(root);
      expect(r.files.map((f) => f.path).sort()).toEqual(["real.wav", "target/x.wav", "vo/deeper/more.wav", "vo/take.wav"]);
    });
  });

  it("skips a file that turns into a symlink between the listing and the lstat", async () => {
    await inTree(["real.wav", "swap.wav", "elsewhere/target.wav"], async (root, tmp) => {
      await symlink(join(root, "real.wav"), join(tmp, "swapped-link"));
      spy.lstatLies = [["/swap.wav", join(tmp, "swapped-link")]];
      const r = await scanFolder(root);
      const paths = r.files.map((f) => f.path);
      expect(paths).not.toContain("swap.wav");
      expect(paths).toContain("real.wav");
      expect(paths).toContain("elsewhere/target.wav");
    });
  });

  it("skips a real folder whose real path leads outside the root", async () => {
    await inTree(["escape/inside.wav", "fine/ok.wav"], async (root, tmp) => {
      await touch(join(tmp, "outside"), "inside.wav");
      spy.realpathLies = [["/escape", join(tmp, "outside")]];
      const r = await scanFolder(root);
      expect(r.files.map((f) => f.path)).toEqual(["fine/ok.wav"]);
    });
  });

  it("does not take a sibling folder that merely starts with the root's name as inside it", async () => {
    await inTree(["escape/inside.wav", "fine/ok.wav"], async (root) => {
      spy.realpathLies = [["/escape", `${root}-sibling`]];
      const r = await scanFolder(root);
      expect(r.files.map((f) => f.path)).toEqual(["fine/ok.wav"]);
    });
  });

  it("rejects when the root does not exist", async () => {
    await expect(scanFolder(join(tmpdir(), "rushes-found-no-such-folder"))).rejects.toThrow();
  });
});

describe("scanFolder budget and yielding", () => {
  it("stops the moment the elapsed time reaches the budget, not one tick later", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "rushes-found-budget-"));
    try {
      for (const n of ["a", "b", "c"]) await touch(tmp, `${n}.wav`);
      let calls = 0;
      // The first call is the start (0); every later look at the clock says exactly the budget has gone.
      const exactly = await scanFolder(tmp, { limits: { budgetMs: 3000 }, now: () => (calls++ === 0 ? 0 : 3000) });
      expect(exactly).toEqual({ files: [], complete: false, examined: 0 });
      calls = 0;
      const justUnder = await scanFolder(tmp, { limits: { budgetMs: 3000 }, now: () => (calls++ === 0 ? 0 : 2999) });
      expect(justUnder.complete).toBe(true);
      expect(justUnder.examined).toBe(3);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("yields to the event loop every 200 entries, and not before", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "rushes-found-yield-"));
    try {
      const writes: Promise<void>[] = [];
      for (let i = 0; i < 400; i++) writes.push(writeFile(join(tmp, `f-${String(i).padStart(3, "0")}.wav`), "x"));
      await Promise.all(writes);

      spy.yields = 0;
      const all = await scanFolder(tmp);
      expect(all.examined).toBe(400);
      expect(spy.yields).toBe(2); // after the 200th and the 400th

      spy.yields = 0;
      const nearly = await scanFolder(tmp, { limits: { maxExamined: 399 } });
      expect(nearly.examined).toBe(399);
      expect(spy.yields).toBe(1); // only the 200th

      spy.yields = 0;
      await scanFolder(tmp, { limits: { maxExamined: 199 } });
      expect(spy.yields).toBe(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("reads a big folder a few entries at a time, never all of it, when the examined limit is small", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "rushes-found-big-folder-"));
    try {
      const writes: Promise<void>[] = [];
      for (let i = 0; i < 3000; i++) writes.push(writeFile(join(tmp, `take-${String(i).padStart(4, "0")}.wav`), "x"));
      await Promise.all(writes);

      spy.reads = 0;
      spy.readdirCalls = 0;
      const r = await scanFolder(tmp, { limits: { maxExamined: 50 } });
      expect(r.complete).toBe(false);
      expect(r.examined).toBe(50);
      expect(r.files).toHaveLength(50);
      expect(spy.readdirCalls).toBe(0);
      expect(spy.reads).toBeGreaterThan(0);
      expect(spy.reads).toBeLessThanOrEqual(51); // the limit, plus one to know there was more
      // What was read is sorted before it is walked.
      const paths = r.files.map((f) => f.path);
      expect(paths).toEqual([...paths].sort());
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("scanFolder on a big tree", () => {
  // Wall time on a shared machine depends on everything else it's running (this flaked at a load
  // average of 37), so the speed check uses the process's own CPU time, and the walk is given a
  // budget it can't run out of. What must hold is bounded work: every file once, and the limits.
  it("scans 5,000 generated files in under 2 s of CPU, and stops at the defaults on a bigger one", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "rushes-found-big-"));
    try {
      const folders = 50;
      const perFolder = 100;
      const writes: Promise<void>[] = [];
      for (let d = 0; d < folders; d++) {
        const dir = join(tmp, `session-${String(d).padStart(2, "0")}`);
        await mkdir(dir);
        for (let i = 0; i < perFolder; i++) writes.push(writeFile(join(dir, `take-${String(i).padStart(3, "0")}.wav`), "x"));
      }
      await Promise.all(writes);

      const roomy = { maxExamined: 20000, maxKept: 20000, budgetMs: 120_000 };
      const cpu0 = process.cpuUsage();
      const r = await scanFolder(tmp, { limits: roomy });
      const cpu = process.cpuUsage(cpu0);
      expect(r.files).toHaveLength(folders * perFolder);
      expect(r.complete).toBe(true);
      expect(r.examined).toBe(folders + folders * perFolder); // each folder and file looked at once
      expect((cpu.user + cpu.system) / 1000).toBeLessThan(2000);

      // With the default limits the same tree is cut short at the examined limit, never hung.
      const limited = await scanFolder(tmp, { limits: { budgetMs: 120_000 } });
      expect(limited.complete).toBe(false);
      expect(limited.examined).toBeLessThanOrEqual(DEFAULT_LIMITS.maxExamined);
      expect(limited.files.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxKept);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("scoreCandidate (§20.4)", () => {
  const cutTime = Date.UTC(2026, 9, 6, 12, 0, 0);
  const anchor = (a: Partial<Anchor> = {}): Anchor => ({ duration: 68.7, modified: cutTime, words: ["film"], ...a });
  const none = new Set<string>();

  it("scores a same-length file made 12 minutes before the cut", () => {
    const f = file({ path: "vo/full.wav", duration: 68.6, modified: cutTime - 12 * MIN });
    const s = scoreCandidate(f, anchor(), none);
    expect(s.score).toBe(5);
    expect(s.reasons).toEqual(["same length as the cut (68.6 s vs 68.7 s)", "made 12 min before it"]);
  });

  it("scores length by closeness: 2 % is +3, 10 % is +2, 25 % is +1, beyond is none", () => {
    const at = (duration: number) => scoreCandidate(file({ path: "a.wav", duration, modified: 0 }), anchor({ duration: 100, modified: 1e12 }), none);
    expect(at(102).score).toBe(3);
    expect(at(110).score).toBe(2);
    expect(at(110).reasons).toEqual(["close to the cut's length"]);
    expect(at(75).score).toBe(1);
    expect(at(75).reasons).toEqual(["in the region of the cut's length"]);
    expect(at(60).score).toBe(0);
  });

  it("puts the length bands' edges exactly where the spec does (inclusive), on both sides", () => {
    const at = (duration: number) => scoreCandidate(file({ path: "a.wav", duration, modified: 0, kind: "music" }), anchor({ duration: 100, modified: 1e12 }), none).score;
    // within 2 %
    expect(at(98)).toBe(3);
    expect(at(102)).toBe(3);
    expect(at(103)).toBe(2);
    expect(at(97)).toBe(2);
    // within 10 %
    expect(at(90)).toBe(2);
    expect(at(110)).toBe(2);
    expect(at(111)).toBe(1);
    expect(at(89)).toBe(1);
    // within 25 %
    expect(at(75)).toBe(1);
    expect(at(125)).toBe(1);
    expect(at(126)).toBe(0);
    expect(at(74)).toBe(0);
  });

  it("gives the short-line reason under 15 s only, and only to voice and other files", () => {
    const reasons = (duration: number, kind: FoundFile["kind"]) =>
      scoreCandidate(file({ path: "a.wav", kind, duration, modified: 0 }), anchor({ modified: 1e12 }), none).reasons;
    expect(reasons(14, "voice")).toEqual(["a short line (14 s)"]);
    expect(reasons(4, "other")).toEqual(["a short line (4 s)"]);
    expect(reasons(15, "voice")).toEqual([]);
    expect(reasons(16, "voice")).toEqual([]);
    expect(reasons(4, "music")).toEqual([]);
    expect(reasons(4, "sfx")).toEqual([]);
  });

  it("gives a short line below 4 and says so", () => {
    const f = file({ path: "vo/line-03.wav", duration: 4, modified: cutTime - 10 * MIN });
    const s = scoreCandidate(f, anchor(), none);
    expect(s.score).toBeLessThan(4);
    expect(s.reasons).toContain("a short line (4 s)");
  });

  it("gives a sound effect no length score", () => {
    const sfx = scoreCandidate(file({ path: "sfx/hit.wav", kind: "sfx", duration: 68.7, modified: 0 }), anchor({ modified: 1e12 }), none);
    expect(sfx.score).toBe(0);
    expect(sfx.reasons).toEqual([]);
    const voice = scoreCandidate(file({ path: "vo/hit.wav", kind: "voice", duration: 68.7, modified: 0 }), anchor({ modified: 1e12 }), none);
    expect(voice.score).toBe(3);
  });

  it("ignores one-letter name words and words that are the version", () => {
    const base = anchor({ duration: null, modified: 1e12 });
    // "a" is in both names but is not a word that tells anything.
    const a = scoreCandidate(file({ path: "bed/bed-A.wav", modified: 0 }), { ...base, words: ["a", "film"] }, none);
    expect(a.score).toBe(0);
    expect(a.reasons).toEqual([]);
    // The version is worth +2 once, not +1 as a name word and +2 as a version.
    const v = scoreCandidate(file({ path: "vo/v20j.wav", modified: 0 }), { ...base, words: ["v20j"] }, none);
    expect(v.score).toBe(2);
    expect(v.reasons).toEqual(["same version (v20j)"]);
  });

  it("scores a version word only when it tells cuts apart: unique +2, on every file 0", () => {
    const files = [
      file({ path: "vo/take-v20j.wav", modified: 0 }),
      file({ path: "vo/other-v20j.wav", modified: 0 }),
      file({ path: "vo/third-v20j.wav", modified: 0 }),
    ];
    const base = anchor({ duration: null, modified: 1e12, words: ["v20j"] });
    const everywhere = commonWordsOf(files);
    expect(everywhere.has("v20j")).toBe(true);
    expect(scoreCandidate(files[0], base, everywhere)).toMatchObject({ score: 0, reasons: [] });

    const mixed = [...files.slice(0, 1), file({ path: "vo/take-v19.wav", modified: 0 }), file({ path: "vo/line.wav", modified: 0 })];
    const some = commonWordsOf(mixed);
    expect(some.has("v20j")).toBe(false);
    expect(scoreCandidate(mixed[0], base, some)).toMatchObject({ score: 2, reasons: ["same version (v20j)"] });
  });

  it("scores nothing for length when either duration is unknown", () => {
    const s = scoreCandidate(file({ path: "a.wav", duration: null, modified: 0 }), anchor({ modified: 1e12 }), none);
    expect(s.score).toBe(0);
    const t = scoreCandidate(file({ path: "a.wav", duration: 68.7, modified: 0 }), anchor({ duration: null, modified: 1e12 }), none);
    expect(t.score).toBe(0);
  });

  it("scores the time window: 6 h before to 1 h after is +2, the 24 h before is +1", () => {
    const at = (delta: number) => scoreCandidate(file({ path: "a.wav", modified: cutTime + delta }), anchor({ duration: null }), none);
    expect(at(-6 * HOUR).score).toBe(2);
    expect(at(HOUR).score).toBe(2);
    expect(at(HOUR + MIN).score).toBe(0);
    expect(at(-6 * HOUR - MIN).score).toBe(1);
    expect(at(-24 * HOUR).score).toBe(1);
    expect(at(-24 * HOUR - MIN).score).toBe(0);
  });

  it("words the time reasons plainly: minutes, then hours", () => {
    const reason = (delta: number) => scoreCandidate(file({ path: "a.wav", modified: cutTime + delta }), anchor({ duration: null }), none).reasons[0];
    expect(reason(-12 * MIN)).toBe("made 12 min before it");
    expect(reason(20 * MIN)).toBe("made 20 min after it");
    expect(reason(-3 * HOUR)).toBe("made 3 hours before it");
    expect(reason(-HOUR)).toBe("made 1 hour before it");
    expect(reason(-14 * HOUR)).toBe("made 14 hours before it");
    expect(reason(10e3)).toBe("made at about the same time");
  });

  it("counts a shared word only when it is not common, up to two, plus a version word", () => {
    const words = ["harbour", "reel", "jules", "phone", "v20j"];
    const f = file({ path: "vo_jules/harbour-reel-jules-phone-v20J.wav", modified: 0 });
    const base = anchor({ duration: null, modified: 1e12, words });

    // "harbour" and "reel" are common, so they say nothing; "jules" and "phone" count; the version adds 2.
    const s = scoreCandidate(f, base, new Set(["harbour", "reel"]));
    expect(s.score).toBe(2 + 2);
    expect(s.reasons).toEqual(["name shares “jules” and “phone”", "same version (v20j)"]);

    // Up to two shared words, however many match.
    const capped = scoreCandidate(f, base, none);
    expect(capped.score).toBe(2 + 2);

    // Only one shared word is +1 and phrased singly.
    const one = scoreCandidate(file({ path: "vo/jules-read.wav", modified: 0 }), base, none);
    expect(one.score).toBe(1);
    expect(one.reasons).toEqual(["name shares “jules”"]);

    // A different version is worth nothing.
    const other = scoreCandidate(file({ path: "vo/take-v19.wav", modified: 0 }), base, none);
    expect(other.score).toBe(0);
  });
});

describe("commonWordsOf", () => {
  it("keeps the words in more than half of the paths", () => {
    const files = [
      file({ path: "vo/film-line-01.wav" }),
      file({ path: "vo/film-line-02.wav" }),
      file({ path: "bed/film-bed.wav" }),
      file({ path: "vo_jules/jules-read.wav" }),
    ];
    const common = commonWordsOf(files);
    expect(common.has("film")).toBe(true); // 3 of 4
    expect(common.has("line")).toBe(false); // exactly half is not more than half
    expect(common.has("vo")).toBe(true); // vo/ twice and vo_jules: 3 of 4
    expect(common.has("jules")).toBe(false);
    expect(commonWordsOf([]).size).toBe(0);
  });
});

describe("pickCurrentSet (§20.4)", () => {
  const s = (path: string, kind: FoundFile["kind"], score: number): Scored => ({ file: file({ path, kind }), score, reasons: [] });

  it("takes the top candidate per kind only at 4 or more with a lead of 1", () => {
    const picked = pickCurrentSet([
      s("vo/a.wav", "voice", 6),
      s("vo/b.wav", "voice", 4),
      s("bed/a.wav", "music", 4),
      s("bed/b.wav", "music", 3),
      s("sfx/a.wav", "sfx", 5),
    ]);
    expect(picked.voice?.file.path).toBe("vo/a.wav");
    expect(picked.music?.file.path).toBe("bed/a.wav");
    expect(picked.sfx?.file.path).toBe("sfx/a.wav");
  });

  it("picks nothing when the best is under 4", () => {
    expect(pickCurrentSet([s("vo/a.wav", "voice", 3), s("vo/b.wav", "voice", 1)])).toEqual({});
  });

  it("picks nothing for a kind that ties", () => {
    const picked = pickCurrentSet([s("vo/a.wav", "voice", 5), s("vo/b.wav", "voice", 5), s("bed/a.wav", "music", 5)]);
    expect(picked.voice).toBeUndefined();
    expect(picked.music?.file.path).toBe("bed/a.wav");
  });

  it("never picks 'other' or cuts, and at most one per kind", () => {
    const picked = pickCurrentSet([s("a/x.wav", "other", 9), s("c.mp4", "cut", 9), s("vo/a.wav", "voice", 5), s("vo/b.wav", "voice", 2)]);
    expect(Object.keys(picked)).toEqual(["voice"]);
  });

  it("does not depend on input order", () => {
    const list = [s("vo/b.wav", "voice", 4), s("vo/a.wav", "voice", 7)];
    expect(pickCurrentSet(list).voice?.file.path).toBe("vo/a.wav");
    expect(pickCurrentSet([...list].reverse()).voice?.file.path).toBe("vo/a.wav");
  });
});
