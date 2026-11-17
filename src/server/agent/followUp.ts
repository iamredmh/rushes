// §28.5: the user's answer on a note goes back to the running conversation as its own turn. Only for a note
// that is still with the agent and whose batch this runner carried in this process (ruling R3): an answer on
// a note sent by copying the prompt, or on any note after a restart, sends nothing.
import { AGENT_LINES } from "../../core/agentActivity.js";
import { noteState } from "../../core/noteState.js";
import type { Batch } from "../../core/schema.js";
import type { Store } from "../../core/store.js";

/** One turn's work: a batch, or the user's answer on a note of a batch already carried. */
export interface TurnJob {
  kind: "batch" | "followUp";
  /** The batch whose notes this turn works on: the note's own batch for a follow-up. */
  batchId: string;
  /** A follow-up's note: Stop or a failure gives back that note alone. Null for a batch. */
  note: string | null;
  /** How Activity and the Change Log name the turn. */
  label: string;
  prompt: string;
}

/** How many carried batch ids the runner remembers. */
export const CARRIED_KEPT = 50;
/** A follow-up quotes the note's text up to this many characters. */
export const FOLLOW_UP_QUOTE_MAX = 200;

export const batchJob = (b: Batch): TurnJob => ({ kind: "batch", batchId: b.id, note: null, label: b.id, prompt: b.prompt + "\n\n" + AGENT_LINES });

export function followUpText(note: string, noteText: string, answer: string): string {
  const quote = Array.from(noteText).slice(0, FOLLOW_UP_QUOTE_MAX).join("");
  return `The user answered on note ${note} ("${quote}"): ${answer}\nCarry on with that note, then rushes_reply on it.`;
}

/** The batch ids handed to the agent in this process, the newest last, at most CARRIED_KEPT. */
export class CarriedBatches {
  private ids: string[] = [];

  add(id: string): void {
    this.ids = this.ids.filter((x) => x !== id);
    this.ids.push(id);
    if (this.ids.length > CARRIED_KEPT) this.ids.splice(0, this.ids.length - CARRIED_KEPT);
  }

  has(id: string): boolean {
    return this.ids.includes(id);
  }
}

/** The follow-up turn for a "user-reply" event, or null when nothing is to be sent. */
export async function followUpFor(store: Store, carried: CarriedBatches, e: { note: string; text: string }): Promise<TurnJob | null> {
  const answer = String(e?.text ?? "").trim();
  if (!answer) return null;
  const n = (await store.read("notes")).notes.find((x) => x.id === e.note);
  if (!n || noteState(n) !== "sent" || n.batch === null || !carried.has(n.batch)) return null;
  return { kind: "followUp", batchId: n.batch, note: n.id, label: `your answer on ${n.id}`, prompt: followUpText(n.id, n.text, answer) };
}
