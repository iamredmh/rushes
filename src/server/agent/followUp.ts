// §28.5: the user's answer on a note goes back to the conversation as its own turn, for a note that is still with
// the agent (sent). Ruling R11: the runner sends it when Send to AI is on, the agent is signed in and a session is
// kept for it (loaded as Send loads it, so a restart loses nothing). Otherwise the note goes back to to do (runner.ts).
import { AGENT_LINES } from "../../core/agentActivity.js";
import { noteState } from "../../core/noteState.js";
import type { Batch } from "../../core/schema.js";
import type { Store } from "../../core/store.js";

/** One turn's work: a batch, or the user's answer on a note that is with the agent. */
export interface TurnJob {
  kind: "batch" | "followUp";
  /** The batch whose notes this turn works on: the note's own batch for a follow-up. */
  batchId: string;
  /** A follow-up's note: Stop or a failure gives back that note alone. Null for a batch. */
  note: string | null;
  /** How Activity and the Change Log name the turn. */
  label: string;
  prompt: string;
  /** A follow-up's note's reply count when the job was made (its last reply the answer it carries). 0 for a batch. */
  replies: number;
}

/** A follow-up quotes the note's text up to this many characters. */
export const FOLLOW_UP_QUOTE_MAX = 200;

export const batchJob = (b: Batch): TurnJob => ({ kind: "batch", batchId: b.id, note: null, label: b.id, prompt: b.prompt + "\n\n" + AGENT_LINES, replies: 0 });

export function followUpText(note: string, noteText: string, answer: string): string {
  const quote = Array.from(noteText).slice(0, FOLLOW_UP_QUOTE_MAX).join("");
  return `The user answered on note ${note} ("${quote}"): ${answer}\nCarry on with that note, then rushes_reply on it.`;
}

/** The follow-up turn for a "user-reply" event, or null when nothing is to be sent. */
export async function followUpFor(store: Store, e: { note: string; text: string }): Promise<TurnJob | null> {
  const answer = String(e?.text ?? "").trim();
  if (!answer) return null;
  const n = (await store.read("notes")).notes.find((x) => x.id === e.note);
  if (!n || noteState(n) !== "sent" || n.batch === null) return null;
  return {
    kind: "followUp",
    batchId: n.batch,
    note: n.id,
    label: `your answer on ${n.id}`,
    prompt: followUpText(n.id, n.text, answer),
    replies: n.replies.length,
  };
}
