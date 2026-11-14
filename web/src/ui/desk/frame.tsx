// §27, 5.4 and 5.5: what the Timeline tab and each sound's tab share around the monitor: the player's level and mute,
// remembered per browser, and the divider that sets the timeline panel's share of the column (moved here from Picture).
import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

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

function readSplit(): number | null {
  try {
    const n = Number(localStorage.getItem(SPLIT_KEY));
    return localStorage.getItem(SPLIT_KEY) !== null && Number.isFinite(n) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, n)) : null;
  } catch {
    return null;
  }
}

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
