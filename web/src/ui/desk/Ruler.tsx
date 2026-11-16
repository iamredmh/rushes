import { useState } from "preact/hooks";
import { fullView, markTitle, type RulerMark, type TimeView, viewPct, viewTime } from "../../desk.js";

export interface RulerMarker extends RulerMark {
  /** §21.5: an all-format note on a cut with formats is a ring, a format's note a dot. */
  ring: boolean;
  /** The marker's name and tooltip: the note's text, with its format first on a cut with formats. */
  title: string;
}

export interface RulerProps {
  duration: number;
  t: number;
  marks: RulerMarker[];
  /** The In/Out being marked, as percentages, or null. */
  live: { left: number; width: number } | null;
  onSeek(to: number): void;
  onMark(id: string): void;
  /** The stretch on screen once zoomed (the Timeline tab); the whole cut without one. The markers' and `live`'s
   *  percentages are of this stretch. */
  view?: TimeView;
}

/** A step between labelled ticks that leaves room for about eight labels. */
const STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const label = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}${s % 1 ? `.${String(Math.round((s % 1) * 10))}` : ""}`;

/**
 * §27, 5.6: time ticks and labels, the playhead, and a marker per note. A click or a drag along it seeks. Under the time
 * labels runs the notes band (Red, 16 Nov: it is where he scrubs and where notes land, so it is tall and shows the time
 * under the pointer, to read as somewhere to click).
 */
export function Ruler({ duration, t, marks, live, onSeek, onMark, view }: RulerProps) {
  const v = view ?? fullView(duration);
  const span = v.end - v.start;
  const pct = (s: number) => viewPct(s, v);
  const step = STEPS.find((s) => span / s <= 8) ?? STEPS[STEPS.length - 1];
  const ticks: number[] = [];
  if (span > 0) {
    const half = step / 2;
    for (let s = Math.floor(v.start / half) * half; s < Math.min(duration, v.end + half) - 1e-6; s += half) {
      if (s >= 0) ticks.push(Math.round(s * 1000) / 1000);
    }
  }
  const at = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return r.width ? viewTime((e.clientX - r.left) / r.width, v) : 0;
  };
  // The time under the pointer, while it is over the ruler.
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div
      class="ruler"
      role="slider"
      aria-label="Timeline"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={t}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        onSeek(at(e));
      }}
      onPointerMove={(e) => {
        if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) onSeek(at(e));
        if (e.pointerType === "mouse") setHover(at(e));
      }}
      onPointerLeave={() => setHover(null)}
    >
      <span class="rband" aria-hidden="true" />
      {ticks.map((s) => {
        const major = Math.abs(s / step - Math.round(s / step)) < 1e-6;
        return <span key={s} class={`rtick${major ? " major" : ""}`} style={{ left: `${pct(s)}%` }}>{major ? <span class="rlbl">{label(s)}</span> : null}</span>;
      })}
      {marks.map((m) => m.width !== null && <span key={`s${m.id}`} class={`span ${m.status}`} style={{ left: `${m.left}%`, width: `${m.width}%` }} />)}
      {live && <span class="span live" style={{ left: `${live.left}%`, width: `${live.width}%` }} />}
      {hover !== null && (
        <span class="rhover" aria-hidden="true" style={{ left: `${pct(hover)}%` }}>
          <span class="rhtc">{label(Math.round(hover * 10) / 10)}</span>
        </span>
      )}
      {marks.map((m) => (
        <button
          key={m.id}
          type="button"
          // Its tooltip opens under the ruler, lined up with the marker's side near either end so the panel never cuts it off.
          class={`mk ${m.status}${m.ring ? " ring" : ""}${m.left < 25 ? " tstart" : m.left > 75 ? " tend" : ""}`}
          data-note={m.id}
          style={{ left: `${m.left}%` }}
          data-tip={markTitle(m.status, m.title)}
          aria-label={markTitle(m.status, m.title)}
          tabIndex={-1}
          // The ruler's own seek waits for the ruler: a marker seeks to its note and selects it.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (e.detail > 0) (e.currentTarget as HTMLElement).blur();
            onMark(m.id);
          }}
        />
      ))}
      <span class="playhead" style={{ left: `${pct(t)}%` }} />
    </div>
  );
}
