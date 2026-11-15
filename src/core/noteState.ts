// A note's lifecycle, as one small state machine. Pure (no Node imports): the server, the dashboard and the
// agent's tools all read a note's state here, so they can never disagree about it.
//
// It is stored as two fields, `status` and `batch`, and every note file from before still loads: a state is only
// ever worked out from them, never written down.
//
//   todo  --send-->    sent   Send filed it in a batch: the agent has it.
//   todo  --resolve--> done   Fixed, or ticked off, before it was ever sent.
//   sent  --resolve--> done   The agent (or the user) marked it done. It keeps its batch, as history.
//   done  --reopen-->  todo   Not fixed after all. It leaves its batch, so the next Send takes it again.
//
// Prior art: a Review Board issue (open, resolved, dropped) and a Kitsu task (waiting for approval, retake,
// approved) are both a status read with whose turn it is; here, a batch means it is the agent's turn.
import type { Note } from "./schema.js";

export const NOTE_STATES = ["todo", "sent", "done"] as const;
export type NoteState = (typeof NOTE_STATES)[number];

export type NoteEvent = { type: "send"; batch: string } | { type: "resolve" } | { type: "reopen" };

/** Every move a note can make: from a state, on an event, to a state. A move not listed is refused. */
export const NOTE_TRANSITIONS: Readonly<Record<NoteState, Readonly<Partial<Record<NoteEvent["type"], NoteState>>>>> = {
  todo: { send: "sent", resolve: "done" },
  sent: { resolve: "done" },
  done: { reopen: "todo" },
};

/** Each state in words, for a marker's or a dot's name and tooltip, and for an agent. */
export const NOTE_STATE_LABEL: Readonly<Record<NoteState, string>> = { todo: "To do", sent: "With your agent", done: "Done" };

/** A to-do note is sent once a batch holds it; done wins over both. */
export function noteState(n: Pick<Note, "status" | "batch">): NoteState {
  return n.status === "done" ? "done" : n.batch !== null ? "sent" : "todo";
}

export const canMove = (from: NoteState, event: NoteEvent["type"]): boolean => NOTE_TRANSITIONS[from][event] !== undefined;

/** Makes the move on the note's stored fields, or throws when the table has no such move from its state. */
export function moveNote(n: Pick<Note, "status" | "batch">, event: NoteEvent): void {
  const from = noteState(n);
  if (!canMove(from, event.type)) throw new Error(`can't ${event.type} a note that is ${from}`);
  if (event.type === "send") n.batch = event.batch;
  else if (event.type === "resolve") n.status = "done";
  else {
    n.status = "todo";
    n.batch = null;
  }
}

/**
 * Status as a person or an agent sets it ("todo" or "done"), made as moves: done to todo reopens, todo to done
 * resolves, and the status a note already has changes nothing.
 */
export function setStatus(n: Pick<Note, "status" | "batch">, status: Note["status"] | undefined): void {
  if (status === undefined || status === n.status) return;
  moveNote(n, { type: status === "done" ? "resolve" : "reopen" });
}

/** Send: the batch's notes that are still to do and unsent are filed in it. Ones sent before, or done, stay as they are. */
export function markSent(notes: Pick<Note, "id" | "status" | "batch">[], batch: { id: string; noteIds: readonly string[] }): void {
  const ids = new Set(batch.noteIds);
  for (const n of notes) if (ids.has(n.id) && noteState(n) === "todo") moveNote(n, { type: "send", batch: batch.id });
}

/** The note with its state, as the server hands it out. A copy: the stored note never carries one. */
export const withState = <T extends Pick<Note, "status" | "batch">>(n: T): T & { state: NoteState } => ({ ...n, state: noteState(n) });
