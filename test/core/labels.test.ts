import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { LABEL_MAX, clip, oneLine, oneLineOf, shortLabel } from "../../src/core/labels.js";
import { addVersion } from "../../src/core/project.js";
import { ProjectSchema, type Project } from "../../src/core/schema.js";

const v = (id: string, note: string, extra: { label?: string; file?: string } = {}) => ({
  id, note, file: extra.file ?? "renders/lumen_v6.mp4", ...(extra.label !== undefined ? { label: extra.label } : {}),
});

describe("shortLabel (§22.4)", () => {
  it("uses the agent's label when there is one, and the note when it's blank", () => {
    expect(shortLabel(v("v6", "v6: anything", { label: "Launch slower" }))).toBe("Launch slower");
    expect(shortLabel(v("v6", "v6: launch 1.45x slower; more", { label: "   " }))).toBe("launch 1.45x slower");
  });

  it.each([
    ["v6", "v6: launch 1.45x slower; each zoomed request types itself out; crowd on a wider oval", "launch 1.45x slower"],
    ["v3", "v3 (batch b_1): zoom in on each of the first four requests and back out (New York, London, Lagos, Cape Town during the outage); crowd starts 1, 2, 3, 4", "zoom in on each of the first four requests and…"],
    ["v1", "Picture v1, silent. Night globe on demo nodes (Frankfurt, Mumbai)", "Picture v1, silent"],
    ["v2", "v2, new narrative (notes): centred button, then pull back off the globe", "new narrative"],
    ["v4", "v4 (batch b_2): softer zooms (0.95 s, eased in and out)", "softer zooms"],
    ["v6", "V6 — Slower launch, held logo", "Slower launch, held logo"],
    ["v1", "v1: first pass; rough", "first pass"],
    ["v3", "v3 - tighter cut; more", "tighter cut"],
    ["v5", "(batch b_9): quieter bed", "quieter bed"],
    ["v7", "line one\nline two; the rest", "line one line two"],
  ])("%s: %j becomes %j", (id, note, label) => expect(shortLabel(v(id, note))).toBe(label));

  it("only ends a clause after its first 12 characters", () => {
    expect(shortLabel(v("v1", "v1: ok; then the long part"))).toBe("ok; then the long part");
  });

  it("never strips a version id that isn't this cut's (§22.9)", () => {
    expect(shortLabel(v("v61", "v6: not this cut"))).toBe("v6: not this cut");
    expect(shortLabel(v("v2", "v5: copied from the old cut"))).toBe("v5: copied from the old cut");
  });

  it("falls back to the file's name without its extension: no note, punctuation only, or only the id (§22.9)", () => {
    expect(shortLabel(v("v6", ""))).toBe("lumen_v6");
    expect(shortLabel(v("v6", "…;;; — --"))).toBe("lumen_v6");
    expect(shortLabel(v("v6", "v6"))).toBe("lumen_v6");
    expect(shortLabel(v("v1", "", { file: "renders/harbour_launch_reel_v20J_final_master_export_4k_graded_prores.mov" }))).toBe("harbour_launch_reel_v20J_final_master_export…");
    expect(shortLabel(v("final", "", { file: "" }))).toBe("final");
  });

  it("is never over 48 characters and never splits an emoji, whatever it's given (Review Focus 2)", () => {
    for (const note of ["word ".repeat(30), "a".repeat(200), `${"a".repeat(46)}🎬🎬🎬`, `v9: ${"tiny ".repeat(20)}`]) {
      const label = shortLabel(v("v9", note));
      expect(Array.from(label).length).toBeLessThanOrEqual(LABEL_MAX);
      expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
    expect(shortLabel(v("v1", `${"a".repeat(46)}🎬🎬🎬`))).toBe(`${"a".repeat(46)}🎬…`);
  });

  it("shows a hand-edited label over 48 cut at a word with an ellipsis (§22.9)", () => {
    expect(shortLabel(v("v1", "", { label: "A label somebody typed by hand that runs on far past the limit of the list" }))).toBe(
      "A label somebody typed by hand that runs on far…",
    );
  });

  it("never splits a ZWJ sequence or a flag at the cut", () => {
    const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}"; // 5 code points, one character
    const label = shortLabel(v("v1", `${"a".repeat(44)}${family}${family}`));
    expect(label).toBe(`${"a".repeat(44)}…`);
    const flags = shortLabel(v("v1", `${"a".repeat(46)}\u{1F1EC}\u{1F1E7}\u{1F1EC}\u{1F1E7}`));
    expect(flags).toBe(`${"a".repeat(46)}…`);
    expect(shortLabel(v("v1", `${"a".repeat(44)}\u{1F1EC}\u{1F1E7}xyz`))).toBe(`${"a".repeat(44)}\u{1F1EC}\u{1F1E7}x…`);
  });

  it("never splits a combining character from its base, and copes with control characters and very long notes", () => {
    const accented = `${"é".repeat(60)}`; // 120 code points, 60 characters
    const label = shortLabel(v("v1", accented));
    expect(Array.from(label).length).toBeLessThanOrEqual(LABEL_MAX);
    expect(label.startsWith("́")).toBe(false);
    expect(Array.from(label.replace(/…$/, "")).at(-1)).not.toBe("e");
    expect(shortLabel(v("v1", "a\u0000b\u0007c\u001bd"))).toBe("a b c d");
    expect(Array.from(shortLabel(v("v1", "x ".repeat(100000)))).length).toBeLessThanOrEqual(LABEL_MAX);
  });
});

describe("clip and oneLine", () => {
  it("cuts at the last space that leaves room for the ellipsis, else at _ - /, else inside the one word", () => {
    expect(clip("short", 48)).toBe("short");
    expect(clip("Every launch starts with a single request.", 32)).toBe("Every launch starts with a…");
    expect(clip("harbour_launch_reel_v20J_final_master_export_4k", 30)).toBe("harbour_launch_reel_v20J…");
    expect(clip("a".repeat(60), 48)).toBe(`${"a".repeat(47)}…`);
  });

  it("turns control characters, tabs and newlines into single spaces", () => {
    expect(oneLineOf("  a\n\tb\u0007 c  ")).toBe("a b c");
    expect(Array.from(oneLine("x ".repeat(200), 160)).length).toBeLessThanOrEqual(160);
  });
});

describe("Version.label (§22.3, R2)", () => {
  it("a 0.2.2 project.json loads with every label empty, and a hand-edited long one still loads", () => {
    const p = ProjectSchema.parse({
      schema: 1, rev: 3, name: "Lumen launch film",
      videos: [{ id: "lumen", name: "Lumen", versions: [
        { id: "v1", file: "a.mp4", addedAt: "2026-10-05T09:00:00Z", note: "first" },
        { id: "v2", file: "b.mp4", addedAt: "2026-10-06T09:00:00Z", label: "x".repeat(80) },
      ] }],
    });
    expect(p.videos[0].versions[0].label).toBe("");
    expect(p.videos[0].versions[1].label).toHaveLength(80);
  });

  it("addVersion stores the label trimmed, and empty when there's none", () => {
    const p: Project = { schema: 1, rev: 0, name: "demo", fps: 30, videos: [], lanes: [], files: [], autoProxy: false };
    expect(addVersion(p, { video: "Hero", file: "a.mp4", label: "  Launch slower " }).version.label).toBe("Launch slower");
    expect(addVersion(p, { video: "Hero", file: "b.mp4" }).version.label).toBe("");
  });
});

// What would pull zod or Node into the web bundle: an import, a re-export from a module, a dynamic import, require.
const pullsInAModule = (js: string): boolean =>
  /^\s*import\b/m.test(js) || /^\s*export\s*(\*|\{[^}]*\})\s*from\b/m.test(js) || /\bimport\s*\(/.test(js) || /\brequire\s*\(/.test(js);

it("labels.ts compiles to JavaScript with no import at all, so the dashboard bundles it without zod or Node", () => {
  const text = readFileSync(new URL("../../src/core/labels.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, removeComments: true } }).outputText;
  expect(js).toContain("export function shortLabel");
  expect(pullsInAModule(js)).toBe(false);
  // Safari before 16.4 can't parse a lookbehind, and this file runs in the dashboard.
  expect(text).not.toMatch(/\(\?<[=!]/);
});
