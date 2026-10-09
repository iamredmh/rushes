import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fmt, noteTime, shotAt } from "../../src/core/timecode.js";
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

  it("is the one copy the dashboard and the server use, not a second one kept equal by a test", () => {
    expect(webFmt).toBe(fmt);
    expect(webNoteTime).toBe(noteTime);
    expect(webShotAt).toBe(shotAt);
    expect(projectShotAt).toBe(shotAt);
  });
});
