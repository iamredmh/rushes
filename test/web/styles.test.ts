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
  it("sets the interface in Geist and timecode in Geist Mono", () => {
    expect(css).toMatch(/--sans:\s*"Geist",/);
    expect(css).toMatch(/--mono:\s*"Geist Mono",/);
    expect(css).not.toMatch(/Figtree|JetBrains/);
  });
  it("keeps every colour in the two token blocks", () => {
    for (const file of ["styles.css", "changes.css", "cues.css", "desk.css"]) {
      const text = readFileSync(new URL(`../../web/src/${file}`, import.meta.url), "utf8")
        .replace(/:root\s*\{[^}]*\}/g, "")
        .replace(/:root\[data-theme="light"\]\s*\{[^}]*\}/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      expect(text.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? [], file).toEqual([]);
    }
  });
  it("defines every token in both modes", () => {
    const names = (block: string) =>
      [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]).filter((n) => !/^--(sans|mono|r|r-lg|body-pad)$/.test(n)).sort();
    const dark = css.match(/:root\s*\{([^}]*)\}/)![1];
    const light = css.match(/:root\[data-theme="light"\]\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(names(light)).toEqual(names(dark));
    expect(names(dark)).toContain("--black");
  });
  it("the lanes take their colours from the tokens, so they follow the mode", () => {
    for (const file of ["Mix.tsx", "VariantTab.tsx", "Voice.tsx"]) {
      const text = readFileSync(new URL(`../../web/src/ui/${file}`, import.meta.url), "utf8");
      expect(text.match(/"#[0-9a-fA-F]{6}"/g) ?? [], file).toEqual([]);
    }
  });
  it("bundles its fonts and fetches none", () => {
    const main = readFileSync(new URL("../../web/src/main.tsx", import.meta.url), "utf8");
    expect(main).toMatch(/@fontsource\/geist\/400\.css/);
    expect(main).toMatch(/@fontsource\/geist-mono\/400\.css/);
    expect(main + css).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
  });
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
    // §27: the light mode's pair holds the same line.
    const light = css.match(/:root\[data-theme="light"\]\s*\{([^}]*)\}/)![1];
    const lightToken = (name: string) => light.match(new RegExp(`--${name}: (#[0-9a-f]{6});`))![1];
    expect(ratio(lightToken("on-accent"), lightToken("accent"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(lightToken("todo"), lightToken("bg"))).toBeGreaterThanOrEqual(3);
    // The plain mark keeps the to-do colour on the unselected chip, which sits on the dark ground.
    expect(ratio(token("todo"), token("bg"))).toBeGreaterThanOrEqual(4.5);
  });
  it("small text and status marks keep their contrast in both modes (§27 review)", () => {
    const block = (sel: RegExp) => css.match(sel)![1];
    const dark = block(/:root\s*\{([^}]*)\}/);
    const light = block(/:root\[data-theme="light"\]\s*\{([^}]*)\}/);
    const tok = (b: string, name: string) => b.match(new RegExp(`--${name}: (#[0-9a-f]{6});`))![1];
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    // The quietest text that is still meant to be read.
    expect(ratio(tok(dark, "text-3"), tok(dark, "bg"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(tok(light, "text-3"), tok(light, "app"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(tok(light, "text-2"), tok(light, "bg"))).toBeGreaterThanOrEqual(4.5);
    // Status words (To do, Fixed) on a panel.
    for (const name of ["todo", "done"]) {
      expect(ratio(tok(light, name), tok(light, "raised")), `light ${name}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(tok(dark, name), tok(dark, "app")), `dark ${name}`).toBeGreaterThanOrEqual(4.5);
    }
    // Text on the surfaces that stay dark.
    expect(ratio(tok(light, "k-text-2"), tok(light, "black"))).toBeGreaterThanOrEqual(4.5);
  });
  it("what sits on a surface that stays dark reads as on dark in both modes (§27 review)", () => {
    // The picture's surround, the lightboxes and the full-screen viewer are near-black in light mode
    // too, so the text and line tokens inside them point at the dark set.
    const rule = css.match(/\n\.frame, \.srcswitch, \.sblight, \.lightbox, \.vzframe, \.vzfs \{([^}]*)\}/)?.[1] ?? "";
    for (const t of ["text", "text-2", "text-3", "line", "line-2", "hover", "raised", "app", "bg"]) expect(rule, t).toContain(`--${t}: var(--k-${t});`);
  });
  it("the chips reserve their count slot and their bold label, so no chip moves (review I1)", () => {
    expect(css).toMatch(/\.fmts \.n \{[^}]*min-width: calc\(2ch \+ 14px\)/);
    expect(css).toMatch(/\.fmts \.n\.none \{[^}]*visibility: hidden/);
    expect(css).toMatch(/\.fmts \.lbl::after \{[^}]*content: attr\(data-label\)[^}]*font-weight: 600[^}]*visibility: hidden/);
  });
});
