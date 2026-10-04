import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harnesses, mcpLaunch, mergeJson, mergeToml, type Harness, type HarnessId } from "./harnesses.js";

export interface SetupEnv {
  home: string;
  platform: NodeJS.Platform;
  appData?: string;
  /** Is this command on PATH? */
  which(cmd: string): Promise<boolean>;
  /**
   * Run a command in `cwd`; resolve with exit code and output. With `timeout` (ms), the command
   * gets no stdin and is killed once the time is up, resolving with `timedOut: true`.
   */
  exec(cmd: string, args: string[], cwd: string, opts?: { timeout?: number }): Promise<{ code: number; out: string; timedOut?: boolean }>;
  /** Path of the SKILL.md to install. Defaults to the one shipped in this package. */
  skillFile?: string;
}

export interface SetupOptions {
  only?: HarnessId[];
  dryRun?: boolean;
}

export interface SetupResult {
  harness: HarnessId;
  name: string;
  status: "added" | "already" | "not-found" | "failed" | "would-add";
  detail: string;
  skill?: "added" | "already" | "would-add";
}

const exists = (p: string) => access(p).then(() => true, () => false);

export function packagedSkill(): string {
  return fileURLToPath(new URL("../../skills/rushes/SKILL.md", import.meta.url));
}

async function installed(h: Harness, env: SetupEnv): Promise<boolean> {
  return (await exists(h.marker)) || (h.bin ? await env.which(h.bin) : false);
}

async function writeConfig(path: string, text: string, existed: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (existed) await copyFile(path, `${path}.rushes.bak`);
  await writeFile(path, text, "utf8");
}

async function installSkill(h: Harness, env: SetupEnv, dryRun: boolean): Promise<SetupResult["skill"]> {
  if (!h.skillDir) return undefined;
  const target = join(h.skillDir, "SKILL.md");
  const source = env.skillFile ?? packagedSkill();
  const want = await readFile(source, "utf8");
  const have = await readFile(target, "utf8").catch(() => null);
  if (have === want) return "already";
  if (dryRun) return "would-add";
  await mkdir(h.skillDir, { recursive: true });
  await writeFile(target, want, "utf8");
  return "added";
}

async function one(h: Harness, env: SetupEnv, dryRun: boolean): Promise<SetupResult> {
  const base = { harness: h.id, name: h.name };
  if (!(await installed(h, env))) return { ...base, status: "not-found", detail: "not installed" };
  const launch = mcpLaunch(env.platform);
  const command = [launch.command, ...launch.args];
  try {
    if (h.kind === "claude-cli") {
      if (!(await env.which("claude"))) return { ...base, status: "failed", detail: "the claude command isn't on PATH. Run: claude mcp add --scope user rushes -- " + command.join(" ") };
      // Run from home so a project's own .mcp.json can't make it look registered.
      const got = await env.exec("claude", ["mcp", "get", "rushes"], env.home);
      const skill = await installSkill(h, env, dryRun);
      if (got.code === 0) return { ...base, status: "already", detail: "rushes MCP server already registered", skill };
      if (dryRun) return { ...base, status: "would-add", detail: "claude mcp add --scope user rushes", skill };
      const add = await env.exec("claude", ["mcp", "add", "--scope", "user", "rushes", "--", ...command], env.home);
      if (add.code !== 0) return { ...base, status: "failed", detail: add.out.trim() || "claude mcp add failed", skill };
      return { ...base, status: "added", detail: "registered with claude mcp add --scope user", skill };
    }
    const path = h.config!;
    const existed = await exists(path);
    const before = existed ? await readFile(path, "utf8") : null;
    const merged = h.kind === "toml" ? mergeToml(before, launch) : mergeJson(before, launch);
    const skill = await installSkill(h, env, dryRun);
    if (!merged.changed) return { ...base, status: "already", detail: path, skill };
    if (dryRun) return { ...base, status: "would-add", detail: path, skill };
    await writeConfig(path, merged.text, existed);
    return { ...base, status: "added", detail: existed ? `${path} (backup: ${path}.rushes.bak)` : path, skill };
  } catch (e) {
    return { ...base, status: "failed", detail: `${h.config ?? h.name}: ${(e as Error).message}. Nothing was changed.` };
  }
}

/** Register the Rushes MCP server (and skill, where supported) with every installed harness. */
export async function setup(env: SetupEnv, opts: SetupOptions = {}): Promise<SetupResult[]> {
  const list = harnesses(env.home, env.platform, env.appData).filter((h) => !opts.only || opts.only.includes(h.id));
  const out: SetupResult[] = [];
  for (const h of list) out.push(await one(h, env, !!opts.dryRun));
  return out;
}
