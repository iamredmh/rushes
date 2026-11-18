// Task 10 round 2 (1): codex-acp 2.7.0, for a client that takes AIR (Rushes does, for its session failures), follows the
// "AIR tool-call contract": the ask for an item that has already started repeats none of what its tool_call said.
//   - A started command's ask (CommandReporter.permission, index.js 34471-34505) has no kind and no status; its title
//     and rawInput { command, cwd } are there, its locations empty. Its tool_call (startFacts, 34531) had the kind
//     (execute, or read / search for a read, search or listing), the rawInput and, for a read, the path.
//   - A started file change's ask (FileChangeReporter.permission, 35234) has its title and paths but no kind; its
//     tool_call (FileChangeReporter.started, 35208) had kind "edit".
// Without a kind Rushes's rules read the ask as "other": project-edits would ask for every edit in the project and no
// Always rule would match. So an ask is completed from the tool_call the same adapter reported for the same
// toolCallId: only fields the ask lacks, never one it carries. An ask with no such tool_call stays as it came.
import type { AcpPermissionParams } from "./acp.js";

type Seen = { kind?: string; rawInput?: unknown; locations?: { path: string }[] };
/** The tool calls an adapter has reported, by toolCallId: what an ask for one may lack. */
export type SeenCalls = Map<string, Seen>;
const KEPT = 200;

const record = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const pathsOf = (v: unknown): { path: string }[] | undefined =>
  Array.isArray(v) ? v.filter((l): l is { path: string } => typeof record(l)?.path === "string").map((l) => ({ path: l.path })) : undefined;

/** Keeps the kind, rawInput and locations of a tool_call or tool_call_update, merged by toolCallId. The oldest go past 200. */
export function noteToolCall(seen: SeenCalls, update: unknown): void {
  const u = record(update);
  if (!u || (u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update") || typeof u.toolCallId !== "string") return;
  const prev = seen.get(u.toolCallId) ?? {};
  const locations = pathsOf(u.locations);
  const next: Seen = {
    ...prev,
    ...(typeof u.kind === "string" && u.kind !== "" ? { kind: u.kind } : {}),
    ...(u.rawInput !== undefined && u.rawInput !== null ? { rawInput: u.rawInput } : {}),
    ...(locations && locations.length > 0 ? { locations } : {}),
  };
  seen.delete(u.toolCallId);
  seen.set(u.toolCallId, next);
  while (seen.size > KEPT) seen.delete(seen.keys().next().value as string);
}

/**
 * The ask with what it lacks filled from its own tool_call: a kind, a rawInput (or its command), locations (an empty list
 * carries none). A field the ask carries is never changed. With no tool_call seen for its toolCallId, the ask as it came.
 */
export function withSeen(p: AcpPermissionParams, seen: SeenCalls): AcpPermissionParams {
  const s = seen.get(p.toolCall.toolCallId);
  if (!s) return p;
  const tc = { ...p.toolCall };
  if ((tc.kind === undefined || tc.kind === null || tc.kind === "") && s.kind) tc.kind = s.kind;
  const raw = record(tc.rawInput);
  const seenRaw = record(s.rawInput);
  if (tc.rawInput === undefined || tc.rawInput === null) {
    if (s.rawInput !== undefined) tc.rawInput = s.rawInput;
  } else if (raw && raw.command === undefined && seenRaw?.command !== undefined) {
    tc.rawInput = { ...raw, command: seenRaw.command };
  }
  if ((tc.locations === undefined || tc.locations.length === 0) && s.locations) tc.locations = s.locations;
  return { ...p, toolCall: tc };
}
