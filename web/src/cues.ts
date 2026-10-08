// §23: pure helpers for a pass's cues on Sound effects -- time order, layers by sound, the card's
// words and where it goes, and the keys that walk a row of cues. No DOM, so they're unit-tested in Node.
import { fmt } from "./lib.js";

/** A cue as the lanes draw it: the stored cue, with its optional source file (§23.3). */
export interface CueLike {
  id: string;
  name: string;
  t: number;
  file?: string;
}

/** The cues in time order; cues at the same time keep the order they were sent in. */
export function cuesInTime<C extends CueLike>(cues: readonly C[]): C[] {
  return cues
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.t - b.c.t || a.i - b.i)
    .map((x) => x.c);
}

/** The name a cue is shown and grouped by: as sent, trimmed; "Untitled cue" when that leaves nothing. */
export function cueName(c: Pick<CueLike, "name">): string {
  return c.name.trim() || "Untitled cue";
}

/** A cue's accessible name, on its label and its ticks: "thud at 0:04.20". */
export function cueLabel(c: Pick<CueLike, "name" | "t">): string {
  return `${cueName(c)} at ${fmt(c.t)}`;
}

/** "cue 5 of 80". */
export function cueCount(n: number, of: number): string {
  return `cue ${n} of ${of}`;
}

/** One layer by sound (§23.2): every cue with one name, in time order, and the sample they name. */
export interface CueLayer<C extends CueLike = CueLike> {
  name: string;
  cues: C[];
  /** The first file its cues name, in time order, or null. */
  file: string | null;
  /** How many other files its cues name. */
  moreFiles: number;
}

/** The layers by sound: one per distinct name (cueName), in order of first appearance in time. */
export function cueLayers<C extends CueLike>(cues: readonly C[]): CueLayer<C>[] {
  const layers = new Map<string, CueLayer<C>>();
  for (const c of cuesInTime(cues)) {
    const name = cueName(c);
    let layer = layers.get(name);
    if (!layer) {
      layer = { name, cues: [], file: null, moreFiles: 0 };
      layers.set(name, layer);
    }
    layer.cues.push(c);
  }
  for (const layer of layers.values()) {
    const files = [...new Set(layer.cues.flatMap((c) => (c.file ? [c.file] : [])))];
    layer.file = files[0] ?? null;
    layer.moreFiles = Math.max(0, files.length - 1);
  }
  return [...layers.values()];
}

/** Where ←, →, Home and End move from cue `i` of `n`; null for any other key. Never wraps. */
export function rovingIndex(key: string, i: number, n: number): number | null {
  if (n <= 0) return null;
  if (key === "ArrowLeft") return Math.max(0, i - 1);
  if (key === "ArrowRight") return Math.min(n - 1, i + 1);
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return null;
}

/** The last part of a path, for the layer's file button. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** A layer tick's left edge: its time as a share of the timeline, kept on the track (ruling R16). */
export function tickLeft(t: number, length: number): string {
  const share = length > 0 ? Math.min(1, Math.max(0, t / length)) : 0;
  return `${(share * 100).toFixed(3)}%`;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where the hover card goes (§23.5): under its cue, centred on it, 8 px away; above it when
 * there's no room below; always at least 16 px inside the window.
 */
export function cardPosition(anchor: Box, card: { width: number; height: number }, view: { width: number; height: number }): { left: number; top: number } {
  const GAP = 8;
  const EDGE = 16;
  const centred = anchor.left + anchor.width / 2 - card.width / 2;
  const left = Math.max(EDGE, Math.min(centred, view.width - EDGE - card.width));
  const below = anchor.top + anchor.height + GAP;
  const top = below + card.height <= view.height - EDGE ? below : Math.max(EDGE, anchor.top - GAP - card.height);
  return { left: Math.round(left), top: Math.round(top) };
}
