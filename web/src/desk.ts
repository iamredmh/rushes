// §27: the desk's own logic, pure. Where a view sits in the workspaces, what the number keys open,
// and how a sound's takes are grouped.
import { madeForStale, takeState } from "../../src/core/takes.js";
import { NOTE_STATE_LABEL, noteState, type NoteState } from "../../src/core/noteState.js";
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
        // The server's own answer (src/core/takes.ts), so the lists and an agent's rushes_get_picks agree.
        const state = takeState(variant, l.id, use);
        const inUse = state === "in-use";
        const row: TakeRow = {
          lane: l.id,
          round: part.round,
          roundKey: `${l.id}\n${part.key}`,
          variant,
          madeFor: (video && variant.madeFor?.[video.id]) ?? null,
          stale: video ? madeForStale(variant, video) : false,
          inUse,
        };
        if (state === "in-use") out.inUse = row;
        else if (state === "put-away") out.away.push(row);
        else if (state === "new") out.fresh.push(row);
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
  /** The label's two parts (final review I6): its time ("00:00:11:00", a range "00:00:01:00–00:00:02:00"), beside the
   *  target menu, or null; and what the note is on, by name ("03 The scan", "Voice · George · retimed"), on its own line. */
  when: string | null;
  name: string;
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
  const named = (shotHere: { n: number; name: string } | null) => (shotHere ? `${two(shotHere.n)} ${shotHere.name}` : "");
  /** The label from its time and its name, " · " between them when it has both. */
  const parts = (at: string | null, name: string) => ({ label: at && name ? `${at} · ${name}` : (at ?? name), when: at, name });
  switch (s.kind) {
    case "frame":
      return { stage: "picture", on: null, scope: "point", t: s.t, tOut: null, ...parts(tc(s.t), named(shot)) };
    case "range":
      return { stage: "picture", on: null, scope: "range", t: s.t, tOut: s.tOut, ...parts(when(s.t, s.tOut), named(shot)) };
    case "shot":
      return { stage: "picture", on: null, scope: "point", t: s.t, tOut: null, ...parts(tc(s.t), named(s)) };
    case "take":
      return { stage: s.stage, on: s.on, ...timed(s.t, s.tOut), ...parts(when(s.t, s.tOut), `${SOUND_NAMES[s.stage]} · ${s.name}`) };
    case "mix":
      return { stage: "mix", on: null, ...timed(s.t, s.tOut), ...parts(when(s.t, s.tOut), "The whole mix") };
    case "line":
      return { stage: "script", on: s.id, scope: "whole", t: null, tOut: null, ...parts(null, s.label) };
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
 * made, so the agent has it) or done (green). A sent note is still to do: the To do filter keeps it. The lifecycle is the
 * server's own (src/core/noteState.ts), so the desk, the server and an agent read the same state.
 */
export { NOTE_STATE_LABEL, noteState, type NoteState } from "../../src/core/noteState.js";
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

/** The ruler's markers, one per note with a time (placed on the cut on screen by the caller), clamped to the cut. With a
 *  `view` (the timeline zoomed in), the percentages are of the stretch on screen. */
export function rulerMarks(notes: Note[], length: number, view?: TimeView): RulerMark[] {
  const at = (s: number) => (view ? viewPct(Math.min(length, Math.max(0, s)), view) : pctOf(s, length));
  return notes
    .filter((n) => n.t !== null)
    .map((n) => {
      const left = at(n.t!);
      return { id: n.id, left, width: n.tOut !== null ? at(n.tOut) - left : null, status: noteState(n) };
    });
}

/**
 * The stretch of the cut the timeline shows, in seconds: the whole cut, or less once zoomed in (Red, 16 Nov: Premiere's
 * zoom bar under the timeline). Every lane places its marks with `viewPct`, so they all zoom and scroll together.
 */
export interface TimeView {
  start: number;
  end: number;
}

/** The shortest stretch the timeline zooms in to: two seconds, or the whole cut when it is shorter. */
export const minSpan = (length: number): number => Math.min(length, 2);

/** The whole cut. */
export const fullView = (length: number): TimeView => ({ start: 0, end: Math.max(0, length) });

/** True when the view shows the whole cut. */
export const isFull = (v: TimeView, length: number): boolean => v.start <= 1e-6 && v.end >= length - 1e-6;

/**
 * A time as a percentage across the stretch on screen. Not clamped to 0 to 100 (a mark off screen sits past the lane's
 * edge, which clips it), only to a little either side so a long range's width stays right.
 */
export function viewPct(s: number, v: TimeView): number {
  const span = v.end - v.start;
  if (!(span > 0)) return 0;
  return Math.min(110, Math.max(-10, ((s - v.start) / span) * 100));
}

/** The time under a point `frac` (0 to 1) across the lane. */
export const viewTime = (frac: number, v: TimeView): number => v.start + Math.min(1, Math.max(0, frac)) * (v.end - v.start);

/** A view held inside the cut, at least `minSpan` long, its length kept when it is only moved. */
export function clampView(v: TimeView, length: number): TimeView {
  if (!(length > 0)) return fullView(0);
  const span = Math.min(length, Math.max(minSpan(length), v.end - v.start));
  const start = Math.min(length - span, Math.max(0, v.start));
  return { start, end: start + span };
}

/** Zoomed by `factor` (under 1 zooms in) about the time `anchor`, which stays where it is on screen. */
export function zoomView(v: TimeView, length: number, factor: number, anchor = (v.start + v.end) / 2): TimeView {
  const span = Math.min(length, Math.max(minSpan(length), (v.end - v.start) * factor));
  const frac = v.end > v.start ? (anchor - v.start) / (v.end - v.start) : 0.5;
  return clampView({ start: anchor - frac * span, end: anchor - frac * span + span }, length);
}

/** Moved along the cut by `by` seconds, its length kept. */
export const panView = (v: TimeView, length: number, by: number): TimeView => clampView({ start: v.start + by, end: v.end + by }, length);

/**
 * Where the view goes so the playhead `t` stays on screen, as Premiere pages: past the right edge, the next page starts at
 * the playhead; before the left edge (a jump back), the playhead lands a tenth of the way in. A playhead already on
 * screen leaves the view as it is.
 */
export function followView(v: TimeView, length: number, t: number): TimeView {
  if (t >= v.start && t <= v.end) return v;
  const span = v.end - v.start;
  return clampView(t > v.end ? { start: t, end: t + span } : { start: t - span * 0.1, end: t + span * 0.9 }, length);
}
