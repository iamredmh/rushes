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
  });
});
