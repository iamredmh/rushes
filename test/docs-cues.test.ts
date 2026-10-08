import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("shipped docs on cue samples and layers by sound (§23)", () => {
  it.each(["AGENTS.md", "skills/rushes/SKILL.md"])("%s tells agents a cue can carry its sample's file, and to keep a sound's name", (file) => {
    const text = read(file);
    expect(text).toContain("`{name, t, file?}`");
    expect(text).toMatch(/same name/);
    expect(text).toMatch(/an audio file/);
  });

  it("README explains the card, the layers by sound and their keys", () => {
    const text = read("README.md");
    for (const words of ["layers by sound", "`thud ×19`", "source file", "**Esc** hides the card", "Mix's Sound effects lane has the card too"]) {
      expect(text).toContain(words);
    }
  });

  it.each(["README.md", "AGENTS.md", "skills/rushes/SKILL.md"])("%s has no personal path", (file) => {
    const text = read(file);
    expect(text).not.toContain("/Users/");
    expect(text).not.toMatch(/\/home\/[a-z]/i);
  });
});
