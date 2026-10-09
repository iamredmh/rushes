import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEVEL_MAX, LEVEL_MIN, LEVEL_STEP } from "../../src/core/levels.js";
import { OPEN_SAFE_EXT } from "../../src/core/extensions.js";
import { markLabel } from "../../src/core/labels.js";
import { markLabel as schemaMarkLabel, LEVEL_MAX as schemaMax, LEVEL_MIN as schemaMin, LEVEL_STEP as schemaStep } from "../../src/core/schema.js";
import { OPEN_SAFE_EXT as revealOpenSafe } from "../../src/server/reveal.js";
import { markLabel as webMarkLabel, LEVEL_MAX as webMax, LEVEL_MIN as webMin, LEVEL_STEP as webStep, OPEN_SAFE_EXT as webOpenSafe } from "../../web/src/lib.js";
import { modulesPulledIn } from "../helpers/imports.js";

// Each of these was a hand copy in web/src/lib.ts, kept equal to the server's by a test. They are
// one thing: the dashboard's Open button must only appear for what the server will open, its level
// slider must span what the server accepts, and a mark reads the same in both. The dashboard bundles
// these files, so each has no import of any kind: nothing here may pull in zod or Node.
describe.each(["levels", "extensions"])("%s.ts", (name) => {
  it("has no import of any kind, so the dashboard bundles it without zod or Node", () => {
    expect(modulesPulledIn(readFileSync(new URL(`../../src/core/${name}.ts`, import.meta.url), "utf8"))).toEqual([]);
  });
});

describe("what the dashboard and the server share is one thing, not two kept equal", () => {
  it("a Mix lane's level range and step", () => {
    expect([schemaMin, schemaMax, schemaStep]).toEqual([LEVEL_MIN, LEVEL_MAX, LEVEL_STEP]);
    expect([webMin, webMax, webStep]).toEqual([LEVEL_MIN, LEVEL_MAX, LEVEL_STEP]);
    expect([LEVEL_MIN, LEVEL_MAX, LEVEL_STEP]).toEqual([-24, 6, 0.5]); // §19.6
  });

  it("the extensions Open acts on, with no svg", () => {
    expect(webOpenSafe).toBe(OPEN_SAFE_EXT);
    expect(revealOpenSafe).toBe(OPEN_SAFE_EXT);
    expect(OPEN_SAFE_EXT.has("svg")).toBe(false);
  });

  it("how a mark reads", () => {
    expect(webMarkLabel).toBe(markLabel);
    expect(schemaMarkLabel).toBe(markLabel);
    expect([{ kind: "rise" }, { kind: "fall" }, { kind: "louder", db: 3 }, { kind: "quieter", db: 6 }, { kind: "quieter", db: 1.5 }].map((m) => markLabel(m as never))).toEqual([
      "Rise", "Fall", "Louder 3 dB", "Quieter 6 dB", "Quieter 1.5 dB",
    ]);
  });
});
