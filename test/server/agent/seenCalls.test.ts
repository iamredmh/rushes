// Task 10 round 2 (1): an ask completed from its own tool call (seenCalls.ts).
import { describe, expect, it } from "vitest";
import { noteToolCall, withSeen, type SeenCalls } from "../../../src/server/agent/seenCalls.js";
import type { AcpPermissionParams } from "../../../src/server/agent/acp.js";

const ask = (toolCall: AcpPermissionParams["toolCall"]): AcpPermissionParams => ({ sessionId: "s", toolCall, options: [] });

describe("withSeen", () => {
  it("a started command whose tool call was parsed as a read is still a command: execute, with its command and no paths", () => {
    const seen: SeenCalls = new Map();
    noteToolCall(seen, { sessionUpdate: "tool_call", toolCallId: "c1", kind: "read", title: "Read file 'a.txt'", status: "in_progress", locations: [{ path: "/p/a.txt" }] });
    noteToolCall(seen, { sessionUpdate: "tool_call_update", toolCallId: "c1", rawInput: { command: "cat a.txt", cwd: "/p" } });
    expect(withSeen(ask({ toolCallId: "c1", title: "cat a.txt", rawInput: { cwd: "/p" }, locations: [] }), seen).toolCall).toEqual({
      toolCallId: "c1", title: "cat a.txt", kind: "execute", rawInput: { cwd: "/p", command: "cat a.txt" }, locations: [],
    });
  });

  it("search, execute and an untyped tool call become execute; only an edit stays edit, with its paths", () => {
    const seen: SeenCalls = new Map();
    noteToolCall(seen, { sessionUpdate: "tool_call", toolCallId: "s", kind: "search", rawInput: { command: "rg foo" } });
    noteToolCall(seen, { sessionUpdate: "tool_call", toolCallId: "x", kind: "execute", rawInput: { command: "make" } });
    noteToolCall(seen, { sessionUpdate: "tool_call", toolCallId: "u", title: "Something" });
    noteToolCall(seen, { sessionUpdate: "tool_call", toolCallId: "e", kind: "edit", title: "Editing files", locations: [{ path: "/p/b.txt" }] });
    expect(withSeen(ask({ toolCallId: "s", title: "rg foo" }), seen).toolCall).toEqual({ toolCallId: "s", title: "rg foo", kind: "execute", rawInput: { command: "rg foo" } });
    expect(withSeen(ask({ toolCallId: "x", title: "make" }), seen).toolCall.kind).toBe("execute");
    expect(withSeen(ask({ toolCallId: "u", title: "Something" }), seen).toolCall.kind).toBe("execute");
    expect(withSeen(ask({ toolCallId: "e", title: "Editing files" }), seen).toolCall).toEqual({ toolCallId: "e", title: "Editing files", kind: "edit", locations: [{ path: "/p/b.txt" }] });
  });

  it("never changes what the ask carries", () => {
    const seen: SeenCalls = new Map();
    noteToolCall(seen, { sessionUpdate: "tool_call", toolCallId: "c1", kind: "edit", rawInput: { command: "seen" }, locations: [{ path: "/p/seen" }] });
    const carried = { toolCallId: "c1", title: "Run command", kind: "execute", rawInput: { command: "asked" }, locations: [{ path: "/p/asked" }] };
    expect(withSeen(ask(carried), seen).toolCall).toEqual(carried);
  });

  it("an ask with no tool call seen for its id is left as it came", () => {
    const seen: SeenCalls = new Map();
    noteToolCall(seen, { sessionUpdate: "tool_call", toolCallId: "other", kind: "edit" });
    const lone = ask({ toolCallId: "lone", title: "Editing files" });
    expect(withSeen(lone, seen)).toBe(lone);
  });

  it("keeps at most 200 tool calls, the newest", () => {
    const seen: SeenCalls = new Map();
    for (let i = 0; i < 230; i++) noteToolCall(seen, { sessionUpdate: "tool_call", toolCallId: `t${i}`, kind: "edit" });
    expect(seen.size).toBe(200);
    expect(seen.has("t0")).toBe(false);
    expect(seen.has("t229")).toBe(true);
  });
});
