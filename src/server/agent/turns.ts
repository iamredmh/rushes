// §28.5: the user's answer on a note goes back to the conversation as its own turn, for a note that is still with
// the agent (sent). Ruling R11: the runner sends it when Send to AI is on, the agent is signed in and a session is
// kept for it (loaded as Send loads it, so a restart loses nothing). Otherwise the note goes back to to do (runner.ts).
import { AGENT_LINES } from "../../core/agentActivity.js";
import { oneLine } from "../../core/labels.js";
import { noteState } from "../../core/noteState.js";
import type { AgentPermissions, Batch } from "../../core/schema.js";
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
  /**
   * §33: a batch's permission row, read from the user's rules when it was sent. The agent runs the batch in that row's
   * mode; a change in the menu applies from the next Send. A follow-up has none: it runs in the mode already running.
   */
  level?: AgentPermissions;
}

/** How much of a note's words an Activity line about an answer on it quotes (Task 10, 4). */
export const ANSWER_QUOTE_MAX = 40;

/** "your answer on '<the note's first words…>'": how Activity names an answer on a note, as M7 names a batch by its notes. */
export const answerLabel = (noteText: string): string => `your answer on '${oneLine(noteText, ANSWER_QUOTE_MAX) || "a note"}'`;

/** A follow-up quotes the note's text up to this many characters. */
export const FOLLOW_UP_QUOTE_MAX = 200;

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** A batch's turn by what it holds (M7): "3 notes", or its script lines when it holds no note. Never its id. */
export const batchLabel = (b: Pick<Batch, "noteIds" | "sectionIds">): string =>
  b.noteIds.length === 0 && b.sectionIds.length > 0 ? count(b.sectionIds.length, "script line", "script lines") : count(b.noteIds.length, "note", "notes");

export const batchJob = (b: Batch): TurnJob => ({ kind: "batch", batchId: b.id, note: null, label: batchLabel(b), prompt: b.prompt + "\n\n" + AGENT_LINES });

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
  return { kind: "followUp", batchId: n.batch, note: n.id, label: answerLabel(n.text), prompt: followUpText(n.id, n.text, answer) };
}
