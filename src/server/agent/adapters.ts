import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId } from "../../core/schema.js";
import type { AdapterSpec, McpServerSpec } from "./acp.js";
import { searchPath, type AgentInfo } from "./detect.js";

/*
 * Checked 17 Nov 2026 with `npm view <pkg> version`:
 *   @agentclientprotocol/claude-agent-acp 0.107.3   (used)
 *   @agentclientprotocol/codex-acp        2.7.0     (used)
 *   older names, not used: @zed-industries/claude-code-acp 0.16.2, @zed-industries/claude-agent-acp 0.23.1,
 *                          @zed-industries/codex-acp 0.16.0
 * The Claude adapter's README says to set CLAUDE_CODE_EXECUTABLE to use a Claude CLI you already have.
 * The Codex adapter's README names CODEX_PATH for the same purpose.
 * Pinned exactly; run through `npx -y <pkg>@<version>`.
 */
export const ADAPTERS: Record<AgentId, { pkg: string; version: string }> = {
  claude: { pkg: "@agentclientprotocol/claude-agent-acp", version: "0.107.3" },
  codex: { pkg: "@agentclientprotocol/codex-acp", version: "2.7.0" },
};

/** How to start the ACP adapter for an agent, in the project folder. */
export function adapterSpec(agent: AgentInfo, root: string): AdapterSpec {
  const { pkg, version } = ADAPTERS[agent.id];
  // The same PATH detection used, so npx and node are found even when the server has a thin PATH.
  const env: Record<string, string> = { PATH: searchPath() };
  if (agent.id === "claude" && agent.path) env.CLAUDE_CODE_EXECUTABLE = agent.path;
  if (agent.id === "codex" && agent.path) env.CODEX_PATH = agent.path;
  return { command: "npx", args: ["-y", `${pkg}@${version}`], env, cwd: root };
}

/** This package's built CLI. src/server/agent/ and dist/server/agent/ are both three folders below the package root. */
function cliPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "dist", "cli", "index.js");
}

/** dist/cli/index.js exists only after `npm run build`; callers under tsx pass RunnerOptions.mcp (Task 5). */
/** The Rushes MCP server, handed to the agent so it can call rushes_reply. */
export function rushesMcp(root: string): McpServerSpec {
  return { name: "rushes", command: process.execPath, args: [cliPath(), "mcp", root], env: [] };
}
