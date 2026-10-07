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

  it("keeps a leading version id only when it's this cut's, and strips it only as a prefix (§22.9)", () => {
    expect(shortLabel(v("v6", "v60: x"))).toBe("v60: x");
    expect(shortLabel(v("v6", "v6.5 slower launch"))).toBe("v6.5 slower launch");
    expect(shortLabel(v("v6", "v6 slower launch"))).toBe("v6 slower launch");
    expect(shortLabel(v("v6", "v6. slower launch"))).toBe("slower launch");
    expect(shortLabel(v("v6", "v6, slower launch"))).toBe("slower launch");
    expect(shortLabel(v("v6", "v6"))).toBe("lumen_v6");
    expect(shortLabel(v("v6x", "v6: other"))).toBe("v6: other");
    expect(shortLabel(v("cut v6", "v6: other"))).toBe("v6: other");
  });

  it("strips a leading (batch …) with or without its colon, and nothing that only starts with the word", () => {
    expect(shortLabel(v("v1", "(batch b_1) tighter cut"))).toBe("tighter cut");
    expect(shortLabel(v("v1", "(batch b_1): tighter cut"))).toBe("tighter cut");
    expect(shortLabel(v("v1", "(batches are next) later"))).toBe("(batches are next) later");
  });

  it("a label of exactly 48 characters is shown whole, and 49 is cut", () => {
    const exact = `${"word ".repeat(9)}abc`;
    expect(Array.from(exact)).toHaveLength(48);
    expect(shortLabel(v("v1", "", { label: exact }))).toBe(exact);
    expect(shortLabel(v("v1", exact))).toBe(exact);
    expect(shortLabel(v("v1", "", { label: `${exact}d` }))).toBe(`${"word ".repeat(9).trim()}…`);
  });

  it("takes the comma and colon off the end of a cut before the ellipsis", () => {
    expect(shortLabel(v("v1", `${"a".repeat(40)} three, overflow`))).toBe(`${"a".repeat(40)} three…`);
    expect(clip(`${"a".repeat(40)} three: overflow`, 48)).toBe(`${"a".repeat(40)} three…`);
  });

  it("counts the 12-character minimum in characters, not UTF-16 units", () => {
    expect(shortLabel(v("v1", "\u{1F3AC}".repeat(6) + "; then more words"))).toBe("\u{1F3AC}".repeat(6) + "; then more words");
  });

  it("drops bidi and zero-width characters, and treats a label made only of them as blank (§22.9)", () => {
    expect(oneLineOf("\u202eab\u200bc\u2066d")).toBe("abcd");
    expect(oneLineOf("a\u0085b\u2028c\u2029d")).toBe("a b c d");
    expect(oneLineOf("\u200b\u200b \u202e")).toBe("");
    expect(oneLineOf("\u200d")).toBe("");
    expect(shortLabel(v("v6", "v6: launch slower", { label: "\u200b\u200b\u202e" }))).toBe("launch slower");
    // The joiner and the tag characters belong to emoji sequences, so they stay inside text.
    const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}";
    expect(oneLineOf(`a ${family}`)).toBe(`a ${family}`);
    const england = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    expect(oneLineOf(england)).toBe(england);
  });

  it("replaces a lone surrogate with U+FFFD instead of passing it on", () => {
    expect(oneLineOf("a\uD83Db")).toBe("a\uFFFDb");
    expect(oneLineOf("a\uDC00b")).toBe("a\uFFFDb");
    expect(shortLabel(v("v1", "tidy \uD83D up"))).toBe("tidy \uFFFD up");
    expect(oneLineOf("ok \u{1F3AC}")).toBe("ok \u{1F3AC}");
  });

  it("the fallback is one line, never a bare ellipsis, and never empty", () => {
    expect(shortLabel(v("v1", "", { file: "renders/take\none.mp4" }))).toBe("take one");
    expect(shortLabel(v("v2", "", { file: `${"-".repeat(60)}.mp4` }))).toBe("v2");
    expect(shortLabel(v("v3", "", { file: `${"\u0301".repeat(60)}.mp4` }))).toBe("v3");
    expect(shortLabel(v("v4", "!!!", { file: "" }))).toBe("v4");
    expect(shortLabel(v("", "", { file: "" })).length).toBeGreaterThan(0);
    expect(shortLabel(v("", "...", { file: "" })).length).toBeGreaterThan(0);
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
    expect(addVersion(p, { video: "Hero", file: "c.mp4", label: "\u200b\u202e" }).version.label).toBe("");
  });
});

// What would pull zod or Node into the web bundle: any import or export declaration that names a
// module (including `export * as ns from`, `import x = require()` and type-only ones), a dynamic
// import(), or a require() call. Found by walking the syntax tree, so formatting can't hide one.
function modulesPulledIn(text: string): string[] {
  const sf = ts.createSourceFile("labels.ts", text, ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) found.push(n.moduleSpecifier.getText(sf));
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) found.push(n.moduleReference.getText(sf));
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) found.push(n.getText(sf));
    else if (ts.isImportTypeNode(n)) found.push(n.getText(sf));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

it("the import check sees every way of pulling a module in", () => {
  for (const bad of ['import "zod";', 'import { z } from "zod";', 'import type { T } from "./x.js";', 'export * from "zod";', 'export * as z from "zod";', 'export { a } from "./x.js";',
    'const m = await import("node:fs");', 'const f = require("fs");', 'import fs = require("fs");', 'type T = import("zod").ZodType;']) {
    expect(modulesPulledIn(bad), bad).not.toEqual([]);
  }
  expect(modulesPulledIn("export const a = 1; export function f(): void {}")).toEqual([]);
});

it("labels.ts has no import of any kind, so the dashboard bundles it without zod or Node", () => {
  const text = readFileSync(new URL("../../src/core/labels.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, removeComments: true } }).outputText;
  expect(js).toContain("export function shortLabel");
  expect(modulesPulledIn(text)).toEqual([]);
  // Safari before 16.4 can't parse a lookbehind, and this file runs in the dashboard.
  expect(text).not.toMatch(/\(\?<[=!]/);
  // Invisible characters are written as escapes, so nobody has to find them by eye.
  expect(text).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufe00-\ufe0f\ufeff]/);
});
