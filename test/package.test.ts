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
});
