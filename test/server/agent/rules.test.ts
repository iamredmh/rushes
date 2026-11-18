import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tmpProject } from "../../helpers/tmp.js";
import { AgentRulesFile, agentRulesFor, rulesKey, rulesPath, userConfigDir } from "../../../src/server/agent/rules.js";

describe("the agent's rules file (R10)", () => {
  it("lives in the user config folder, named from the project's real path", async () => {
    const { root, store } = await tmpProject();
    const config = await realpath(await mkdtemp(join(tmpdir(), "rushes-config-")));
    expect(userConfigDir({ XDG_CONFIG_HOME: config })).toBe(config);
    expect(userConfigDir({ XDG_CONFIG_HOME: "relative/dir" })).toMatch(/\.config$/);
    expect(userConfigDir({})).toMatch(/\.config$/);
    const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
    expect(rulesKey(root)).toBe(key);
    expect(rulesPath(root, config)).toBe(join(config, "rushes", "agent-rules", `${key}.json`));
    // A symlink to the project names the same file.
    const link = join(config, "link");
    await symlink(root, link);
    expect(rulesKey(link)).toBe(key);
    // Tests run with XDG_CONFIG_HOME set to a temp folder, never ~/.config.
    expect(agentRulesFor(store).path).toBe(rulesPath(root, process.env.XDG_CONFIG_HOME));
    expect(agentRulesFor(store)).toBe(agentRulesFor(store));
  });

  it("a case-variant path to the same project names the same file (skipped on a case-sensitive volume)", async () => {
    const { root } = await tmpProject();
    const variant = join(dirname(root), "mY pROJECT");
    if (!existsSync(variant)) return; // case-sensitive volume: a different folder
    expect(rulesKey(variant)).toBe(rulesKey(root));
    expect(rulesKey(root.toUpperCase())).toBe(rulesKey(root));
  });

  it("reads the defaults with no file, and writes the file 0600 in a 0700 folder", async () => {
    const { root } = await tmpProject();
    const config = await realpath(await mkdtemp(join(tmpdir(), "rushes-config-")));
    const f = new AgentRulesFile(root, config);
    expect(await f.read()).toEqual({ permissions: "project-edits", always: [], setUp: false, agent: null });
    await f.update((r) => {
      r.permissions = "ask-all";
      r.always.push({ kind: "execute", command: "npm run" });
    });
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ permissions: "ask-all", always: [{ kind: "execute", command: "npm run" }], setUp: false, agent: null });
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(config, "rushes", "agent-rules"))).mode & 0o777).toBe(0o700);
    expect(await f.read()).toEqual({ permissions: "ask-all", always: [{ kind: "execute", command: "npm run" }], setUp: false, agent: null });
  });

  it("keeps the newest 50 of a longer list instead of failing (M8)", async () => {
    const { root } = await tmpProject();
    const config = await realpath(await mkdtemp(join(tmpdir(), "rushes-config-")));
    const f = new AgentRulesFile(root, config);
    await mkdir(join(config, "rushes", "agent-rules"), { recursive: true });
    const always = Array.from({ length: 60 }, (_, i) => ({ kind: "execute", command: `tool${i}` }));
    await writeFile(f.path, JSON.stringify({ permissions: "project-edits", always }));
    const read = await f.read();
    expect(read.always).toHaveLength(50);
    expect(read.always[0]).toEqual({ kind: "execute", command: "tool10" });
    expect(read.always.at(-1)).toEqual({ kind: "execute", command: "tool59" });
    await f.update(() => undefined);
    expect(JSON.parse(await readFile(f.path, "utf8")).always).toHaveLength(50);
  });

  it("a damaged file reads as ask-all with no rules", async () => {
    const { root } = await tmpProject();
    const config = await realpath(await mkdtemp(join(tmpdir(), "rushes-config-")));
    const f = new AgentRulesFile(root, config);
    await mkdir(join(config, "rushes", "agent-rules"), { recursive: true });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const bad of ["{", JSON.stringify({ permissions: "everything", always: [] })]) {
      await writeFile(f.path, bad);
      expect(await f.read()).toEqual({ permissions: "ask-all", always: [], setUp: false, agent: null });
    }
    quiet.mockRestore();
  });
});
