import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../web/src/cues.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const main = readFileSync(new URL("../../web/src/main.tsx", import.meta.url), "utf8");

describe("cues.css (§23)", () => {
  it("is loaded after styles.css, so its overrides win", () => {
    expect(main.indexOf('import "./cues.css";')).toBeGreaterThan(main.indexOf('import "./styles.css";'));
    expect(main.indexOf('import "./styles.css";')).toBeGreaterThan(-1);
  });

  it("sets no type under 15 px", () => {
    const sizes = [...css.matchAll(/font(?:-size)?:[^;]*?(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const s of sizes) expect(s).toBeGreaterThanOrEqual(15);
  });

  it("uses explicit grid tracks: every fraction is minmax(0, 1fr) (Safari)", () => {
    const grids = [...css.matchAll(/grid-template-columns:([^;]+);/g)];
    expect(grids.length).toBeGreaterThan(0);
    for (const m of grids) expect(m[1].replace(/minmax\(0, 1fr\)/g, "")).not.toMatch(/\dfr/);
  });

  it("scrolls the layers after about eight rows (8 × 30 px + 7 × 3 px)", () => {
    expect(css).toMatch(/\.clayers \{[^}]*max-height: 261px;[^}]*overflow-y: auto;/);
  });

  it("turns the chevron without motion when motion is reduced", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.chev svg\.ic \{ transition: none; \}/);
  });

  it("styles the chevron only as a button, so Found's chevron icon (an svg with the same class) stays unboxed", () => {
    expect(css).not.toMatch(/(^|\n)\s*\.chev(:[a-z-]+(\([^)]*\))?)*\s*\{/);
    expect(css).toMatch(/(^|\n)button\.chev \{[^}]*border: 1px solid/);
    expect(css).toMatch(/button\.chev:hover:not\(:disabled\) \{/);
  });

  it("sizes the card to its content, so measuring it doesn't depend on where it was last put", () => {
    expect(css).toMatch(/\.cuecard \{[^}]*width: max-content;/);
    expect(css).toMatch(/\.cuecard \{[^}]*max-width: min\(420px, calc\(100vw - 32px\)\);/);
  });

  it("sits the card above the Change Log drawer, the version menu and the format pop", () => {
    expect(css).toMatch(/\.cuecard \{[^}]*z-index: 47;/);
  });
});
