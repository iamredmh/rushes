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

export function viewForTab(tab: ReviewTab): DeskView {
  return tab === "timeline" ? "picture" : tab;
}

/** One read, bed or pass as a sound's tab lists it. */
export interface TakeRow {
  lane: string;
  /** The round's name (its lane's). */
  round: string;
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

/** A sound's takes in the order its tab shows them. `lanes` are the film's own (filmLanes); `use` is its take in use for the sound. */
export function takeGroups(lanes: Lane[], stage: LaneStage, use: Use | undefined, video: Pick<Video, "id" | "versions"> | undefined): TakeGroups {
  const out: TakeGroups = { fresh: [], inUse: null, earlier: [], away: [] };
  const rounds = lanes.filter((l) => l.stage === stage);
  for (let i = rounds.length - 1; i >= 0; i--) {
    const l = rounds[i];
    const rest: TakeRow[] = [];
    for (const variant of l.variants) {
      const inUse = use !== undefined && use.lane === l.id && use.variant === variant.id;
      const row: TakeRow = {
        lane: l.id,
        round: l.name,
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
    if (rest.length > 0) out.earlier.push({ round: l.name, takes: rest });
  }
  return out;
}

export function takeCount(g: TakeGroups): { all: number; fresh: number } {
  const earlier = g.earlier.reduce((n, r) => n + r.takes.length, 0);
  return { all: g.fresh.length + (g.inUse ? 1 : 0) + earlier + g.away.length, fresh: g.fresh.length };
}

export interface NextInput {
  plan: { exists: boolean; approved: boolean };
  hasCut: boolean;
  /** Notes and edits waiting to be sent. */
  unsent: number;
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
 * leads, or null when the step is not somewhere on the desk (asking the agent, pressing Send).
 */
export function nextHint(i: NextInput): { text: string; go: DeskView | null } {
  if (!i.hasCut) return i.plan.exists && !i.plan.approved ? { text: "approve the plan", go: "script" } : { text: "ask for cut 1", go: null };
  if (i.unsent > 0) return { text: `send ${counted(i.unsent, "note")}`, go: null };
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

/** A note's marker on the ruler: where it starts and, for a range, how wide, as percentages of the cut. */
export interface RulerMark {
  id: string;
  left: number;
  width: number | null;
  status: "todo" | "done";
}

const clampPct = (s: number, length: number) => (length > 0 ? Math.min(100, Math.max(0, (s / length) * 100)) : 0);

/** The ruler's markers, one per note with a time (placed on the cut on screen by the caller), clamped to the cut. */
export function rulerMarks(notes: Note[], length: number): RulerMark[] {
  return notes
    .filter((n) => n.t !== null)
    .map((n) => {
      const left = clampPct(n.t!, length);
      return { id: n.id, left, width: n.tOut !== null ? clampPct(n.tOut, length) - left : null, status: n.status };
    });
}
