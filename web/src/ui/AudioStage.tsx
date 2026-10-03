// The shared layout of the audio tabs (§17.1): the tracks on the left (title, transport, lanes), a
// muted picture preview and the notes on the right. Music, Sound effects and Voiceover use it; Mix
// reuses it.
//
// One AudioEngine per mount (useAudioStage) is the clock. Nothing re-renders per frame: the
// playheads, the timecode and the preview follow `engine.subscribe` through refs.
import type { ComponentChildren } from "preact";
import { type MutableRef, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, mediaUrl } from "../api.js";
import { type AudioEngine, type EngineSnapshot, liveContexts } from "../audio/engine.js";
import { type Clip, needsVideoSync, setStreamThreshold } from "../audio/timeline.js";
import { useAudioStage } from "../audio/useAudioStage.js";
import {
  AUDIO_CHIPS, type AudioStageId, fmt, laneSelection, type Listening, notePending, noteTime, type OnOption, type Scope, snap, stepFrame, testFlags,
} from "../lib.js";
import type { Mark, Note } from "../types.js";
import { Icon } from "./Icon.js";
import { type LaneMark, Lanes, type StageRow, waveDraws } from "./Lanes.js";
import { Notes } from "./Notes.js";

// ---- test-only switches (never on in normal use) ----
// `?test=1` exposes the engine on window.__rushesAudio for the e2e suite; `&streamOver=1` streams
// any file over 1 second, so the long-file fallback runs in a real browser.
const FLAGS = typeof location === "undefined" ? { test: false, streamOver: false } : testFlags(location.search);
if (FLAGS.streamOver) setStreamThreshold(1);

export interface AudioTestHook {
  /** The mounted tab's engine, or null when no audio tab is showing. */
  engine: AudioEngine | null;
  inspect(): EngineSnapshot | null;
  /** AudioStage renders since the page loaded. */
  renders: number;
  /** Waveform draws since the page loaded. */
  draws(): number;
  liveContexts(): number;
  /** The clips the mounted tab plays: every one, and those heard now (variant gain × lane gain > 0). */
  clips: Clip[];
  heard(): { id: string; lane: string; path: string; offset: number }[];
}
declare global {
  interface Window {
    __rushesAudio?: AudioTestHook;
  }
}
const hook: AudioTestHook | null = FLAGS.test
  ? {
      engine: null,
      inspect() {
        return this.engine ? this.engine.inspect() : null;
      },
      renders: 0,
      draws: waveDraws,
      liveContexts,
      clips: [],
      heard() {
        const s = this.engine?.inspect();
        if (!s) return [];
        return this.clips
          .filter((c) => (s.gains[c.id] ?? 1) * (s.lanes[c.lane] ?? 1) > 0)
          .map((c) => ({ id: c.id, lane: c.lane, path: c.path, offset: c.offset }));
      },
    }
  : null;
if (hook) window.__rushesAudio = hook;

/** The cut the preview plays: the film's locked cut, or its newest. */
export interface Preview {
  video: string;
  version: string;
  file: string;
  duration: number | null;
}

/** What a tab can do to its stage from outside: point the On menu, or start a note. */
export interface StageHandle {
  engine: AudioEngine;
  /** Point the On menu at one of its values. */
  setOn(value: string): void;
  /** Start a note: `text` in the box with the caret at the end, and On and the scope set. */
  startNote(text: string, opts?: { on?: string; scope?: Scope }): void;
}

export interface AudioStageProps {
  stage: AudioStageId;
  title: string;
  /** Beside the title, e.g. Blind on Music. */
  headerExtra?: ComponentChildren;
  /** Under the lanes, e.g. the loudness readout on Mix. */
  belowLanes?: ComponentChildren;
  rows: StageRow[];
  /** Everything the engine plays. Defaults to every row's clips. */
  clips?: Clip[];
  preview: Preview | null;
  /** The project's frame rate: ←/→ step one frame of it. */
  fps: number;
  /** This tab's notes. */
  notes: Note[];
  /** The On menu. A row's `on` names one of these. */
  onOptions: OnOption[];
  /** The row (or rows) a note is drawn on, or null (whole notes are never drawn). */
  noteRow(note: Note): string | string[] | null;
  /** What a listed note is on, for the notes column. */
  onLabel(note: Note): string | null;
  toast(message: string): void;
  onChanged(): void;
  /** A half-typed note or a range is waiting (as on Picture): the caller refuses a film switch meanwhile. */
  onPendingChange?(pending: boolean): void;
  /**
   * What's heard with a row selected (null: none). Defaults to one variant per engine lane, from
   * each row's `audition` and `picked` (laneSelection). Applied as gain ramps, never a restart.
   */
  listen?(selected: string | null): Listening;
  /** The On menu's value until a lane is clicked. Defaults to the picked row's, else the first row's. */
  defaultOn?: string;
  /** Filled with the stage's handle on every render. */
  handle?: MutableRef<StageHandle | null>;
  /** A lane was clicked. */
  onSelect?(row: StageRow): void;
  /** The scope segments this tab offers, in order. Defaults to all three. */
  scopes?: Scope[];
  /** The scope selected before the user changes it. Defaults to "point". */
  defaultScope?: Scope;
  /** The quick-start chips for the current scope. Defaults to this stage's AUDIO_CHIPS. */
  chipsFor?(scope: Scope): string[];
  /** Whether Range offers quick marks (Rise/Fall/Louder/Quieter). Defaults to true. */
  marks?: boolean;
}

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
const NO_RANGE = { in: null, out: null } as { in: number | null; out: number | null };
const ALL_SCOPES: Scope[] = ["point", "range", "whole"];

export function AudioStage(props: AudioStageProps) {
  const { stage, title, headerExtra, belowLanes, rows, preview, fps, notes, onOptions, noteRow, onLabel, toast, onChanged, onPendingChange, listen } = props;
  if (hook) hook.renders++;
  const clips = props.clips ?? dedupe(rows.flatMap((r) => r.clips));

  // The preview's own duration, for a cut the server couldn't probe (no ffmpeg).
  const [loadedDuration, setLoadedDuration] = useState<number | null>(null);
  const [aspect, setAspect] = useState(16 / 9);
  useEffect(() => {
    setLoadedDuration(null);
    setAspect(16 / 9);
  }, [preview?.file]);
  const videoDuration = preview ? (preview.duration ?? loadedDuration) : null;
  const { engine, playing, length, media } = useAudioStage(clips, videoDuration);

  const [picked, setSelected] = useState<string | null>(null);
  // A selected lane that's gone (another section's take, a removed variant) selects nothing.
  const selected = rows.some((r) => r.key === picked) ? picked : null;
  useLayoutEffect(() => {
    if (picked !== null && selected === null) setSelected(null);
  }, [selected]);
  const [onValue, setOnValue] = useState<string | null>(null);
  const [range, setRange] = useState(NO_RANGE);
  const [scope, setScope] = useState<Scope>(props.defaultScope ?? "point");
  const [marks, setMarks] = useState<Mark[]>([]);
  const [noteHasText, setNoteHasText] = useState(false);
  const hasRange = (props.scopes ?? ALL_SCOPES).includes("range");
  const baseScope: Scope = props.defaultScope ?? "point";
  // Another film or cut starts from the tab's own scope again. (A pending note refuses the switch,
  // so nothing in progress is dropped here.)
  const previewKey = `${preview?.video ?? ""}/${preview?.version ?? ""}`;
  const seenPreview = useRef(previewKey);
  useLayoutEffect(() => {
    if (seenPreview.current === previewKey) return;
    seenPreview.current = previewKey;
    setScope(baseScope);
  }, [previewKey]);

  // Nothing pending is dropped: a half-typed note, a range or ticked marks hold the film (and its
  // cut), as on Picture. A layout effect, so the hold is in place before the next key (`]` straight
  // after `I`) is handled.
  const pending = notePending({ range, marks, hasText: noteHasText });
  useLayoutEffect(() => {
    onPendingChange?.(pending);
  }, [pending]);
  useEffect(() => () => onPendingChange?.(false), []);

  // ---- what's heard (§17.3, §18.3): the selected lane, else the picks ----
  const plan = (sel: string | null): Listening => (listen ? listen(sel) : { select: laneSelection(rows, sel), gains: {} });
  const applied = useRef<Listening>({ select: {}, gains: {} });
  // Only what changed is applied: each is a 4 ms gain ramp on the clock, never a restart.
  const apply = (next: Listening) => {
    const was = applied.current;
    for (const [lane, clip] of Object.entries(next.select)) if (!(lane in was.select) || was.select[lane] !== clip) engine.selectVariant(lane, clip);
    for (const [lane, gain] of Object.entries(next.gains)) if (was.gains[lane] !== gain) engine.setLaneGain(lane, gain);
    applied.current = { select: { ...was.select, ...next.select }, gains: { ...was.gains, ...next.gains } };
  };
  const listening = plan(selected);
  // A layout effect, so what you hear changes in the same commit that marks a new pick In use.
  // The engine keeps a lane's selection and gain apart from its clips, so this may run before setClips.
  useLayoutEffect(() => apply(listening), [engine, JSON.stringify(listening)]);

  // The On menu defaults to the lane you last clicked, else the pick, else the first entry; an
  // entry that's gone (a variant removed, say) falls back the same way.
  const fallbackOn = props.defaultOn ?? rows.find((r) => r.picked)?.on ?? rows[0]?.on ?? onOptions[0]?.value ?? null;
  const onCurrent = onOptions.some((o) => o.value === onValue) ? onValue : fallbackOn;
  const option = onOptions.find((o) => o.value === onCurrent) ?? null;

  // ---- the playhead, timecode and preview: refs, never per-frame state ----
  const root = useRef<HTMLDivElement>(null);
  const heads = useRef<HTMLElement[]>([]);
  const tc = useRef<HTMLSpanElement>(null);
  const pvTc = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const starter = useRef<((text: string) => void) | null>(null);
  const placeholderFor = (t: number) => {
    if (scope === "whole") return stage === "voice" ? "Note on the whole read" : "Note on the whole track";
    if (hasRange) {
      if (range.in !== null && range.out === null) return "Set an Out point";
      if (range.in !== null && range.out !== null) return `Note on ${noteTime(range.in, range.out)}`;
      if (scope === "range") return "Set In and Out";
    }
    return `Note at ${fmt(option?.t ?? snap(t, fps))}`;
  };
  const paint = (t: number) => {
    const len = engine.length;
    const left = `${len > 0 ? (Math.min(t, len) / len) * 100 : 0}%`;
    for (const h of heads.current) h.style.left = left;
    const label = fmt(t);
    if (tc.current) tc.current.textContent = label;
    if (pvTc.current) pvTc.current.textContent = label;
    if (input.current) input.current.placeholder = placeholderFor(t);
    // The preview follows the audio clock: seeked back once it's more than a frame off (§17.2).
    const v = video.current;
    if (v && v.readyState >= 1 && !v.seeking && needsVideoSync(v.currentTime, t, fps)) {
      v.currentTime = Math.min(t, Number.isFinite(v.duration) ? v.duration : t);
    }
  };
  const paintRef = useRef(paint);
  paintRef.current = paint;
  useLayoutEffect(() => {
    heads.current = root.current ? [...root.current.querySelectorAll<HTMLElement>(".playhead")] : [];
    paint(engine.time);
  });
  useEffect(() => engine.subscribe((t) => paintRef.current(t)), [engine]);
  // The muted preview runs alongside; drift correction in paint() keeps it within a frame.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (playing) void v.play().catch(() => undefined);
    else {
      v.pause();
      paintRef.current(engine.time);
    }
  }, [playing, preview?.file]);

  // ---- transport ----
  const toggle = () => (engine.playing ? engine.pause() : engine.play());
  const step = (n: number) => {
    engine.pause();
    engine.seek(stepFrame(engine.time, fps, n, engine.length));
  };
  const setIn = () => {
    if (!hasRange) return;
    setRange({ in: snap(engine.time, fps), out: null });
    setScope("range");
  };
  const setOut = () => {
    if (!hasRange) return;
    const at = snap(engine.time, fps);
    const start = range.in ?? 0;
    if (at <= start) return toast("Out has to come after In");
    setRange({ in: start, out: at });
    setScope("range");
  };
  const clearRange = () => {
    setRange(NO_RANGE);
    setMarks([]);
    if (scope === "range") setScope(baseScope);
  };
  const changeScope = (s: Scope) => {
    // A tab that doesn't offer Range never enters it, whoever asks.
    if (s === "range" && !hasRange) return;
    setScope(s);
    if (s !== "range") {
      setRange(NO_RANGE);
      setMarks([]);
    }
  };

  // Clicking a lane selects it, auditions it at the playhead (a 4 ms gain ramp, the playhead
  // untouched) and points the On menu at it.
  const select = (row: StageRow) => {
    setSelected(row.key);
    // Heard in the click itself, not a render later.
    apply(plan(row.key));
    if (row.on) setOnValue(row.on);
    props.onSelect?.(row);
  };

  if (props.handle) {
    props.handle.current = {
      engine,
      setOn: setOnValue,
      startNote(text, opts = {}) {
        // Nothing pending is ever dropped: a half-typed note, a range or quick marks hold the
        // note box, so the caller's request is refused rather than overwriting them.
        if (pending) {
          toast("Finish or clear the note you're writing first.");
          return;
        }
        if (opts.on !== undefined) setOnValue(opts.on);
        if (opts.scope !== undefined) changeScope(opts.scope);
        starter.current?.(text);
      },
    };
  }

  // ---- keyboard: Space, ←/→ (Shift: ten), I, O, N ----
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKeyRef.current = (e: KeyboardEvent) => {
    if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.key === " ") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(e.shiftKey ? -10 : -1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(e.shiftKey ? 10 : 1); }
    else if (k === "i") setIn();
    else if (k === "o") setOut();
    else if (k === "n") { e.preventDefault(); input.current?.focus(); }
  };
  // Bound in a layout effect, so a key pressed straight after switching to the tab is never missed.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- the test hook (only with ?test=1) ----
  useLayoutEffect(() => {
    if (hook) hook.clips = clips;
  });
  useEffect(() => {
    if (!hook) return;
    hook.engine = engine;
    return () => {
      if (hook.engine === engine) hook.engine = null;
    };
  }, [engine]);

  // ---- notes ----
  const add = async (text: string) => {
    let t: number | null = null;
    let tOut: number | null = null;
    if (scope === "range") {
      if (range.in === null || range.out === null) throw new Error("set In and Out for a range");
      t = range.in;
      tOut = range.out;
    } else if (scope === "point") {
      // A note on a cue is saved at the cue's time (§17.4); otherwise at the playhead.
      t = option?.t ?? snap(engine.time, fps);
    }
    await api.post("/api/notes", {
      stage,
      video: preview?.video ?? null,
      version: preview?.version ?? null,
      on: option?.on ?? null,
      scope,
      t,
      tOut,
      text,
      marks: scope === "range" ? marks : [],
    });
    setRange(NO_RANGE);
    setMarks([]);
    setScope(baseScope);
    onChanged();
  };

  const version = preview?.version ?? null;
  // Audio times are the audio's own: they don't move with the cut, so they're drawn as saved.
  const drawn: Record<string, LaneMark[]> = {};
  for (const n of notes) {
    if (n.scope === "whole" || n.t === null) continue;
    const at = noteRow(n);
    for (const row of at === null ? [] : typeof at === "string" ? [at] : at) {
      (drawn[row] ??= []).push({ id: n.id, t: n.t, tOut: n.tOut, status: n.status, text: n.text });
    }
  }

  const rangeLabel = range.in === null ? null : range.out === null ? `${fmt(range.in)} →` : noteTime(range.in, range.out);

  return (
    <div class="astage" ref={root}>
      <div class="stack">
        <div class="ahead">
          <h2>{title}</h2>
          {headerExtra}
          <span class="sp" />
        </div>
        <div class="bar">
          <button class="btn ghost ib" data-tip="Back one frame  ←" aria-label="Back one frame" onClick={() => step(-1)}><Icon name="prev" /></button>
          <button class="btn ib" data-tip="Play  Space" aria-label={playing ? "Pause" : "Play"} onClick={toggle}><Icon name={playing ? "pause" : "play"} /></button>
          <button class="btn ghost ib" data-tip="Forward one frame  →" aria-label="Forward one frame" onClick={() => step(1)}><Icon name="next" /></button>
          <span class="tc" aria-label="Timecode"><span ref={tc}>{fmt(engine.time)}</span><small>/ {fmt(length)}</small></span>
          <span class="sp" />
          {rangeLabel && (
            <span class="chipx">
              <span class="mono">{rangeLabel}</span>
              <button aria-label="Clear range" onClick={clearRange}><Icon name="x" /></button>
            </span>
          )}
          {hasRange && (
            <>
              <button class="btn ghost ib" data-tip="Set in  I" aria-label="Set in point" onClick={setIn}><Icon name="in" /></button>
              <button class="btn ghost ib" data-tip="Set out  O" aria-label="Set out point" onClick={setOut}><Icon name="out" /></button>
            </>
          )}
        </div>
        <Lanes
          rows={rows}
          length={length}
          media={media}
          selected={selected}
          marks={drawn}
          range={range}
          onSelect={select}
          onSeek={(t, row) => {
            select(row);
            engine.seek(t);
          }}
        />
        {belowLanes}
      </div>

      <div class="acol">
        <div class="pv">
          <div class="frame" style={{ aspectRatio: String(aspect) }}>
            {preview ? (
              <video
                ref={video}
                src={mediaUrl(preview.file)}
                muted
                playsInline
                preload="auto"
                aria-label="Picture preview"
                onLoadedMetadata={(e) => {
                  const v = e.target as HTMLVideoElement;
                  if (Number.isFinite(v.duration)) setLoadedDuration(v.duration);
                  if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
                  paintRef.current(engine.time);
                }}
                // A seek requested while another was still landing is skipped; catch up once it lands.
                onSeeked={() => paintRef.current(engine.time)}
              />
            ) : (
              <div class="pvempty" aria-label="No cut yet"><Icon name="film" /></div>
            )}
            <div class="tcover" ref={pvTc}>{fmt(engine.time)}</div>
          </div>
        </div>
        <Notes
          notes={notes}
          version={version}
          placeholder={placeholderFor(engine.time)}
          inputRef={input}
          toast={toast}
          onAdd={add}
          onChanged={onChanged}
          onTextChange={setNoteHasText}
          fixedTimes
          onSeek={(t) => engine.seek(t)}
          on={{ options: onOptions, value: onCurrent, onChange: setOnValue }}
          scope={{ value: scope, onChange: changeScope, options: props.scopes }}
          chips={(props.chipsFor ?? (() => AUDIO_CHIPS[stage]))(scope)}
          marks={props.marks === false ? undefined : { value: marks, onChange: setMarks }}
          onLabel={onLabel}
          starter={starter}
        />
      </div>
    </div>
  );
}

function dedupe(clips: Clip[]): Clip[] {
  const seen = new Set<string>();
  return clips.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}
