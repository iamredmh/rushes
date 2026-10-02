import { join } from "node:path";

/** What every harness runs to start the Rushes MCP server. Switches to "rushes" once it's on npm. */
export const SOURCE = "github:iamredmh/rushes";
export const MCP_COMMAND = "npx";
export const MCP_ARGS = ["-y", SOURCE, "mcp"];

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
export function mergeJson(existing: string | null): { text: string; changed: boolean } {
  const doc: Record<string, unknown> = existing && existing.trim() ? JSON.parse(existing) : {};
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error("config is not a JSON object");
  const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
  if (typeof servers !== "object" || Array.isArray(servers)) throw new Error('"mcpServers" is not an object');
  const want = { command: MCP_COMMAND, args: MCP_ARGS };
  if (JSON.stringify(servers.rushes) === JSON.stringify(want)) return { text: existing ?? "", changed: false };
  doc.mcpServers = { ...servers, rushes: want };
  return { text: JSON.stringify(doc, null, 2) + "\n", changed: true };
}

const TOML_BLOCK = `[mcp_servers.rushes]\ncommand = "${MCP_COMMAND}"\nargs = [${MCP_ARGS.map((a) => JSON.stringify(a)).join(", ")}]\n`;

/** Add or replace the [mcp_servers.rushes] table in a Codex config.toml, leaving everything else as written. */
export function mergeToml(existing: string | null): { text: string; changed: boolean } {
  const text = existing ?? "";
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === "[mcp_servers.rushes]");
  if (start === -1) {
    const sep = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return { text: text + sep + TOML_BLOCK, changed: true };
  }
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end === -1) end = lines.length;
  const current = lines.slice(start, end).join("\n").trim();
  if (current === TOML_BLOCK.trim()) return { text, changed: false };
  const next = [...lines.slice(0, start), ...TOML_BLOCK.trimEnd().split("\n"), "", ...lines.slice(end)].join("\n");
  return { text: next.replace(/\n{3,}/g, "\n\n"), changed: true };
}
