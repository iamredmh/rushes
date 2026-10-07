import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  CHIP_ORDER, FORMAT_ID_RE, MAX_FORMATS, chipOrder, durationWarning, formatTag, labelOfId, noteShowsOn, ratioId, ratioLabel, ratioValue, settleLabel, versionFormats,
  type FormatSource,
} from "../../src/core/formats.js";

describe("ratioLabel (§21.3)", () => {
  it.each([
    [1920, 1080, "16:9"], [1080, 1920, "9:16"], [1080, 1080, "1:1"], [1080, 1350, "4:5"], [1350, 1080, "5:4"],
    [1440, 1080, "4:3"], [1080, 1440, "3:4"], [1620, 1080, "3:2"], [1080, 1620, "2:3"], [2520, 1080, "21:9"], [1080, 2520, "9:21"],
  ])("%i×%i is %s", (w, h, label) => expect(ratioLabel(w, h)).toBe(label));

  // Review Focus 2: what real renders measure.
  it.each([
    [1920, 1088, "16:9"], // padded to a multiple of 16 by the encoder
    [1918, 1080, "16:9"],
    [1080, 1349, "4:5"],
    [1920, 817, "21:9"], // 2.35:1 is within 1% of 21:9
  ])("%i×%i snaps to %s within 1%%", (w, h, label) => expect(ratioLabel(w, h)).toBe(label));

  it.each([[1000, 700, "10:7"], [2000, 1000, "2:1"], [3000, 1000, "3:1"]])(
    "%i×%i, off the standard list, is the reduced fraction %s",
    (w, h, label) => expect(ratioLabel(w, h)).toBe(label),
  );

  it.each([
    [2560, 1080, "2.37:1"], // 1.6% off 21:9, and 64:27 has a term over 32
    [1920, 804, "2.39:1"],
    [804, 1920, "1:2.39"],
    [1998, 1080, "1.85:1"],
  ])("%i×%i is the decimal %s (R13)", (w, h, label) => expect(ratioLabel(w, h)).toBe(label));

  it("refuses a size that isn't one", () => {
    expect(() => ratioLabel(0, 1080)).toThrow(RangeError);
    expect(() => ratioLabel(1920, Number.NaN)).toThrow(RangeError);
  });
});

describe("ratioLabel, fix round 1 (M1, M2, M4)", () => {
  it("a portrait picture is labelled as the mirror of its landscape twin", () => {
    // 1309x729 is 1.0100 of 16:9 (just out); 729x1309 used to snap to 9:16 on a linear error. Now both miss.
    expect(ratioLabel(1309, 729)).toBe("1.8:1");
    expect(ratioLabel(729, 1309)).toBe("1:1.8");
    // Just in, both ways.
    expect(ratioLabel(1308, 729)).toBe("16:9");
    expect(ratioLabel(729, 1308)).toBe("9:16");
  });
  it("the decimal of a portrait is the height over the width, so 738×720 and 720×738 mirror", () => {
    const [a, b] = ratioLabel(738, 720).split(":");
    expect(a).not.toBe("1");
    expect(ratioLabel(720, 738)).toBe(`${b}:${a}`);
  });
  it("the reduced fraction is used while both terms are 32 or less, and not past that", () => {
    expect(ratioLabel(3840, 1080)).toBe("32:9");
    expect(ratioLabel(1080, 3840)).toBe("9:32");
    expect(ratioLabel(3300, 1000)).toBe("3.3:1"); // 33:10 has a term over 32
    expect(ratioLabel(1000, 3300)).toBe("1:3.3");
  });
  it("needs two whole numbers from 1 to 100000, and says RangeError for anything else", () => {
    for (const [w, h] of [[0.4, 1000], [1e20, 1], [1e21, 1], [Number.NaN, 1080], [Number.POSITIVE_INFINITY, 1080], [1920, Number.NEGATIVE_INFINITY], [100001, 1000], [1080.5, 1920], [-1080, 1920]]) {
      expect(() => ratioLabel(w, h), `${w}x${h}`).toThrow(RangeError);
    }
    expect(ratioLabel(100000, 1)).toBe("100000:1");
    expect(ratioLabel(1, 100000)).toBe("1:100000");
  });
  it("every label it makes is a valid format id of 16 characters or fewer", () => {
    for (const [w, h] of [[100000, 1], [1, 100000], [99999, 100000], [100000, 99999], [3300, 1000], [7, 100000]]) {
      const label = ratioLabel(w, h);
      expect(label.length).toBeLessThanOrEqual(16);
      expect(FORMAT_ID_RE.test(ratioId(label))).toBe(true);
    }
  });
});

describe("format ids", () => {
  it("are the label with ':' as 'x', and back", () => {
    expect(ratioId("9:16")).toBe("9x16");
    expect(ratioId("2.39:1")).toBe("2.39x1");
    expect(labelOfId("1x2.39")).toBe("1:2.39");
    for (const id of ["9x16", "2.39x1", "10x7", "1x2.39"]) expect(FORMAT_ID_RE.test(id)).toBe(true);
    for (const id of ["9:16", "landscape", "x16", "9x", "../9x16"]) expect(FORMAT_ID_RE.test(id)).toBe(false);
  });
  it("ratioValue reads a label, and nothing else", () => {
    expect(ratioValue("9:16")).toBeCloseTo(0.5625, 6);
    expect(ratioValue("2.4:1")).toBeCloseTo(2.4, 6);
    expect(ratioValue("wide")).toBeNull();
    expect(ratioValue("0:1")).toBeNull();
  });
});

describe("settleLabel: the label hint (§21.4, R10)", () => {
  it("is used for a non-standard ratio within 2% of it", () => {
    expect(settleLabel(1920, 804, "2.4:1")).toEqual({ label: "2.4:1", note: null });
  });
  it("is ignored, with a note, for a standard ratio, a far one, or one that isn't a ratio", () => {
    expect(settleLabel(1080, 1920, "4:5")).toEqual({ label: "9:16", note: expect.stringContaining("9:16") });
    expect(settleLabel(1920, 804, "21:9").label).toBe("2.39:1");
    expect(settleLabel(1920, 804, "scope").note).toMatch(/isn't a ratio like 2\.39:1/);
  });
  it("with no hint, or the same one, is the measured label", () => {
    expect(settleLabel(1080, 1920)).toEqual({ label: "9:16", note: null });
    expect(settleLabel(1080, 1920, "9:16")).toEqual({ label: "9:16", note: null });
  });
});

describe("settleLabel: a hint can't make a second spelling of one shape (fix round 1, I3)", () => {
  it.each(["2.4:1", "12:5", "2.40:1", "2.4:1.0", " 2.4:1 "])("the hint %j is written as the canonical 2.4:1", (hint) => {
    expect(settleLabel(1920, 804, hint).label).toBe("2.4:1");
  });
  it("says so when it rewrites a hint, and stays quiet when it doesn't", () => {
    expect(settleLabel(1920, 804, "12:5").note).toMatch(/12:5/);
    expect(settleLabel(1920, 804, "2.4:1").note).toBeNull();
  });
  it("a portrait hint is canonical too: the long side over the short, 1:2.4", () => {
    expect(settleLabel(804, 1920, "5:12").label).toBe("1:2.4");
  });
  it("rejects a hint within 1% of a standard ratio, so it can't mislabel a render as a ratio it isn't", () => {
    // 1950x1080 is 1.81:1, outside 1% of 16:9; the hint "16:9" must not make it 16x9.
    expect(settleLabel(1950, 1080, "16:9")).toEqual({ label: "1.81:1", note: expect.stringContaining("standard") });
    expect(settleLabel(1950, 1080, "1.78:1").label).toBe("1.81:1");
  });
  it("rejects a hint too long to be a label", () => {
    const long = "2.4000000000000000:1";
    expect(settleLabel(1920, 804, long)).toEqual({ label: "2.39:1", note: expect.stringMatching(/too long/) });
  });
});

describe("chipOrder (§21.5)", () => {
  const f = (id: string, width: number, height: number) => ({ id, width, height });
  it("puts 9:16, 4:5, 1:1, 4:3 and 16:9 first, then the rest from narrow to wide", () => {
    const order = chipOrder([f("16x9", 1920, 1080), f("2.39x1", 1920, 804), f("1x1", 1080, 1080), f("9x16", 1080, 1920), f("2x3", 1080, 1620), f("4x5", 1080, 1350)]);
    expect(order.map((x) => x.id)).toEqual(["9x16", "4x5", "1x1", "16x9", "2x3", "2.39x1"]);
    expect(CHIP_ORDER).toEqual(["9x16", "4x5", "1x1", "4x3", "16x9"]);
  });
});

const source = (over: Partial<FormatSource> = {}): FormatSource => ({ file: "renders/hero_v1.mp4", width: 1920, height: 1080, duration: 8, fps: 30, formats: [], ...over });
const tall = { id: "9x16", label: "9:16", file: "renders/hero_v1_9x16.mp4", width: 1080, height: 1920, duration: 8, fps: 30, addedAt: "" };

describe("versionFormats", () => {
  it("is the primary first, measured from its own size, then the formats as stored", () => {
    expect(versionFormats(source({ formats: [tall] }))).toEqual([
      { id: "16x9", label: "16:9", file: "renders/hero_v1.mp4", width: 1920, height: 1080, duration: 8, fps: 30, primary: true },
      { id: "9x16", label: "9:16", file: "renders/hero_v1_9x16.mp4", width: 1080, height: 1920, duration: 8, fps: 30, primary: false },
    ]);
  });
  it("is empty while the primary's size is unknown, unless the player measured it (R2)", () => {
    expect(versionFormats(source({ width: null, height: null }))).toEqual([]);
    expect(versionFormats(source({ width: null, height: null }), { width: 1080, height: 1080 })[0]).toMatchObject({ id: "1x1", primary: true });
  });
});

describe("durationWarning (§21.3)", () => {
  it("speaks only past 0.1 s, in §21.3's words", () => {
    expect(durationWarning("9:16", 8.4, 8)).toBe("9:16 is 8.4 s; the cut is 8.0 s");
    expect(durationWarning("9:16", 8.1, 8)).toBeNull();
    expect(durationWarning("9:16", 7.95, 8)).toBeNull();
    expect(durationWarning("9:16", null, 8)).toBeNull();
    expect(durationWarning("9:16", 8.4, null)).toBeNull();
  });
});

describe("which notes show where (§21.2)", () => {
  it("an all-format note shows on every format, a format note on its own only, and every note on a one-format cut", () => {
    expect(noteShowsOn({ format: null }, "16x9")).toBe(true);
    expect(noteShowsOn({ format: "9x16" }, "9x16")).toBe(true);
    expect(noteShowsOn({ format: "9x16" }, "16x9")).toBe(false);
    expect(noteShowsOn({ format: "9x16" }, null)).toBe(true);
  });
  it("formatTag names the format, says All on a cut with formats, and says nothing on a one-format cut (R4)", () => {
    const videos = [
      { id: "hero", versions: [{ id: "v1", ...source({ formats: [tall] }) }] },
      { id: "solo", versions: [{ id: "v1", ...source() }] },
    ];
    const n = (video: string, format: string | null, stage: "picture" | "music" = "picture") => ({ stage, video, version: "v1", format });
    expect(formatTag(n("hero", "9x16"), videos)).toBe("9:16");
    expect(formatTag(n("hero", null), videos)).toBe("All");
    expect(formatTag(n("solo", null), videos)).toBeNull();
    expect(formatTag(n("hero", null, "music"), videos)).toBeNull();
  });
});

it("MAX_FORMATS is eight shapes, the primary included (R3)", () => expect(MAX_FORMATS).toBe(8));

// What would pull zod or Node into the web bundle: an import, a re-export from a module, a dynamic import, require.
const pullsInAModule = (js: string): boolean =>
  /^\s*import\b/m.test(js) || /^\s*export\s*(\*|\{[^}]*\})\s*from\b/m.test(js) || /\bimport\s*\(/.test(js) || /\brequire\s*\(/.test(js);

it("formats.ts compiles to JavaScript with no import, re-export or require, so the dashboard can bundle it without zod or Node", () => {
  const text = readFileSync(new URL("../../src/core/formats.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, removeComments: true } }).outputText;
  expect(js).toContain("export const MAX_FORMATS");
  expect(pullsInAModule(js)).toBe(false);
});

it("the check above would catch each way of pulling a module in", () => {
  for (const src of [`import { z } from "zod";\nconsole.log(z);`, `import{z}from"zod";console.log(z);`, `import "./x.js";`, `export * from "./x.js";`, `export { a } from "./x.js";`, `export {\n a\n} from "./x.js";`, `const m = await import("x");`, `const m = require("x");`]) {
    const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    expect(pullsInAModule(js), src).toBe(true);
  }
  // An `import type` is erased, so it passes.
  expect(pullsInAModule(ts.transpileModule(`import type { Note } from "./schema.js";\nexport const a = 1;`, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText)).toBe(false);
});
