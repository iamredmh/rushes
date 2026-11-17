import {
  NoteSchema, ReplySchema, type Lane, type LaneStage, type Note, type NotesFile, type Picks, type Project, type Script, type Stage, type Variant,
} from "./schema.js";
import { InvalidError, NotFoundError, RushesError } from "./errors.js";
import { labelOfId, versionFormats } from "./formats.js";
import { newId } from "./ids.js";
import { noteState, setStatus, type NoteState } from "./noteState.js";

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
  /** §25.4: a point on a visual's image, as fractions of it. */
  pin?: Note["pin"];
  grab?: string | null;
  /** Stamped by the server (Task 2) from the version's shots; passed through here. */
  shot?: Note["shot"];
  /** User-owned, like text (§14.5): the quick marks on a range note on an audio tab. */
  marks?: Note["marks"];
  /** §21.3: a Format id, or null for every format. User-owned, like text. */
  format?: string | null;
  by?: Note["by"];
}

export function addNote(file: NotesFile, input: NewNote, now = new Date()): Note {
  // Ids are short and random (24 bits), so a long file can draw one a note already has, and a reply
  // for one note would then land on the other. Draw again, as the log does.
  let id = newId("n");
  while (file.notes.some((n) => n.id === id)) id = newId("n");
  const parsed = NoteSchema.safeParse({ ...input, id, createdAt: now.toISOString() });
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

export function applyReply(file: NotesFile, r: Reply, now = new Date()): Note {
  const n = find(file, r.id);
  if (r.reply !== undefined) {
    n.reply = r.reply;
    const text = r.reply.trim();
    if (text !== "") n.replies.push({ by: "agent", text, at: now.toISOString() });
  }
  // A status is a move in the note's lifecycle (noteState.ts): done to todo reopens it, which leaves its batch.
  setStatus(n, r.status);
  if (r.fixT !== undefined) n.fixT = r.fixT;
  if (r.fixVersion !== undefined) n.fixVersion = r.fixVersion;
  return n;
}

export const USER_REPLY_MAX = 4000;

/** The user's answer to the agent's reply, added to the note's thread. */
export function addUserReply(file: NotesFile, id: string, text: string, now = new Date()): Note {
  const n = find(file, id);
  if (text.trim().length > USER_REPLY_MAX) throw new InvalidError(`An answer is at most ${USER_REPLY_MAX} characters`);
  const parsed = ReplySchema.safeParse({ by: "user", text, at: now.toISOString() });
  if (!parsed.success) throw new InvalidError("Reply is invalid", parsed.error.issues);
  n.replies.push(parsed.data);
  return n;
}

/** Fields the user owns. Status is shared. */
export interface UserEdit {
  id: string;
  text?: string;
  box?: Note["box"];
  /** §25.4: a point on a visual's image. */
  pin?: Note["pin"];
  grab?: string | null;
  scope?: Note["scope"];
  t?: number | null;
  tOut?: number | null;
  /** User-owned, like text (§14.5): applyReply never touches this. */
  marks?: Note["marks"];
  /** §21.3: a Format id, or null for every format. User-owned, like text. */
  format?: string | null;
  status?: Note["status"];
}

export function applyUserEdit(file: NotesFile, e: UserEdit, check?: (next: Note, prev: Note) => void): Note {
  const n = find(file, e.id);
  const next = { ...n };
  for (const k of ["text", "box", "pin", "grab", "scope", "t", "tOut", "marks", "status", "format"] as const) {
    if (e[k] !== undefined) (next as Record<string, unknown>)[k] = e[k];
  }
  const parsed = NoteSchema.safeParse(next);
  if (!parsed.success) throw new InvalidError("Note edit is invalid", parsed.error.issues);
  check?.(parsed.data, n);
  // Status and batch move together, by the lifecycle's rules (noteState.ts); the rest is the user's edit.
  const life = { status: n.status, batch: n.batch };
  setStatus(life, e.status);
  Object.assign(n, { ...parsed.data, ...life });
  return n;
}

export interface NoteFormatCheck {
  next: Pick<Note, "stage" | "video" | "version" | "format" | "box">;
  /** The note as it was, for an edit. */
  prev?: Pick<Note, "format" | "box">;
  /** The edit draws the box again (so it belongs to the format it's drawn on now). */
  boxRedrawn?: boolean;
}

/**
 * §21.3 and R7, checked when a note is written: a format must be one of the note's version's;
 * only Picture notes have one; on a cut with two or more formats a box needs a format, and a box
 * kept from before stays on the format it was drawn on (the primary, for a note from before formats).
 */
export function checkNoteFormat({ next, prev, boxRedrawn = false }: NoteFormatCheck, project: Pick<Project, "videos">): void {
  if (next.format !== null && next.stage !== "picture") throw new RushesError("Only Picture notes belong to a format.", 400, "format_not_picture");
  if (next.stage !== "picture") return;
  const version = project.videos.find((v) => v.id === next.video)?.versions.find((v) => v.id === next.version);
  const shapes = version ? versionFormats(version) : [];
  if (next.format !== null && !shapes.some((f) => f.id === next.format)) {
    throw new RushesError(`${next.version ?? "That cut"} has no ${labelOfId(next.format)} format.`, 400, "unknown_format", { format: next.format });
  }
  if (!next.box || !version || version.formats.length === 0) return;
  if (next.format === null) throw new RushesError("A drawn box belongs to one frame, so this note stays on one format.", 400, "box_needs_format");
  if (prev?.box && !boxRedrawn) {
    // An older note drew its box on the primary. If the primary's size isn't stored, nobody can say
    // which format that is, so the box isn't judged (and no primary is invented).
    const drawnOn = prev.format ?? shapes.find((f) => f.primary)?.id;
    if (drawnOn !== undefined && next.format !== drawnOn) {
      throw new RushesError(`A drawn box belongs to the frame it was drawn on (${labelOfId(drawnOn)}), so this note stays there.`, 400, "box_fixes_format", { format: drawnOn });
    }
  }
}

/** A script line in words, as the Script page and the notes panel name it: "S2 · The scan finds it", cut at 48 characters. */
export function sectionLineLabel(section: { id: string; current: string }): string {
  const words = section.current.trim().replace(/\s+/g, " ");
  return `${section.id.toUpperCase()} · ${words.length > 48 ? `${words.slice(0, 47).trimEnd()}…` : words}`;
}

/** What `onLabel` needs to resolve a note's `on`. `picks` only steers an older bare id on Mix. */
export interface OnContext {
  project: Pick<Project, "lanes">;
  script: Pick<Script, "sections">;
  picks?: Pick<Picks, "lanes">;
}

/**
 * What an audio note is `on`, in words, for export and the CLI (§17): the lane and variant
 * ("Music · Warm keys"), a cue ("Sound effects · Pass A · Cue · Swipe"), a take ("S2 · Take 1"), a
 * section ("S2"), the read ("Assembled read") or, on Mix, "Whole mix" / "Voiceover". Resolved in
 * the same order as the dashboard: the exact lane-qualified variant (`"<lane>/<variant>"`) or cue
 * (`"<lane>/<variant>:<cue>"`) first, then `"vo"`, a take (`"<section>:<take>"`), a section id, and
 * last the older bare forms (a bare variant id, `"<variant>:<cue>"` or a bare cue id). On Script, the line a
 * note is about (§27, 5.8: `on` is its section id), as "S2 · The scan finds it". Null on Picture, on a
 * Script note with no line, or when `on` names nothing that's still there.
 */
export function onLabel(note: Pick<Note, "stage" | "on">, ctx: OnContext): string | null {
  const { stage, on } = note;
  if (stage === "script") {
    const section = on === null ? undefined : ctx.script.sections.find((s) => s.id === on);
    return section ? sectionLineLabel(section) : null;
  }
  if (stage !== "voice" && stage !== "music" && stage !== "sfx" && stage !== "mix") return null;
  if (on === null) return stage === "mix" ? "Whole mix" : stage === "voice" ? "Assembled read" : null;

  // Mix's own Music and Sound effects lanes; every other tab looks at its own stage only.
  const stages: LaneStage[] = stage === "mix" ? ["music", "sfx"] : [stage];
  const lanes = ctx.project.lanes.filter((l) => stages.includes(l.stage));
  const variantLabel = (l: Lane, v: Variant) => `${l.name} · ${v.name}`;
  const cueLabel = (l: Lane, v: Variant, cueId: string) => {
    const cue = v.cues.find((c) => c.id === cueId);
    return cue ? `${variantLabel(l, v)} · Cue · ${cue.name}` : null;
  };

  // 1. Lane-qualified variant or cue. Lane and variant ids are slugs, so `/` and `:` split cleanly.
  const slash = on.indexOf("/");
  if (slash > 0) {
    const colon = on.indexOf(":", slash);
    const laneId = on.slice(0, slash);
    const variantId = on.slice(slash + 1, colon === -1 ? undefined : colon);
    const lane = lanes.find((l) => l.id === laneId);
    const variant = lane?.variants.find((v) => v.id === variantId);
    const label = lane && variant ? (colon === -1 ? variantLabel(lane, variant) : cueLabel(lane, variant, on.slice(colon + 1))) : null;
    if (label) return label;
  }
  // 2–4. The read, a take, a section.
  if (on === "vo" && (stage === "voice" || stage === "mix")) return stage === "mix" ? "Voiceover" : "Assembled read";
  if (stage === "voice") {
    for (const s of ctx.script.sections) {
      const i = s.takes.findIndex((t) => `${s.id}:${t.id}` === on);
      if (i !== -1) return `${s.id.toUpperCase()} · Take ${i + 1}`;
    }
    if (ctx.script.sections.some((s) => s.id === on)) return on.toUpperCase();
  }
  // 5. Older bare forms. On Mix, a picked variant first, as the dashboard prefers one being heard.
  const picked = (l: Lane, v: Variant) => ctx.picks?.lanes[l.id] === v.id;
  const pairs = lanes.flatMap((l) => l.variants.map((v) => ({ l, v })));
  const ordered = stage === "mix" ? [...pairs.filter((p) => picked(p.l, p.v)), ...pairs.filter((p) => !picked(p.l, p.v))] : pairs;
  const bare = ordered.find((p) => p.v.id === on);
  if (bare) return variantLabel(bare.l, bare.v);
  const colon = on.indexOf(":");
  if (colon > 0) {
    const pass = pairs.find((p) => p.v.id === on.slice(0, colon) && p.v.cues.some((c) => c.id === on.slice(colon + 1)));
    if (pass) return cueLabel(pass.l, pass.v, on.slice(colon + 1));
  }
  const withCue = pairs.find((p) => p.v.cues.some((c) => c.id === on));
  return withCue ? cueLabel(withCue.l, withCue.v, on) : null;
}

export interface NoteFilter {
  stage?: Stage;
  status?: Note["status"];
  /** The lifecycle's state (noteState.ts): "sent" is the to-do notes a Send has given the agent. */
  state?: NoteState;
  batch?: string;
  version?: string;
  format?: string;
  onlyThisFormat?: boolean;
}

export function filterNotes(notes: Note[], f: NoteFilter = {}): Note[] {
  return notes.filter(
    (n) =>
      (f.stage === undefined || n.stage === f.stage) &&
      (f.status === undefined || n.status === f.status) &&
      (f.state === undefined || noteState(n) === f.state) &&
      (f.batch === undefined || n.batch === f.batch) &&
      (f.version === undefined || n.version === f.version) &&
      (f.format === undefined || (n.stage === "picture" && (n.format === f.format || (!f.onlyThisFormat && n.format === null)))),
  );
}
