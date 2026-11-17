import type { AgentId } from "../../core/schema.js";
import type { AcpPermissionParams } from "./acp.js";
import { isProjectRoot } from "../../core/projectFolder.js";

/*
 * R16: an ask for one of Rushes's own MCP tools (the server the runner passes in session/new and session/load,
 * named "rushes"; see rushesMcp) is allowed with no ask, under every permission level. Those tools only read and
 * write the project's Rushes data through Rushes's own API. Everything else, other servers and lookalike names
 * included, goes on to decide() as before. Matched on structured fields only, never on a title or other free text.
 *
 * Claude (claude-agent-acp 0.107.3, dist/permissions/presentation.js:112-124, set at dist/v1/acp-agent.js:6679-6686):
 *   toolCall._meta.claudeCode.toolName  "mcp__rushes__rushes_reply"
 *   toolCall._meta.claudeCode.mcpServer { name: "rushes", source: "dynamic" }   (the SDK's canUseTool mcpServer)
 *   All three must hold: source is exactly "dynamic", name is exactly "rushes", and toolName is exactly
 *   "mcp__rushes__" + a rushes_ tool. On a Claude CLI too old to report mcpServer, the ask goes to the user.
 *   Why "dynamic": the SDK says to key trust on `source`, not the name (claude-agent-sdk sdk.d.ts:258-268). The
 *   server Rushes passes in session/new is an ACP stdio server; the adapter makes it a stdio config
 *   (claude-agent-acp dist/mcp-servers.js:19-25); the SDK (0.3.325, sdk.mjs:166) hands every non-sdk server to the
 *   CLI as `--mcp-config`; and the CLI's can_use_tool schema says `source` is "dynamic for --mcp-config /
 *   mcp_set_servers process servers" (the bundled CLI, claude-agent-sdk-darwin-arm64 0.3.325, `mcp_server`
 *   description; its --mcp-config parser passes scope:"dynamic"). A server named "rushes" from the user's,
 *   project's or local config reads "user", "project" or "local", and asks. Read from the source only: the next
 *   real run confirms the value.
 *
 * Codex (codex-acp 2.7.0, dist/index.js): the approval itself carries no server or tool name. When the MCP call
 * starts, Codex sends a tool_call update whose rawInput is { server, tool, arguments } (McpToolReporter.started
 * :35824-35835, mcpInput :35851). The approval then comes as session/request_permission with the request's
 * _meta.is_mcp_tool_approval === true and toolCall { toolCallId: <that call's id>, kind: "execute" }
 * (buildMcpPermissionRequest :40486-40505, :40494; ElicitationReporter.permission :40386-40393, the correlated id from
 * popPendingMcpApproval :40304, keyed by the same server). So the runner remembers each tool_call's rawInput
 * server and tool by id (noteMcpCall), and the approval matches when its id names a rushes_ tool of server
 * "rushes". Codex's standalone form (two calls to one server pending at once) names the tool only in free
 * text, so it asks.
 */

/** The name of the MCP server Rushes hands the agent. */
export const RUSHES_SERVER = "rushes";

/** One of Rushes's tool names: rushes_ then lower-case letters, digits and single underscores. Anchored. */
const OWN_TOOL = /^rushes_[a-z0-9]+(?:_[a-z0-9]+)*$/;
const CLAUDE_PREFIX = `mcp__${RUSHES_SERVER}__`;
/** The `source` Claude Code gives a server passed in session/new (see above). */
const CLAUDE_SOURCE = "dynamic";

/** Codex MCP tool calls seen in tool_call updates, by toolCallId. */
export type McpCalls = Map<string, { server: string; tool: string; args: unknown }>;
const KEPT = 200;

const record = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null);

/** Keeps the server and tool of a tool_call update whose rawInput names them (Codex's MCP calls). The oldest go past 200. */
export function noteMcpCall(calls: McpCalls, update: unknown): void {
  const u = record(update);
  if (!u || u.sessionUpdate !== "tool_call" || typeof u.toolCallId !== "string") return;
  const input = record(u.rawInput);
  if (!input || typeof input.server !== "string" || typeof input.tool !== "string") return;
  calls.delete(u.toolCallId);
  calls.set(u.toolCallId, { server: input.server, tool: input.tool, args: input.arguments });
  while (calls.size > KEPT) calls.delete(calls.keys().next().value as string);
}

/**
 * True only for an ask to run one of Rushes's own MCP tools. Only the branch of the agent that runs is read:
 * a Codex-shaped request from Claude, or a Claude-shaped one from Codex, asks.
 */
export function isOwnRushesTool(agent: AgentId, root: string, p: AcpPermissionParams, calls: McpCalls): boolean {
  const tc = record(p.toolCall);
  if (!tc) return false;
  return agent === "claude" ? ownClaudeTool(tc, root) : agent === "codex" ? ownCodexTool(p, tc, calls, root) : false;
}

/**
 * R17, defence in depth beside the pinned MCP server: the tool's arguments name no project, or this one. Claude
 * sends the tool's input as toolCall.rawInput (claude-agent-acp dist/tool-calls/renderer.js:212); Codex as
 * rawInput.arguments of its tool_call (codex-acp dist/index.js mcpInput :35851).
 */
function ownProject(args: unknown, root: string): boolean {
  const a = record(args);
  return a !== null && isProjectRoot(root, a.project);
}

function ownClaudeTool(tc: Record<string, unknown>, root: string): boolean {
  const claude = record(record(tc._meta)?.claudeCode);
  if (!claude) return false;
  const name = claude.toolName;
  const server = record(claude.mcpServer);
  return server?.source === CLAUDE_SOURCE && server?.name === RUSHES_SERVER && typeof name === "string" && name.startsWith(CLAUDE_PREFIX) && OWN_TOOL.test(name.slice(CLAUDE_PREFIX.length)) && ownProject(tc.rawInput, root);
}

function ownCodexTool(p: AcpPermissionParams, tc: Record<string, unknown>, calls: McpCalls, root: string): boolean {
  if (record((p as { _meta?: unknown })._meta)?.is_mcp_tool_approval !== true) return false;
  if (tc.kind !== "execute" || typeof tc.toolCallId !== "string") return false;
  const call = calls.get(tc.toolCallId);
  return call !== undefined && call.server === RUSHES_SERVER && OWN_TOOL.test(call.tool) && ownProject(call.args, root);
}
