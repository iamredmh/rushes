import { describe, expect, it } from "vitest";
import { isOwnRushesTool, noteMcpCall, type McpCalls } from "../../../src/server/agent/ownTools.js";
import type { AcpPermissionParams } from "../../../src/server/agent/acp.js";

const OPTIONS: AcpPermissionParams["options"] = [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }];

/** A request as claude-agent-acp 0.107.3 sends it for an MCP tool (permissions/presentation.js:112-124). */
const claudeAsk = (toolName: unknown, mcpServer?: unknown): AcpPermissionParams =>
  ({
    sessionId: "s",
    toolCall: { toolCallId: "t1", title: String(toolName), kind: "other", _meta: { claudeCode: { toolName, ...(mcpServer === undefined ? {} : { mcpServer }) } } },
    options: OPTIONS,
  }) as AcpPermissionParams;

/** codex-acp 2.7.0: the tool_call it sends at item/started (McpToolReporter.started), then the correlated ask. */
const codexCall = (server: unknown, tool: unknown, id = "item-1") => ({
  sessionUpdate: "tool_call", toolCallId: id, kind: "execute", title: `mcp.${server}.${tool}`, status: "pending",
  rawInput: { server, tool, arguments: {} },
});
const codexAsk = (id = "item-1", meta: unknown = { is_mcp_tool_approval: true }): AcpPermissionParams =>
  ({ sessionId: "s", toolCall: { toolCallId: id, kind: "execute", status: "pending" }, options: OPTIONS, ...(meta === null ? {} : { _meta: meta }) }) as AcpPermissionParams;

const withCalls = (...updates: unknown[]): McpCalls => {
  const calls: McpCalls = new Map();
  for (const u of updates) noteMcpCall(calls, u);
  return calls;
};

describe("isOwnRushesTool", () => {
  it("Claude: a rushes_ tool of the rushes server, by _meta.claudeCode.toolName and mcpServer.name", () => {
    for (const tool of ["rushes_reply", "rushes_working_on", "rushes_get_batch"]) {
      expect(isOwnRushesTool("claude", claudeAsk(`mcp__rushes__${tool}`, { name: "rushes", source: "dynamic" }), new Map()), tool).toBe(true);
    }
  });

  it("Claude: lookalikes ask", () => {
    const own = { name: "rushes", source: "dynamic" };
    const cases: [unknown, unknown][] = [
      ["mcp__rushes2__rushes_reply", { name: "rushes2", source: "user" }],
      ["mcp__rushes2__rushes_reply", own],
      ["mcp__rushes__other", own],
      ["mcp__rushes__rushes_x;rm", own],
      ["mcp__rushes__rushes_", own],
      ["mcp__rushes__rushes_reply ", own],
      ["xmcp__rushes__rushes_reply", own],
      ["mcp__rushes__rushes_reply", { name: "rushes2", source: "user" }],
      ["mcp__rushes__rushes_reply", undefined],
      ["mcp__rushes__rushes_reply", { name: "Rushes", source: "dynamic" }],
      ["mcp__rushes__rushes__reply", own],
      [42, own],
    ];
    for (const [toolName, server] of cases) expect(isOwnRushesTool("claude", claudeAsk(toolName, server), new Map()), String(toolName)).toBe(false);
    // The tool name in the title alone (free text) is not enough.
    expect(isOwnRushesTool("claude", { sessionId: "s", toolCall: { toolCallId: "t", title: "mcp__rushes__rushes_reply" }, options: OPTIONS }, new Map())).toBe(false);
  });

  it("Codex: the approval of a call whose tool_call named server rushes and a rushes_ tool", () => {
    expect(isOwnRushesTool("codex", codexAsk(), withCalls(codexCall("rushes", "rushes_reply")))).toBe(true);
  });

  it("Codex: lookalikes, other ids and asks without the MCP approval marker all ask", () => {
    expect(isOwnRushesTool("codex", codexAsk(), withCalls(codexCall("rushes2", "rushes_reply")))).toBe(false);
    expect(isOwnRushesTool("codex", codexAsk(), withCalls(codexCall("rushes", "other")))).toBe(false);
    expect(isOwnRushesTool("codex", codexAsk(), withCalls(codexCall("rushes", "rushes_x;rm")))).toBe(false);
    expect(isOwnRushesTool("codex", codexAsk("item-2"), withCalls(codexCall("rushes", "rushes_reply")))).toBe(false);
    expect(isOwnRushesTool("codex", codexAsk("item-1", null), withCalls(codexCall("rushes", "rushes_reply")))).toBe(false);
    expect(isOwnRushesTool("codex", codexAsk("item-1", { is_mcp_tool_approval: "yes" }), withCalls(codexCall("rushes", "rushes_reply")))).toBe(false);
    // A command approval that reuses the id (kind not execute is not the shape either).
    const cmd = { ...codexAsk(), toolCall: { toolCallId: "item-1", kind: "edit" } } as AcpPermissionParams;
    expect(isOwnRushesTool("codex", cmd, withCalls(codexCall("rushes", "rushes_reply")))).toBe(false);
    // Codex's standalone form (no earlier tool call to tie it to): the tool is only in free text, so it asks.
    const standalone = {
      sessionId: "s", options: OPTIONS, _meta: { is_mcp_tool_approval: true },
      toolCall: { toolCallId: "mcp-rushes-1", kind: "execute", title: "MCP tool call approval", rawInput: { serverName: "rushes", description: 'Run tool "rushes_reply"?' } },
    } as AcpPermissionParams;
    expect(isOwnRushesTool("codex", standalone, new Map())).toBe(false);
  });

  it("each agent's shape counts only for that agent (round 2, item 4)", () => {
    const calls = withCalls(codexCall("rushes", "rushes_reply"));
    expect(isOwnRushesTool("claude", codexAsk(), calls)).toBe(false);
    expect(isOwnRushesTool("codex", claudeAsk("mcp__rushes__rushes_reply", { name: "rushes", source: "dynamic" }), calls)).toBe(false);
    // A Codex-shaped request whose toolCall also carries a Claude-shaped _meta: Codex reads only its own fields.
    const both = { ...codexAsk(), toolCall: { toolCallId: "item-1", kind: "execute", _meta: { claudeCode: { toolName: "mcp__rushes__other" } } } } as AcpPermissionParams;
    expect(isOwnRushesTool("codex", both, calls)).toBe(true);
  });

  it("noteMcpCall keeps only tool_call starts with a string server and tool, and only so many", () => {
    const calls = withCalls(
      { sessionUpdate: "tool_call_update", toolCallId: "u", rawInput: { server: "rushes", tool: "rushes_reply" } },
      { sessionUpdate: "tool_call", toolCallId: "n", rawInput: { server: 1, tool: "rushes_reply" } },
      null,
      codexCall("rushes", "rushes_reply", "ok"),
    );
    expect([...calls.keys()]).toEqual(["ok"]);
    const many: McpCalls = new Map();
    for (let i = 0; i < 1000; i++) noteMcpCall(many, codexCall("rushes", "rushes_reply", `i${i}`));
    expect(many.size).toBeLessThanOrEqual(200);
    expect(many.has("i999")).toBe(true);
  });
});
