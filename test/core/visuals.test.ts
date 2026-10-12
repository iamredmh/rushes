import { describe, expect, it } from "vitest";
import { VisualsFileSchema, type VisualsFile } from "../../src/core/schema.js";
import { addVisualVersion, checkVisualNote, pinWords, regionWords, registerVisual, visualNoteView, visualRatios } from "../../src/core/visuals.js";
import { RushesError } from "../../src/core/errors.js";
import { readFileSync } from "node:fs";
import { modulesPulledIn } from "../helpers/imports.js";

// §25.3 and §25.5: registering a visual, registering a version of it, and checking a note against it.
const NOW = new Date("2026-10-12T10:00:00.000Z");
const empty = (): VisualsFile => VisualsFileSchema.parse({ schema: 1, rev: 0 });
const img = (file: string, width: number, height: number) => ({ file, width, height });
const portrait = (n: number) => img(`visuals/launch/p${n}-4x5.png`, 1080, 1350);
const wide = (n: number) => img(`visuals/launch/p${n}-16x9.png`, 1600, 900);
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as RushesError).code;
  }
  return undefined;
};

function carousel(): VisualsFile {
  const f = empty();
  registerVisual(f, { name: "Launch carousel", pages: [1, 2, 3].map((n) => ({ files: [portrait(n)] })) }, NOW);
  return f;
}

describe("registerVisual", () => {
  it("makes a carousel from several pages, naming ratios from the pictures' sizes", () => {
    const f = empty();
    const { visual, version } = registerVisual(f, { name: "Launch carousel", pages: [1, 2, 3].map((n) => ({ files: [portrait(n)] })) }, NOW);
    expect(visual).toMatchObject({ id: "launch-carousel", name: "Launch carousel", kind: "carousel", addedAt: NOW.toISOString() });
    expect(version).toMatchObject({ id: "v1", label: "" });
    expect(version.pages.map((p) => p.n)).toEqual([1, 2, 3]);
    expect(version.pages[0].images).toEqual([{ ratio: "4x5", file: "visuals/launch/p1-4x5.png", width: 1080, height: 1350 }]);
    expect(f.visuals).toHaveLength(1);
  });
  it("makes a still from one page, in more than one ratio", () => {
    const f = empty();
    const { visual, version } = registerVisual(f, { name: "Quote", pages: [{ files: [portrait(1), wide(1)] }] }, NOW);
    expect(visual.kind).toBe("still");
    expect(version.pages[0].images.map((i) => i.ratio)).toEqual(["4x5", "16x9"]);
  });
  it("lets a one-page visual be called a carousel, and a many-page one not be a still", () => {
    expect(registerVisual(empty(), { name: "One", kind: "carousel", pages: [{ files: [portrait(1)] }] }, NOW).visual.kind).toBe("carousel");
    expect(code(() => registerVisual(empty(), { name: "Many", kind: "still", pages: [{ files: [portrait(1)] }, { files: [portrait(2)] }] }, NOW))).toBe("bad_pages");
  });
  it("numbers pages in order, and takes the numbers it is given when they are 1, 2, 3", () => {
    const f = empty();
    const { version } = registerVisual(f, { name: "A", pages: [{ n: 1, files: [portrait(1)] }, { n: 2, files: [portrait(2)] }] }, NOW);
    expect(version.pages.map((p) => p.n)).toEqual([1, 2]);
    expect(code(() => registerVisual(empty(), { name: "B", pages: [{ n: 2, files: [portrait(1)] }] }, NOW))).toBe("bad_pages");
  });
  it("refuses a name already used, an empty page list, and more than 100 pages", () => {
    const f = carousel();
    expect(code(() => registerVisual(f, { name: "launch carousel", pages: [{ files: [portrait(1)] }] }, NOW))).toBe("duplicate_name");
    expect(code(() => registerVisual(empty(), { name: "None", pages: [] }, NOW))).toBe("bad_pages");
    expect(code(() => registerVisual(empty(), { name: "Huge", pages: Array.from({ length: 101 }, (_, i) => ({ files: [portrait(i + 1)] })) }, NOW))).toBe("too_many_pages");
  });
  it("refuses two pictures of one shape on a page, and pages that disagree about their ratios", () => {
    expect(code(() => registerVisual(empty(), { name: "Twin", pages: [{ files: [portrait(1), img("visuals/x/big.png", 2160, 2700)] }] }, NOW))).toBe("same_ratio");
    expect(code(() => registerVisual(empty(), { name: "Odd", pages: [{ files: [portrait(1)] }, { files: [portrait(2), wide(2)] }] }, NOW))).toBe("ratio_set");
  });
  it("gives a second visual with a similar name its own id", () => {
    const f = carousel();
    expect(registerVisual(f, { name: "Launch carousel 2", pages: [{ files: [portrait(1)] }] }, NOW).visual.id).toBe("launch-carousel-2");
  });
});

describe("addVisualVersion", () => {
  it("inherits every page it is not sent", () => {
    const f = carousel();
    const { version } = addVisualVersion(f, { visual: "launch-carousel", label: "Shorter headline", pages: [{ n: 3, files: [img("visuals/launch/p3-v2.png", 1080, 1350)] }] }, NOW);
    expect(version.id).toBe("v2");
    expect(version.label).toBe("Shorter headline");
    expect(version.pages.map((p) => p.images[0].file)).toEqual(["visuals/launch/p1-4x5.png", "visuals/launch/p2-4x5.png", "visuals/launch/p3-v2.png"]);
    expect(f.visuals[0].versions).toHaveLength(2);
    // The first version is untouched.
    expect(f.visuals[0].versions[0].pages[2].images[0].file).toBe("visuals/launch/p3-4x5.png");
  });
  it("finds the visual by its name as well as its id", () => {
    const f = carousel();
    expect(addVisualVersion(f, { visual: "Launch carousel", pages: [{ n: 1, files: [portrait(1)] }] }, NOW).visual.id).toBe("launch-carousel");
  });
  it("can add pages at the end, but not leave a gap", () => {
    const f = carousel();
    const { version } = addVisualVersion(f, { visual: "launch-carousel", pages: [{ n: 4, files: [portrait(4)] }] }, NOW);
    expect(version.pages).toHaveLength(4);
    expect(code(() => addVisualVersion(f, { visual: "launch-carousel", pages: [{ n: 9, files: [portrait(9)] }] }, NOW))).toBe("bad_pages");
  });
  it("can bring in a new ratio only when every page gets it", () => {
    const f = carousel();
    expect(code(() => addVisualVersion(f, { visual: "launch-carousel", pages: [{ n: 1, files: [wide(1)] }] }, NOW))).toBe("grid_incomplete");
    const { version } = addVisualVersion(f, { visual: "launch-carousel", pages: [1, 2, 3].map((n) => ({ n, files: [wide(n)] })) }, NOW);
    expect(visualRatios(version)).toEqual(["4x5", "16x9"]);
    expect(version.pages[1].images.map((i) => i.file)).toEqual(["visuals/launch/p2-4x5.png", "visuals/launch/p2-16x9.png"]);
  });
  it("replaces one ratio of a page and keeps the other", () => {
    const f = empty();
    registerVisual(f, { name: "Quote", pages: [{ files: [portrait(1), wide(1)] }] }, NOW);
    const { version } = addVisualVersion(f, { visual: "quote", pages: [{ n: 1, files: [img("visuals/launch/p1-16x9-v2.png", 1600, 900)] }] }, NOW);
    expect(version.pages[0].images.find((i) => i.ratio === "16x9")?.file).toBe("visuals/launch/p1-16x9-v2.png");
    expect(version.pages[0].images.find((i) => i.ratio === "4x5")?.file).toBe("visuals/launch/p1-4x5.png");
  });
  it("refuses a visual that is not there, a page without a number, and a page sent twice", () => {
    const f = carousel();
    expect(code(() => addVisualVersion(f, { visual: "nope", pages: [{ n: 1, files: [portrait(1)] }] }, NOW))).toBe("no_such_visual");
    expect(code(() => addVisualVersion(f, { visual: "launch-carousel", pages: [{ files: [portrait(1)] }] }, NOW))).toBe("bad_pages");
    expect(code(() => addVisualVersion(f, { visual: "launch-carousel", pages: [{ n: 1, files: [portrait(1)] }, { n: 1, files: [portrait(1)] }] }, NOW))).toBe("bad_pages");
  });
  it("changes nothing when it refuses", () => {
    const f = carousel();
    const before = JSON.stringify(f);
    code(() => addVisualVersion(f, { visual: "launch-carousel", pages: [{ n: 1, files: [wide(1)] }] }, NOW));
    expect(JSON.stringify(f)).toBe(before);
  });
});

describe("checkVisualNote", () => {
  const f = (() => {
    const x = empty();
    registerVisual(x, { name: "Launch carousel", pages: [{ files: [portrait(1), wide(1)] }, { files: [portrait(2), wide(2)] }] }, NOW);
    addVisualVersion(x, { visual: "launch-carousel", pages: [{ n: 2, files: [portrait(2)] }] }, NOW);
    return x;
  })();
  const ok = { stage: "visuals" as const, on: "launch-carousel/2", version: "v2", format: "4x5", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, pin: null };
  it("accepts a note on a page that is there, on a ratio the version has", () => {
    expect(code(() => checkVisualNote(ok, f))).toBeUndefined();
    expect(code(() => checkVisualNote({ ...ok, box: null, format: null }, f))).toBeUndefined();
  });
  it("refuses a visual, a page, a version or a ratio that is not there", () => {
    expect(code(() => checkVisualNote({ ...ok, on: "nope/1" }, f))).toBe("no_such_visual");
    expect(code(() => checkVisualNote({ ...ok, on: "launch-carousel/9" }, f))).toBe("no_such_page");
    expect(code(() => checkVisualNote({ ...ok, on: "launch-carousel" }, f))).toBe("no_such_page");
    expect(code(() => checkVisualNote({ ...ok, version: "v9" }, f))).toBe("no_such_version");
    expect(code(() => checkVisualNote({ ...ok, format: "1x1" }, f))).toBe("unknown_format");
  });
  it("needs a ratio for a region or a point, because a place on one shape is not the place on another", () => {
    expect(code(() => checkVisualNote({ ...ok, format: null }, f))).toBe("shape_needs_format");
    expect(code(() => checkVisualNote({ ...ok, box: null, pin: { x: 0.5, y: 0.5 }, format: null }, f))).toBe("shape_needs_format");
  });
});

describe("saying where a mark is, in words (§25.5)", () => {
  it("names the thirds a region covers", () => {
    expect(regionWords({ x: 0.1, y: 0.05, w: 0.3, h: 0.2 })).toBe("left third, top third");
    expect(regionWords({ x: 0, y: 0.4, w: 1, h: 0.2 })).toBe("full width, middle");
    expect(regionWords({ x: 0.5, y: 0.6, w: 0.5, h: 0.4 })).toBe("right two thirds, bottom third");
    expect(regionWords({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 })).toBe("the centre");
    expect(regionWords({ x: 0, y: 0, w: 1, h: 1 })).toBe("the whole picture");
  });
  it("puts a region too small to cover a third where its middle is", () => {
    expect(regionWords({ x: 0.05, y: 0.9, w: 0.05, h: 0.05 })).toBe("left third, bottom third");
  });
  it("names where a point is", () => {
    expect(pinWords({ x: 0.5, y: 0.5 })).toBe("the centre");
    expect(pinWords({ x: 0.1, y: 0.9 })).toBe("left, bottom");
    expect(pinWords({ x: 0.9, y: 0.1 })).toBe("right, top");
  });
});

describe("visualNoteView", () => {
  const file = (() => {
    const x = empty();
    registerVisual(x, { name: "Launch carousel", pages: [{ files: [portrait(1), wide(1)] }, { files: [portrait(2), wide(2)] }] }, NOW);
    return x;
  })();
  const note = (over: object) => ({ stage: "visuals" as const, on: "launch-carousel/2", version: "v1", format: "4x5", box: null, pin: null, ...over });
  it("gives the agent a region with its words and the file to open", () => {
    expect(visualNoteView(note({ box: { x: 0.1, y: 0.05, w: 0.3, h: 0.2 } }), file)).toEqual({
      visual: { id: "launch-carousel", name: "Launch carousel" }, version: "v1", page: 2, ratio: "4:5", shape: "region",
      region: { x: 0.1, y: 0.05, w: 0.3, h: 0.2 }, pin: null, words: "left third, top third", file: "visuals/launch/p2-4x5.png",
    });
  });
  it("gives a point, and a whole-image note with no ratio and no file", () => {
    expect(visualNoteView(note({ pin: { x: 0.5, y: 0.5 }, format: "16x9" }), file)).toMatchObject({ shape: "pin", words: "the centre", ratio: "16:9", file: "visuals/launch/p2-16x9.png" });
    expect(visualNoteView(note({ format: null }), file)).toMatchObject({ shape: "image", ratio: null, words: null, file: null, region: null, pin: null });
  });
  it("is null when the visual is gone", () => {
    expect(visualNoteView(note({ on: "gone/1" }), file)).toBeNull();
  });
});

it("visualWords.ts imports nothing, so the dashboard can bundle it without zod or Node (§25.6)", () => {
  const text = readFileSync(new URL("../../src/core/visualWords.ts", import.meta.url), "utf8");
  expect(modulesPulledIn(text)).toEqual([]);
});
