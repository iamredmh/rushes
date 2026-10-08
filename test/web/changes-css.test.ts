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

describe("changes.css: the drawer (§22.8)", () => {
  it("is 440 px wide, full width under 560 px, and drops its slide under reduced motion", () => {
    expect(css).toMatch(/\.drawer \{[^}]*width: 440px/);
    expect(css).toMatch(/@media \(max-width: 559px\) \{ \.drawer \{ width: 100%; \} \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.drawer \{ animation: none; \}/);
  });
  it("tags every area with its stage's colour", () => {
    for (const area of ["picture", "voice", "music", "sfx", "mix", "notes", "assets", "script", "project"]) expect(css, area).toContain(`.ltag.${area}`);
  });
});
