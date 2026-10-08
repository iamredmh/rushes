import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Fix round 2: container query units (Safari 16+, Chrome 105+) sit behind @supports, so an older
// browser keeps the layout from before fix round 1 rather than a half-applied one.
const css = readFileSync(new URL("../../web/src/styles.css", import.meta.url), "utf8");

/** The stylesheet with every `@supports (width: 1cqw) { … }` block taken out, braces balanced. */
function outsideSupports(text: string): string {
  let out = "";
  let i = 0;
  const marker = "@supports (width: 1cqw)";
  for (;;) {
    const at = text.indexOf(marker, i);
    if (at < 0) return out + text.slice(i);
    out += text.slice(i, at);
    let j = text.indexOf("{", at);
    let depth = 1;
    while (depth > 0 && ++j < text.length) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
    }
    i = j + 1;
  }
}

describe("styles.css", () => {
  it("uses container units and containers only inside @supports (width: 1cqw)", () => {
    expect(css).toContain("@supports (width: 1cqw)");
    const rest = outsideSupports(css).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rest).not.toMatch(/\d(cqw|cqh|cqi|cqb|cqmin|cqmax)\b/);
    expect(rest).not.toMatch(/container-type\s*:/);
  });
  it("the format toggle and the note's format switch use explicit grid tracks (§21.8, Safari)", () => {
    expect(css).toMatch(/\.fmts \{[^}]*display: inline-grid/);
    expect(css).toMatch(/\.fscope \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    // Task 5 review M1: the Other formats row's grid too.
    expect(css).toMatch(/\.otherfmts \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  });
  it("a selected chip's warning mark reads at 4.5:1 or more against the chip (review M7)", () => {
    const token = (name: string) => css.match(new RegExp(`--${name}: (#[0-9a-f]{6});`))![1];
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    expect(css).toMatch(/\.fmts \[aria-checked="true"\] \.warn \{[^}]*color: var\(--on-accent\)/);
    expect(css).toMatch(/\.fmts \[role="radio"\]\[aria-checked="true"\] \{[^}]*background: var\(--accent\)/);
    expect(ratio(token("on-accent"), token("accent"))).toBeGreaterThanOrEqual(4.5);
    // The plain mark keeps the to-do colour on the unselected chip, which sits on the dark ground.
    expect(ratio(token("todo"), token("bg"))).toBeGreaterThanOrEqual(4.5);
  });
  it("the chips reserve their count slot and their bold label, so no chip moves (review I1)", () => {
    expect(css).toMatch(/\.fmts \.n \{[^}]*min-width: calc\(2ch \+ 14px\)/);
    expect(css).toMatch(/\.fmts \.n\.none \{[^}]*visibility: hidden/);
    expect(css).toMatch(/\.fmts \.lbl::after \{[^}]*content: attr\(data-label\)[^}]*font-weight: 600[^}]*visibility: hidden/);
  });
});
