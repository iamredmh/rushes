// §35.5: Attention items. When the agent can't go on without the user outside Rushes (a sign-in, a missing key, a
// missing file) it raises one; it is a Change Log line of the kind "attention" on a film, carrying the note it is about
// and, once it clears, when. It clears when its note is marked done, when the note gets a reply naming the version it
// was fixed in, or when the user dismisses it. Pure: the server, the desk and the tests read it here.
import { appendEvent } from "./log.js";
import { LOG_TEXT_MAX, logText } from "./logText.js";
import type { LogEntry, LogFile } from "./schema.js";

export const ATTENTION_TITLE_MAX = LOG_TEXT_MAX;

/** A line that still needs the user. */
export const isOpenAttention = (e: Pick<LogEntry, "kind" | "resolved">): boolean => e.kind === "attention" && !e.resolved;

export interface AttentionInput {
  title: string;
  note: string | null;
  video: string | null;
}

/**
 * Writes the Attention line, or gives back the open one with the same words on the same film and note (raising it
 * again adds nothing). `created` says which.
 */
export function raiseAttention(file: LogFile, a: AttentionInput, at: Date): { entry: LogEntry; created: boolean } {
  const text = logText(a.title);
  if (!text) throw new Error("An attention item needs a title");
  const open = file.entries.find((e) => isOpenAttention(e) && e.text === text && (e.video ?? null) === a.video && (e.note ?? null) === a.note);
  if (open) return { entry: open, created: false };
  const entry = appendEvent(file, { area: "notes", kind: "attention", text, video: a.video, merge: "never" }, "agent", at);
  if (a.note) entry.note = a.note;
  return { entry, created: true };
}

/** Clears every open Attention line `match` picks. Returns the ones cleared. */
export function resolveAttention(file: LogFile, match: (e: LogEntry) => boolean, at: Date): LogEntry[] {
  const cleared: LogEntry[] = [];
  for (const e of file.entries) {
    if (!isOpenAttention(e) || !match(e)) continue;
    e.resolved = at.toISOString();
    cleared.push(e);
  }
  return cleared;
}

/** A reply that clears its note's Attention: the note is done, or the reply names the version it was fixed in. */
export const replySettles = (r: { status?: "todo" | "done"; fixVersion?: string | null }): boolean => r.status === "done" || !!r.fixVersion;
