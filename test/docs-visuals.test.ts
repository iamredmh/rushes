import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// §25: what the agent docs and the README say about the Visuals tab.
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

describe("shipped docs: Visuals (§25)", () => {
  it.each(["AGENTS.md", "skills/rushes/SKILL.md"])("%s tells the agent when to register a visual, the one-call shape, and what to do with feedback", (file) => {
    const text = read(file);
    expect(text).toContain("rushes_add_visual");
    expect(text).toContain("one visual per post");
    expect(text).toContain("every aspect ratio");
    expect(text).toContain("only the pages that changed");
    expect(text).toContain("fixVersion");
    expect(text).toContain("never mark a note done");
    // A note names its picture and where on it the mark is.
    expect(text).toMatch(/region.*point.*whole image/s);
  });

  it("AGENTS.md says what the Visuals notes in a batch carry, and that a note with no ratio is for every ratio", () => {
    const text = read("AGENTS.md");
    expect(text).toContain("`visual`");
    expect(text).toContain("`words`");
    expect(text).toContain("`file`");
    expect(text).toMatch(/no ratio.*every ratio/s);
  });

  it("README describes the Visuals tab: one page at a time, marking, the notes column, and the keys", () => {
    const text = read("README.md");
    expect(text).toContain("### Visuals: mark up stills and carousels");
    expect(text).toContain("whichever visual crosses the middle");
    expect(text).toContain("Drag");
    expect(text).toContain("**1–8** switch tab (1: Planning, which opens the page you used last; 7: Visuals; 8: Assets)");
    expect(text).toContain("The **Assets** tab (key `8`)");
    expect(text).not.toContain("**1–7** switch tab");
  });
});
