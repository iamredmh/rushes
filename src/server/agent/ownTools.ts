import type { AcpPermissionParams } from "./acp.js";

/*
 * R16: an ask for one of Rushes's own MCP tools (the server the runner passes in session/new and session/load,
 * named "rushes"; see rushesMcp) is allowed with no ask, under every permission level. Those tools only read and
 * write the project's Rushes data through Rushes's own API. Everything else, other servers and lookalike names
 * included, goes on to decide() as before. Matched on structured fields only, never on a title or other free text.
 *
 * Claude (claude-agent-acp 0.107.3, dist/permissions/presentation.js:112-124, set at dist/v1/acp-agent.js:6679-6686):
 *   toolCall._meta.claudeCode.toolName  "mcp__rushes__rushes_reply"
 *   toolCall._meta.claudeCode.mcpServer { name: "rushes", source }   (the SDK's canUseTool mcpServer)
 *   Both must agree: mcpServer.name is exactly "rushes" and toolName is exactly "mcp__rushes__" + a rushes_ tool.
 *   On a Claude CLI too old to report mcpServer, the ask goes to the user.
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

/** Codex MCP tool calls seen in tool_call updates, by toolCallId. */
export type McpCalls = Map<string, { server: string; tool: string }>;
const KEPT = 200;

const record = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null);

/** Keeps the server and tool of a tool_call update whose rawInput names them (Codex's MCP calls). The oldest go past 200. */
export function noteMcpCall(calls: McpCalls, update: unknown): void {
  const u = record(update);
  if (!u || u.sessionUpdate !== "tool_call" || typeof u.toolCallId !== "string") return;
  const input = record(u.rawInput);
  if (!input || typeof input.server !== "string" || typeof input.tool !== "string") return;
  calls.delete(u.toolCallId);
  calls.set(u.toolCallId, { server: input.server, tool: input.tool });
  while (calls.size > KEPT) calls.delete(calls.keys().next().value as string);
}

/** True only for an ask to run one of Rushes's own MCP tools, from the Claude or the Codex adapter. */
export function isOwnRushesTool(p: AcpPermissionParams, calls: McpCalls): boolean {
  const tc = record(p.toolCall);
  if (!tc) return false;
  // Claude
  const claude = record(record(tc._meta)?.claudeCode);
  if (claude) {
    const name = claude.toolName;
    const server = record(claude.mcpServer);
    return (
      server?.name === RUSHES_SERVER &&
      typeof name === "string" &&
      name.startsWith(CLAUDE_PREFIX) &&
      OWN_TOOL.test(name.slice(CLAUDE_PREFIX.length))
    );
  }
  // Codex
  if (record((p as { _meta?: unknown })._meta)?.is_mcp_tool_approval !== true) return false;
  if (tc.kind !== "execute" || typeof tc.toolCallId !== "string") return false;
  const call = calls.get(tc.toolCallId);
  return call !== undefined && call.server === RUSHES_SERVER && OWN_TOOL.test(call.tool);
}
