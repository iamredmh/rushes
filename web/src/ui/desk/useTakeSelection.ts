// §27, 5.7: a take picked on its sound row as the next note's target, shared by the Timeline tab with and without a cut.
// Its name picks the whole take; a click on its block picks that point (and the playhead goes there). A take that stops
// being in use (unpicked here, by the agent or in another tab) lets go.
import { useEffect, useState } from "preact/hooks";
import type { Selection } from "../../desk.js";
import { MIX_STAGE, snap, type MixLane } from "../../lib.js";
import type { Note, Video } from "../../types.js";
import { type Mix, type SoundRow, takeOn } from "./useMix.js";

export type TakeSelection = Extract<Selection, { kind: "take" }>;

export interface TakeSelectionState {
  /** The take picked, with the time clicked (null: the whole take). */
  takeSel: TakeSelection | null;
  clear(): void;
  /** The row the picked take is on, for its highlight. */
  selected: MixLane | null;
  /** The notes on the takes in use on this film: listed with the tab's own, and marked on their rows. */
  takeNotes: Note[];
  /** SoundTracks' onPick: `at` is the time clicked, or null for the row's name. */
  pick(row: SoundRow, at: number | null): void;
}

/** `seek` moves the clock (pausing it first); `onGone` runs when the picked take is no longer in use. */
export function useTakeSelection(mix: Mix, notes: Note[], video: Pick<Video, "id"> | null, fps: number, seek: (t: number) => void, onGone?: () => void): TakeSelectionState {
  const [takeSel, setTakeSel] = useState<TakeSelection | null>(null);
  const rowOf = (sel: TakeSelection) => mix.rows.find((r) => r.take && takeOn(r.take) === sel.on) ?? null;
  const gone = takeSel !== null && rowOf(takeSel) === null;
  useEffect(() => {
    if (!gone) return;
    setTakeSel(null);
    onGone?.();
  }, [gone]);
  return {
    takeSel,
    clear: () => setTakeSel(null),
    selected: takeSel ? (rowOf(takeSel)?.lane ?? null) : null,
    takeNotes: notes.filter((n) => (n.stage === "voice" || n.stage === "music" || n.stage === "sfx") && (!n.video || n.video === video?.id) && mix.noteRow(n) !== null),
    pick: (row, at) => {
      const take = row.take!;
      const to = at === null ? null : snap(at, fps);
      setTakeSel({ kind: "take", stage: MIX_STAGE[row.lane], on: takeOn(take), name: take.variant.name, t: to });
      if (to !== null) seek(to);
    },
  };
}
