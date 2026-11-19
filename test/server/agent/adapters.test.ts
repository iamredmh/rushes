import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADAPTERS, AGENT_MODE, ASK_MODE, adapterSpec, modeFor, rushesMcp, sessionSetup } from "../../../src/server/agent/adapters.js";
import type { AgentInfo } from "../../../src/server/agent/detect.js";

const root = "/tmp/some project";
const claude: AgentInfo = { id: "claude", name: "Claude Code", installed: true, signedIn: true, path: "/usr/local/bin/claude", signIn: "claude auth login" };
const codex: AgentInfo = { id: "codex", name: "Codex", installed: true, signedIn: true, path: "/opt/homebrew/bin/codex", signIn: "codex login" };

describe("adapterSpec", () => {
  it("pins the version and points the Claude adapter at the user's claude", () => {
    expect(adapterSpec(claude, root)).toMatchObject({
      command: "npx", args: ["-y", `${ADAPTERS.claude.pkg}@${ADAPTERS.claude.version}`], cwd: root,
      env: { CLAUDE_CODE_EXECUTABLE: "/usr/local/bin/claude" },
    });
    expect(ADAPTERS.claude.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ADAPTERS.codex.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("gives Codex its detected binary and not the Claude variable", () => {
    const spec = adapterSpec(codex, root);
    expect(spec.args).toEqual(["-y", `${ADAPTERS.codex.pkg}@${ADAPTERS.codex.version}`]);
    expect(spec.env.CODEX_PATH).toBe("/opt/homebrew/bin/codex");
    expect(spec.env.CLAUDE_CODE_EXECUTABLE).toBeUndefined();
  });
  it("starts Codex in read-only, where its approvals come to Rushes, never in its self-reviewing modes (R15)", () => {
    const env = adapterSpec(codex, root).env;
    expect(env.INITIAL_AGENT_MODE).toBe("read-only");
    expect(ASK_MODE.codex).toBe("read-only");
    expect(["agent", "agent-full-access"]).not.toContain(env.INITIAL_AGENT_MODE);
    expect(adapterSpec(claude, root).env.INITIAL_AGENT_MODE).toBeUndefined();
  });
  it("gives both adapters the extended PATH, deduplicated", () => {
    for (const agent of [claude, codex]) {
      const parts = adapterSpec(agent, root).env.PATH.split(delimiter);
      for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin")]) expect(parts).toContain(dir);
      expect(new Set(parts).size).toBe(parts.length);
    }
  });
});

describe("§33: each menu row's agent mode", () => {
  it("maps Manual and Accept edits to the ask modes, Auto and Bypass to the agent's own", () => {
    expect(AGENT_MODE).toEqual({
      "ask-all": { claude: "default", codex: "read-only" },
      "project-edits": { claude: "default", codex: "read-only" },
      auto: { claude: "auto", codex: "agent" },
      bypass: { claude: "bypassPermissions", codex: "agent-full-access" },
    });
    expect(modeFor("claude", "auto")).toBe("auto");
  });
  it("starts Codex with the row's INITIAL_AGENT_MODE, read-only when no row is given", () => {
    expect(adapterSpec(codex, root).env.INITIAL_AGENT_MODE).toBe("read-only");
    expect(adapterSpec(codex, root, "ask-all").env.INITIAL_AGENT_MODE).toBe("read-only");
    expect(adapterSpec(codex, root, "auto").env.INITIAL_AGENT_MODE).toBe("agent");
    expect(adapterSpec(codex, root, "bypass").env.INITIAL_AGENT_MODE).toBe("agent-full-access");
    expect(adapterSpec(claude, root, "auto").env.INITIAL_AGENT_MODE).toBeUndefined();
  });
  it("asks Claude for the row's mode in configOptions", () => {
    const mode = (l?: Parameters<typeof sessionSetup>[1]) => (sessionSetup("claude", l).configOptions as { configId: string; value: string }[])[0];
    expect(mode()).toEqual({ configId: "mode", value: "default" });
    expect(mode("auto")).toEqual({ configId: "mode", value: "auto" });
    expect(mode("bypass")).toEqual({ configId: "mode", value: "bypassPermissions" });
    expect(sessionSetup("codex", "auto")).toEqual({});
  });
});

describe("rushesMcp", () => {
  it("runs this package's CLI with the project folder", () => {
    const spec = rushesMcp(root);
    expect(spec).toMatchObject({ name: "rushes", command: process.execPath, env: [] });
    // R17: pinned to the project, so its tools refuse any other folder.
    expect(spec.args.slice(1)).toEqual(["mcp", root, "--pinned"]);
    expect(spec.args[0].endsWith(join("dist", "cli", "index.js"))).toBe(true);
    // dist/cli/index.js sits under the package root, the folder holding package.json.
    expect(existsSync(join(dirname(dirname(dirname(spec.args[0]))), "package.json"))).toBe(true);
  });
});
