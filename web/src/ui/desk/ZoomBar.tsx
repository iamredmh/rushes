// Red, 16 Nov 2026, after Premiere: under the timeline, a bar for the stretch of the cut the lanes show. Drag its middle
// to move along the cut, either end to zoom; a double-click shows the whole cut again. And the handle at the foot of
// each track that sets its height.
import { useRef } from "preact/hooks";
import { clampView, minSpan, panView, type TimeView, viewTime, zoomView } from "../../desk.js";
import { Icon } from "../Icon.js";
import { ROW_MAX, ROW_MIN, type TimeViewState, type TrackHeights } from "./tracks.js";

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

/** The row under a timeline: zoom out, zoom in (about the playhead), and the bar. The Timeline tab and every sound's tab. */
export function ZoomRow({ tv, duration, t }: { tv: TimeViewState; duration: number; t: number }) {
  const press = (factor: number) => (e: MouseEvent) => {
    if (e.detail > 0) (e.currentTarget as HTMLElement).blur();
    tv.set(zoomView(tv.view, duration, factor, t));
  };
  return (
    <div class="trow zrow">
      <div class="thead">
        <button type="button" class="tbtn" data-tip="Zoom out · -" aria-label="Zoom out · -" disabled={!tv.zoomed} onClick={press(2)}>
          <Icon name="zoomout" />
        </button>
        <button type="button" class="tbtn" data-tip="Zoom in · =" aria-label="Zoom in · =" disabled={duration <= 0 || tv.view.end - tv.view.start <= Math.min(duration, 2) + 1e-6} onClick={press(0.5)}>
          <Icon name="zoomin" />
        </button>
      </div>
      <ZoomBar view={tv.view} duration={duration} t={t} onView={tv.set} />
    </div>
  );
}

/**
 * The wheel over a timeline: Ctrl/Cmd or Alt (a pinch on a trackpad) zooms about the pointer; a sideways swipe, or Shift
 * with the wheel, scrolls along the cut once zoomed. A plain wheel scrolls the rows. Placed by the panel's `.ruler`.
 */
export function timelineWheel(e: WheelEvent, tv: TimeViewState, duration: number): void {
  const lane = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(".ruler");
  const r = lane?.getBoundingClientRect();
  if (!r || r.width <= 0 || !(duration > 0)) return;
  const frac = (e.clientX - r.left) / r.width;
  if (e.ctrlKey || e.metaKey || e.altKey) {
    e.preventDefault();
    tv.set(zoomView(tv.view, duration, Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.01))), viewTime(frac, tv.view)));
    return;
  }
  const sideways = e.shiftKey ? e.deltaY || e.deltaX : Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
  if (sideways && tv.zoomed) {
    e.preventDefault();
    const span = tv.view.end - tv.view.start;
    tv.set({ start: tv.view.start + (sideways / r.width) * span, end: tv.view.end + (sideways / r.width) * span });
  }
}
