// The Timeline tab's rows (Red, 16 Nov 2026, after Premiere): each track's height can be dragged at its foot, and Fit
// shares the panel's height between them again. And the stretch of the cut the lanes show, zoomed with the bar under
// them, paging to follow the playhead.
import { useEffect, useRef, useState } from "preact/hooks";
import { clampView, followView, fullView, isFull, type TimeView } from "../../desk.js";

/** The rows' heights once one has been dragged, remembered per browser (none kept: the rows fit the panel). */
const HEIGHTS_KEY = "rushes:track-heights";
export const ROW_MIN = 24;
export const ROW_MAX = 480;

function readHeights(): Record<string, number> | null {
  try {
    const v = JSON.parse(localStorage.getItem(HEIGHTS_KEY) ?? "null") as unknown;
    if (!v || typeof v !== "object") return null;
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n === "number" && Number.isFinite(n)) out[k] = Math.min(ROW_MAX, Math.max(ROW_MIN, Math.round(n)));
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

function keepHeights(h: Record<string, number> | null): void {
  try {
    if (h === null) localStorage.removeItem(HEIGHTS_KEY);
    else localStorage.setItem(HEIGHTS_KEY, JSON.stringify(h));
  } catch {
    // Storage refused (a private window): the heights hold for this visit only.
  }
}

export interface TrackHeights {
  /** Each row's height in px once one has been dragged; null while the rows fit the panel. */
  heights: Record<string, number> | null;
  /** The rows' box: their heights are read from it when a drag starts from Fit. */
  box: { current: HTMLDivElement | null };
  /** The style for a row: its height once sized, nothing while the rows fit. */
  style(row: string): Record<string, string> | undefined;
  /** Back to fitting the panel. */
  fit(): void;
  /** The rows' heights as they are on screen now. */
  measure(): Record<string, number>;
  /** Sets the heights (`save`: remembered, at the end of a drag). */
  set(h: Record<string, number>, save: boolean): void;
}

export function useTrackHeights(): TrackHeights {
  const [heights, setHeights] = useState(readHeights);
  const box = useRef<HTMLDivElement>(null);
  const measure = () => {
    const out: Record<string, number> = {};
    box.current?.querySelectorAll<HTMLElement>("[data-row]").forEach((el) => {
      out[el.dataset.row!] = Math.round(el.getBoundingClientRect().height);
    });
    return out;
  };
  return {
    heights,
    box,
    measure,
    style: (row) => (heights && heights[row] ? { height: `${heights[row]}px` } : undefined),
    fit: () => {
      setHeights(null);
      keepHeights(null);
    },
    set: (h, save) => {
      setHeights(h);
      if (save) keepHeights(h);
    },
  };
}

/**
 * The stretch of the cut on screen: the whole cut until zoomed. A new cut (another length) starts whole again. While the
 * playhead moves past either edge, the view pages to keep it on screen. `t` null: the caller pages it itself with
 * `follow(t)` (the sound tabs, whose playhead never re-renders them).
 */
export interface TimeViewState {
  view: TimeView;
  zoomed: boolean;
  set(v: TimeView | null): void;
  /** Pages the view to keep `t` on screen (only while zoomed). */
  follow(t: number): void;
}

export function useTimeView(duration: number, t: number | null, cut: string): TimeViewState {
  const [kept, setKept] = useState<TimeView | null>(null);
  useEffect(() => setKept(null), [duration, cut]);
  const view = kept && duration > 0 ? clampView(kept, duration) : fullView(duration);
  const set = (v: TimeView | null) => setKept(v === null || isFull(v, duration) ? null : clampView(v, duration));
  const follow = (at: number) => {
    if (!kept) return;
    const next = followView(view, duration, at);
    if (next !== view) setKept(next);
  };
  // Paging: only while zoomed, and only when the playhead itself moves (a pan away while paused stays where it is put).
  const last = useRef(t);
  useEffect(() => {
    if (t === null || last.current === t) return;
    last.current = t;
    follow(t);
  }, [t]);
  return { view, zoomed: kept !== null, set, follow };
}
