import { describe, expect, it } from "vitest";
import { boxFrom, firstTab, fit, fmt, frameAt, noteTime, placeNote, snap, stepFrame } from "../../web/src/lib.js";
import type { Note, TabState } from "../../web/src/types.js";

const note = (over: Partial<Note>): Note => ({
  id: "n_1", stage: "picture", video: "hero", version: "v3", on: null, scope: "point", t: 12.4, tOut: null, frame: null,
  text: "x", box: null, grab: null, status: "todo", reply: "", fixT: null, fixVersion: null, batch: null,
  createdAt: "2026-10-02T00:00:00Z", by: "user", ...over,
});

describe("timecode", () => {
  it("formats minutes, seconds and hundredths", () => {
    expect(fmt(0)).toBe("0:00.00");
    expect(fmt(12.4)).toBe("0:12.40");
    expect(fmt(72.456)).toBe("1:12.46");
    expect(fmt(-3)).toBe("0:00.00");
  });
  it("finds frames and steps by one frame, clamped", () => {
    expect(frameAt(12.4, 60)).toBe(744);
    expect(stepFrame(12.4, 60, 1, 60)).toBeCloseTo(745 / 60, 6);
    expect(stepFrame(0, 30, -1, 10)).toBe(0);
    expect(stepFrame(9.99, 30, 5, 10)).toBe(10);
  });
  it("snaps a time to the start of its frame", () => {
    expect(snap(0.9666667, 30)).toBe(0.966667);
    expect(snap(1.01, 30)).toBe(1);
    expect(snap(12.4, 60)).toBe(12.4);
  });
  it("labels points, ranges and whole-track notes", () => {
    expect(noteTime(31.05, 33.1)).toBe("0:31.05–0:33.10");
    expect(noteTime(4.6, null)).toBe("0:04.60");
    expect(noteTime(null, null)).toBe("Whole");
  });
});

describe("placeNote", () => {
  it("leaves a note on the version being watched where it is", () => {
    expect(placeNote(note({}), "v3")).toEqual({ t: 12.4, tOut: null, from: null });
  });
  it("moves a fixed note from an older cut to where the fix landed, keeping a range's length", () => {
    const n = note({ version: "v2", t: 4.1, tOut: 5.1, scope: "range", fixT: 4.6, fixVersion: "v3" });
    const placed = placeNote(n, "v3");
    expect(placed.t).toBe(4.6);
    expect(placed.tOut).toBeCloseTo(5.6, 6);
    expect(placed.from).toBe("v2 at 0:04.10");
  });
  it("keeps an unfixed note from an older cut at its old time, and says where it's from", () => {
    expect(placeNote(note({ version: "v1", t: 2 }), "v3")).toEqual({ t: 2, tOut: null, from: "v1 at 0:02.00" });
  });
  it("has no time for a whole-track note", () => {
    expect(placeNote(note({ scope: "whole", t: null }), "v3")).toEqual({ t: null, tOut: null, from: null });
  });
});

describe("fit", () => {
  it("matches the server's thresholds", () => {
    expect(fit("one two three", 13, 2.6).state).toBe("ok");
    expect(fit("one two three four five six seven eight nine ten", 4.5, 2.6).state).toBe("tight");
    expect(fit("a b c d e f g h i j k l m n o p q r s t u v w", 8, 2.6).state).toBe("over");
  });
});

describe("firstTab", () => {
  const tabs = (unlocked: string[]): TabState[] =>
    (["script", "picture", "voice", "music", "sfx", "mix"] as const).map((stage) => ({ stage, unlocked: unlocked.includes(stage), todo: 0 }));
  it("prefers Picture, then the first unlocked tab, then Picture", () => {
    expect(firstTab(tabs(["script", "picture"]))).toBe("picture");
    expect(firstTab(tabs(["script"]))).toBe("script");
    expect(firstTab(tabs([]))).toBe("picture");
  });
});

describe("boxFrom", () => {
  it("normalises a drag in any direction and clamps it to the frame", () => {
    expect(boxFrom(100, 50, 300, 150, 400, 200)).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(boxFrom(300, 150, 100, 50, 400, 200)).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(boxFrom(-50, -50, 500, 300, 400, 200)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});
