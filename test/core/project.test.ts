import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { addVariant, addVersion, ensureProjectId, latestVersion, lockPicture, setShots, shotAt } from "../../src/core/project.js";
import { fromManifestPath, toManifestPath } from "../../src/core/paths.js";
import { newProjectId, PROJECT_ID_ALPHABET, slugify, uniqueId } from "../../src/core/ids.js";
import { parseRate } from "../../src/core/media.js";
import { ProjectSchema, type Project, type Shot } from "../../src/core/schema.js";
import { InvalidError, NotFoundError } from "../../src/core/errors.js";

const empty = (): Project => ({ schema: 1, rev: 0, name: "demo", fps: 30, videos: [], lanes: [] });

describe("ids", () => {
  it("slugifies names, keeping digits and dropping accents", () => {
    expect(slugify("Hero 60s!")).toBe("hero-60s");
    expect(slugify("Café Señor")).toBe("cafe-senor");
    expect(slugify("!!!")).toBe("item");
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
});

describe("manifest paths", () => {
  const root = "/Users/red/My Project";
  it("stores files inside the project as relative, forward-slash paths", () => {
    expect(toManifestPath(root, "/Users/red/My Project/renders/hero v3.mp4")).toBe("renders/hero v3.mp4");
    expect(toManifestPath(root, "renders/hero.mp4")).toBe("renders/hero.mp4");
  });
  it("keeps files outside the project absolute", () => {
    expect(toManifestPath(root, "/Volumes/Extreme SSD/out.mov")).toBe("/Volumes/Extreme SSD/out.mov");
    expect(toManifestPath(root, "../elsewhere/a.mp4")).toBe("/Users/red/elsewhere/a.mp4");
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

describe("parseRate", () => {
  it("reads ffprobe rates", () => {
    expect(parseRate("30000/1001")).toBe(29.97);
    expect(parseRate("60/1")).toBe(60);
    expect(parseRate("0/0")).toBeNull();
    expect(parseRate(undefined)).toBeNull();
  });
});
