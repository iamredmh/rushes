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

describe("shipped docs: the Change Log (§22.7)", () => {
  it.each(["AGENTS.md", "skills/rushes/SKILL.md"])("%s says to read the log at the start of a session and add a line when changing direction", (file) => {
    const text = read(file);
    expect(text).toMatch(/at the start of a session, (call|read) `rushes_get_log`/i);
    expect(text).toMatch(/(change direction|a decision)[^.]*`rushes_log`|`rushes_log`[^.]*(change direction|a decision)/i);
    for (const tool of ["rushes_log", "rushes_get_log"]) expect(text).toContain(`\`${tool}\``);
    expect(text).toMatch(/rushes log/);
    expect(text).not.toMatch(/\/Users\//);
  });

  it.each(["AGENTS.md", "skills/rushes/SKILL.md"])("%s lists what Rushes logs itself, in full, and says one line per decision (review M3, I2)", (file) => {
    const text = read(file);
    expect(text).toMatch(/picture lock/i);
    expect(text).toMatch(/files added/i);
    expect(text).toMatch(/bring-ins/i);
    expect(text).toMatch(/one line per decision/i);
    expect(text).toMatch(/never copy a note's or reply's text/i);
  });

  it("AGENTS.md names `dropped` among what rushes_get_log returns, and the -- form for text that starts with a dash (review M3, M4)", () => {
    const text = read("AGENTS.md");
    expect(text).toContain("`dropped`");
    expect(text).toContain('rushes log add --area mix -- "-3 dB on the bed"');
  });
});
