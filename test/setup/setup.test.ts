import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { harnesses, mcpLaunch, mergeJson, mergeToml, LEGACY_SOURCES, MCP_ARGS, SOURCE } from "../../src/setup/harnesses.js";
import { setup, type SetupEnv } from "../../src/setup/setup.js";

const homes: string[] = [];
afterEach(async () => { while (homes.length) await rm(homes.pop()!, { recursive: true, force: true }); });

/** A bare temp home, for tests that supply their own `exec`/`which` rather than fakeHome's. */
async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "rushes home "));
  homes.push(home);
  return home;
}

async function fakeHome() {
  const home = await mkdtemp(join(tmpdir(), "rushes home "));
  homes.push(home);
  const skillFile = join(home, "SKILL.src.md");
  await writeFile(skillFile, "---\nname: rushes\n---\nskill body\n");
  const calls: string[][] = [];
  let registered = false;
  const env: SetupEnv = {
    home,
    platform: "darwin",
    skillFile,
    which: async (cmd) => cmd === "claude",
    exec: async (cmd, args, cwd) => {
      expect(cwd).toBe(home);
      calls.push([cmd, ...args]);
      if (args[1] === "get") return { code: registered ? 0 : 1, out: "" };
      registered = true;
      return { code: 0, out: "Added" };
    },
  };
  return { home, env, calls };
}

describe("mergeJson", () => {
  it("adds rushes and keeps every other key", () => {
    const before = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } });
    const { text, changed } = mergeJson(before);
    expect(changed).toBe(true);
    const doc = JSON.parse(text);
    expect(doc.theme).toBe("dark");
    expect(doc.mcpServers.other).toEqual({ command: "x" });
    expect(doc.mcpServers.rushes).toEqual({ command: "npx", args: ["-y", SOURCE, "mcp"] });
  });
  it("is a no-op when rushes is already there", () => {
    const once = mergeJson(null).text;
    expect(mergeJson(once)).toEqual({ text: once, changed: false });
  });
  it("refuses a config that isn't a JSON object", () => {
    expect(() => mergeJson("[1,2]")).toThrow(/not a JSON object/);
    expect(() => mergeJson("{ broken")).toThrow();
  });
});

describe("Windows launch", () => {
  it("launches through cmd /c on win32 and npx directly elsewhere", () => {
    expect(mcpLaunch("win32")).toEqual({ command: "cmd", args: ["/c", "npx", "-y", SOURCE, "mcp"] });
    expect(mcpLaunch("darwin")).toEqual({ command: "npx", args: ["-y", SOURCE, "mcp"] });
    expect(mcpLaunch("linux")).toEqual({ command: "npx", args: MCP_ARGS });
  });
  it("the win32 JSON merge writes cmd /c npx", () => {
    const doc = JSON.parse(mergeJson(null, mcpLaunch("win32")).text);
    expect(doc.mcpServers.rushes).toEqual({ command: "cmd", args: ["/c", "npx", "-y", SOURCE, "mcp"] });
  });
  it("the win32 TOML merge writes cmd /c npx", () => {
    expect(mergeToml(null, mcpLaunch("win32")).text).toContain(`command = "cmd"\nargs = ["/c", "npx", "-y", "${SOURCE}", "mcp"]`);
  });
  it("setup on win32 registers Claude Code with cmd /c npx and writes cmd into JSON configs", async () => {
    const { env, home, calls } = await fakeHome();
    env.platform = "win32";
    await mkdir(join(home, ".cursor"));
    const r = await setup(env, { only: ["claude-code", "cursor"] });
    expect(r.map((x) => x.status)).toEqual(["added", "added"]);
    expect(calls).toContainEqual(["claude", "mcp", "add", "--scope", "user", "rushes", "--", "cmd", "/c", "npx", "-y", SOURCE, "mcp"]);
    const cursor = JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8"));
    expect(cursor.mcpServers.rushes.command).toBe("cmd");
  });
});

describe("mergeToml", () => {
  it("appends the table, keeping what's there", () => {
    const { text } = mergeToml('model = "o4"\n\n[mcp_servers.other]\ncommand = "x"\n');
    expect(text).toContain('model = "o4"');
    expect(text).toContain("[mcp_servers.other]");
    expect(text).toContain(`[mcp_servers.rushes]\ncommand = "npx"\nargs = ["-y", "${SOURCE}", "mcp"]`);
  });
  it("replaces an outdated rushes table and is idempotent", () => {
    const old = '[mcp_servers.rushes]\ncommand = "node"\nargs = ["old.js"]\n\n[profiles.x]\nmodel = "y"\n';
    const once = mergeToml(old);
    expect(once.changed).toBe(true);
    expect(once.text).not.toContain("old.js");
    expect(once.text).toContain("[profiles.x]");
    expect(mergeToml(once.text).changed).toBe(false);
  });
  it("keeps Windows line endings", () => {
    const { text } = mergeToml('model = "o4"\r\n\r\n[profiles.x]\r\nmodel = "y"\r\n');
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(text).toContain("[mcp_servers.rushes]\r\n");
    expect(mergeToml(text).changed).toBe(false);
  });
  it("recognises a rushes header with a trailing comment instead of adding a second table", () => {
    const { text } = mergeToml('[mcp_servers.rushes] # mine\ncommand = "node"\nargs = ["x"]\n');
    expect(text.match(/\[mcp_servers\.rushes\]/g)).toHaveLength(1);
    expect(text).toContain(`args = ["-y", "${SOURCE}", "mcp"]`);
  });
});

describe("harness paths", () => {
  it("puts Claude Desktop's config in the right folder on each platform", () => {
    const desk = (p: NodeJS.Platform, appData?: string) => harnesses("/home/u", p, appData).find((h) => h.id === "claude-desktop")!.config;
    expect(desk("darwin")).toBe(join("/home/u", "Library", "Application Support", "Claude", "claude_desktop_config.json"));
    expect(desk("win32", "/c/Users/u/AppData/Roaming")).toBe(join("/c/Users/u/AppData/Roaming", "Claude", "claude_desktop_config.json"));
    expect(desk("linux")).toBe(join("/home/u", ".config", "Claude", "claude_desktop_config.json"));
  });
});

describe("setup", () => {
  it("only touches harnesses that are installed", async () => {
    const { env, home } = await fakeHome();
    await mkdir(join(home, ".cursor"));
    const r = await setup(env);
    const by = Object.fromEntries(r.map((x) => [x.harness, x.status]));
    expect(by).toMatchObject({ "claude-code": "added", cursor: "added", codex: "not-found", "claude-desktop": "not-found", gemini: "not-found" });
    const cursor = JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8"));
    expect(cursor.mcpServers.rushes.args).toEqual(MCP_ARGS);
  });

  it("registers with Claude Code through its CLI, installs the skill, and is idempotent", async () => {
    const { env, home, calls } = await fakeHome();
    const first = (await setup(env, { only: ["claude-code"] }))[0];
    expect(first).toMatchObject({ status: "added", skill: "added" });
    expect(calls).toContainEqual(["claude", "mcp", "add", "--scope", "user", "rushes", "--", "npx", ...MCP_ARGS]);
    expect(await readFile(join(home, ".claude", "skills", "rushes", "SKILL.md"), "utf8")).toContain("skill body");
    const second = (await setup(env, { only: ["claude-code"] }))[0];
    expect(second).toMatchObject({ status: "already", skill: "already" });
  });

  it("running it twice changes nothing the second time", async () => {
    const { env, home } = await fakeHome();
    await mkdir(join(home, ".cursor"));
    await writeFile(join(home, ".cursor", "mcp.json"), '{ "mcpServers": { "other": { "command": "x" } } }');
    expect((await setup(env, { only: ["cursor"] }))[0].status).toBe("added");
    const after = await readFile(join(home, ".cursor", "mcp.json"), "utf8");
    await rm(join(home, ".cursor", "mcp.json.rushes.bak"));
    expect((await setup(env, { only: ["cursor"] }))[0].status).toBe("already");
    expect(await readFile(join(home, ".cursor", "mcp.json"), "utf8")).toBe(after);
    await expect(readFile(join(home, ".cursor", "mcp.json.rushes.bak"), "utf8")).rejects.toThrow();
  });

  it("backs up an existing config before changing it", async () => {
    const { env, home } = await fakeHome();
    const dir = join(home, ".gemini");
    await mkdir(dir);
    await writeFile(join(dir, "settings.json"), '{ "theme": "GitHub" }');
    const r = (await setup(env, { only: ["gemini"] }))[0];
    expect(r.status).toBe("added");
    expect(await readFile(join(dir, "settings.json.rushes.bak"), "utf8")).toBe('{ "theme": "GitHub" }');
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).theme).toBe("GitHub");
  });

  it("leaves a broken config alone and says so", async () => {
    const { env, home } = await fakeHome();
    await mkdir(join(home, ".cursor"));
    await writeFile(join(home, ".cursor", "mcp.json"), "{ nope");
    const r = (await setup(env, { only: ["cursor"] }))[0];
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("Nothing was changed");
    expect(await readFile(join(home, ".cursor", "mcp.json"), "utf8")).toBe("{ nope");
  });

  it("dry run changes nothing", async () => {
    const { env, home, calls } = await fakeHome();
    await mkdir(join(home, ".codex"));
    const r = await setup(env, { dryRun: true, only: ["codex", "claude-code"] });
    expect(r.map((x) => x.status)).toEqual(["would-add", "would-add"]);
    expect(calls.filter((c) => c[2] === "add")).toEqual([]);
    await expect(readFile(join(home, ".codex", "config.toml"), "utf8")).rejects.toThrow();
  });

  it("finds Claude Desktop in the right folder per platform", async () => {
    const { env, home } = await fakeHome();
    const mac = join(home, "Library", "Application Support", "Claude");
    await mkdir(mac, { recursive: true });
    const r = (await setup(env, { only: ["claude-desktop"] }))[0];
    expect(r.status).toBe("added");
    expect(JSON.parse(await readFile(join(mac, "claude_desktop_config.json"), "utf8")).mcpServers.rushes.command).toBe("npx");
  });
});

describe("migrating a legacy (pre-npm) registration, §19.7", () => {
  it("switches a legacy JSON registration (Cursor) to the npm source, keeping a single rushes key", async () => {
    const { env, home } = await fakeHome();
    const configPath = join(home, ".cursor", "mcp.json");
    await mkdir(join(home, ".cursor"));
    await writeFile(configPath, JSON.stringify({ theme: "dark", mcpServers: { rushes: { command: "npx", args: ["-y", LEGACY_SOURCES[0], "mcp"] } } }));
    const r = (await setup(env, { only: ["cursor"] }))[0];
    expect(r.status).toBe("added");
    const doc = JSON.parse(await readFile(configPath, "utf8"));
    expect(doc.theme).toBe("dark");
    expect(Object.keys(doc.mcpServers)).toEqual(["rushes"]);
    expect(doc.mcpServers.rushes).toEqual({ command: "npx", args: ["-y", SOURCE, "mcp"] });
    // Running it again is a no-op: the migration doesn't flap.
    expect((await setup(env, { only: ["cursor"] }))[0].status).toBe("already");
  });

  it("switches a legacy TOML registration (Codex) to the npm source, keeping a single table", async () => {
    const { env, home } = await fakeHome();
    const configPath = join(home, ".codex", "config.toml");
    await mkdir(join(home, ".codex"));
    await writeFile(configPath, `model = "o4"\n\n[mcp_servers.rushes]\ncommand = "npx"\nargs = ["-y", "${LEGACY_SOURCES[0]}", "mcp"]\n`);
    const r = (await setup(env, { only: ["codex"] }))[0];
    expect(r.status).toBe("added");
    const text = await readFile(configPath, "utf8");
    expect(text.match(/\[mcp_servers\.rushes\]/g)).toHaveLength(1);
    expect(text).toContain(`args = ["-y", "${SOURCE}", "mcp"]`);
    expect(text).not.toContain(LEGACY_SOURCES[0]);
    expect((await setup(env, { only: ["codex"] }))[0].status).toBe("already");
  });

  it("switches a legacy Claude Code registration to the npm source instead of leaving it, and doesn't add a duplicate", async () => {
    const home = await freshHome();
    const calls: string[][] = [];
    let out = `rushes: npx -y ${LEGACY_SOURCES[0]} mcp  (stdio)\n`;
    const env: SetupEnv = {
      home,
      platform: "darwin",
      which: async (cmd) => cmd === "claude",
      exec: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args[0] === "mcp" && args[1] === "get") return { code: 0, out };
        if (args[0] === "mcp" && args[1] === "remove") {
          out = ""; // the name is gone until the next `add`
          return { code: 0, out: "Removed" };
        }
        if (args[0] === "mcp" && args[1] === "add") {
          out = `rushes: npx -y ${SOURCE} mcp  (stdio)\n`;
          return { code: 0, out: "Added" };
        }
        return { code: 1, out: "" };
      },
    };
    const r = (await setup(env, { only: ["claude-code"] }))[0];
    expect(r.status).toBe("added");
    expect(r.detail).toContain("npm");
    // Exactly one remove and one add -- never two adds, which would risk a duplicate.
    expect(calls.filter((c) => c[2] === "remove")).toHaveLength(1);
    expect(calls.filter((c) => c[2] === "add")).toHaveLength(1);
    expect(calls).toContainEqual(["claude", "mcp", "remove", "--scope", "user", "rushes"]);
    expect(calls).toContainEqual(["claude", "mcp", "add", "--scope", "user", "rushes", "--", "npx", ...MCP_ARGS]);
    // Running it again now reports already registered, on the npm source -- no further remove/add.
    const second = (await setup(env, { only: ["claude-code"] }))[0];
    expect(second.status).toBe("already");
    expect(calls.filter((c) => c[2] === "remove")).toHaveLength(1);
  });

  it("a dry run on a legacy Claude Code registration reports what it would do, without calling remove or add", async () => {
    const home = await freshHome();
    const calls: string[][] = [];
    const env: SetupEnv = {
      home,
      platform: "darwin",
      which: async (cmd) => cmd === "claude",
      exec: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args[0] === "mcp" && args[1] === "get") return { code: 0, out: `rushes: npx -y ${LEGACY_SOURCES[0]} mcp  (stdio)\n` };
        return { code: 1, out: "" };
      },
    };
    const r = (await setup(env, { only: ["claude-code"], dryRun: true }))[0];
    expect(r.status).toBe("would-add");
    expect(calls.some((c) => c[2] === "remove" || c[2] === "add")).toBe(false);
  });
});

describe("a registration the user wrote or adjusted themselves", () => {
  // GUI apps don't see the shell's PATH, so a working Claude Desktop entry often names npx by its
  // full path and sets PATH. Re-running setup must not undo that, and doctor must still call it
  // registered (it asks the same mergers whether anything would change).
  const adjusted = { command: "/opt/node/bin/npx", args: ["-y", SOURCE, "mcp"], env: { PATH: "/opt/node/bin:/usr/bin" } };

  describe("mergeJson", () => {
    it("leaves an entry that already launches the current package, whatever npx path, env or pinned version it adds", () => {
      for (const rushes of [adjusted, { command: "npx", args: ["-y", `${SOURCE}@0.4.0`, "mcp"] }]) {
        const before = JSON.stringify({ mcpServers: { rushes } }, null, 4);
        expect(mergeJson(before)).toEqual({ text: before, changed: false });
      }
    });
    it("still replaces an entry that doesn't launch it", () => {
      for (const rushes of [{ command: "node", args: ["old.js"] }, { command: "rushes-mcp" }, { command: "npx", args: ["-y", SOURCE] }]) {
        const { text, changed } = mergeJson(JSON.stringify({ mcpServers: { rushes } }));
        expect(changed).toBe(true);
        expect(JSON.parse(text).mcpServers.rushes).toEqual({ command: "npx", args: ["-y", SOURCE, "mcp"] });
      }
    });
  });

  describe("mergeToml", () => {
    it("leaves a table that already launches the current package, with its env table and a multi-line args list", () => {
      const before = `[mcp_servers.rushes]\ncommand = "/opt/node/bin/npx"\nargs = [\n  "-y",\n  "${SOURCE}@0.4.0",\n  "mcp",\n]\n\n[mcp_servers.rushes.env]\nPATH = "/opt/node/bin:/usr/bin"\n`;
      expect(mergeToml(before)).toEqual({ text: before, changed: false });
    });
    it.each([
      ["an inline entry under [mcp_servers]", `[mcp_servers]\nrushes = { command = "npx", args = ["-y", "${SOURCE}", "mcp"] }\n`],
      ["a quoted table name", `[mcp_servers."rushes"]\ncommand = "npx"\nargs = ["-y", "${SOURCE}", "mcp"]\n`],
      ["a dotted key at the top", `mcp_servers.rushes.command = "npx"\nmcp_servers.rushes.args = ["-y", "${SOURCE}", "mcp"]\n`],
    ])("refuses %s rather than add a second definition, which would make the file invalid", (_name, before) => {
      expect(() => mergeToml(before)).toThrow(/by hand/);
    });
    it("doesn't mistake a neighbouring key, or a rushes key in another table, for its own", () => {
      for (const before of [`[mcp_servers]\nrushes_other = 1\nmyrushes = 2\n`, `[other]\nrushes = 1\n`]) {
        const { text, changed } = mergeToml(before);
        expect(changed).toBe(true);
        expect(text).toContain("[mcp_servers.rushes]");
      }
    });
  });

  describe("setup", () => {
    it("reports an adjusted Cursor entry as already registered, and leaves the file byte for byte", async () => {
      const { env, home } = await fakeHome();
      const path = join(home, ".cursor", "mcp.json");
      await mkdir(join(home, ".cursor"));
      const before = JSON.stringify({ mcpServers: { rushes: adjusted } }, null, 4);
      await writeFile(path, before);
      expect((await setup(env, { only: ["cursor"] }))[0].status).toBe("already");
      expect(await readFile(path, "utf8")).toBe(before);
      await expect(readFile(`${path}.rushes.bak`, "utf8")).rejects.toThrow();
    });
    it("fails, changing nothing, on a Codex entry written in a form it can't edit", async () => {
      const { env, home } = await fakeHome();
      const path = join(home, ".codex", "config.toml");
      await mkdir(join(home, ".codex"));
      const before = `model = "o4"\n\n[mcp_servers]\nrushes = { command = "npx", args = ["-y", "${SOURCE}", "mcp"] }\n`;
      await writeFile(path, before);
      const r = (await setup(env, { only: ["codex"] }))[0];
      expect(r.status).toBe("failed");
      expect(r.detail).toContain("by hand");
      expect(r.detail).toContain("Nothing was changed");
      expect(await readFile(path, "utf8")).toBe(before);
      await expect(readFile(`${path}.rushes.bak`, "utf8")).rejects.toThrow();
    });
  });
});
