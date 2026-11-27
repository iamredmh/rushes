// §35.3: the Timeline lists the film's notes from every tab. Its own are the Picture and Mix notes (and those on the
// takes in use); these helpers add the rest of the film's Voice, Music and Effects notes and the shared Visuals notes,
// each with a small tab label. Pure: the Timeline, the no-cut timeline and the sound tabs' "All tabs" switch share it.
import type { Note, Project } from "./types.js";

/** The tabs a note may come from, as the desk names them. */
export const TAB_NAMES: Readonly<Record<Note["stage"], string>> = {
  script: "Script",
  picture: "Picture",
  mix: "Mix",
  voice: "Voice",
  music: "Music",
  sfx: "Effects",
  visuals: "Visuals",
  storyboard: "Storyboard",
};

/** The tabs whose notes are a take's: their `on` is "<lane>/<variant>", or "<lane>/<variant>:<cue>". */
const TAKE_TABS: ReadonlySet<Note["stage"]> = new Set(["voice", "music", "sfx"]);

/**
 * The notes from the other tabs that the Timeline adds to its own: every Voice, Music and Effects note, and every
 * Visuals note. `notes` is already the selected film's (scopeState, §31), so nothing from another film comes in.
 * Script notes stay on Plan.
 */
export function otherTabNotes(notes: readonly Note[]): Note[] {
  return notes.filter((n) => TAKE_TABS.has(n.stage) || n.stage === "visuals");
}

/** The list as the Timeline shows it: its own notes, then the other tabs', with none twice. */
export function timelineNotes(own: readonly Note[], notes: readonly Note[]): Note[] {
  const ids = new Set(own.map((n) => n.id));
  return [...own, ...otherTabNotes(notes).filter((n) => !ids.has(n.id))];
}

/** The take a note's `on` names, by its lane and variant ids, or null for an older form that names none. */
function takeOf(n: Pick<Note, "on">, lanes: Project["lanes"]): { lane: Project["lanes"][number]; name: string } | null {
  if (!n.on) return null;
  const [laneId, rest] = n.on.split("/", 2);
  if (rest === undefined) return null;
  const variantId = rest.split(":", 1)[0];
  const lane = lanes.find((l) => l.id === laneId);
  const variant = lane?.variants.find((v) => v.id === variantId);
  return lane && variant ? { lane, name: variant.name } : null;
}

/**
 * The tab label on a note from another tab: "Voice · Eliza, read 3", "Music · Bed B", "Effects · Pass 2", "Visuals ·
 * Shared". A take that isn't the one in use on its row reads "(not in use)". A Picture note has none (it is the
 * Timeline's own); `own` gives a Mix note's, or a take in use's, label as the Timeline already words it.
 */
export function tabLabel(n: Note, lanes: Project["lanes"], inUse: (n: Note) => boolean, own?: (n: Note) => string | null): string | null {
  if (n.stage === "picture" || n.stage === "script") return null;
  if (n.stage === "mix") return own?.(n) ?? null;
  if (n.stage === "visuals") return `${TAB_NAMES.visuals} · Shared`;
  if (inUse(n)) return own?.(n) ?? labelOf(n, lanes, false);
  return labelOf(n, lanes, true);
}

function labelOf(n: Note, lanes: Project["lanes"], notInUse: boolean): string {
  const take = takeOf(n, lanes);
  const tab = TAB_NAMES[n.stage];
  const named = take ? `${tab} · ${take.name}` : tab;
  return notInUse && take ? `${named} (not in use)` : named;
}

/** What each sound uses on a film, as the server works it out (§27.6): a take by its lane and variant ids. */
export type TakesInUse = Partial<Record<"voice" | "music" | "sfx", { lane: string; variant: string } | null | undefined>> | undefined | null;

/** Whether a note's take is the one in use for its sound on the film. */
export function onTakeInUse(n: Pick<Note, "stage" | "on">, use: TakesInUse): boolean {
  if (n.stage !== "voice" && n.stage !== "music" && n.stage !== "sfx") return false;
  const u = use?.[n.stage];
  if (!u || !n.on) return false;
  const [lane, rest] = n.on.split("/", 2);
  return rest !== undefined && lane === u.lane && rest.split(":", 1)[0] === u.variant;
}

/**
 * §35.3, the sound tabs' "All tabs" switch: the tab's own notes, then the film's notes from every other tab (Script
 * stays on Plan), with none twice.
 */
export function allTabNotes(own: readonly Note[], notes: readonly Note[]): Note[] {
  const ids = new Set(own.map((n) => n.id));
  return [...own, ...notes.filter((n) => n.stage !== "script" && !ids.has(n.id))];
}

/** The tab label on another tab's note, seen from a sound tab: "Picture", "Mix", "Music · Bed B (not in use)", "Visuals · Shared". */
export function otherTabLabel(n: Note, lanes: Project["lanes"], use: TakesInUse): string | null {
  if (n.stage === "picture" || n.stage === "mix") return TAB_NAMES[n.stage];
  return tabLabel(n, lanes, (x) => onTakeInUse(x, use));
}
