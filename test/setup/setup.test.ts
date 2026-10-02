import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { mergeJson, mergeToml, MCP_ARGS, SOURCE } from "../../src/setup/harnesses.js";
import { setup, type SetupEnv } from "../../src/setup/setup.js";

const homes: string[] = [];
afterEach(async () => { while (homes.length) await rm(homes.pop()!, { recursive: true, force: true }); });

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
