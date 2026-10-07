import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/server/app.js";
import { SOURCE } from "../src/setup/harnesses.js";

// §19.7: what ships to npm. Keeping this list in a test, rather than just in package.json,
// means a future change to "files" has to pass a reader who can say why each entry is there.
const EXPECTED_FILES = ["dist", "web-dist", "skills", ".claude-plugin", ".mcp.json", "README.md", "AGENTS.md", "LICENSE"];

describe("package.json, §19.7", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    files: string[];
    version: string;
    scripts: Record<string, string>;
  };

  it("ships exactly dist, web-dist, skills, .claude-plugin, .mcp.json, README.md, AGENTS.md and LICENSE", () => {
    expect(pkg.files).toEqual(EXPECTED_FILES);
  });

  it("prepublishOnly builds, typechecks and runs the unit tests, never the e2e suite", () => {
    expect(pkg.scripts.prepublishOnly).toBe("npm run build && npm run typecheck && npx vitest run");
  });

  it("is at 0.2.2", () => {
    expect(pkg.version).toBe("0.2.2");
  });

  it("the runtime VERSION constant (the CLI's --version and help banner) matches package.json, so they can't drift apart", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("the Claude Code plugin's version matches package.json, so plugin users get the new skill (the plugin cache is keyed on it)", () => {
    const plugin = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8")) as { version: string };
    expect(plugin.version).toBe(pkg.version);
  });

  it("package-lock.json is at the same version, so the next npm install doesn't rewrite it in an unrelated change", () => {
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as { version: string; packages: Record<string, { version?: string }> };
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
  });
});

describe("shipped agent docs (final review I3)", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

  it.each(["skills/rushes/SKILL.md", "AGENTS.md"])("%s runs the demo through npx with --no-browser, then rushes_open, never a bare `rushes demo`", (file) => {
    const text = read(file);
    // A bare `rushes demo` assumes a global binary and, without --no-browser, never returns.
    expect(text).toContain("npx -y rushes demo <folder> --no-browser");
    expect(text).toMatch(/--no-browser`?,? then `rushes_open`/);
    expect(text).not.toMatch(/`rushes demo`/);
  });

  // §20.7: an agent should know Rushes looks for the other files itself, and how to correct it.
  it.each(["skills/rushes/SKILL.md", "AGENTS.md"])("%s tells the agent to call rushes_open, say what it brought in and left, and pass `include` for files it made", (file) => {
    const text = read(file);
    expect(text).toMatch(/When (the user )?asked? to open or review work in Rushes, call `rushes_open`/i);
    expect(text).toMatch(/what (it )?brought in and what (it )?left/i);
    expect(text).toMatch(/`include`/);
    expect(text).toMatch(/files you made for this cut/);
    expect(text).toMatch(/`rushes_open`[^.]*`film`|`film`[^.]*`rushes_open`/);
    for (const tool of ["rushes_scan", "rushes_bring_in"]) expect(text).toContain(`\`${tool}\``);
    expect(text).toMatch(/rushes scan/);
    expect(text).toMatch(/rushes bring-in/);
    expect(text).toMatch(/nothing is (ever )?picked|never picks/i);
  });

  it.each(["skills/rushes/SKILL.md", "AGENTS.md"])("%s says rushes_scan also brings in, what the result lists, and the 20 second wait", (file) => {
    const text = read(file);
    expect(text).toMatch(/`rushes_scan`[^.]*(also )?brings in the current set/);
    for (const word of ["alreadyIn", "origin", "scanning: true", "about 20 seconds"]) expect(text).toContain(word);
  });

  it("AGENTS.md says an include keeps winning, and the one case it can't", () => {
    const text = read("AGENTS.md");
    expect(text).toMatch(/on any later scan or restart/);
    expect(text).toMatch(/both are in, unpicked/);
  });

  it.each(["README.md", "AGENTS.md", "skills/rushes/SKILL.md"])("%s counts twenty tools, and names every one", (file) => {
    const text = read(file);
    expect(text).toMatch(/twenty tools/);
    expect(text).not.toMatch(/nineteen/);
    for (const tool of ["rushes_scan", "rushes_bring_in", "rushes_add_format"]) expect(text).toContain(`\`${tool}\``);
  });

  it.each(["README.md", "AGENTS.md", "skills/rushes/SKILL.md"])("%s names exactly the tools the server registers", (file) => {
    const registered = [...read("src/mcp/tools.ts").matchAll(/registerTool\(\s*"(rushes_\w+)"/g)].map((m) => m[1]);
    expect(registered).toHaveLength(20);
    const text = read(file);
    for (const tool of registered) expect(text, tool).toContain(`\`${tool}\``);
  });

  it.each(["skills/rushes/SKILL.md", "AGENTS.md"])("%s tells the agent to register every shape, main one first, and fix only a note's own format (§21.4)", (file) => {
    const text = read(file);
    expect(text).toContain("`rushes_add_format`");
    expect(text).toMatch(/register every shape you rendered/i);
    expect(text).toMatch(/main one first/i);
    expect(text).toMatch(/fix only that format/i);
    expect(text).toMatch(/`format`/);
  });
});

// Plan 5, Task 6: finding the project's other files, in the words an agent and a user will read.
describe("shipped docs on finding the project's other files (§20)", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

  it.each(["README.md", "AGENTS.md", "skills/rushes/SKILL.md"])("%s names rushes_scan, rushes_bring_in and include, and has no personal path", (file) => {
    const text = read(file);
    for (const word of ["`rushes_scan`", "`rushes_bring_in`", "`include`"]) expect(text).toContain(word);
    expect(text).not.toContain("/Users/");
    expect(text).not.toMatch(/\/home\/[a-z]/i);
  });

  it.each(["README.md", "AGENTS.md", "skills/rushes/SKILL.md"])("%s says nothing is picked for you, and the 12-per-kind cap", (file) => {
    const text = read(file);
    expect(text).toMatch(/nothing is (ever )?picked|never picks|never picked/i);
    expect(text).toMatch(/12 (files )?(of each kind|per kind)|up to 12/i);
  });

  it("README has a 'Finding your other files' section covering open, the current set, Found, Bring in and Not these", () => {
    const text = read("README.md");
    const at = text.indexOf("## Finding your other files");
    expect(at).toBeGreaterThan(-1);
    const next = text.indexOf("\n## ", at + 5);
    const section = text.slice(at, next === -1 ? undefined : next);
    for (const word of ["current set", "Assets › Found", "Bring in", "Not these", "Look again", "rushes scan", "rushes bring-in", "--kind", "--round", "--json", "`include`"]) {
      expect(section).toContain(word);
    }
    // Where it looks, and where it never does.
    expect(section).toMatch(/inside the project folder/i);
    expect(section).toMatch(/symlink/i);
  });

  it("README and AGENTS describe the locked-tab line and its Review button", () => {
    for (const file of ["README.md", "AGENTS.md"]) {
      const text = read(file);
      expect(text).toMatch(/14 music files found in this project/);
      expect(text).toMatch(/\*\*Review\*\*/);
    }
  });

  it("every CLI flag the scan and bring-in commands take is in the README", () => {
    const text = read("README.md");
    for (const flag of ["--film", "--kind", "--round", "--json"]) expect(text).toContain(flag);
  });
});

describe("install source, §19.7: SOURCE is rushes", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

  it.each(["README.md", "AGENTS.md", "skills/rushes/SKILL.md"])("%s has no `npx -y github:iamredmh/rushes` install command, apart from README's one before-publishing note", (file) => {
    const text = read(file);
    const matches = text.match(/npx -y github:iamredmh\/rushes/g) ?? [];
    if (file === "README.md") {
      expect(matches).toHaveLength(1);
      expect(text).toContain("Before publishing to npm, the GitHub form also works: `npx -y github:iamredmh/rushes setup`.");
    } else {
      expect(matches).toHaveLength(0);
    }
  });

  it("SOURCE is the npm package name", () => {
    expect(SOURCE).toBe("rushes");
  });

  it("the shipped .mcp.json (the Claude Code plugin) launches rushes from npm, not GitHub", () => {
    const mcp = JSON.parse(read(".mcp.json")) as { mcpServers: { rushes: { command: string; args: string[] } } };
    expect(mcp.mcpServers.rushes).toEqual({ command: "npx", args: ["-y", SOURCE, "mcp"] });
  });
});
