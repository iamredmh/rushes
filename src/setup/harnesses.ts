import { join } from "node:path";

/** What every harness runs to start the Rushes MCP server, now that Rushes is on npm (§19.7). */
export const SOURCE = "rushes";
/**
 * Older `npx` sources that already-registered harnesses may still be using, from before the
 * npm publish. `setup` and `doctor` recognise these as Rushes too, and `setup` migrates a
 * registration that uses one of them to `SOURCE` in place, rather than adding a duplicate.
 */
export const LEGACY_SOURCES = ["github:iamredmh/rushes"];
/** The detail `doctor` reports for a harness still registered through a legacy source. */
export const LEGACY_DETAIL = "registered with the older GitHub launch. Run rushes setup to switch to npm.";
/** The launch everywhere except Windows. */
export const MCP_COMMAND = "npx";
export const MCP_ARGS = ["-y", SOURCE, "mcp"];

export interface McpLaunch {
  command: string;
  args: string[];
}

/**
 * How a harness should start the Rushes MCP server on this platform, from a given `npx` source.
 * On Windows npx is a .cmd script, which harnesses can't spawn directly, so it goes through cmd /c.
 */
function launchFor(platform: NodeJS.Platform, source: string): McpLaunch {
  const args = ["-y", source, "mcp"];
  return platform === "win32" ? { command: "cmd", args: ["/c", MCP_COMMAND, ...args] } : { command: MCP_COMMAND, args };
}

/** How a harness should start the Rushes MCP server on this platform, from the current `SOURCE`. */
export function mcpLaunch(platform: NodeJS.Platform): McpLaunch {
  return launchFor(platform, SOURCE);
}

/** The same launch shapes, one per `LEGACY_SOURCES` entry, for recognising an existing registration. */
export function legacyMcpLaunches(platform: NodeJS.Platform): McpLaunch[] {
  return LEGACY_SOURCES.map((source) => launchFor(platform, source));
}

/** Does this text (e.g. `claude mcp get rushes` output) name a legacy `npx` source? */
export function mentionsLegacySource(text: string): boolean {
  return LEGACY_SOURCES.some((source) => text.includes(source));
}

const DEFAULT_LAUNCH: McpLaunch = { command: MCP_COMMAND, args: MCP_ARGS };

export type HarnessId = "claude-code" | "codex" | "cursor" | "claude-desktop" | "gemini";

export interface Harness {
  id: HarnessId;
  name: string;
  /** How Rushes gets registered. */
  kind: "claude-cli" | "json" | "toml";
  /** Config file (json/toml kinds). */
  config?: string;
  /** Folder whose presence means the harness is installed. */
  marker: string;
  /** CLI on PATH that also means the harness is installed. */
  bin?: string;
  /** Where to copy the Rushes skill, if the harness reads skills. */
  skillDir?: string;
}

export function harnesses(home: string, platform: NodeJS.Platform, appData = join(home, "AppData", "Roaming")): Harness[] {
  const desktopDir =
    platform === "darwin"
      ? join(home, "Library", "Application Support", "Claude")
      : platform === "win32"
        ? join(appData, "Claude")
        : join(home, ".config", "Claude");
  return [
    { id: "claude-code", name: "Claude Code", kind: "claude-cli", marker: join(home, ".claude"), bin: "claude", skillDir: join(home, ".claude", "skills", "rushes") },
    { id: "codex", name: "Codex", kind: "toml", config: join(home, ".codex", "config.toml"), marker: join(home, ".codex"), bin: "codex", skillDir: join(home, ".codex", "skills", "rushes") },
    { id: "cursor", name: "Cursor", kind: "json", config: join(home, ".cursor", "mcp.json"), marker: join(home, ".cursor") },
    { id: "claude-desktop", name: "Claude Desktop", kind: "json", config: join(desktopDir, "claude_desktop_config.json"), marker: desktopDir },
    { id: "gemini", name: "Gemini CLI", kind: "json", config: join(home, ".gemini", "settings.json"), marker: join(home, ".gemini"), bin: "gemini" },
  ];
}

/**
 * Add Rushes to a JSON config's "mcpServers" without touching anything else.
 * Throws if the existing file isn't a JSON object, so we never clobber it.
 */
export function mergeJson(existing: string | null, launch: McpLaunch = DEFAULT_LAUNCH): { text: string; changed: boolean } {
  const doc: Record<string, unknown> = existing && existing.trim() ? JSON.parse(existing) : {};
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error("config is not a JSON object");
  const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
  if (typeof servers !== "object" || Array.isArray(servers)) throw new Error('"mcpServers" is not an object');
  const want = { command: launch.command, args: launch.args };
  if (JSON.stringify(servers.rushes) === JSON.stringify(want)) return { text: existing ?? "", changed: false };
  doc.mcpServers = { ...servers, rushes: want };
  return { text: JSON.stringify(doc, null, 2) + "\n", changed: true };
}

const tomlBlock = (launch: McpLaunch) =>
  `[mcp_servers.rushes]\ncommand = ${JSON.stringify(launch.command)}\nargs = [${launch.args.map((a) => JSON.stringify(a)).join(", ")}]\n`;

const TOML_HEADER = /^\s*\[mcp_servers\.rushes\]\s*(#.*)?$/;

/**
 * Add or replace the [mcp_servers.rushes] table in a Codex config.toml, leaving
 * everything else as written and keeping the file's line endings. This is line
 * surgery, not a TOML parser: it never makes a valid file invalid, and a file
 * that was already broken gets a backup (see setup.ts) and an appended table.
 */
export function mergeToml(existing: string | null, launch: McpLaunch = DEFAULT_LAUNCH): { text: string; changed: boolean } {
  const text = existing ?? "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = tomlBlock(launch).trimEnd().split("\n");
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => TOML_HEADER.test(l));
  if (start === -1) {
    const body = text.replace(/(\r?\n)+$/, "");
    return { text: (body ? body + eol + eol : "") + block.join(eol) + eol, changed: true };
  }
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end === -1) end = lines.length;
  const current = lines.slice(start + 1, end).map((l) => l.trim()).filter(Boolean);
  if (current.join("\n") === block.slice(1).join("\n")) return { text, changed: false };
  const next = [...lines.slice(0, start), ...block, "", ...lines.slice(end)].join(eol);
  return { text: next.replace(/(\r?\n){3,}/g, eol + eol), changed: true };
}
