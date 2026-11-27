// §38.4: notes on storyboard shots: how they are named, and how a note finds its shot again after the agent edits the file.
import { describe, expect, it } from "vitest";
import { NoteSchema } from "../../src/core/schema.js";
import { shotNoteLabel, shotOfNote, shotNoteWhere } from "../../src/core/shotNotes.js";

const base = { id: "n1", stage: "storyboard", video: "hero", version: null, on: "shot/3", scope: "whole", text: "Lower the sign.", createdAt: "2026-11-27T10:00:00.000Z" };

describe("a storyboard note", () => {
  it("takes a box or a point on the still, and remembers the still", () => {
    const boxed = NoteSchema.parse({ ...base, box: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 }, shot: { n: 3, name: "Offline" }, still: "storyboard/s3.png" });
    expect(boxed.still).toBe("storyboard/s3.png");
    expect(NoteSchema.safeParse({ ...base, pin: { x: 0.5, y: 0.5 } }).success).toBe(true);
  });

  it("has no time", () => {
    expect(NoteSchema.safeParse({ ...base, scope: "point", t: 1 }).success).toBe(false);
  });

  it("an older note without a still loads with none", () => {
    expect(NoteSchema.parse({ ...base, stage: "picture", on: null, scope: "point", t: 1 }).still).toBeNull();
  });
});

describe("shotNoteLabel", () => {
  it("names the shot, and says region or point", () => {
    expect(shotNoteLabel({ on: "shot/3", shot: { n: 3, name: "Offline" }, box: null, pin: null })).toBe("Shot 03 · Offline");
    expect(shotNoteLabel({ on: "shot/3", shot: { n: 3, name: "Offline" }, box: { x: 0, y: 0, w: 0.5, h: 0.5 }, pin: null })).toBe("Shot 03 · Offline · region");
    expect(shotNoteLabel({ on: "shot/12", shot: null, box: null, pin: { x: 0.5, y: 0.5 } })).toBe("Shot 12 · point");
  });
});

describe("shotNoteWhere", () => {
  it("says where on the still, in words and fractions, or the whole shot", () => {
    expect(shotNoteWhere({ box: null, pin: null })).toBe("the whole shot");
    expect(shotNoteWhere({ box: null, pin: { x: 0.5, y: 0.5 } })).toMatch(/^point \(.+\)$/);
    expect(shotNoteWhere({ box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, pin: null })).toMatch(/^region \(.+\)$/);
  });
});

describe("shotOfNote", () => {
  const shots = [
    { n: 1, name: "A replica rises" },
    { n: 2, name: "Seven link up" },
    { n: 3, name: "Offline" },
  ];
  it("finds the same number and name", () => {
    expect(shotOfNote(shots, { on: "shot/3", shot: { n: 3, name: "Offline" } })).toBe(2);
  });
  it("finds a renumbered shot by its name when only one has it", () => {
    const moved = [{ n: 1, name: "New open" }, ...shots.map((s) => ({ ...s, n: s.n + 1 }))];
    expect(shotOfNote(moved, { on: "shot/3", shot: { n: 3, name: "Offline" } })).toBe(3);
  });
  it("finds a renamed shot by its number only when that number's name is the same", () => {
    const renamed = shots.map((s) => (s.n === 3 ? { ...s, name: "Lights out" } : s));
    expect(shotOfNote(renamed, { on: "shot/3", shot: { n: 3, name: "Offline" } })).toBeNull();
  });
  it("is null for a shot that has gone", () => {
    expect(shotOfNote(shots.slice(0, 2), { on: "shot/3", shot: { n: 3, name: "Offline" } })).toBeNull();
  });
  it("uses the number alone for a note that carries no name", () => {
    expect(shotOfNote(shots, { on: "shot/2", shot: null })).toBe(1);
  });
});
