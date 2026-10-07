import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { addFile, addFormat, addVariant, addVersion, ensureProjectId, ensureProjectIdOnce, latestVersion, lockPicture, resolveCut, resolveVideo, setShots, shotAt } from "../../src/core/project.js";
import { fromManifestPath, toManifestPath } from "../../src/core/paths.js";
import { newProjectId, PROJECT_ID_ALPHABET, slugify, uniqueId } from "../../src/core/ids.js";
import { parseRate } from "../../src/core/media.js";
import { NoteSchema, ProjectSchema, type Project, type Shot } from "../../src/core/schema.js";
import { CorruptFileError, InvalidError, NotFoundError, RushesError } from "../../src/core/errors.js";
import { tmpProject } from "../helpers/tmp.js";

const empty = (): Project => ({ schema: 1, rev: 0, name: "demo", fps: 30, videos: [], lanes: [], files: [], autoProxy: false });

describe("ids", () => {
  it("slugifies names, keeping digits and dropping accents", () => {
    expect(slugify("Hero 60s!")).toBe("hero-60s");
    expect(slugify("Café Señor")).toBe("cafe-senor");
    expect(slugify("!!!")).toMatch(/^item-[0-9a-f]{6}$/);
  });
  it("two different non-Latin names get different ids, but the same name gives the same one back", () => {
    const a = slugify("日本");
    const b = slugify("中国");
    expect(a).toMatch(/^item-[0-9a-f]{6}$/);
    expect(b).toMatch(/^item-[0-9a-f]{6}$/);
    expect(a).not.toBe(b);
    expect(slugify("日本")).toBe(a);
  });
  it("uniqueId appends -2, -3", () => {
    expect(uniqueId("a", ["a", "a-2"])).toBe("a-3");
    expect(uniqueId("b", ["a"])).toBe("b");
  });
});

describe("newProjectId", () => {
  it("makes 8 characters from the alphabet, and 200 calls don't collide", () => {
    const ids = Array.from({ length: 200 }, () => newProjectId());
    for (const id of ids) {
      expect(id).toHaveLength(8);
      expect([...id].every((c) => PROJECT_ID_ALPHABET.includes(c))).toBe(true);
    }
    expect(new Set(ids).size).toBe(200);
  });
});

describe("ensureProjectId", () => {
  it("sets an id on a project without one and returns true", () => {
    const p = empty();
    expect(p.id).toBeUndefined();
    expect(ensureProjectId(p)).toBe(true);
    expect(p.id).toMatch(new RegExp(`^[${PROJECT_ID_ALPHABET}]{8}$`));
  });
  it("a second call returns false and leaves the id unchanged", () => {
    const p = empty();
    ensureProjectId(p);
    const id = p.id;
    expect(ensureProjectId(p)).toBe(false);
    expect(p.id).toBe(id);
  });
  it("a project parsed from a Plan 2 JSON fixture with no id still validates", () => {
    const plan2Fixture = { schema: 1, rev: 0, name: "demo", fps: 30, videos: [], lanes: [] };
    const parsed = ProjectSchema.parse(plan2Fixture);
    expect(parsed.id).toBeUndefined();
  });
  it("a project parsed from an older JSON fixture with no files still validates, defaulting to an empty list", () => {
    const olderFixture = { schema: 1, rev: 0, name: "demo", fps: 30, videos: [], lanes: [] };
    const parsed = ProjectSchema.parse(olderFixture);
    expect(parsed.files).toEqual([]);
  });
});

describe("ensureProjectIdOnce", () => {
  it("concurrent callers for the same store share one write, and get the same id back", async () => {
    const { store } = await tmpProject();
    const before = (await store.read("project")).rev;
    const ids = await Promise.all(Array.from({ length: 5 }, () => ensureProjectIdOnce(store)));
    expect(new Set(ids).size).toBe(1);
    const project = await store.read("project");
    expect(project.id).toBe(ids[0]);
    expect(project.rev).toBe(before + 1);
  });
  it("when an id is already on disk, the first call for this store just reads it rather than writing again", async () => {
    const { store } = await tmpProject();
    await store.update("project", ensureProjectId);
    const { id, rev } = await store.read("project");
    const got = await ensureProjectIdOnce(store);
    expect(got).toBe(id);
    expect((await store.read("project")).rev).toBe(rev);
  });
});

describe("manifest paths", () => {
  const root = "/Users/you/My Project";
  it("stores files inside the project as relative, forward-slash paths", () => {
    expect(toManifestPath(root, "/Users/you/My Project/renders/hero v3.mp4")).toBe("renders/hero v3.mp4");
    expect(toManifestPath(root, "renders/hero.mp4")).toBe("renders/hero.mp4");
  });
  it("keeps files outside the project absolute", () => {
    expect(toManifestPath(root, "/Volumes/Extreme SSD/out.mov")).toBe("/Volumes/Extreme SSD/out.mov");
    expect(toManifestPath(root, "../elsewhere/a.mp4")).toBe("/Users/you/elsewhere/a.mp4");
  });
  it("round-trips back to an absolute path", () => {
    expect(fromManifestPath(root, "renders/hero v3.mp4")).toBe(join(root, "renders", "hero v3.mp4"));
    expect(fromManifestPath(root, "/Volumes/x.mov")).toBe("/Volumes/x.mov");
  });
});

describe("addVersion", () => {
  it("creates the video on first use and numbers versions v1, v2", () => {
    const p = empty();
    const a = addVersion(p, { video: "Hero 60s", file: "renders/v1.mp4" }, new Date("2026-10-02T10:00:00Z"));
    expect(a.video).toMatchObject({ id: "hero-60s", name: "Hero 60s" });
    expect(a.version).toMatchObject({ id: "v1", file: "renders/v1.mp4", addedAt: "2026-10-02T10:00:00.000Z", note: "" });
    const b = addVersion(p, { video: "hero-60s", file: "renders/v2.mp4", note: "logo hold" });
    expect(b.version.id).toBe("v2");
    expect(p.videos).toHaveLength(1);
    expect(latestVersion(p.videos[0])?.note).toBe("logo hold");
  });
  it("keeps counting from the highest version even if one was removed", () => {
    const p = empty();
    addVersion(p, { video: "a", file: "1.mp4" });
    addVersion(p, { video: "a", file: "2.mp4" });
    p.videos[0].versions.shift();
    expect(addVersion(p, { video: "a", file: "3.mp4" }).version.id).toBe("v3");
  });
  it("a new version inherits the previous version's shots, as a deep copy", () => {
    const p = empty();
    addVersion(p, { video: "a", file: "1.mp4" });
    setShots(p, "a", "v1", [{ name: "Wide", start: 0 }]);
    const { version: v2 } = addVersion(p, { video: "a", file: "2.mp4" });
    expect(v2.shots).toEqual([{ n: 1, name: "Wide", start: 0, tag: "" }]);
    v2.shots[0].name = "Changed";
    expect(p.videos[0].versions[0].shots[0].name).toBe("Wide");
  });
  it("the first version of a new video has no shots", () => {
    const p = empty();
    expect(addVersion(p, { video: "b", file: "1.mp4" }).version.shots).toEqual([]);
  });
  it("drops inherited shots that start at or past a shorter cut's known duration", () => {
    const p = empty();
    addVersion(p, { video: "a", file: "1.mp4" });
    setShots(p, "a", "v1", [{ name: "A", start: 0 }, { name: "B", start: 2 }, { name: "C", start: 5 }]);
    const { version: v2 } = addVersion(p, { video: "a", file: "2.mp4", duration: 4 });
    expect(v2.shots).toEqual([
      { n: 1, name: "A", start: 0, tag: "" },
      { n: 2, name: "B", start: 2, tag: "" },
    ]);
  });
  it("keeps every inherited shot when the new version's duration isn't known", () => {
    const p = empty();
    addVersion(p, { video: "a", file: "1.mp4" });
    setShots(p, "a", "v1", [{ name: "A", start: 0 }, { name: "C", start: 5 }]);
    const { version: v2 } = addVersion(p, { video: "a", file: "2.mp4" });
    expect(v2.shots).toHaveLength(2);
  });
  it("two different non-Latin video names create two videos, not one merged film", () => {
    const p = empty();
    addVersion(p, { video: "日本", file: "1.mp4" });
    addVersion(p, { video: "中国", file: "2.mp4" });
    expect(p.videos).toHaveLength(2);
    expect(p.videos[0].versions).toHaveLength(1);
    expect(p.videos[1].versions).toHaveLength(1);
  });
});

describe("resolveVideo", () => {
  it("matches by exact id", () => {
    const p = empty();
    addVersion(p, { video: "Hero 60s", file: "1.mp4" });
    expect(resolveVideo(p, "hero-60s").id).toBe("hero-60s");
  });
  it("matches by slugify(ref), when ref isn't itself an id", () => {
    const p = empty();
    addVersion(p, { video: "Hero 60s", file: "1.mp4" });
    expect(resolveVideo(p, "Hero 60s").id).toBe("hero-60s");
    expect(resolveVideo(p, "Hero_60s").id).toBe("hero-60s");
  });
  it("matches by a case-insensitive exact name, as a last resort", () => {
    const p = empty();
    addVersion(p, { video: "Héro!", file: "1.mp4" });
    // "Héro!" slugifies to "hero", which collides with nothing here, so the id stays unique:
    expect(p.videos[0].id).toBe("hero");
    expect(resolveVideo(p, "héro!").id).toBe("hero");
    expect(resolveVideo(p, "HÉRO!")).toBe(p.videos[0]);
  });
  it("prefers an exact id match over a same-named video with a different id", () => {
    const p = empty();
    addVersion(p, { video: "a", file: "1.mp4" });
    p.videos[0].name = "b";
    addVersion(p, { video: "b", file: "1.mp4" });
    expect(resolveVideo(p, "a").id).toBe("a");
  });
  it("throws NotFoundError for no match", () => {
    const p = empty();
    addVersion(p, { video: "Hero 60s", file: "1.mp4" });
    expect(() => resolveVideo(p, "nope")).toThrow(NotFoundError);
    expect(() => resolveVideo(p, "nope")).toThrow('video "nope" not found');
  });
});

describe("setShots", () => {
  it("sorts by start and renumbers from 1", () => {
    const p = empty();
    addVersion(p, { video: "a", file: "1.mp4" });
    const v = setShots(p, "a", "v1", [
      { name: "B", start: 5 },
      { name: "A", start: 1.5 },
    ]);
    expect(v.shots).toEqual([
      { n: 1, name: "A", start: 1.5, tag: "" },
      { n: 2, name: "B", start: 5, tag: "" },
    ]);
  });
  it("defaults to the newest version", () => {
    const p = empty();
    addVersion(p, { video: "a", file: "1.mp4" });
    addVersion(p, { video: "a", file: "2.mp4" });
    const v = setShots(p, "a", undefined, [{ name: "A", start: 0 }]);
    expect(v.id).toBe("v2");
  });
  it("throws for a duplicate start, with the time to 2dp", () => {
    const p = empty();
    addVersion(p, { video: "a", file: "1.mp4" });
    expect(() => setShots(p, "a", "v1", [{ name: "A", start: 1.7 }, { name: "B", start: 1.7 }])).toThrow(
      "Two shots start at 1.70 s",
    );
  });
  it("throws when a start is at or after the cut's known duration", () => {
    const p = empty();
    addVersion(p, { video: "a", file: "1.mp4", duration: 10 });
    expect(() => setShots(p, "a", "v1", [{ name: "A", start: 10 }])).toThrow(InvalidError);
  });
  it("throws for an unknown video or version", () => {
    const p = empty();
    addVersion(p, { video: "a", file: "1.mp4" });
    expect(() => setShots(p, "nope", "v1", [])).toThrow(NotFoundError);
    expect(() => setShots(p, "a", "v9", [])).toThrow(NotFoundError);
  });
});

describe("lockPicture", () => {
  it("locks at a version and unlocks with null", () => {
    const p = empty();
    addVersion(p, { video: "a", file: "1.mp4" });
    const locked = lockPicture(p, "a", "v1");
    expect(locked.lockedVersion).toBe("v1");
    const unlocked = lockPicture(p, "a", null);
    expect(unlocked.lockedVersion).toBeNull();
  });
  it("throws for an unknown version", () => {
    const p = empty();
    addVersion(p, { video: "a", file: "1.mp4" });
    expect(() => lockPicture(p, "a", "v9")).toThrow(NotFoundError);
  });
});

describe("shotAt", () => {
  const shots: Shot[] = [
    { n: 1, name: "Wide", start: 2, tag: "" },
    { n: 2, name: "Close", start: 5, tag: "" },
  ];
  it("returns null when t is before the first shot's start", () => {
    expect(shotAt(shots, 1)).toBeNull();
  });
  it("returns a shot exactly at its start", () => {
    expect(shotAt(shots, 5)).toEqual({ n: 2, name: "Close" });
  });
  it("returns the last shot when t is after the last start", () => {
    expect(shotAt(shots, 99)).toEqual({ n: 2, name: "Close" });
  });
  it("returns null for an empty list", () => {
    expect(shotAt([], 5)).toBeNull();
  });
});

describe("addVariant", () => {
  it("creates a lane named after the stage and gives variants unique ids", () => {
    const p = empty();
    const a = addVariant(p, { stage: "music", name: "Deep house", file: "a.wav", meta: { bpm: 120 } });
    expect(a.lane).toMatchObject({ id: "music", stage: "music", name: "Music" });
    expect(a.variant).toMatchObject({ id: "deep-house", meta: { bpm: 120 }, cues: [] });
    const b = addVariant(p, { stage: "music", name: "Deep house", file: "b.wav" });
    expect(b.variant.id).toBe("deep-house-2");
    expect(p.lanes).toHaveLength(1);
  });
  it("stores cues with ids", () => {
    const p = empty();
    const { variant } = addVariant(p, { stage: "sfx", name: "Pass A", file: "s.wav", cues: [{ name: "Swipe", t: 31.05 }, { name: "Swipe", t: 40 }] });
    expect(variant.cues.map((c) => c.id)).toEqual(["swipe", "swipe-2"]);
  });
  it("refuses to put a music bed in an sfx lane", () => {
    const p = empty();
    addVariant(p, { stage: "sfx", lane: "fx", name: "A", file: "a.wav" });
    expect(() => addVariant(p, { stage: "music", lane: "fx", name: "B", file: "b.wav" })).toThrow(/belongs to sfx/);
  });
});

describe("addVariant rounds (§18.4)", () => {
  it("creates a lane named for the round, slugged for its id", () => {
    const p = empty();
    const { lane } = addVariant(p, { stage: "voice", name: "Gerald", file: "media/g.wav", round: "Round 1 · Voices" });
    expect(lane).toMatchObject({ id: "round-1-voices", name: "Round 1 · Voices", stage: "voice" });
    const second = addVariant(p, { stage: "voice", name: "Jane", file: "media/j.wav", round: "Round 1 · Voices" });
    expect(second.lane.id).toBe("round-1-voices");
    expect(p.lanes).toHaveLength(1);
  });
  it("lets an explicit lane win over round", () => {
    const p = empty();
    const { lane } = addVariant(p, { stage: "voice", name: "Gerald", file: "media/g.wav", lane: "vo-a", round: "Round 9" });
    expect(lane.id).toBe("vo-a");
  });
  it("gives a round that slugs to nothing a stable, non-empty id, keeping the round's own name (I1)", () => {
    const p = empty();
    const first = addVariant(p, { stage: "voice", name: "Gerald", file: "media/g.wav", round: "!!!" });
    expect(first.lane.id).not.toBe("");
    expect(first.lane.name).toBe("!!!");
    const second = addVariant(p, { stage: "voice", name: "Jane", file: "media/j.wav", round: "!!!" });
    expect(second.lane.id).toBe(first.lane.id);
    expect(p.lanes).toHaveLength(1);
  });
  it("throws when a round's slug clashes with another stage's lane", () => {
    const p = empty();
    addVariant(p, { stage: "music", lane: "round-1", name: "A", file: "a.wav" });
    expect(() => addVariant(p, { stage: "voice", name: "Gerald", file: "media/g.wav", round: "Round 1" })).toThrow(/belongs to music/);
  });
});

describe("addFile", () => {
  it("defaults the name to the file's base name and stamps addedAt", () => {
    const p = empty();
    const f = addFile(p, { kind: "doc", file: "README.md" }, new Date("2026-10-03T09:00:00Z"));
    expect(f).toMatchObject({ kind: "doc", file: "README.md", name: "README.md", note: "", video: null, addedAt: "2026-10-03T09:00:00.000Z" });
    expect(p.files).toEqual([f]);
  });
  it("uses a given name and note over the default", () => {
    const p = empty();
    const f = addFile(p, { kind: "doc", file: "docs/brief.md", name: "Creative brief", note: "v2, approved" });
    expect(f).toMatchObject({ name: "Creative brief", note: "v2, approved" });
  });
  it("resolves video by id or name to the video's id", () => {
    const p = empty();
    addVersion(p, { video: "Hero 60s", file: "renders/hero_v1.mp4" });
    expect(addFile(p, { kind: "delivery", file: "exports/hero.mov", video: "Hero 60s" }).video).toBe("hero-60s");
    expect(addFile(p, { kind: "delivery", file: "exports/hero2.mov", video: "hero-60s" }).video).toBe("hero-60s");
  });
  it("throws for an unknown video", () => {
    const p = empty();
    expect(() => addFile(p, { kind: "delivery", file: "x.mov", video: "nope" })).toThrow(NotFoundError);
  });
  it("gives files with the same name unique ids", () => {
    const p = empty();
    const a = addFile(p, { kind: "doc", file: "a/notes.md", name: "Notes" });
    const b = addFile(p, { kind: "doc", file: "b/notes.md", name: "Notes" });
    expect(a.id).toBe("notes");
    expect(b.id).toBe("notes-2");
  });
  it("registers a 90-character file name with an id of 64 characters or fewer (I1)", () => {
    const p = empty();
    const longName = `${"a".repeat(89)}.md`;
    const f = addFile(p, { kind: "doc", file: `docs/${longName}` });
    expect(f.name).toBe(longName);
    expect(f.id.length).toBeLessThanOrEqual(64);
  });
  it("gives two long names that share a prefix unique ids (I1)", () => {
    const p = empty();
    const base = "a".repeat(90);
    const a = addFile(p, { kind: "doc", file: "one.md", name: `${base} one` });
    const b = addFile(p, { kind: "doc", file: "two.md", name: `${base} two` });
    expect(a.id).not.toBe(b.id);
    expect(a.id.length).toBeLessThanOrEqual(64);
    expect(b.id.length).toBeLessThanOrEqual(64);
  });
  it("trims a default name over 120 characters, with an ellipsis (I1)", () => {
    const p = empty();
    const longBase = `${"b".repeat(130)}.md`;
    const f = addFile(p, { kind: "doc", file: longBase });
    expect(f.name.length).toBe(120);
    expect(f.name.endsWith("…")).toBe(true);
  });
  it("rejects an explicit name over 120 characters with a 400, not a schema crash (I1)", () => {
    const p = empty();
    expect(() => addFile(p, { kind: "doc", file: "x.md", name: "c".repeat(121) })).toThrow(InvalidError);
  });
});

describe("parseRate", () => {
  it("reads ffprobe rates", () => {
    expect(parseRate("30000/1001")).toBe(29.97);
    expect(parseRate("60/1")).toBe(60);
    expect(parseRate("0/0")).toBeNull();
    expect(parseRate(undefined)).toBeNull();
  });
});

describe("formats in the data (§21.3)", () => {
  const T0 = new Date("2026-10-07T00:00:00Z");
  const withCut = (size: { width: number | null; height: number | null } = { width: 1920, height: 1080 }) => {
    const p = empty();
    addVersion(p, { video: "Hero", file: "renders/hero_v1.mp4", duration: 8, fps: 30, ...size }, T0);
    return p;
  };
  const shape = (file: string, width: number, height: number, duration: number | null = 8) => ({ file, width, height, duration, fps: 30 });

  // Review Focus 1.
  it("a project and notes from 0.2.x load unchanged: no size, no formats, notes for every format", () => {
    const old = ProjectSchema.parse({
      schema: 1, rev: 3, name: "demo", fps: 30, lanes: [], files: [], autoProxy: false,
      videos: [{ id: "hero", name: "Hero", lockedVersion: null, versions: [{ id: "v1", file: "renders/hero_v1.mp4", duration: 8, fps: 30, addedAt: "2026-10-01T00:00:00Z", note: "", shots: [], proxy: null }] }],
    });
    expect(old.videos[0].versions[0]).toMatchObject({ width: null, height: null, formats: [] });
    const note = NoteSchema.parse({ id: "n_1", stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "x", createdAt: "2026-10-01T00:00:00Z", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } });
    expect(note.format).toBeNull();
  });

  it("addVersion records the primary's size and starts with no formats", () => {
    expect(withCut().videos[0].versions[0]).toMatchObject({ width: 1920, height: 1080, formats: [] });
  });

  it("addFormat registers a shape on the newest cut, measured and labelled", () => {
    const p = withCut();
    const r = addFormat(p, shape("renders/hero_v1_9x16.mp4", 1080, 1920), new Date("2026-10-07T10:00:00Z"));
    expect(r.format).toEqual({ id: "9x16", label: "9:16", file: "renders/hero_v1_9x16.mp4", width: 1080, height: 1920, duration: 8, fps: 30, addedAt: "2026-10-07T10:00:00.000Z" });
    expect(r.warning).toBeNull();
    expect(ProjectSchema.safeParse(p).success).toBe(true);
  });

  // Review Focus 4.
  it("refuses a second render of a ratio the cut already has, the primary's own included", () => {
    const p = withCut();
    addFormat(p, shape("renders/a.mp4", 1080, 1920));
    const again = () => addFormat(p, shape("renders/b.mp4", 720, 1280));
    expect(again).toThrow(RushesError);
    expect(again).toThrow("v1 already has 9:16. Register a re-render as a new version.");
    expect(() => addFormat(p, shape("renders/hero_v1.mp4", 1920, 1080))).toThrow("v1 already has 16:9. Register a re-render as a new version.");
  });

  it("refuses a ninth shape: eight in all, the primary included (R3)", () => {
    const p = withCut();
    const sizes: [number, number][] = [[1080, 1920], [1080, 1080], [1080, 1350], [1440, 1080], [1620, 1080], [1080, 1620], [2520, 1080]];
    sizes.forEach(([w, h], i) => addFormat(p, shape(`renders/f${i}.mp4`, w, h)));
    expect(() => addFormat(p, shape("renders/f8.mp4", 1080, 2520))).toThrow("v1 already has 8 formats, the most one cut can have.");
  });

  it("warns when a format's length is more than 0.1 s off the cut's, and registers it anyway", () => {
    const p = withCut();
    expect(addFormat(p, shape("renders/t.mp4", 1080, 1920, 8.4)).warning).toBe("9:16 is 8.4 s; the cut is 8.0 s");
    expect(p.videos[0].versions[0].formats).toHaveLength(1);
  });

  it("takes a label hint only for an unusual ratio close to it (R10)", () => {
    const r = addFormat(withCut(), { ...shape("renders/scope.mp4", 1920, 804), label: "2.4:1" });
    expect(r.format).toMatchObject({ id: "2.4x1", label: "2.4:1" });
    expect(addFormat(withCut(), { ...shape("renders/t.mp4", 1080, 1920), label: "4:5" }).labelNote).toMatch(/standard ratio/);
  });

  it("uses the primary's size given for a cut from before formats, and refuses without one", () => {
    const p = withCut({ width: null, height: null });
    expect(() => addFormat(p, shape("renders/t.mp4", 1080, 1920))).toThrow(/can't read v1's own picture size/);
    addFormat(p, { ...shape("renders/t.mp4", 1080, 1920), primarySize: { width: 1920, height: 1080 } });
    expect(p.videos[0].versions[0]).toMatchObject({ width: 1920, height: 1080 });
  });

  // Fix round 1, I1: a refusal leaves the project exactly as it was.
  it("addFormat is atomic: after any refusal the project is unchanged, a primarySize included", () => {
    const old = withCut({ width: null, height: null });
    const before = structuredClone(old);
    const primarySize = { width: 1920, height: 1080 };
    // 16:9 against a primary that primarySize says is 16:9 (409).
    expect(() => addFormat(old, { ...shape("renders/same.mp4", 1280, 720), primarySize })).toThrow("v1 already has 16:9.");
    expect(old).toEqual(before);
    // A bad size for the new render, and a bad primarySize: a RushesError, never a RangeError, and no change.
    for (const bad of [{ ...shape("renders/z.mp4", 0, 1920), primarySize }, { ...shape("renders/z.mp4", 1080, 1920), primarySize: { width: 0, height: 1080 } }]) {
      let err: unknown;
      try { addFormat(old, bad); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(RushesError);
      expect(err).not.toBeInstanceOf(RangeError);
      expect(old).toEqual(before);
    }
    // The ninth shape (400) and no primary size (422) change nothing either.
    const full = withCut();
    [[1080, 1920], [1080, 1080], [1080, 1350], [1440, 1080], [1620, 1080], [1080, 1620], [2520, 1080]].forEach(([w, h], i) => addFormat(full, shape(`renders/f${i}.mp4`, w, h)));
    const full0 = structuredClone(full);
    expect(() => addFormat(full, shape("renders/f8.mp4", 1080, 2520))).toThrow(RushesError);
    expect(full).toEqual(full0);
    expect(() => addFormat(old, shape("renders/t.mp4", 1080, 1920))).toThrow(RushesError);
    expect(old).toEqual(before);
    // And a success does backfill the primary's size.
    addFormat(old, { ...shape("renders/t.mp4", 1080, 1920), primarySize });
    expect(old.videos[0].versions[0]).toMatchObject({ width: 1920, height: 1080 });
  });

  it("adds to a locked cut too (§21.6)", () => {
    const p = withCut();
    lockPicture(p, "hero", "v1");
    expect(addFormat(p, shape("renders/t.mp4", 1080, 1920)).format.id).toBe("9x16");
  });

  it("defaults to the newest cut of the newest film, and takes a film and version by name (R16)", () => {
    const p = withCut();
    addVersion(p, { video: "Teaser", file: "renders/teaser_v1.mp4", width: 1920, height: 1080 }, new Date("2026-10-08T00:00:00Z"));
    expect(resolveCut(p).video.id).toBe("teaser");
    addVersion(p, { video: "Hero", file: "renders/hero_v2.mp4", width: 1920, height: 1080 }, new Date("2026-10-09T00:00:00Z"));
    expect(resolveCut(p)).toMatchObject({ video: { id: "hero" }, version: { id: "v2" } });
    expect(resolveCut(p, "Hero", "v1").version.id).toBe("v1");
    expect(() => resolveCut(empty())).toThrow("There's no cut to add a format to yet. Register one with rushes_add_version first.");
  });

  it("project.json with a ratio twice, a format equal to the primary, a label off its id, or nine formats fails validation", () => {
    const p = withCut();
    addFormat(p, shape("renders/t.mp4", 1080, 1920));
    const f0 = p.videos[0].versions[0].formats[0];
    const variants: Project[] = [structuredClone(p), structuredClone(p), structuredClone(p), structuredClone(p)];
    variants[0].videos[0].versions[0].formats.push({ ...f0, file: "renders/u.mp4" });
    variants[1].videos[0].versions[0].formats[0] = { ...f0, id: "16x9", label: "16:9" };
    variants[2].videos[0].versions[0].formats[0] = { ...f0, label: "4:5" };
    variants[3].videos[0].versions[0].formats = Array.from({ length: 9 }, (_, i) => ({ ...f0, id: `${i + 1}x40`, label: `${i + 1}:40` }));
    for (const v of variants) expect(ProjectSchema.safeParse(v).success).toBe(false);
  });

  // Fix round 1, I2: a bad size is a schema failure, never a crash inside the refinement.
  it.each([0, -5, 1.5])("a primary width of %s is reported as a corrupt file, not thrown as a RangeError", async (bad) => {
    const p = withCut();
    addFormat(p, shape("renders/t.mp4", 1080, 1920));
    const raw = structuredClone(p);
    raw.videos[0].versions[0].width = bad;
    expect(() => ProjectSchema.safeParse(raw)).not.toThrow();
    expect(ProjectSchema.safeParse(raw).success).toBe(false);
    const { store } = await tmpProject();
    await writeFile(store.path("project"), JSON.stringify(raw));
    await expect(store.read("project")).rejects.toBeInstanceOf(CorruptFileError);
  });

  it("the store refuses to write a duplicated format, and reports a hand edit that has one", async () => {
    const { store } = await tmpProject();
    await store.update("project", (d) => {
      addVersion(d, { video: "Hero", file: "renders/hero_v1.mp4", width: 1920, height: 1080 });
      addFormat(d, shape("renders/t.mp4", 1080, 1920));
    });
    await expect(store.update("project", (d) => { d.videos[0].versions[0].formats.push({ ...d.videos[0].versions[0].formats[0] }); })).rejects.toThrow(/project\.json is invalid/);
    const raw = JSON.parse(await readFile(store.path("project"), "utf8"));
    raw.videos[0].versions[0].formats.push(raw.videos[0].versions[0].formats[0]);
    await writeFile(store.path("project"), JSON.stringify(raw));
    await expect(store.read("project")).rejects.toThrow(/project\.json can't be read/);
  });
});
