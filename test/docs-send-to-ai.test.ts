import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { alwaysLabel } from "../src/core/alwaysLabel.js";
import { MENU_WORDS, PERMISSION_CHOICES, SHEET_WORDS, mayQuestion, rowText, whoLine } from "../web/src/agent.js";

// What the README says about Send to AI, pinned to the words the desk really shows (pulled from the source, not retyped).
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const readme = read("README.md");
const section = readme.slice(readme.indexOf("## Send to AI"), readme.indexOf("## The Change Log"));

describe("shipped docs: Send to AI", () => {
  it("has its own section", () => {
    expect(section.length).toBeGreaterThan(500);
    expect(section.startsWith("## Send to AI")).toBe(true);
  });

  it("names the desk's own words: permission levels, fresh conversation, Always, sign in, no key", () => {
    for (const p of PERMISSION_CHOICES) expect(section).toContain(`**${p.label}**`);
    expect(section).toContain(MENU_WORDS.fresh);
    expect(section).toContain(MENU_WORDS.signIn);
    expect(section).toContain(SHEET_WORDS.noKey.split(".")[0]);
    expect(section).toContain(alwaysLabel({ kind: "execute", command: "npx hyperframes" } as never).split(" npx")[0]);
    expect(section).toContain("**Allow once**");
    expect(section).toContain("**Always**");
    expect(section).toContain("**Stop**");
  });

  it("describes the row, the who-line and the first-Send questions as the desk shows them", () => {
    expect(rowText({ agent: "claude" } as never).startsWith("Send to AI")).toBe(true);
    expect(section).toContain("**Send to AI**");
    expect(section).toContain(whoLine({ permissions: "project-edits", session: null } as never));
    expect(section).toContain(whoLine({ permissions: "ask-all", session: null } as never));
    expect(section).toContain(SHEET_WORDS.who);
    expect(section).toContain(mayQuestion("claude").replace("Claude Code", "<agent>"));
  });

  it("says a start failure puts the notes back in to do and copies nothing; not set up, not signed in or not installed opens the copy dialog", () => {
    expect(section).not.toContain("When the agent can't start or isn't signed in, Send copies the prompt and says why");
    expect(section).toMatch(/fails to start[^.]*back in to do[^.]*(copies nothing|nothing is copied)/s);
    expect(section).toMatch(/not set up, not signed in or not installed[^.]*copy dialog/s);
  });

  it("states the limits: the agent's own allow rules, Codex read-only commands, background commands, versions", () => {
    expect(section).toContain("Rushes never sees");
    expect(section).toMatch(/allow rules/);
    expect(section).toMatch(/Codex[^.]*only read[^.]*without asking/s);
    expect(section).toMatch(/wait for (its )?commands to finish/);
    expect(section).toMatch(/only adds a (new )?version when the picture or sound changed/);
  });

  it("never mentions the test hook or a client or project name", () => {
    expect(readme).not.toContain("RUSHES_TEST_AGENT");
    expect(section).not.toMatch(/dfinity|caffeine|rebalance|oisy|bea media/i);
  });
});
