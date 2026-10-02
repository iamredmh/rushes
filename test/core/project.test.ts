import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { addVariant, addVersion, latestVersion } from "../../src/core/project.js";
import { fromManifestPath, toManifestPath } from "../../src/core/paths.js";
import { slugify, uniqueId } from "../../src/core/ids.js";
import { parseRate } from "../../src/core/media.js";
import type { Project } from "../../src/core/schema.js";

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
