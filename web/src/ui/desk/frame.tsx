// §27, 5.4 and 5.5: what the Timeline tab and each sound's tab share around the monitor: the player's level and mute,
// remembered per browser, and the divider that sets the timeline panel's share of the column (moved here from Picture).
import type { RefObject } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { NOTES_ROOM, PREVIEW_KEY, PREVIEW_MAX, PREVIEW_MIN, readShare } from "./share.js";

/**
 * §27, 5.5 (final review I3): the film's one playhead across the Review tabs (Timeline, Voice, Music, Effects). The desk
 * keeps where each film's playhead is; a tab starts there when it mounts, and leaves its own time there when it goes.
 */
export interface ReviewClock {
  /** Where `film`'s playhead is, in seconds ("" for a project with no film). */
  at(film: string): number;
  /** The mounted tab's live time for `film`, for the desk to read at a film switch. Returns the detach, which leaves the
   *  tab's time as the film's playhead. */
  attach(film: string, read: () => number): () => void;
}

/**
 * Hands the desk this tab's live time while it is mounted on `film`, and leaves it behind when the tab goes or the film
 * changes. Call it before the hook that owns the clock (its cleanup must read the time before the clock is disposed).
 */
export function useReviewClock(clock: ReviewClock | undefined, film: string, read: () => number): void {
  const latest = useRef(read);
  latest.current = read;
  useLayoutEffect(() => clock?.attach(film, () => latest.current()), [clock, film]);
}

/** §27, 5.5: the player's level and mute, remembered per browser. */
const VOLUME_KEY = "rushes:volume";
/** §27, 5.4: the timeline panel's share of the column once its divider has been dragged, remembered per browser. */
const SPLIT_KEY = "rushes:split";
/** The timeline panel never takes more than this share of the column, nor less than the ruler needs. */
const SPLIT_MAX = 0.55;
const SPLIT_MIN = 0.08;

function readVolume(): { level: number; muted: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? "null") as { level?: unknown; muted?: unknown } | null;
    const level = typeof v?.level === "number" && Number.isFinite(v.level) ? Math.min(1, Math.max(0, v.level)) : 1;
    return { level, muted: v?.muted === true };
  } catch {
    return { level: 1, muted: false };
  }
}

const readSplit = () => readShare(SPLIT_KEY, SPLIT_MIN, SPLIT_MAX);

function remember(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage refused (a private window): the setting holds for this visit only.
  }
}

/** The transport's level and mute, remembered per browser. */
export function useVolume(): [{ level: number; muted: boolean }, (sound: { level: number; muted: boolean }) => void] {
  const [sound, setSound] = useState(readVolume);
  useEffect(() => remember(VOLUME_KEY, JSON.stringify(sound)), [sound]);
  return [sound, setSound];
}

/** The timeline panel's share of the column (null: as tall as its rows, up to the cap), remembered once dragged. */
export function useSplit(): { split: number | null; keep(to: number | null): void; set(to: number): void } {
  const [split, setSplit] = useState(readSplit);
  return {
    split,
    set: setSplit,
    keep: (to) => {
      setSplit(to);
      remember(SPLIT_KEY, to === null ? null : String(Math.round(to * 1000) / 1000));
    },
  };
}

/** The preview's share of the sound tab's right column (null: the cut's shape at the column's width, up to 45%). */
export function usePreviewSize(): { size: number | null; keep(to: number | null): void; set(to: number): void } {
  const [size, setSize] = useState(() => readShare(PREVIEW_KEY, PREVIEW_MIN, PREVIEW_MAX));
  return {
    size,
    set: setSize,
    keep: (to) => {
      setSize(to);
      remember(PREVIEW_KEY, to === null ? null : String(Math.round(to * 1000) / 1000));
    },
  };
}

/**
 * The line under a sound tab's preview: dragging it down makes the picture bigger, up smaller (PREVIEW_MIN to
 * PREVIEW_MAX of the column, and never into the notes panel's NOTES_ROOM); the arrow keys move it, a double-click puts it back. The right column widens to keep the
 * cut's shape (desk.css, up to half the window), and the notes panel takes the rest.
 */
export function PreviewDivider({ column, preview, size }: { column: RefObject<HTMLElement>; preview: RefObject<HTMLElement>; size: ReturnType<typeof usePreviewSize> }) {
  const drag = useRef<{ top: number; height: number } | null>(null);
  // Never into the notes panel's room (Red, round 2): the most is what leaves NOTES_ROOM under the preview.
  const most = (): number => {
    const h = column.current?.getBoundingClientRect().height ?? 0;
    return h > 0 ? Math.max(PREVIEW_MIN, Math.min(PREVIEW_MAX, (h - NOTES_ROOM) / h)) : PREVIEW_MAX;
  };
  const clamp = (n: number) => Math.min(most(), Math.max(PREVIEW_MIN, n));
  const at = (clientY: number): number | null => {
    const d = drag.current;
    if (!d || d.height <= 0) return null;
    // The divider's middle sits 4 px under the preview's foot.
    const to = clamp((clientY - 4 - d.top) / d.height);
    size.set(to);
    return to;
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    if (size.size !== null) size.keep(size.size);
  };
  const current = (): number => {
    const col = column.current?.getBoundingClientRect();
    const pv = preview.current?.getBoundingClientRect();
    return col && pv && col.height > 0 ? pv.height / col.height : PREVIEW_MIN;
  };
  return (
    <div
      class="pvsplit"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the preview"
      aria-valuemin={Math.round(PREVIEW_MIN * 100)}
      aria-valuemax={Math.round(most() * 100)}
      aria-valuenow={Math.round(Math.min(most(), size.size ?? current()) * 100)}
      tabIndex={0}
      onPointerDown={(e) => {
        const col = column.current;
        if (!col || e.button !== 0) return;
        const r = col.getBoundingClientRect();
        drag.current = { top: r.top, height: r.height };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => at(e.clientY)}
      onPointerUp={(e) => {
        const to = at(e.clientY);
        drag.current = null;
        if (to !== null) size.keep(to);
      }}
      onPointerCancel={() => end()}
      onLostPointerCapture={() => end()}
      onDblClick={() => size.keep(null)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        e.stopPropagation();
        size.keep(clamp((size.size ?? current()) + (e.key === "ArrowDown" ? 0.03 : -0.03)));
      }}
    />
  );
}

/** The panel's style for a share of the column, and its class. */
export function splitPanel(split: number | null, base = "tlpanel"): { class: string; style: Record<string, string> | undefined } {
  return { class: `${base}${split === null ? "" : " sized"}`, style: split === null ? undefined : { height: `${split * 100}%` } };
}

/** §27, 5.4: dragging the divider sets the timeline panel's share of the column, from SPLIT_MIN to SPLIT_MAX; double-click resets. */
export function SplitDivider({ column, split }: { column: RefObject<HTMLElement>; split: ReturnType<typeof useSplit> }) {
  const drag = useRef<{ top: number; height: number } | null>(null);
  const at = (clientY: number): number | null => {
    const d = drag.current;
    if (!d || d.height <= 0) return null;
    const to = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, (d.top + d.height - clientY) / d.height));
    split.set(to);
    return to;
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    if (split.split !== null) split.keep(split.split);
  };
  return (
    <div
      class="tlsplit"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the timeline"
      aria-valuemin={Math.round(SPLIT_MIN * 100)}
      aria-valuemax={Math.round(SPLIT_MAX * 100)}
      aria-valuenow={split.split === null ? undefined : Math.round(split.split * 100)}
      tabIndex={0}
      onPointerDown={(e) => {
        const col = column.current;
        if (!col || e.button !== 0) return;
        const r = col.getBoundingClientRect();
        drag.current = { top: r.top, height: r.height };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => at(e.clientY)}
      onPointerUp={(e) => {
        const to = at(e.clientY);
        drag.current = null;
        if (to !== null) split.keep(to);
      }}
      // A drag the browser takes away ends where it was, remembered as a drag let go there would be; never left armed.
      onPointerCancel={() => end()}
      onLostPointerCapture={() => end()}
      onDblClick={() => split.keep(null)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        const col = column.current;
        const panel = col?.querySelector<HTMLElement>(".tlpanel");
        const from = split.split ?? (col && panel ? panel.getBoundingClientRect().height / col.getBoundingClientRect().height : SPLIT_MIN);
        split.keep(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, from + (e.key === "ArrowUp" ? 0.03 : -0.03))));
      }}
    />
  );
}
