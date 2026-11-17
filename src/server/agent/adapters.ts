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

/*
 * R14/R15: the session mode in which the agent asks Rushes (session/request_permission) before it acts, instead of
 * approving its own actions. The runner sends session/set_mode with it after every session/new and session/load,
 * when the session offers it. Never acceptEdits, auto, bypassPermissions or dontAsk (Claude), nor agent or
 * agent-full-access (Codex): in those the agent, or its own reviewer, decides.
 *
 * Claude (claude-agent-acp 0.107.3, read 17 Nov 2026):
 *   - dist/session-mode.js:47-48: with no permissions.defaultMode in the user's settings a session starts in `auto`
 *     ("Claude handles permission decisions", :312) when the catalog offers it. That is F1.
 *   - `default` is "Manual: Always ask before making changes" (dist/session-mode.js:290-292). In it Claude Code calls
 *     the adapter's canUseTool for every action its own rules don't already allow, and canUseTool always ends in
 *     requestPermissionFromClient, i.e. session/request_permission (dist/v1/acp-agent.js:6608-6710; :6646 "Do not
 *     auto-allow here based on the session's advertised mode"). The user's own allow rules still win (F3).
 *   - No env var or launch flag sets the initial mode (the only env the adapter reads is listed in its README and
 *     dist; none is a mode). The setup requests take `configOptions` instead (the "Session options" RFD,
 *     dist/initial-config-options.js; advertised as sessionCapabilities.options, dist/v1/acp-agent.js:531-532):
 *     session/new and session/load apply them before they answer (dist/v1/acp-agent.js:601-611, 767-783, via
 *     selectSessionConfigOption :5753, config id "mode" = MODE_CONFIG_ID, dist/session-mode.js:5). So no prompt
 *     ever runs in `auto`; the set_mode after it is the second guard.
 */
export const ASK_MODE: Partial<Record<AgentId, string>> = {
  claude: "default",
};

/** Extra params for session/new and session/load: Claude's initial mode, so the session is never in `auto` (R14). */
export function sessionSetup(agent: AgentId): Record<string, unknown> {
  if (agent === "claude") return { configOptions: [{ configId: "mode", value: ASK_MODE.claude }] };
  return {};
}

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
