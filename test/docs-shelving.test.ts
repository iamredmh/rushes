import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// §26: what the agent docs and the README say about shelving a film.
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

describe("shipped docs: shelved films (§26)", () => {
  it.each(["AGENTS.md", "skills/rushes/SKILL.md"])("%s tells the agent a shelved film is the user's decision: leave it alone, and a new cut restores it", (file) => {
    const text = read(file);
    expect(text).toContain("shelved");
    expect(text).toContain("`films`");
    expect(text).toMatch(/leave (it|them) alone/);
    expect(text).toContain("restored: true");
    // The agent never shelves or restores.
    expect(text).toMatch(/never shelve/i);
  });

  it("README describes the Film menu, the Shelved list, the +N list, and what shelving does to the counts", () => {
    const text = read("README.md");
    expect(text).toContain("### Shelve a film");
    expect(text).toContain("Film actions");
    expect(text).toContain("**Shelved (N)**");
    expect(text).toContain("+N");
    expect(text).toContain("Shift+S");
    expect(text).toMatch(/open notes.*(stop counting|do not count)/s);
    expect(text).toContain("**[ / ]** previous/next film in play");
  });
});
