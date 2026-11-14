import { pctOf, type RulerMark } from "../../desk.js";

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
}

/** A step between labelled ticks that leaves room for about eight labels. */
const STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const label = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}${s % 1 ? `.${String(Math.round((s % 1) * 10))}` : ""}`;

/** §27, 5.6: time ticks and labels, the playhead, and a marker per note. A click or a drag along it seeks. */
export function Ruler({ duration, t, marks, live, onSeek, onMark }: RulerProps) {
  const pct = (s: number) => pctOf(s, duration);
  const step = STEPS.find((s) => duration / s <= 8) ?? STEPS[STEPS.length - 1];
  const ticks: number[] = [];
  if (duration > 0) for (let s = 0; s < duration - 1e-6; s += step / 2) ticks.push(s);
  const at = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return r.width ? ((e.clientX - r.left) / r.width) * duration : 0;
  };
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
      }}
    >
      {ticks.map((s, i) => (
        <span key={s} class={`rtick${i % 2 ? "" : " major"}`} style={{ left: `${pct(s)}%` }}>{i % 2 ? null : <span class="rlbl">{label(s)}</span>}</span>
      ))}
      {marks.map((m) => m.width !== null && <span key={`s${m.id}`} class={`span ${m.status}`} style={{ left: `${m.left}%`, width: `${m.width}%` }} />)}
      {live && <span class="span live" style={{ left: `${live.left}%`, width: `${live.width}%` }} />}
      {marks.map((m) => (
        <button
          key={m.id}
          type="button"
          // Its tooltip opens under the ruler, lined up with the marker's side near either end so the panel never cuts it off.
          class={`mk ${m.status}${m.ring ? " ring" : ""}${m.left < 25 ? " tstart" : m.left > 75 ? " tend" : ""}`}
          data-note={m.id}
          style={{ left: `${m.left}%` }}
          data-tip={m.title}
          aria-label={m.title}
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
