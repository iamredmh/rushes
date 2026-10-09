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

describe("README: starting a film (§24)", () => {
  const text = read("README.md");

  it("Get started leads with starting a film, and still offers the review-tool line for a film that exists", () => {
    const start = text.slice(text.indexOf("## Get started"), text.indexOf("## How it works"));
    expect(start).toMatch(/Use github\.com\/iamredmh\/rushes to start a new film/);
    expect(start).toMatch(/Already have a film\?/);
    expect(start).toContain("Use github.com/iamredmh/rushes as my review tool for video, voiceover and music.");
    // The first instruction is the new-film one.
    expect(start.indexOf("to start a new film")).toBeLessThan(start.indexOf("as my review tool"));
  });

  it("has a 'Start a film' section with the command, the refusals and the flags", () => {
    const section = text.slice(text.indexOf("### Start a film"), text.indexOf("### Try it first"));
    expect(section).toContain("npx -y rushes new my-film");
    expect(section).toContain("brief.md");
    expect(section).toMatch(/already a Rushes project/);
    expect(section).toMatch(/never overwritten/);
    expect(section).toContain("--name");
    expect(section).toContain("--no-browser");
  });

  it("the agent steps point at Starting a film in AGENTS.md", () => {
    const agents = text.slice(text.indexOf("## For agents: set yourself up"), text.indexOf("## Manual setup"));
    expect(agents).toContain("**Starting a film** in AGENTS.md");
  });
});
