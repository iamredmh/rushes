import { describe, expect, it } from "vitest";
import { FILES, NoteSchema, STAGES, VisualsFileSchema } from "../../src/core/schema.js";

// §25.4: a note on a visual is an ordinary note with a stage, a page it is on, a ratio, and a region, a pin or neither.
const base = { id: "n_1", stage: "visuals", video: null, version: "v2", on: "launch/3", scope: "whole", text: "Headline is too long.", createdAt: "2026-10-12T10:00:00.000Z" };
const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.1 };

describe("the Visuals stage", () => {
  it("comes after Mix, so its tab does", () => {
    expect(STAGES.at(-1)).toBe("visuals");
    expect(STAGES.indexOf("visuals")).toBeGreaterThan(STAGES.indexOf("mix"));
  });
  it("keeps its visuals in .rushes/visuals.json, read as an empty file until the first write", () => {
    expect(FILES.visuals.name).toBe("visuals.json");
    expect(VisualsFileSchema.parse({ schema: 1, rev: 0 }).visuals).toEqual([]);
  });
});

describe("a note on a visual", () => {
  it("can mark a region, a point, or the whole image", () => {
    expect(NoteSchema.safeParse({ ...base, box, format: "4x5" }).success).toBe(true);
    expect(NoteSchema.safeParse({ ...base, pin: { x: 0.5, y: 0.25 }, format: "4x5" }).success).toBe(true);
    expect(NoteSchema.safeParse({ ...base, format: null }).success).toBe(true);
  });
  it("defaults to no pin, so every earlier note still loads", () => {
    expect(NoteSchema.parse({ ...base, format: null }).pin).toBeNull();
    expect(NoteSchema.parse({ id: "n_2", stage: "picture", scope: "point", t: 1, text: "x", createdAt: base.createdAt }).pin).toBeNull();
  });
  it("is never a region and a point at once", () => {
    const r = NoteSchema.safeParse({ ...base, box, pin: { x: 0.5, y: 0.5 }, format: "4x5" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("pin");
  });
  it("keeps a point inside the image", () => {
    for (const pin of [{ x: -0.1, y: 0.5 }, { x: 0.5, y: 1.2 }]) expect(NoteSchema.safeParse({ ...base, pin, format: "4x5" }).success).toBe(false);
  });
  it("has no time: an image is not a moment", () => {
    expect(NoteSchema.safeParse({ ...base, scope: "point", t: 1, format: null }).success).toBe(false);
    expect(NoteSchema.safeParse({ ...base, scope: "range", t: 1, tOut: 2, format: null }).success).toBe(false);
  });
  it("is the only kind of note that can have a point", () => {
    expect(NoteSchema.safeParse({ id: "n_3", stage: "picture", scope: "point", t: 1, pin: { x: 0.5, y: 0.5 }, text: "x", createdAt: base.createdAt }).success).toBe(false);
  });
});
