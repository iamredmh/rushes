import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("shipped docs: short labels (§22.4)", () => {
  it.each(["AGENTS.md", "skills/rushes/SKILL.md"])("%s says to give every cut a short label and put the detail in note", (file) => {
    const text = read(file);
    expect(text).toMatch(/give every cut a short `label`/i);
    expect(text).toContain("48 characters");
    expect(text).toMatch(/detail in `note`/);
  });
});
