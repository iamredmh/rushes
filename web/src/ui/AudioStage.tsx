// The shared layout of the audio tabs (§17.1): the tracks on the left (title, transport, lanes), a
// muted picture preview and the notes on the right. Music, Sound effects and Voiceover use it; Mix
// reuses it.
//
// One AudioEngine per mount (useAudioStage) is the clock. Nothing re-renders per frame: the
// playheads, the timecode and the preview follow `engine.subscribe` through refs.
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, mediaUrl } from "../api.js";
import { type AudioEngine, type EngineSnapshot, liveContexts } from "../audio/engine.js";
import { type SampleState, samples } from "../audio/sample.js";
import { type Clip, needsVideoSync, setStreamThreshold } from "../audio/timeline.js";
import { useAudioStage } from "../audio/useAudioStage.js";
import { noteTarget, timecode } from "../desk.js";
import {
  AUDIO_CHIPS, type AudioStageId, fmt, laneSelection, type Listening, notePending, noteTime, type OnOption, type Scope, snap, spacePressesButton, stepFrame, testFlags,
} from "../lib.js";
import type { Mark, Note } from "../types.js";
import { Icon } from "./Icon.js";
import { type LaneMark, Lanes, type StageRow, waveDraws } from "./Lanes.js";
import { NotesPanel } from "./desk/NotesPanel.js";

// ---- test-only switches (never on in normal use) ----
// `?test=1` exposes the engine on window.__rushesAudio for the e2e suite; `&streamOver=1` streams
// any file over 1 second, so the long-file fallback runs in a real browser.
const FLAGS = typeof location === "undefined" ? { test: false, streamOver: false } : testFlags(location.search);
if (FLAGS.streamOver) setStreamThreshold(1);

export interface AudioTestHook {
  /** The mounted tab's engine (an audio tab's, or the Timeline tab's), or null when neither is showing. */
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
  /** §23: the cue-sample player's state. */
  sample(): SampleState;
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
      sample: () => samples.state(),
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
/** The same hook, for the Timeline tab's sound (§27, 5.6), whose engine follows the picture. */
export const audioTestHook = hook;

/** The cut the preview plays: the film's locked cut, or its newest. */
export interface Preview {
  video: string;
  version: string;
  file: string;
  duration: number | null;
}

export interface AudioStageProps {
  stage: AudioStageId;
  /** The film being reviewed (null: none). Another film starts the note's target on its default again. Defaults to the preview's film. */
  film?: string | null;
  /** §26: the film is shelved, so the tab is looked at, not added to: no note box (a note on it would never be counted or sent). */
  readOnly?: boolean;
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
  /** What a note can be on: a row's `on` names one of these (§27, 5.7: picked by clicking the row, not from a menu). */
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
  /** What a note is on until a lane is clicked. Defaults to the picked row's, else the first row's. */
  defaultOn?: string;
  /** A lane was clicked. */
  onSelect?(row: StageRow): void;
  /** What notes this tab takes: a range is offered only when "range" is among them. Defaults to all three. */
  scopes?: Scope[];
  /** The quick-start chips for the current scope. Defaults to this stage's AUDIO_CHIPS. */
  chipsFor?(scope: Scope): string[];
  /** Whether Range offers quick marks (Rise/Fall/Louder/Quieter). Defaults to true. */
  marks?: boolean;
}

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
const NO_RANGE = { in: null, out: null } as { in: number | null; out: number | null };
const ALL_SCOPES: Scope[] = ["point", "range", "whole"];
// What a tab says when the film has nothing on it yet: its reads, beds and passes are another film's.
const NONE_YET: Record<AudioStageId, string> = {
  voice: "No voice reads for this film yet.",
  music: "No music beds for this film yet.",
  sfx: "No sound effects passes for this film yet.",
  mix: "Nothing to mix for this film yet.",
};

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
  // §27, 5.7: what the next note is on, as the selection says: the lane (or cue) last clicked, at the time clicked or
  // the whole take; nothing clicked, the default take, whole. The value is one of onOptions'.
  const [aim, setAim] = useState<{ value: string; t: number | null } | null>(null);
  // A selected lane that's gone (a removed variant, a folded Voiceover round) selects nothing: the
  // default is heard again, and the note's target goes back to its default too.
  const selected = rows.some((r) => r.key === picked) ? picked : null;
  useLayoutEffect(() => {
    if (picked === null || selected !== null) return;
    setSelected(null);
    setAim(null);
  }, [selected]);
  const [range, setRange] = useState(NO_RANGE);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [noteHasText, setNoteHasText] = useState(false);
  const hasRange = (props.scopes ?? ALL_SCOPES).includes("range");
  const offersPoint = (props.scopes ?? ALL_SCOPES).includes("point");
  // Another film (or another cut of it) starts the note's target from its default again, with or without a
  // preview. A pending note refuses the switch, so nothing in progress is dropped here.
  const filmKey = `${props.film !== undefined ? (props.film ?? "") : (preview?.video ?? "")}/${preview?.version ?? ""}`;
  const seenFilm = useRef(filmKey);
  useLayoutEffect(() => {
    if (seenFilm.current === filmKey) return;
    seenFilm.current = filmKey;
    setAim(null);
  }, [filmKey]);

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

  // The target defaults to the pick, else the first entry; an entry that's gone (a variant removed, say) falls back the same way.
  const fallbackOn = props.defaultOn ?? rows.find((r) => r.picked)?.on ?? rows[0]?.on ?? onOptions[0]?.value ?? null;
  const aimed = aim !== null && onOptions.some((o) => o.value === aim.value) ? aim : null;
  const option = onOptions.find((o) => o.value === (aimed?.value ?? fallbackOn)) ?? null;
  const aimT = aimed?.t ?? null;
  const clearAim = () => {
    setAim(null);
    setSelected(null);
    setRange(NO_RANGE);
    setMarks([]);
  };
  /** The note's stage, `on`, scope, times and target line, read at `at` (the playhead now). */
  const targetAt = (at: number) => {
    const marked = hasRange && range.in !== null && range.out !== null ? { t: range.in, tOut: range.out } : null;
    const t = marked ? marked.t : option?.t ?? aimT;
    if (stage === "mix" || !option || option.on === null) {
      const when = marked ? noteTime(marked.t, marked.tOut) : timecode(snap(at, fps), fps);
      return { stage, on: option?.on ?? null, scope: (marked ? "range" : "point") as Scope, t: marked?.t ?? snap(at, fps), tOut: marked?.tOut ?? null, label: `${when} · ${title}` };
    }
    return noteTarget({ kind: "take", stage, on: option.on, name: option.full ?? option.label, t, tOut: marked?.tOut ?? null }, null, fps);
  };

  // ---- the playhead, timecode and preview: refs, never per-frame state ----
  const root = useRef<HTMLDivElement>(null);
  const heads = useRef<HTMLElement[]>([]);
  const tc = useRef<HTMLSpanElement>(null);
  const pvTc = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  // The preview starts when the audio clock does, not when Play is pressed (see paint).
  const pvStarted = useRef(false);
  const lastPaintT = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const placeholderFor = (t: number) => {
    if (hasRange && range.in !== null && range.out === null) return "Set an Out point";
    const target = targetAt(t);
    if (target.scope === "whole") return stage === "voice" ? "Note on the whole read" : "Note on the whole track";
    if (target.scope === "range") return `Note on ${noteTime(target.t, target.tOut)}`;
    return `Note at ${fmt(target.t ?? snap(t, fps))}`;
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
    // Audio can take a moment to start after Play (WebKit's especially, under load). A preview
    // already running would get ahead of a clock still at the start and be pulled back, again and
    // again; so it's started on the first frame the clock has actually moved.
    if (v && engine.playing && !pvStarted.current && t > lastPaintT.current) {
      pvStarted.current = true;
      void v.play().catch(() => undefined);
    }
    lastPaintT.current = t;
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
    // Playing, paint() starts the preview (or a newly chosen one) once the audio clock moves.
    pvStarted.current = false;
    if (!playing) {
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
  };
  const setOut = () => {
    if (!hasRange) return;
    const at = snap(engine.time, fps);
    const start = range.in ?? 0;
    if (at <= start) return toast("Out has to come after In");
    setRange({ in: start, out: at });
  };
  const clearRange = () => {
    setRange(NO_RANGE);
    setMarks([]);
  };

  // Clicking a lane selects it, auditions it at the playhead (a 4 ms gain ramp, the playhead
  // untouched) and makes its take the note's target: the whole take, or the point clicked (`t`).
  const select = (row: StageRow, t: number | null = null) => {
    setSelected(row.key);
    // Heard in the click itself, not a render later.
    apply(plan(row.key));
    if (row.on) setAim({ value: row.on, t: offersPoint ? t : null });
    props.onSelect?.(row);
  };

  // ---- keyboard: Space, ←/→ (Shift: ten), I, O, N ----
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKeyRef.current = (e: KeyboardEvent) => {
    if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.key === " ") {
      // A focused button (Measure again, say) is pressed by Space, not played over (§19.8).
      if (spacePressesButton(e.target)) return;
      e.preventDefault();
      toggle();
    }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(e.shiftKey ? -10 : -1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(e.shiftKey ? 10 : 1); }
    else if (k === "i") setIn();
    else if (k === "o") setOut();
    else if (k === "n") { e.preventDefault(); input.current?.focus(); }
    else if (k === "v" || e.key === "Escape") clearAim();
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
    if (hasRange && range.in !== null && range.out === null) throw new Error("set an Out point for the range");
    // A note on a cue is saved at the cue's time (§17.4); a click on a lane, at the time clicked; else the whole take.
    const target = targetAt(engine.time);
    await api.post("/api/notes", {
      stage,
      video: preview?.video ?? null,
      version: preview?.version ?? null,
      on: target.on,
      scope: target.scope,
      t: target.t,
      tOut: target.tOut,
      text,
      marks: target.scope === "range" ? marks : [],
    });
    setRange(NO_RANGE);
    setMarks([]);
    onChanged();
  };

  const version = preview?.version ?? null;
  // Audio times are the audio's own: they don't move with the cut, so they're drawn as saved. A tab
  // without Range (Voiceover, §18.3) draws an older range note as a point at its In, never a span.
  const drawn: Record<string, LaneMark[]> = {};
  for (const n of notes) {
    if (n.scope === "whole" || n.t === null) continue;
    const at = noteRow(n);
    for (const row of at === null ? [] : typeof at === "string" ? [at] : at) {
      (drawn[row] ??= []).push({ id: n.id, t: n.t, tOut: hasRange ? n.tOut : null, status: n.status, text: n.text });
    }
  }

  const rangeLabel = range.in === null ? null : range.out === null ? `${fmt(range.in)} →` : noteTime(range.in, range.out);
  // The target line, as of the last render (a point or a range does not move with the playhead; "this moment" waits for the next render).
  const noteTarget_ = targetAt(engine.time);

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
        {/* Nothing of this film's own: say so, above the folded "Not on this film" when there is one. */}
        {rows.every((r) => r.key.startsWith("loose")) && <p class="lanesnone">{NONE_YET[stage]}</p>}
        <Lanes
          rows={rows}
          length={length}
          media={media}
          selected={selected}
          marks={drawn}
          range={range}
          onSelect={select}
          onSeek={(t, row, cue) => {
            select(row, snap(t, fps));
            // §23: a cue's label or tick also aims the note at that cue, so the next note lands on it at its time.
            const cueAim = cue === undefined ? undefined : onOptions.find((o) => o.value === `c:${row.key}:${cue}`);
            if (cueAim) setAim({ value: cueAim.value, t: null });
            engine.seek(t);
          }}
          toast={toast}
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
        <NotesPanel
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
          target={{ label: noteTarget_.label, onClear: aimed || selected || range.in !== null ? clearAim : undefined }}
          chips={(props.chipsFor ?? (() => AUDIO_CHIPS[stage]))(noteTarget_.scope)}
          marks={props.marks === false || noteTarget_.scope !== "range" ? undefined : { value: marks, onChange: setMarks }}
          onLabel={onLabel}
          readOnly={props.readOnly}
        />
      </div>
    </div>
  );
}

function dedupe(clips: Clip[]): Clip[] {
  const seen = new Set<string>();
  return clips.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}
