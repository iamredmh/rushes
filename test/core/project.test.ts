import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { addFile, addVariant, addVersion, ensureProjectId, ensureProjectIdOnce, latestVersion, lockPicture, resolveVideo, setShots, shotAt } from "../../src/core/project.js";
import { fromManifestPath, toManifestPath } from "../../src/core/paths.js";
import { newProjectId, PROJECT_ID_ALPHABET, slugify, uniqueId } from "../../src/core/ids.js";
import { parseRate } from "../../src/core/media.js";
import { ProjectSchema, type Project, type Shot } from "../../src/core/schema.js";
import { InvalidError, NotFoundError } from "../../src/core/errors.js";
import { tmpProject } from "../helpers/tmp.js";

const empty = (): Project => ({ schema: 1, rev: 0, name: "demo", fps: 30, videos: [], lanes: [], files: [] });

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
