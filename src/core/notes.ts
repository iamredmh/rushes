import { NoteSchema, type Note, type NotesFile, type Stage } from "./schema.js";
import { InvalidError, NotFoundError } from "./errors.js";
import { newId } from "./ids.js";

export interface NewNote {
  stage: Stage;
  video?: string | null;
  version?: string | null;
  on?: string | null;
  scope: Note["scope"];
  t?: number | null;
  tOut?: number | null;
  frame?: number | null;
  text: string;
  box?: Note["box"];
  grab?: string | null;
  /** Stamped by the server (Task 2) from the version's shots; passed through here. */
  shot?: Note["shot"];
  /** User-owned, like text (§14.5): the quick marks on a range note on an audio tab. */
  marks?: Note["marks"];
  by?: Note["by"];
}

export function addNote(file: NotesFile, input: NewNote, now = new Date()): Note {
  const parsed = NoteSchema.safeParse({ ...input, id: newId("n"), createdAt: now.toISOString() });
  if (!parsed.success) throw new InvalidError("Note is invalid", parsed.error.issues);
  file.notes.push(parsed.data);
  return parsed.data;
}

function find(file: NotesFile, id: string): Note {
  const n = file.notes.find((x) => x.id === id);
  if (!n) throw new NotFoundError("note", id);
  return n;
}

/** Fields the agent owns. Status is shared. */
export interface Reply {
  id: string;
  reply?: string;
  status?: Note["status"];
  fixT?: number | null;
  fixVersion?: string | null;
}

/** A done note going back to todo leaves its batch, so the next Send includes it. */
function reopen(n: Note, status: Note["status"] | undefined): void {
  if (n.status === "done" && status === "todo") n.batch = null;
}

export function applyReply(file: NotesFile, r: Reply): Note {
  const n = find(file, r.id);
  if (r.reply !== undefined) n.reply = r.reply;
  reopen(n, r.status);
  if (r.status !== undefined) n.status = r.status;
  if (r.fixT !== undefined) n.fixT = r.fixT;
  if (r.fixVersion !== undefined) n.fixVersion = r.fixVersion;
  return n;
}

/** Fields the user owns. Status is shared. */
export interface UserEdit {
  id: string;
  text?: string;
  box?: Note["box"];
  grab?: string | null;
  scope?: Note["scope"];
  t?: number | null;
  tOut?: number | null;
  /** User-owned, like text (§14.5): applyReply never touches this. */
  marks?: Note["marks"];
  status?: Note["status"];
}

export function applyUserEdit(file: NotesFile, e: UserEdit): Note {
  const n = find(file, e.id);
  const next = { ...n };
  for (const k of ["text", "box", "grab", "scope", "t", "tOut", "marks", "status"] as const) {
    if (e[k] !== undefined) (next as Record<string, unknown>)[k] = e[k];
  }
  const parsed = NoteSchema.safeParse(next);
  if (!parsed.success) throw new InvalidError("Note edit is invalid", parsed.error.issues);
  reopen(n, e.status);
  Object.assign(n, { ...parsed.data, batch: n.batch });
  return n;
}

export interface NoteFilter {
  stage?: Stage;
  status?: Note["status"];
  batch?: string;
  version?: string;
}

export function filterNotes(notes: Note[], f: NoteFilter = {}): Note[] {
  return notes.filter(
    (n) =>
      (f.stage === undefined || n.stage === f.stage) &&
      (f.status === undefined || n.status === f.status) &&
      (f.batch === undefined || n.batch === f.batch) &&
      (f.version === undefined || n.version === f.version),
  );
}
