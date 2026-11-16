// Red, 16 Nov 2026, after Premiere: under the timeline, a bar for the stretch of the cut the lanes show. Drag its middle
// to move along the cut, either end to zoom; a double-click shows the whole cut again. And the handle at the foot of
// each track that sets its height.
import { useRef } from "preact/hooks";
import { clampView, minSpan, panView, type TimeView } from "../../desk.js";
import { ROW_MAX, ROW_MIN, type TrackHeights } from "./tracks.js";

export interface ZoomBarProps {
  view: TimeView;
  duration: number;
  t: number;
  onView(v: TimeView | null): void;
}

type Grip = "pan" | "start" | "end";

export function ZoomBar({ view, duration, t, onView }: ZoomBarProps) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ grip: Grip; x: number; v: TimeView; w: number } | null>(null);
  const pct = (s: number) => (duration > 0 ? (s / duration) * 100 : 0);
  const begin = (grip: Grip) => (e: PointerEvent) => {
    if (e.button !== 0 || !track.current || !(duration > 0)) return;
    e.stopPropagation();
    e.preventDefault();
    drag.current = { grip, x: e.clientX, v: view, w: track.current.getBoundingClientRect().width };
    track.current.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.w <= 0) return;
    const by = ((e.clientX - d.x) / d.w) * duration;
    const least = minSpan(duration);
    if (d.grip === "pan") onView(panView(d.v, duration, by));
    else if (d.grip === "start") onView(clampView({ start: Math.min(d.v.start + by, d.v.end - least), end: d.v.end }, duration));
    else onView(clampView({ start: d.v.start, end: Math.max(d.v.end + by, d.v.start + least) }, duration));
  };
  const span = view.end - view.start;
  return (
    <div class="zbar">
      <div
        class="ztrack"
        ref={track}
        onPointerDown={(e) => {
          // A press beside the thumb centres the view there.
          if (e.button !== 0 || !track.current || !(duration > 0)) return;
          const r = track.current.getBoundingClientRect();
          const at = ((e.clientX - r.left) / r.width) * duration;
          onView(clampView({ start: at - span / 2, end: at + span / 2 }, duration));
        }}
        onPointerMove={move}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onLostPointerCapture={() => (drag.current = null)}
      >
        <span class="zplay" style={{ left: `${pct(t)}%` }} aria-hidden="true" />
        <div
          class="zthumb"
          role="scrollbar"
          aria-label="Zoom and scroll the timeline. Drag the ends to zoom; double-click to show the whole cut"
          aria-orientation="horizontal"
          aria-controls="tltracks"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration * 10) / 10}
          aria-valuenow={Math.round(view.start * 10) / 10}
          tabIndex={0}
          data-tip="Drag to scroll · drag the ends to zoom · double-click for the whole cut"
          style={{ left: `${pct(view.start)}%`, width: `${pct(view.end) - pct(view.start)}%` }}
          onPointerDown={begin("pan")}
          onDblClick={() => onView(null)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            e.stopPropagation();
            onView(panView(view, duration, (e.key === "ArrowLeft" ? -1 : 1) * span * 0.25));
          }}
        >
          <span class="zgrip start" onPointerDown={begin("start")} onDblClick={(e) => { e.stopPropagation(); onView(null); }} />
          <span class="zgrip end" onPointerDown={begin("end")} onDblClick={(e) => { e.stopPropagation(); onView(null); }} />
        </div>
      </div>
    </div>
  );
}

/**
 * The line at a track's foot: drag it to set that track's height (the others keep theirs; the panel scrolls when they
 * outgrow it). Double-click, or Fit, shares the panel's height between the tracks again.
 */
export function RowSizer({ row, name, tracks }: { row: string; name: string; tracks: TrackHeights }) {
  const drag = useRef<{ y: number; base: Record<string, number> } | null>(null);
  const to = (base: Record<string, number>, h: number) => ({ ...base, [row]: Math.min(ROW_MAX, Math.max(ROW_MIN, Math.round(h))) });
  return (
    <div
      class="trsz"
      role="separator"
      aria-orientation="horizontal"
      aria-label={`${name} track height`}
      aria-valuemin={ROW_MIN}
      aria-valuemax={ROW_MAX}
      aria-valuenow={tracks.heights?.[row]}
      tabIndex={-1}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        drag.current = { y: e.clientY, base: tracks.heights ?? tracks.measure() };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) tracks.set(to(d.base, (d.base[row] ?? ROW_MIN) + e.clientY - d.y), false);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (d) tracks.set(to(d.base, (d.base[row] ?? ROW_MIN) + e.clientY - d.y), true);
      }}
      onPointerCancel={() => (drag.current = null)}
      onClick={(e) => e.stopPropagation()}
      onDblClick={(e) => {
        e.stopPropagation();
        tracks.fit();
      }}
    />
  );
}
