import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BRIEF_FILE, BRIEF_SECTIONS } from "../src/cli/new.js";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("starting a film: what the agent docs promise (§24)", () => {
  it.each(["AGENTS.md", "skills/rushes/SKILL.md"])("%s says how to start a film, with --no-browser, a short interview, approvals by the user, and no build before them", (file) => {
    const text = read(file);
    expect(text).toContain("## Starting a film");
    expect(text).toContain("npx -y rushes new <folder> --no-browser");
    expect(text).toMatch(/--no-browser`?,? then `rushes_open`/);
    expect(text).toContain("at most three questions");
    expect(text).toContain("recommended answer");
    expect(text).toContain(BRIEF_FILE);
    expect(text).toContain("storyboard.md");
    expect(text).toContain("Status: approved");
    expect(text).toMatch(/never approve (it|either|them) yourself/i);
    expect(text).toContain("rushes_set_script");
    expect(text).toContain("rushes_set_shots");
    expect(text).toContain("name each scene after its planned shot");
  });

  it("AGENTS.md names every section of the brief template, in order, inside Starting a film", () => {
    const whole = read("AGENTS.md");
    const text = whole.slice(whole.indexOf("## Starting a film"), whole.indexOf("## A demo project"));
    expect(text.length).toBeGreaterThan(0);
    let at = -1;
    for (const section of BRIEF_SECTIONS) {
      const i = text.indexOf(section, at + 1);
      expect(i, `"${section}" should come after the previous section, inside Starting a film`).toBeGreaterThan(at);
      at = i;
    }
  });

  it("the skill's description makes an agent reach for Rushes when a user wants a new film", () => {
    const description = /^description: (.+)$/m.exec(read("skills/rushes/SKILL.md"))![1];
    expect(description).toMatch(/start(ing)? a new (film|video)/i);
    expect(description).toContain("review");
  });

  it("AGENTS.md lists `rushes new` in the commands for agents without MCP", () => {
    expect(read("AGENTS.md")).toContain("npx -y rushes new my-film --no-browser");
  });
});
