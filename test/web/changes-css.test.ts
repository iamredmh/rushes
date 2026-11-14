import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const raw = readFileSync(new URL("../../web/src/changes.css", import.meta.url), "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

describe("changes.css (§22.8)", () => {
  it("is loaded after styles.css", () => {
    const main = readFileSync(new URL("../../web/src/main.tsx", import.meta.url), "utf8");
    expect(main.indexOf('import "./changes.css";')).toBeGreaterThan(main.indexOf('import "./styles.css";'));
  });
  it("sets no type under 15 px", () => {
    for (const m of css.matchAll(/font(?:-size)?:[^;]*?(\d+(?:\.\d+)?)px/g)) expect(Number(m[1]), m[0]).toBeGreaterThanOrEqual(15);
  });
  it("lays every grid out with explicit tracks, never a bare fr (Safari, §22.11)", () => {
    for (const m of css.matchAll(/grid-template-columns:\s*([^;]+);/g)) expect(m[1].replace(/minmax\(0,\s*1fr\)/g, ""), m[0]).not.toMatch(/\dfr\b/);
  });
  it("truncates the version label and row labels rather than wrap them", () => {
    for (const sel of [".vbtn .vlbl", ".vrow .vlbl"]) {
      const rule = css.slice(css.indexOf(`${sel} {`), css.indexOf("}", css.indexOf(`${sel} {`)));
      expect(rule, sel).toMatch(/text-overflow: ellipsis/);
      expect(rule, sel).toMatch(/white-space: nowrap/);
    }
  });
});

describe("changes.css: the Change Log's list (§22.8), in the notes panel's Activity tab (§27, 5.7)", () => {
  const desk = readFileSync(new URL("../../web/src/desk.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("has no drawer of its own: the list fills the Activity tab, and under 1100 px the whole panel is a drawer over the work area", () => {
    expect(css).not.toMatch(/\.drawer \{/);
    expect(desk).toMatch(/\.activity \{[^}]*grid-template-rows: auto auto minmax\(0, 1fr\) auto/);
    expect(desk).toMatch(/@media \(max-width: 1099px\) \{[\s\S]*\.npanel\.drawer \{ position: fixed;[^}]*bottom: 26px;/);
  });
  it("tags every area with its stage's colour", () => {
    for (const area of ["picture", "voice", "music", "sfx", "mix", "notes", "assets", "script", "project"]) expect(css, area).toContain(`.ltag.${area}`);
  });
});
