// The lanes of an audio tab (§17.1): a name column with a swatch and the meta, an 80px waveform
// track carrying the lane's note markers, spans and the playhead, and a control column (Use / In use,
// or M / S on Mix). Shared by every audio tab through AudioStage.
//
// Nothing here re-renders per frame. The playheads are plain elements AudioStage moves through a
// ref, and a waveform canvas redraws only when its peaks, its size or the timeline length change.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { LoadResult } from "../audio/engine.js";
import { type Clip, mediaKey } from "../audio/timeline.js";
import { Missing } from "./AssetViews.js";
import { Icon } from "./Icon.js";

/** One lane on an audio tab. */
export interface StageRow {
  /** Unique across the tab. */
  key: string;
  name: string;
  /** The line under the name: `120 BPM · A minor`, or a description. */
  meta?: string | null;
  /** The stage colour, for the swatch and the waveform. */
  color: string;
  /** A sub-lane (a VO take): shorter, indented, no swatch. */
  sub?: boolean;
  /** The clips drawn on this lane's waveform. */
  clips: Clip[];
  /** SFX cues, labelled on the waveform at their times. */
  cues?: { id: string; name: string; t: number }[];
  /** Labels along the top of the track (VO section marks: S1, S2 …). */
  labels?: { t: number; text: string }[];
  /** Clicking the lane auditions this clip in this engine lane. */
  audition?: { lane: string; clip: string };
  /** This lane's clip is the pick: heard when no lane is selected. */
  picked?: boolean;
  /** Manifest position, for "the first lane" when nothing is picked or selected (display order may be shuffled). */
  order?: number;
  /** Use / In use. */
  use?: { inUse: boolean; onUse(): void };
  /** Other controls for the right-hand column (M / S on Mix). */
  controls?: ComponentChildren;
  /** The On menu value that clicking this lane selects. */
  on?: string;
  /** A VO take read from a line that has since changed. */
  stale?: boolean;
  /** The lane's file isn't on disk: it shows the missing mark and has nothing to play. */
  missing?: boolean;
}

/** A note drawn on a lane: a marker at `t`, plus a span to `tOut` for a range. */
export interface LaneMark {
  id: string;
  t: number;
  tOut: number | null;
  status: "todo" | "done";
  text: string;
}

// Test-only: how many times any waveform has been drawn, so e2e can check playback never redraws them.
let draws = 0;
export function waveDraws(): number {
  return draws;
}

interface WaveSegment {
  offset: number;
  duration: number;
  peaks: Float32Array | null;
}

const BAR = 3;
const BAR_WIDTH = 2;

/** A lane's waveform: bars across the timeline where its clips sit. */
function Wave({ segments, length, color }: { segments: WaveSegment[]; length: number; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0, dpr: 1 });

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const measure = () => {
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      setSize((s) => (s.w === r.width && s.h === r.height && s.dpr === dpr ? s : { w: r.width, h: r.height, dpr }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  // Redraws only when the peaks, the size, the length or the colour change: never per frame.
  const deps: unknown[] = [size, length, color];
  for (const s of segments) deps.push(s.offset, s.duration, s.peaks);
  useEffect(() => {
    const c = ref.current;
    if (!c || size.w <= 0 || size.h <= 0) return;
    draws++;
    c.width = Math.round(size.w * size.dpr);
    c.height = Math.round(size.h * size.dpr);
    const x = c.getContext("2d");
    if (!x) return;
    x.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    x.clearRect(0, 0, size.w, size.h);
    if (!(length > 0)) return;
    x.fillStyle = color;
    const bars = Math.floor(size.w / BAR);
    const secondsPerBar = (length * BAR) / size.w;
    for (let i = 0; i < bars; i++) {
      const t0 = i * secondsPerBar;
      const t1 = t0 + secondsPerBar;
      let amp = -1;
      for (const s of segments) {
        if (!(s.duration > 0) || t1 <= s.offset || t0 >= s.offset + s.duration) continue;
        if (!s.peaks || s.peaks.length === 0) {
          // A streamed file has no peaks: a quiet line where it plays.
          amp = Math.max(amp, 0.04);
          continue;
        }
        const n = s.peaks.length;
        const a = Math.max(0, Math.floor(((t0 - s.offset) / s.duration) * n));
        const b = Math.min(n, Math.max(a + 1, Math.ceil(((t1 - s.offset) / s.duration) * n)));
        for (let j = a; j < b; j++) amp = Math.max(amp, s.peaks[j]);
      }
      if (amp < 0) continue;
      const h = Math.max(1.5, Math.min(1, amp) * size.h * 0.92);
      x.globalAlpha = 0.9;
      x.fillRect(i * BAR, (size.h - h) / 2, BAR_WIDTH, h);
    }
  }, deps);

  return <canvas ref={ref} class="wave" aria-hidden="true" />;
}

export interface LanesProps {
  rows: StageRow[];
  length: number;
  media: Record<string, LoadResult | "error">;
  selected: string | null;
  /** The notes drawn on each lane, by row key. */
  marks: Record<string, LaneMark[]>;
  range: { in: number | null; out: number | null };
  onSelect(row: StageRow): void;
  onSeek(t: number, row: StageRow): void;
}

export function Lanes({ rows, length, media, selected, marks, range, onSelect, onSeek }: LanesProps) {
  const pct = (s: number) => `${length > 0 ? (s / length) * 100 : 0}%`;
  return (
    <div class="lanes">
      {rows.map((row) => {
        const current = row.key === selected;
        const results = row.clips.map((c) => media[mediaKey(c)]);
        const streamed = results.some((r) => r !== undefined && r !== "error" && r.streamed);
        const broken = results.some((r) => r === "error");
        const segments: WaveSegment[] = row.clips.map((c, i) => {
          const r = results[i];
          const loaded = r !== undefined && r !== "error" ? r : null;
          return { offset: c.offset, duration: c.duration > 0 ? c.duration : (loaded?.duration ?? 0), peaks: loaded ? loaded.peaks : null };
        });
        const laneMarks = marks[row.key] ?? [];
        return (
          <div class={`lane${row.sub ? " sub" : ""}`} data-row={row.key} aria-current={current ? "true" : undefined}>
            <button
              type="button"
              class="nm"
              aria-current={current ? "true" : "false"}
              aria-label={row.name}
              aria-description={row.missing ? "Missing" : row.stale ? "Stale: the line changed after this take" : undefined}
              onClick={() => onSelect(row)}
            >
              <b>
                {!row.sub && <i style={{ background: row.color }} />}
                <span data-name>{row.name}</span>
                {/* Beside the name, not in the meta line, which clips its tooltip. */}
                {row.missing && <Missing />}
                {row.stale && (
                  <span class="smk" data-stale data-tip="The line changed after this take"><Icon name="stale" /></span>
                )}
              </b>
              <small data-meta>
                {broken ? (
                  <span class="smk bad" data-tip="This file won't play in a browser"><Icon name="alert" /></span>
                ) : streamed ? (
                  <span class="smk" data-tip="Long file: switching isn't sample-exact"><Icon name="stream" /></span>
                ) : null}
                {row.meta ?? ""}
              </small>
            </button>
            <div
              class="track"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                onSeek(((e.clientX - r.left) / r.width) * length, row);
              }}
            >
              <Wave segments={segments} length={length} color={row.color} />
              {(row.labels ?? []).map((l) => <span class="secmk" style={{ left: pct(l.t) }}>{l.text}</span>)}
              {(row.cues ?? []).map((c) => <span class="cue" data-cue={c.id} style={{ left: pct(c.t), color: row.color }}>{c.name}</span>)}
              {laneMarks.map((m) => m.tOut !== null && <div class={`span ${m.status}`} data-note={m.id} style={{ left: pct(m.t), width: pct(m.tOut - m.t) }} />)}
              {laneMarks.map((m) => <div class={`mk ${m.status}`} data-note={m.id} style={{ left: pct(m.t) }} title={m.text} />)}
              {range.in !== null && (
                <div class="span live" style={{ left: pct(range.in), width: pct((range.out ?? range.in + Math.max(0.2, length / 200)) - range.in) }} />
              )}
              <div class="playhead" />
            </div>
            <div class="ctl">
              {row.use && (
                <button
                  type="button"
                  class="use"
                  aria-pressed={row.use.inUse}
                  aria-label={`Use ${row.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    row.use!.onUse();
                  }}
                >
                  {row.use.inUse ? <><Icon name="check" />In use</> : "Use"}
                </button>
              )}
              {row.controls}
            </div>
          </div>
        );
      })}
    </div>
  );
}
