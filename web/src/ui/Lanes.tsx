// The lanes of an audio tab (§17.1): a name column with a swatch and the meta, an 80px waveform
// track carrying the lane's note markers, spans and the playhead, and a control column (Use / In use,
// or M / S on Mix). Shared by every audio tab through AudioStage. A row can carry a heading above it
// (a Voiceover round's name) or be a fold: one full-width button standing for a folded round.
//
// Nothing here re-renders per frame. The playheads are plain elements AudioStage moves through a
// ref, and a waveform canvas redraws only when its peaks, its size or the timeline length change.
import { type ComponentChildren, Fragment } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { LoadResult } from "../audio/engine.js";
import { type Clip, mediaKey } from "../audio/timeline.js";
import { cueRoom } from "../lib.js";
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
  /** A group heading drawn before this row (a Voiceover round's name). */
  heading?: string;
  /** A small pill beside the heading, e.g. "current". */
  tag?: string;
  /**
   * Draw this row as one full-width button instead of a lane (a folded Voiceover round): no clips,
   * track or controls. `dot` marks open notes inside it.
   */
  fold?: { label: ComponentChildren; text: string; open: boolean; dot: boolean; onToggle(): void };
  /** The clips drawn on this lane's waveform. */
  clips: Clip[];
  /** SFX cues, labelled on the waveform at their times. */
  cues?: { id: string; name: string; t: number }[];
  /** Clicking the lane auditions this clip in this engine lane. */
  audition?: { lane: string; clip: string };
  /** This lane's clip is the pick: heard when no lane is selected. */
  picked?: boolean;
  /** Manifest position, for "the first lane" when nothing is picked or selected (display order may be shuffled). */
  order?: number;
  /** Use / In use. `onUnpick`, when given, puts an Unpick button beside In use that clears the pick. */
  use?: { inUse: boolean; onUse(): void; onUnpick?(): void };
  /** Other controls for the right-hand column (M / S on Mix). */
  controls?: ComponentChildren;
  /** The On menu value that clicking this lane selects. */
  on?: string;
  /**
   * The lane has nothing to play: its file isn't on disk (true: the mark's tooltip says "Missing"),
   * or, on Mix, nothing is picked for it (a string: the tooltip to show instead).
   */
  missing?: boolean | string;
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

/**
 * What's cut off by its column. By row key: which lanes have their name ("n") or meta ("m") cut;
 * by "h:<row key>", a cut round heading; by "f:<row key>", a cut fold row.
 */
type Cut = Record<string, string>;

function measureCut(root: HTMLElement): Cut {
  const out: Cut = {};
  const over = (el: Element | null) => el !== null && el.scrollWidth > el.clientWidth;
  for (const lane of root.querySelectorAll<HTMLElement>(".lane[data-row]")) {
    const flags = (over(lane.querySelector("[data-name]")) ? "n" : "") + (over(lane.querySelector("[data-meta-text]")) ? "m" : "");
    if (flags) out[lane.dataset.row!] = flags;
  }
  for (const head of root.querySelectorAll<HTMLElement>(".rhead[data-heading]")) {
    if (over(head.querySelector(".rname"))) out[`h:${head.dataset.heading}`] = "h";
  }
  for (const fold of root.querySelectorAll<HTMLElement>(".fold[data-row]")) {
    if (over(fold.querySelector(".flabel"))) out[`f:${fold.dataset.row}`] = "f";
  }
  return out;
}

const sameCut = (a: Cut, b: Cut) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

export function Lanes({ rows, length, media, selected, marks, range, onSelect, onSeek }: LanesProps) {
  const pct = (s: number) => `${length > 0 ? (s / length) * 100 : 0}%`;

  // A name or meta line cut off by its column shows in full as a tooltip. Measured when the rows'
  // text changes or the window resizes, never per frame.
  const root = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState<Cut>({});
  const measure = () => {
    if (root.current) {
      const next = measureCut(root.current);
      setCut((prev) => (sameCut(prev, next) ? prev : next));
    }
  };
  // The long-file and won't-play marks join a meta line once its media loads, and can cut it off.
  const mediaMarks = rows.map((r) => {
    const results = r.clips.map((c) => media[mediaKey(c)]);
    return (results.some((x) => x !== undefined && x !== "error" && x.streamed) ? "s" : "") + (results.some((x) => x === "error") ? "b" : "");
  });
  const shape = JSON.stringify(rows.map((r, i) => [r.key, r.name, r.meta ?? "", r.heading ?? "", r.fold ? r.fold.text : null, r.missing ?? false, mediaMarks[i]]));
  useLayoutEffect(measure, [shape]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    // Text measured before the web font lands is the fallback font's width.
    void document.fonts?.ready.then(measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  return (
    <div class="lanes" ref={root}>
      {rows.map((row) => {
        const heading = row.heading !== undefined && (
          <div class="rhead" data-heading={row.key} data-tip={cut[`h:${row.key}`] ? row.heading : undefined}>
            <span class="rname">{row.heading}</span>
            {row.tag && <span class="rtag">{row.tag}</span>}
          </div>
        );
        if (row.fold) {
          const f = row.fold;
          return (
            <Fragment key={row.key}>
              {heading}
              <button
                type="button"
                class="fold"
                data-row={row.key}
                data-tip={cut[`f:${row.key}`] ? f.text : undefined}
                aria-expanded={f.open}
                aria-description={f.dot ? "Open notes" : undefined}
                onClick={f.onToggle}
              >
                <Icon name="chev" />
                <span class="flabel">{f.label}</span>
                {f.dot && <span class="fdot" data-dot data-tip="Open notes" />}
              </button>
            </Fragment>
          );
        }
        const current = row.key === selected;
        const flags = cut[row.key] ?? "";
        const rooms = cueRoom(row.cues ?? [], length);
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
          <Fragment key={row.key}>
          {heading}
          <div class="lane" data-row={row.key} aria-current={current ? "true" : undefined}>
            <button
              type="button"
              class="nm"
              aria-current={current ? "true" : "false"}
              aria-label={row.name}
              aria-description={row.missing ? (typeof row.missing === "string" ? row.missing : "Missing") : undefined}
              onClick={() => onSelect(row)}
            >
              {/* The tooltip sits on the unclipped line, not on the ellipsised text, which would clip it. */}
              <b data-tip={flags.includes("n") ? row.name : undefined}>
                <i style={{ background: row.color }} />
                <span data-name>{row.name}</span>
                {/* Beside the name, not in the meta line, which clips its tooltip. */}
                {row.missing && <Missing tip={typeof row.missing === "string" ? row.missing : undefined} />}
              </b>
              <small data-meta data-tip={flags.includes("m") && row.meta ? row.meta : undefined}>
                {broken ? (
                  <span class="smk bad" data-tip="This file won't play in a browser"><Icon name="alert" /></span>
                ) : streamed ? (
                  <span class="smk" data-tip="Long file: switching isn't sample-exact"><Icon name="stream" /></span>
                ) : null}
                <span data-meta-text>{row.meta ?? ""}</span>
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
              {(row.cues ?? []).map((c, i) => <i class="cue-tick" style={{ left: pct(c.t), color: row.color }} key={`t${i}`} />)}
              {(row.cues ?? []).map((c, i) => (
                // Each label gets the gap to its nearest cue, so close cues are cut short rather than overlap.
                <span class="cue" data-cue={c.id} key={`c${i}`} style={{ left: pct(c.t), color: row.color, maxWidth: `calc(${(rooms[i] * 100).toFixed(3)}% - 8px)` }}>
                  {c.name}
                </span>
              ))}
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
              {row.use?.inUse && row.use.onUnpick && (
                <button
                  type="button"
                  class="btn ghost ib sm unpick"
                  data-tip="Unpick"
                  aria-label={`Unpick ${row.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    row.use!.onUnpick!();
                  }}
                >
                  <Icon name="x" />
                </button>
              )}
              {row.controls}
            </div>
          </div>
          </Fragment>
        );
      })}
    </div>
  );
}
