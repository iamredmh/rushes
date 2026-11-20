import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tmpProject } from "../../helpers/tmp.js";
import { AgentRulesFile, agentRulesFor, legacyConfigDir, rulesKey, rulesPath, userConfigDir } from "../../../src/server/agent/rules.js";

describe("the agent's rules file (R10)", () => {
  it("lives in the user config folder, named from the project's real path", async () => {
    const { root, store } = await tmpProject();
    const config = await realpath(await mkdtemp(join(tmpdir(), "rushes-config-")));
    expect(userConfigDir({ XDG_CONFIG_HOME: config })).toBe(config);
    expect(userConfigDir({ XDG_CONFIG_HOME: "relative/dir" }, "darwin")).toMatch(/\.config$/);
    expect(userConfigDir({}, "linux")).toMatch(/\.config$/);
    // §34: Windows keeps them in %APPDATA%, and still reads the old %USERPROFILE%\.config place.
    expect(userConfigDir({ APPDATA: "C:\\Users\\R\\AppData\\Roaming" }, "win32")).toBe("C:\\Users\\R\\AppData\\Roaming");
    expect(legacyConfigDir({}, "win32", "C:\\Users\\R")).toBe(join("C:\\Users\\R", ".config"));
    expect(legacyConfigDir({}, "darwin")).toBeNull();
    expect(legacyConfigDir({ XDG_CONFIG_HOME: config }, "win32")).toBeNull();
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
    if (process.platform !== "win32") expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    if (process.platform !== "win32") expect((await stat(join(config, "rushes", "agent-rules"))).mode & 0o777).toBe(0o700);
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

describe("§33: the four rows in the rules and the Mac-wide default", () => {
  it("reads the ids kept from before §33 and the two new ones; refuses any other", async () => {
    const { AgentRulesReadSchema, AgentDefaultsSchema } = await import("../../../src/core/schema.js");
    for (const permissions of ["ask-all", "project-edits", "auto", "bypass"]) {
      expect(AgentRulesReadSchema.parse({ permissions }).permissions).toBe(permissions);
      expect(AgentDefaultsSchema.parse({ permissions }).permissions).toBe(permissions);
    }
    expect(AgentRulesReadSchema.parse({}).permissions).toBe("project-edits");
    expect(AgentRulesReadSchema.safeParse({ permissions: "yolo" }).success).toBe(false);
  });

  it("an old rules file still reads as it was written", async () => {
    const { root } = await tmpProject();
    const config = await mkdtemp(join(tmpdir(), "rushes-config-"));
    const f = new AgentRulesFile(root, config);
    await mkdir(dirname(f.path), { recursive: true });
    await writeFile(f.path, JSON.stringify({ permissions: "ask-all", always: [{ kind: "execute", command: "npm run" }], setUp: true, agent: "claude" }));
    expect(await f.read()).toEqual({ permissions: "ask-all", always: [{ kind: "execute", command: "npm run" }], setUp: true, agent: "claude" });
  });

  it("Auto is adopted from the default by a new project; Bypass never is (it starts in Accept edits)", async () => {
    const config = await mkdtemp(join(tmpdir(), "rushes-config-"));
    const a = new AgentRulesFile((await tmpProject()).root, config);
    expect(await a.adopt({ agent: "claude", permissions: "auto" })).toEqual({ setUp: true, agent: "claude", permissions: "auto", always: [] });
    const b = new AgentRulesFile((await tmpProject()).root, config);
    expect(await b.adopt({ agent: "codex", permissions: "bypass" })).toEqual({ setUp: true, agent: "codex", permissions: "project-edits", always: [] });
    expect(JSON.parse(await readFile(b.path, "utf8")).permissions).toBe("project-edits");
  });

  it("a brand-new Mac with no rules file starts in Accept edits", async () => {
    const config = await mkdtemp(join(tmpdir(), "rushes-config-"));
    expect((await new AgentRulesFile((await tmpProject()).root, config).read()).permissions).toBe("project-edits");
  });
});

describe("§34: the old Windows place is still read", () => {
  it("reads the legacy file when the new one isn't there, and writes the new one", async () => {
    const { root } = await tmpProject();
    const base = await realpath(await mkdtemp(join(tmpdir(), "rushes-legacy-")));
    const legacy = join(base, "old"), now = join(base, "new");
    const old = new AgentRulesFile(root, legacy);
    await old.update((f) => void (f.permissions = "ask-all"));
    const f = new AgentRulesFile(root, now) as AgentRulesFile & { legacyPath: string | null };
    (f as { legacyPath: string | null }).legacyPath = old.path;
    expect((await f.read()).permissions).toBe("ask-all");
    await f.update((d) => void (d.permissions = "auto"));
    expect((await new AgentRulesFile(root, now).read()).permissions).toBe("auto");
    expect((await old.read()).permissions).toBe("ask-all");
  });
});
