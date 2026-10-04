import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/server/app.js";

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

  it("is at 0.2.0", () => {
    expect(pkg.version).toBe("0.2.0");
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
    expect(text).toContain("npx -y github:iamredmh/rushes demo <folder> --no-browser");
    expect(text).toMatch(/--no-browser`?,? then `rushes_open`/);
    expect(text).not.toMatch(/`rushes demo`/);
  });
});
