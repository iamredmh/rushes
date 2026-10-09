import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fmt, minutesAndSeconds, noteTime, shotAt } from "../../src/core/timecode.js";
import { shotAt as projectShotAt } from "../../src/core/project.js";
import { fmt as webFmt, noteTime as webNoteTime, shotAt as webShotAt } from "../../web/src/lib.js";
import { modulesPulledIn } from "../helpers/imports.js";

// These were written out three times (the dashboard, the notes export, the CLI) and twice (the
// server and the dashboard), each copy with a comment saying src/ and web/ can't share. They can:
// web already bundles labels.ts, logText.ts and formats.ts. What it can't take is a module that
// pulls in zod or Node, so this one has no import at all.
describe("timecode.ts", () => {
  it("has no import of any kind, so the dashboard bundles it without zod or Node", () => {
    const text = readFileSync(new URL("../../src/core/timecode.ts", import.meta.url), "utf8");
    expect(modulesPulledIn(text)).toEqual([]);
  });

  it("splits a time into minutes and seconds the way fmt writes it, carrying 59.999 s into the next minute", () => {
    expect(minutesAndSeconds(72.4)).toEqual({ m: 1, s: "12.40" });
    expect(minutesAndSeconds(59.999)).toEqual({ m: 1, s: "00.00" });
    expect(minutesAndSeconds(59.994)).toEqual({ m: 0, s: "59.99" });
    expect(minutesAndSeconds(-3)).toEqual({ m: 0, s: "00.00" });
    // fmt is that split, written m:s
    for (const t of [0, 12.4, 59.999, 72.456, 3599.999]) expect(fmt(t)).toBe(`${minutesAndSeconds(t).m}:${minutesAndSeconds(t).s}`);
  });

  it("is the one copy the dashboard and the server use, not a second one kept equal by a test", () => {
    expect(webFmt).toBe(fmt);
    expect(webNoteTime).toBe(noteTime);
    expect(webShotAt).toBe(shotAt);
    expect(projectShotAt).toBe(shotAt);
  });
});
