// §27: the desk's own logic, pure. Where a view sits in the workspaces, what the number keys open,
// how a sound's takes are grouped, and the one line that says what to do next.
import { isNewTake, madeForStale } from "../../src/core/takes.js";
import type { PlanPage } from "./lib.js";
import type { InUse, Lane, LaneStage, Note, Stage, Variant, Video } from "./types.js";

export type Workspace = "plan" | "review" | "visuals" | "assets";
export type ReviewTab = "timeline" | "voice" | "music" | "sfx";
/** The monitor's tool strip (§27, 5.4): one is active, Select unless a note, a range or a box is under way. Grab is an action. */
export type Tool = "select" | "note" | "range" | "box" | "grab";
/** Everything the desk can show: a stage, Assets, or one of the planning pages. */
export type DeskView = Stage | "assets" | "brief" | "storyboard";
type Use = NonNullable<InUse["voice"]>;

/** The workspace a view is in, and its tab when that is Review. Picture and the mix are one timeline. */
export function deskPlace(view: DeskView): { workspace: Workspace; tab: ReviewTab | null } {
  switch (view) {
    case "brief":
    case "script":
    case "storyboard":
      return { workspace: "plan", tab: null };
    case "voice":
    case "music":
    case "sfx":
      return { workspace: "review", tab: view };
    case "visuals":
      return { workspace: "visuals", tab: null };
    case "assets":
      return { workspace: "assets", tab: null };
    default:
      return { workspace: "review", tab: "timeline" };
  }
}

const KEY_VIEWS: Record<string, DeskView> = { "2": "picture", "3": "voice", "4": "music", "5": "sfx", "6": "picture", "7": "visuals", "8": "assets" };

/** What a number key opens. They keep the places they had with eight tabs; 6, once Mix, is the timeline. */
export function viewForKey(key: string, planLast: PlanPage): DeskView | null {
  if (key === "1") return planLast;
  return KEY_VIEWS[key] ?? null;
}

/** The view the desk opens for one asked for: the mix plays on the Timeline tab now, so "mix" (a key, a Change Log row) opens that. */
export function deskView(view: DeskView): DeskView {
  return view === "mix" ? "picture" : view;
}

export function viewForTab(tab: ReviewTab): DeskView {
  return tab === "timeline" ? "picture" : tab;
}

/** One read, bed or pass as a sound's tab lists it. */
export interface TakeRow {
  lane: string;
  /** The round's name (its lane's, or the short day takes with no round arrived on). */
  round: string;
  /** Which round it is: its lane, and for takes with no round the full day, so two days that read alike stay apart. */
  roundKey: string;
  variant: Variant;
  /** The cut it was made for on this film, when it recorded one. */
  madeFor: string | null;
  /** Made for an earlier cut than the film has now. */
  stale: boolean;
  inUse: boolean;
}

export interface TakeGroups {
  /** Added since this sound's take in use was picked (or nothing is in use yet): newest round first. */
  fresh: TakeRow[];
  inUse: TakeRow | null;
  /** Everything else, by round, newest round first. */
  earlier: { round: string; takes: TakeRow[] }[];
  /** Put away: hidden until asked for, never deleted. */
  away: TakeRow[];
}

/** The desk's short date, "14 Nov": a shelved film's day, and the day a round of takes with no name arrived. */
export const shortDate = (iso: string, timeZone?: string): string => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone });

/**
 * A sound's takes in the order its tab shows them. `lanes` are the film's own (filmLanes); `use` is its take in use for the
 * sound. Takes added with no round sit in the stage's own lane (id = the stage): they are shown as a round per local day
 * they arrived ("14 Nov"), newest day first, and those with no date under the lane's name. `timeZone` sets "local" (tests).
 */
export function takeGroups(lanes: Lane[], stage: LaneStage, use: Use | undefined, video: Pick<Video, "id" | "versions"> | undefined, timeZone?: string): TakeGroups {
  const out: TakeGroups = { fresh: [], inUse: null, earlier: [], away: [] };
  const rounds = lanes.filter((l) => l.stage === stage);
  const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone });
  for (let i = rounds.length - 1; i >= 0; i--) {
    const l = rounds[i];
    // The rounds this lane shows as: itself, or (the stage's own lane) one per day, newest first, the undated last.
    const parts: { key: string; round: string; variants: Variant[] }[] = [];
    if (l.id !== stage) parts.push({ key: "", round: l.name, variants: l.variants });
    else {
      const byDay = new Map<string, { key: string; round: string; variants: Variant[] }>();
      const undated: Variant[] = [];
      for (const v of l.variants) {
        if (v.addedAt === undefined) {
          undated.push(v);
          continue;
        }
        const k = dayKey(v.addedAt);
        if (!byDay.has(k)) byDay.set(k, { key: k, round: shortDate(v.addedAt, timeZone), variants: [] });
        byDay.get(k)!.variants.push(v);
      }
      parts.push(...[...byDay.values()].sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)));
      if (undated.length > 0) parts.push({ key: "", round: l.name, variants: undated });
    }
    for (const part of parts) {
      const rest: TakeRow[] = [];
      for (const variant of part.variants) {
        const inUse = use !== undefined && use.lane === l.id && use.variant === variant.id;
        const row: TakeRow = {
          lane: l.id,
          round: part.round,
          roundKey: `${l.id}\n${part.key}`,
          variant,
          madeFor: (video && variant.madeFor?.[video.id]) ?? null,
          stale: video ? madeForStale(variant, video) : false,
          inUse,
        };
        if (inUse) out.inUse = row;
        else if (variant.putAway !== undefined) out.away.push(row);
        else if (isNewTake(variant, use)) out.fresh.push(row);
        else rest.push(row);
      }
      if (rest.length > 0) out.earlier.push({ round: part.round, takes: rest });
    }
  }
  return out;
}

/** A take's key on its tab and its clip id in the engine: "<lane>/<variant>", the `on` a note on it saves. */
export const takeKey = (row: Pick<TakeRow, "lane" | "variant">): string => `${row.lane}/${row.variant.id}`;

/** What a sound's tab plays with nothing selected: the take in use, else the first take waiting, else the newest earlier one. */
export function defaultTake(g: TakeGroups): TakeRow | null {
  return g.inUse ?? g.fresh[0] ?? g.earlier[0]?.takes[0] ?? null;
}

/** One heading on a sound's tab and the takes under it. */
export interface TakeSection {
  kind: "fresh" | "inUse" | "earlier";
  /** "New · Round 3", "In use · Round 2", "Earlier · Round 1". */
  heading: string;
  takes: TakeRow[];
}

const SECTION_WORD: Record<TakeSection["kind"], string> = { fresh: "New", inUse: "In use", earlier: "Earlier" };

/**
 * The headings a sound's tab shows above Put away, in order: New (a heading per round, newest first), In use, then
 * Earlier (a heading per round). `shuffle` reorders each heading's takes (Blind); it never moves a take between headings.
 */
export function takeSections(g: TakeGroups, shuffle: (takes: TakeRow[]) => TakeRow[] = (t) => t): TakeSection[] {
  const out: TakeSection[] = [];
  const push = (kind: TakeSection["kind"], round: string, takes: TakeRow[]) => out.push({ kind, heading: `${SECTION_WORD[kind]} · ${round}`, takes: shuffle(takes) });
  // New is newest round first already; consecutive takes of one round (one lane, one day) share a heading.
  let run: TakeRow[] = [];
  for (const t of g.fresh) {
    if (run.length > 0 && run[0].roundKey !== t.roundKey) {
      push("fresh", run[0].round, run);
      run = [];
    }
    run.push(t);
  }
  if (run.length > 0) push("fresh", run[0].round, run);
  if (g.inUse) push("inUse", g.inUse.round, [g.inUse]);
  for (const r of g.earlier) push("earlier", r.round, r.takes);
  return out;
}

export function takeCount(g: TakeGroups): { all: number; fresh: number } {
  const earlier = g.earlier.reduce((n, r) => n + r.takes.length, 0);
  return { all: g.fresh.length + (g.inUse ? 1 : 0) + earlier + g.away.length, fresh: g.fresh.length };
}

export interface NextInput {
  plan: { exists: boolean; approved: boolean };
  hasCut: boolean;
  /** Notes and edits waiting to be sent (unsentCount). */
  unsent: number;
  /** Of those, how many are edits rather than notes (unsentEdits): any at all and the line says "changes". */
  unsentEdits?: number;
  /** The Plan page last used, where Ready to build is: "ask for cut 1" leads there once there is a plan. */
  planPage?: "brief" | "script" | "storyboard";
  /** Where Send is (the view whose notes panel to open), when the line should lead there. */
  sendTo?: DeskView | null;
  /** To-do notes on this film, sent or not. */
  openNotes: number;
  locked: boolean;
  sound: Record<LaneStage, { started: boolean; fresh: number; inUse: boolean; stale: boolean }>;
}

const SOUND_WORDS: Record<LaneStage, { ask: string; one: string }> = {
  voice: { ask: "ask for a voiceover", one: "a read" },
  music: { ask: "ask for music", one: "a bed" },
  sfx: { ask: "ask for sound effects", one: "an effects pass" },
};
const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The status bar's one line (§27, 5.9): the first of these that applies. `go` is where clicking it
 * leads (for Send, the view whose notes panel holds it), or null when the step is not somewhere on the desk (asking the agent).
 */
export function nextHint(i: NextInput): { text: string; go: DeskView | null } {
  // With somewhere to send from, what waits is sent first, cut or no cut (a Visuals note, a plan's edits).
  if (i.unsent > 0 && (i.hasCut || i.sendTo)) return { text: `send ${counted(i.unsent, (i.unsentEdits ?? 0) > 0 ? "change" : "note")}`, go: i.sendTo ?? null };
  if (!i.hasCut) {
    if (i.plan.exists && !i.plan.approved) return { text: "approve the plan", go: "script" };
    return { text: "ask for cut 1", go: i.plan.exists ? (i.planPage ?? null) : null };
  }
  if (i.openNotes > 0) return { text: `${counted(i.openNotes, "note")} open`, go: "picture" };
  if (!i.locked) return { text: "lock picture", go: "picture" };
  // One sound at a time: voice is settled before music is asked for.
  for (const stage of ["voice", "music", "sfx"] as const) {
    const s = i.sound[stage];
    const w = SOUND_WORDS[stage];
    if (!s.started) return { text: w.ask, go: null };
    if (s.fresh > 0) return { text: `choose ${w.one}`, go: stage };
    if (s.inUse && s.stale) return { text: `the ${w.one.replace(/^an? /, "")} in use was made for an older cut`, go: stage };
  }
  return { text: "nothing to do", go: null };
}

/**
 * §27, 5.7: what a new note is about, as the selection says. A take carries `tOut` when a range is marked on it, and the
 * whole mix a time when the note is at a moment of it; neither field is needed for the rest.
 */
export type Selection =
  | { kind: "frame"; t: number }
  | { kind: "range"; t: number; tOut: number }
  | { kind: "shot"; n: number; name: string; t: number }
  | { kind: "take"; stage: LaneStage; on: string; name: string; t: number | null; tOut?: number | null }
  | { kind: "mix"; t?: number | null; tOut?: number | null }
  | { kind: "line"; id: string; label: string };

export interface NoteTarget {
  stage: Stage;
  on: string | null;
  scope: "point" | "range" | "whole";
  t: number | null;
  tOut: number | null;
  /** The note box's target line: "00:00:11:00 · 03 The scan", "Voice · George · retimed", "The whole mix". */
  label: string;
}

const two = (n: number) => String(n).padStart(2, "0");

/** Hours, minutes, seconds and frames: "00:00:11:00", at the nearest frame. */
export function timecode(t: number, fps: number): string {
  const rate = Math.max(1, Math.round(fps));
  const frames = Math.round(Math.max(0, t) * rate);
  const f = frames % rate;
  const s = Math.floor(frames / rate);
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}:${two(f)}`;
}

const SOUND_NAMES: Record<LaneStage, string> = { voice: "Voice", music: "Music", sfx: "Effects" };

/** The stage, `on`, scope and times a note is saved with for a selection, and the words that name it. `shot` is the shot at the time. */
export function noteTarget(s: Selection, shot: { n: number; name: string } | null, fps = 30): NoteTarget {
  const tc = (t: number) => timecode(t, fps);
  const when = (t: number | null | undefined, tOut: number | null | undefined) => (t == null ? null : tOut == null ? tc(t) : `${tc(t)}–${tc(tOut)}`);
  const timed = (t: number | null | undefined, tOut: number | null | undefined) => ({
    scope: (t == null ? "whole" : tOut == null ? "point" : "range") as NoteTarget["scope"],
    t: t ?? null,
    tOut: t == null ? null : (tOut ?? null),
  });
  const named = (shotHere: { n: number; name: string } | null) => (shotHere ? ` · ${two(shotHere.n)} ${shotHere.name}` : "");
  switch (s.kind) {
    case "frame":
      return { stage: "picture", on: null, scope: "point", t: s.t, tOut: null, label: `${tc(s.t)}${named(shot)}` };
    case "range":
      return { stage: "picture", on: null, scope: "range", t: s.t, tOut: s.tOut, label: `${when(s.t, s.tOut)}${named(shot)}` };
    case "shot":
      return { stage: "picture", on: null, scope: "point", t: s.t, tOut: null, label: `${tc(s.t)}${named(s)}` };
    case "take": {
      const at = when(s.t, s.tOut);
      return { stage: s.stage, on: s.on, ...timed(s.t, s.tOut), label: `${at ? `${at} · ` : ""}${SOUND_NAMES[s.stage]} · ${s.name}` };
    }
    case "mix": {
      const at = when(s.t, s.tOut);
      return { stage: "mix", on: null, ...timed(s.t, s.tOut), label: `${at ? `${at} · ` : ""}The whole mix` };
    }
    case "line":
      return { stage: "script", on: s.id, scope: "whole", t: null, tOut: null, label: s.label };
  }
}

type Unsent = { notes: Note[]; inPlay: ReadonlySet<string>; scriptTodo: number; briefChanged: number; storyboardChanged: number };
const waitingNote = (i: Unsent) => (n: Note) => n.status === "todo" && (!n.video || i.inPlay.has(n.video));

/** Of what waits to be sent, the edits that are not notes: changed script lines, the brief's and the storyboard's changes. */
export function unsentEdits(i: Unsent): number {
  const waiting = waitingNote(i);
  const scriptRows = i.scriptTodo - i.notes.filter((n) => n.stage === "script" && waiting(n)).length;
  return Math.max(0, scriptRows) + i.briefChanged + i.storyboardChanged;
}

/**
 * What Send would send that has not been sent yet (§27, 5.7 and 5.9): to-do notes with no batch (on films in play, or on
 * no film), the changed script rows (the script tab's to-do less its own notes), and the brief's and storyboard's
 * changes. Send's count and the status bar's line are this one number.
 */
export function unsentCount(i: Unsent): number {
  const waiting = waitingNote(i);
  return i.notes.filter((n) => waiting(n) && n.batch === null).length + unsentEdits(i);
}

/**
 * §27, 5.5 and 5.7 (ruled in the final review, I4): a note is to do (amber), sent (blue: a to-do note in a batch Send
 * made, so the agent has it) or done (green). A sent note is still to do: the To do filter keeps it.
 */
export type NoteState = "todo" | "sent" | "done";
export function noteState(n: Pick<Note, "status" | "batch">): NoteState {
  return n.status === "done" ? "done" : n.batch !== null ? "sent" : "todo";
}
/** Each state in words, for a marker's or a dot's name and tooltip. */
export const NOTE_STATE_LABEL: Record<NoteState, string> = { todo: "To do", sent: "With your agent", done: "Done" };
/** A marker's name and tooltip: the note's text, after "With your agent · " while the agent has it. */
export const markTitle = (state: NoteState, text: string): string => (state === "sent" ? `${NOTE_STATE_LABEL.sent} · ${text}` : text);

/** A note's marker on the ruler: where it starts and, for a range, how wide, as percentages of the cut. */
export interface RulerMark {
  id: string;
  left: number;
  width: number | null;
  status: NoteState;
}

/** A time as a percentage of `length`, clamped to the timeline (0 to 100), whatever the file on screen reports; 0 with no length. */
export const pctOf = (s: number, length: number): number => (length > 0 ? Math.min(100, Math.max(0, (s / length) * 100)) : 0);

/** The ruler's markers, one per note with a time (placed on the cut on screen by the caller), clamped to the cut. */
export function rulerMarks(notes: Note[], length: number): RulerMark[] {
  return notes
    .filter((n) => n.t !== null)
    .map((n) => {
      const left = pctOf(n.t!, length);
      return { id: n.id, left, width: n.tOut !== null ? pctOf(n.tOut, length) - left : null, status: noteState(n) };
    });
}
