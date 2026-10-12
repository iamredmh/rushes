import { describe, expect, it } from "vitest";
import {
  STRIP_VISIBLE, boxesOn, canMark, defaultView, dragRefusal, groupNotes, noteNo, openByPage, shapeFromDrag, stripStart, targetLabel, viewForNote,
} from "../../web/src/visuals.js";
import type { Note, Visual } from "../../web/src/types.js";

// §25.6: the dashboard's pure rules for the Visuals tab. The component only draws what these say.
const image = (ratio: string, file: string) => ({ ratio, file, width: 10, height: 10 });
const visual = (id: string, name: string, pages: number, versions = 1, ratios = ["4x5"]): Visual => ({
  id, name, kind: pages > 1 ? "carousel" : "still", addedAt: "2026-10-12T10:00:00Z",
  versions: Array.from({ length: versions }, (_, v) => ({
    id: `v${v + 1}`, addedAt: "2026-10-12T10:00:00Z", label: "",
    pages: Array.from({ length: pages }, (_, p) => ({ n: p + 1, images: ratios.map((r) => image(r, `${id}-${p + 1}-${r}-v${v + 1}.png`)) })),
  })),
});
const note = (over: Partial<Note>): Note => ({
  id: "n1", stage: "visuals", video: null, version: "v1", on: "launch/1", scope: "whole", t: null, tOut: null, frame: null, text: "x", box: null, pin: null,
  grab: null, shot: null, marks: [], format: "4x5", status: "todo", reply: "", fixT: null, fixVersion: null, batch: null, createdAt: "2026-10-12T10:00:00Z", by: "user", ...over,
});
const launch = visual("launch", "Launch carousel", 12, 2);
const quote = visual("quote", "Quote still", 1, 1, ["4x5", "16x9"]);

describe("the page strip", () => {
  it("puts the active page first, and keeps the strip full near the end", () => {
    expect(STRIP_VISIBLE).toBe(8);
    expect(stripStart(1, 12)).toBe(0);
    expect(stripStart(3, 12)).toBe(2);
    expect(stripStart(5, 12)).toBe(4);
    expect(stripStart(6, 12)).toBe(4);
    expect(stripStart(12, 12)).toBe(4);
    expect(stripStart(2, 5)).toBe(0);
  });
});

describe("a mark drawn on the picture", () => {
  it("is a region when dragged, clamped to the picture", () => {
    expect(shapeFromDrag({ x: 0.2, y: 0.3 }, { x: 0.5, y: 0.4 }, true)).toEqual({ box: { x: 0.2, y: 0.3, w: 0.3, h: 0.1 } });
    expect(shapeFromDrag({ x: 0.5, y: 0.5 }, { x: 0.2, y: 0.1 }, true)).toEqual({ box: { x: 0.2, y: 0.1, w: 0.3, h: 0.4 } });
    expect(shapeFromDrag({ x: 0.9, y: 0.9 }, { x: 1.4, y: 1.7 }, true)).toEqual({ box: { x: 0.9, y: 0.9, w: expect.closeTo(0.1), h: expect.closeTo(0.1) } });
    expect(shapeFromDrag({ x: -0.2, y: 0.1 }, { x: 0.3, y: 0.3 }, true)).toEqual({ box: { x: 0, y: 0.1, w: 0.3, h: expect.closeTo(0.2) } });
  });
  it("is a point when it is a click, and nothing when a drag is too thin to be a region", () => {
    expect(shapeFromDrag({ x: 0.4, y: 0.6 }, { x: 0.4, y: 0.6 }, false)).toEqual({ pin: { x: 0.4, y: 0.6 } });
    expect(shapeFromDrag({ x: 0.4, y: 0.6 }, { x: 0.41, y: 0.9 }, true)).toBeNull();
    expect(shapeFromDrag({ x: 0.4, y: 0.6 }, { x: 0.9, y: 0.61 }, true)).toBeNull();
  });
});

describe("what each visual is showing", () => {
  it("starts on the newest version, the first page and the first ratio", () => {
    expect(defaultView(launch)).toEqual({ page: 1, ratio: "4x5", ver: "v2" });
    expect(defaultView(quote)).toEqual({ page: 1, ratio: "4x5", ver: "v1" });
  });
  it("lets you mark only the newest version", () => {
    expect(canMark(launch, { page: 1, ratio: "4x5", ver: "v2" })).toBe(true);
    expect(canMark(launch, { page: 1, ratio: "4x5", ver: "v1" })).toBe(false);
  });
  it("names where a note would go, leaving the page out for a still", () => {
    expect(targetLabel(launch, { page: 3, ratio: "4x5", ver: "v2" })).toBe("Launch carousel · page 3 · 4:5 · v2");
    expect(targetLabel(quote, { page: 1, ratio: "16x9", ver: "v1" })).toBe("Quote still · 16:9 · v1");
  });
});

describe("the notes", () => {
  const notes = [
    note({ id: "a", on: "launch/3", version: "v1", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }),
    note({ id: "b", on: "launch/3", version: "v2", box: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } }),
    note({ id: "c", on: "launch/1", version: "v2", format: null }),
    note({ id: "d", on: "quote/1", version: "v1", format: "16x9", pin: { x: 0.5, y: 0.5 } }),
    note({ id: "e", on: "launch/3", version: "v2", pin: { x: 0.2, y: 0.2 }, status: "done" }),
    note({ id: "f", on: "gone/1", version: "v1", format: null }),
  ];
  it("numbers each visual's notes from 1, in the order they were made", () => {
    expect(noteNo(notes, notes[0])).toBe(1);
    expect(noteNo(notes, notes[1])).toBe(2);
    expect(noteNo(notes, notes[2])).toBe(3);
    expect(noteNo(notes, notes[3])).toBe(1);
    expect(noteNo(notes, notes[4])).toBe(4);
  });
  it("groups by visual then page, in the order of the visuals, with a visual that is gone last", () => {
    const g = groupNotes([launch, quote], notes);
    expect(g.map((x) => x.visual.name)).toEqual(["Launch carousel", "Quote still", "gone"]);
    expect(g[0].pages.map((p) => [p.page, p.notes.map((n) => n.id)])).toEqual([[1, ["c"]], [3, ["a", "b", "e"]]]);
    expect(g[0].open).toBe(3);
    expect(g[2].gone).toBe(true);
  });
  it("draws only the marks on this page, ratio and version", () => {
    expect(boxesOn(notes, "launch", { page: 3, ratio: "4x5", ver: "v2" }).map((n) => n.id)).toEqual(["b", "e"]);
    expect(boxesOn(notes, "launch", { page: 3, ratio: "4x5", ver: "v1" }).map((n) => n.id)).toEqual(["a"]);
    expect(boxesOn(notes, "quote", { page: 1, ratio: "4x5", ver: "v1" })).toEqual([]);
    expect(boxesOn(notes, "launch", { page: 1, ratio: "4x5", ver: "v2" })).toEqual([]);
  });
  it("counts the open notes on each page, for the strip's badges, whatever the version", () => {
    expect(openByPage(notes, "launch")).toEqual({ 1: 1, 3: 2 });
  });
  it("shows a clicked note on its own page, ratio and version", () => {
    expect(viewForNote(launch, notes[0], { page: 1, ratio: "4x5", ver: "v2" })).toEqual({ page: 3, ratio: "4x5", ver: "v1" });
    // A note for every ratio keeps the ratio being looked at.
    expect(viewForNote(quote, note({ on: "quote/1", format: null }), { page: 1, ratio: "16x9", ver: "v1" })).toEqual({ page: 1, ratio: "16x9", ver: "v1" });
  });
});

describe("a draft on another visual", () => {
  const here = { vis: "quote", page: 1, ratio: "4x5", ver: "v1" };
  it("is never silently replaced: a new mark is refused while it has words in it", () => {
    expect(dragRefusal({ vis: "launch", page: 3, ratio: "4x5", ver: "v2", text: "Shorten it" }, here, "Launch carousel")).toBe("Finish or discard your draft on Launch carousel first.");
    expect(dragRefusal({ vis: "launch", page: 3, ratio: "4x5", ver: "v2", text: "  " }, here, "Launch carousel")).toBeNull();
    expect(dragRefusal(null, here, "")).toBeNull();
    expect(dragRefusal({ vis: "quote", page: 1, ratio: "4x5", ver: "v1", text: "words" }, here, "Quote still")).toBeNull();
  });
});
