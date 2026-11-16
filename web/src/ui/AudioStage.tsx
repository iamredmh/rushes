// §27, 5.8: the frame of a sound's tab (Voice, Music and Effects), the Timeline tab's own parts reused. The left column
// is the transport, then the tool strip down the left edge beside the timeline panel: the ruler, the Picture row, and
// the sound's takes (Takes), with all the column's height (Red, round 1: the picture is only a reference here). The right
// column is a small preview of the cut (muted, following the audio clock; the no-cut slate before there is one) above
// the notes panel, its target line following the selection and the playhead.
//
// One AudioEngine per mount (useAudioStage) is the clock. It plays this sound's take only (the one selected, else the
// take in use, else the first one waiting): the other sounds and the cut's own sound are heard on the Timeline tab, never
// here. Selecting is a 4 ms gain ramp on one clock, never a restart; nothing is saved until a circle is pressed. Nothing
// here re-renders per frame: the parts that show the time (the transport, the ruler, the Picture row, the preview's
// timecode and the notes panel) each follow the engine on their own (Clocked), and the takes' playheads are moved
// through a ref.
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, mediaUrl, putAway, setPick } from "../api.js";
import { type AudioEngine, type EngineSnapshot, liveContexts } from "../audio/engine.js";
import { type SampleState, samples } from "../audio/sample.js";
import { assetRev, type Clip, needsVideoSync, setStreamThreshold } from "../audio/timeline.js";
import { useAudioStage } from "../audio/useAudioStage.js";
import { defaultTake, noteState, noteTarget, pctOf as pctOfLength, rulerMarks, viewPct, zoomView, type TakeGroups, takeKey, type TakeRow, takeSections, timecode, type Tool } from "../desk.js";
import {
  blindOrder, fmt, frameAt, noteTime, notePending, type Scope, shotAt, shotLabel, shotSeek, snap, spacePressesButton, stepFrame, takeDetails, testFlags, variantFilms,
} from "../lib.js";
import type { Asset, Mark, Note, Version } from "../types.js";
import { shortLabel } from "../versions.js";
import { waveDraws } from "./Lanes.js";
import type { FilmsControl } from "./FilmsMenu.js";
import { PreviewDivider, type ReviewClock, usePreviewSize, useReviewClock, useVolume } from "./desk/frame.js";
import { Icon } from "./Icon.js";
import { NoCutSlate } from "./desk/NoCut.js";
import { escapeIsFree, NotesPanel, useNoteBox } from "./desk/NotesPanel.js";
import { PictureTrack } from "./desk/PictureTrack.js";
import { useTimeView } from "./desk/tracks.js";
import { timelineWheel, ZoomRow } from "./desk/ZoomBar.js";
import { Ruler, type RulerMarker } from "./desk/Ruler.js";
import { archiveTakesOff, type LooseItem, type TakeItem, type TakeListSection, type TakeMark, Takes } from "./desk/Takes.js";
import { ToolStrip } from "./desk/ToolStrip.js";
import { Transport } from "./desk/Transport.js";

// ---- test-only switches (never on in normal use) ----
// `?test=1` exposes the engine on window.__rushesAudio for the e2e suite; `&streamOver=1` streams
// any file over 1 second, so the long-file fallback runs in a real browser.
const FLAGS = typeof location === "undefined" ? { test: false, streamOver: false } : testFlags(location.search);
if (FLAGS.streamOver) setStreamThreshold(1);

export interface AudioTestHook {
  /** The mounted tab's engine (a sound's tab, or the Timeline tab's), or null when neither is showing. */
  engine: AudioEngine | null;
  inspect(): EngineSnapshot | null;
  /** Renders of a sound's tab since the page loaded (its takes list; the clocked parts are not counted). */
  renders: number;
  /** Renders of a sound's tab's notes panel since the page loaded: only when its target line or placeholder changes. */
  panelRenders: number;
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
      panelRenders: 0,
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

export type SoundStage = "voice" | "music" | "sfx";

/** The cut the monitor shows: the film's locked cut, or its newest. */
export interface Preview {
  video: string;
  version: Version;
  locked: boolean;
}

// ---- the takes as a tab shows them ----

/** What a sound's tab lists, built from its takes (takeGroups): the headings and their items, Put away, and each take's name as shown. */
export interface TakeList {
  sections: TakeListSection[];
  away: TakeItem[];
  /** The take a key names, as shown (Blind's "Bed 2"), or null for one not listed here. */
  nameOf(key: string): string | null;
  /** What plays with nothing selected (defaultTake). */
  defaultKey: string | null;
}

/**
 * The tab's items: each take's clip (none when its file is missing), its details and its Films button. With Blind
 * (`blind` the shuffle's seed and `word` the name, "Read"), each heading's takes are shuffled, every take is named "Read
 * n" in the order shown and its details are hidden; what plays never changes with it.
 */
export function takeList(opts: {
  stage: SoundStage;
  groups: TakeGroups;
  assets: Asset[];
  blind: { seed: number; word: string } | null;
  films(row: TakeRow): FilmsControl | undefined;
}): TakeList {
  const { stage, groups, assets, blind } = opts;
  const shuffle = (takes: TakeRow[]) => (blind ? blindOrder(takes.map(takeKey), blind.seed).map((k) => takes.find((t) => takeKey(t) === k)!) : takes);
  const raw = takeSections(groups, shuffle);
  const awayRows = shuffle(groups.away);
  const names = new Map<string, string>();
  let n = 0;
  for (const t of [...raw.flatMap((s) => s.takes), ...awayRows]) names.set(takeKey(t), blind ? `${blind.word} ${++n}` : t.variant.name);
  const item = (t: TakeRow): TakeItem => {
    const key = takeKey(t);
    const asset = assets.find((a) => a.path === t.variant.file);
    const missing = asset?.missing === true;
    return {
      take: t,
      key,
      name: names.get(key)!,
      details: blind ? [] : takeDetails(t.variant.meta, stage === "sfx" ? t.variant.cues.length : 0),
      missing,
      // Every take of a sound shares one engine lane: they are alternatives, and one is heard at a time.
      clip: missing ? null : { id: key, lane: stage, path: t.variant.file, offset: 0, duration: 0, rev: asset ? assetRev(asset) : undefined },
      cues: stage === "sfx" ? t.variant.cues : [],
      films: opts.films(t),
    };
  };
  const d = defaultTake(groups);
  return {
    sections: raw.map((s) => ({ kind: s.kind, heading: s.heading, items: s.takes.map(item) })),
    away: awayRows.map(item),
    nameOf: (key) => names.get(key) ?? null,
    defaultKey: d ? takeKey(d) : null,
  };
}

/** The Films control's input for a take: which films it is on. */
export const filmsOf = (t: TakeRow) => ({ lane: t.lane, variant: t.variant.id, films: variantFilms(t.variant) });

// ---- the frame ----

export interface AudioStageProps {
  stage: SoundStage;
  /** "Voice", "Music", "Effects": the tab's name, on the ruler's row and in a note's target. */
  title: string;
  /** The film being reviewed (null: none). Another film starts the selection and the playhead again. */
  film: string | null;
  /** §26: the film is shelved, so the tab is looked at, not added to: no note box. */
  readOnly?: boolean;
  list: TakeList;
  loose: { items: LooseItem[]; what: string };
  /** Beside the tab's name on the ruler's row: Blind on Voice and Music. */
  headerExtra?: ComponentChildren;
  preview: Preview | null;
  /** What to ask your agent for, for a cut (the no-cut slate). */
  prompt: string;
  fps: number;
  notes: Note[];
  /** The take (its key) a note is drawn on, or null. */
  noteRow(note: Note): string | null;
  /** What a listed note is on, for the notes panel. */
  onLabel(note: Note): string | null;
  /** A note's target line names the take (or one of its cues) like this: "Round 2 · Gerald", "Cue · Swipe". */
  targetName(item: TakeItem, cue: string | null): string;
  /** Every sound's tab takes a range (I and O, the Range tool); Music and Effects also tick marks on it (Rise, Fall,
   *  Louder, Quieter). Voice takes none: a read is replaced, not levelled (round 1 ruling). */
  rangeMarks: boolean;
  /** The target menu's whole-take choice: "The whole read". */
  wholeLabel: string;
  /** Said in the list when the film has no takes of this sound. */
  none: string;
  /** §23: an effects pass's layers by sound. */
  layers?: { open(key: string): boolean; toggle(key: string): void };
  toast(message: string): void;
  onChanged(): void;
  /** A half-typed note, a range or ticked marks wait: the caller refuses a film or tab switch meanwhile. */
  onPendingChange?(pending: boolean): void;
  /** §27, 5.5 (final review I3): the film's one playhead across the Review tabs: the tab starts there, and leaves its
   *  time there when it goes. */
  clock?: ReviewClock;
}

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
const NO_RANGE = { in: null, out: null } as { in: number | null; out: number | null };
const COLOR: Record<SoundStage, string> = { voice: "var(--vo)", music: "var(--music)", sfx: "var(--sfx)" };
// Which folded groups are open, per sound, for the session.
const awayOpen = new Set<SoundStage>();
const looseOpen = new Set<SoundStage>();

/** Re-renders its children as the engine's clock moves, so the parent never has to. */
function Clocked({ engine, children }: { engine: AudioEngine; children: (t: number) => ComponentChildren }) {
  const [t, setT] = useState(engine.time);
  useEffect(() => {
    setT(engine.time);
    return engine.subscribe(setT);
  }, [engine]);
  return <>{children(t)}</>;
}

/**
 * Re-renders its children as the engine's clock moves, but only on a tick that changes `by(t)`: the notes panel follows
 * the clock through its target line and placeholder, so it re-renders when those read differently, never on every frame.
 */
function ClockedBy({ engine, by, children }: { engine: AudioEngine; by: (t: number) => string; children: (t: number) => ComponentChildren }) {
  const [, tick] = useState(0);
  const byRef = useRef(by);
  byRef.current = by;
  useEffect(() => {
    let last = byRef.current(engine.time);
    tick((n) => n + 1);
    return engine.subscribe((t) => {
      const now = byRef.current(t);
      if (now === last) return;
      last = now;
      tick((n) => n + 1);
    });
  }, [engine]);
  // Read at render, so a render the parent asks for (a new selection) is never a tick behind.
  return <>{children(engine.time)}</>;
}

/** What the note is on: a take selected (by its name, a point on its block or one of its cues), or nothing (the default take). */
type Picked = { key: string; cue: string | null; clicked: boolean };

export function AudioStage(props: AudioStageProps) {
  const { stage, title, list, preview, fps, notes, noteRow, onLabel, targetName, rangeMarks, toast, onChanged, onPendingChange, readOnly = false } = props;
  if (hook) hook.renders++;

  // ---- the takes on show, and what the engine plays ----
  const [, rerender] = useState(0);
  const toggleSet = (set: Set<SoundStage>) => {
    if (set.has(stage)) set.delete(stage);
    else set.add(stage);
    rerender((n) => n + 1);
  };
  const showAway = awayOpen.has(stage);
  const items = [...list.sections.flatMap((s) => s.items), ...(showAway ? list.away : [])];
  // Only the takes you can reach are decoded: a folded Put away keeps its files out of the engine. Only this sound's: a
  // sound's tab is for hearing that sound on its own (Red, round 1).
  const clips = items.flatMap((it) => (it.clip ? [it.clip] : []));
  const [loadedDuration, setLoadedDuration] = useState<number | null>(null);
  const [aspect, setAspect] = useState(16 / 9);
  const file = preview?.version.file;
  useEffect(() => {
    setLoadedDuration(null);
    setAspect(16 / 9);
  }, [file]);
  const videoDuration = preview ? (preview.version.duration ?? loadedDuration) : null;
  // Before the engine's own hook, so leaving reads the time before the engine is disposed.
  const engineRef = useRef<AudioEngine | null>(null);
  useReviewClock(props.clock, props.film ?? "", () => snap(engineRef.current?.time ?? 0, fps));
  const { engine, playing, length, media } = useAudioStage(clips, videoDuration);
  engineRef.current = engine;
  // The tab opens where the film's playhead is (clamped to the tab's length once that is known).
  useLayoutEffect(() => {
    const at = props.clock?.at(props.film ?? "") ?? 0;
    if (at > 0) engine.seek(at);
  }, []);

  // ---- the selection: the take auditioned and the note's target ----
  const [picked, setPicked] = useState<Picked | null>(null);
  // The target menu's choice for the take: the whole take (true) or a point (false); null lets the playhead decide.
  const [whole, setWhole] = useState<boolean | null>(null);
  const selectedItem = picked ? items.find((it) => it.key === picked.key) ?? null : null;
  // A selected take that is no longer listed (put away and folded, removed, moved to another film) lets go.
  useLayoutEffect(() => {
    if (picked !== null && selectedItem === null) {
      setPicked(null);
      setWhole(null);
    }
  }, [selectedItem === null]);
  const heardKey = selectedItem?.key ?? list.defaultKey ?? "";
  // A layout effect, so what you hear changes in the same commit that marks a new pick In use. The engine keeps a
  // lane's selection apart from its clips, so this may run before setClips.
  useLayoutEffect(() => engine.selectVariant(stage, heardKey), [engine, heardKey]);

  // ---- the transport's level and the tools ----
  const [sound, setSound] = useVolume();
  // What you hear: the take at full level under the transport's volume. A sound's saved level is a mix decision, heard on
  // the Timeline tab.
  useLayoutEffect(() => engine.setLaneGain(stage, sound.muted ? 0 : sound.level), [engine, sound.muted, sound.level]);
  const [range, setRange] = useState(NO_RANGE);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [noteHasText, setNoteHasText] = useState(false);
  const [noteFocused, setNoteFocused] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const openNoteBox = useNoteBox(input);
  const monitorRef = useRef<HTMLDivElement>(null);
  // The preview's size once its divider has been dragged (shared by the three sound tabs), and the column it is a share of.
  const previewSize = usePreviewSize();
  const sideRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onIn = (e: FocusEvent) => setNoteFocused(!!input.current && e.target === input.current);
    const onOut = (e: FocusEvent) => {
      if (e.target === input.current) setNoteFocused(false);
    };
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, []);

  // Another film starts at its own playhead with nothing selected. A pending note refuses the switch, so nothing in
  // progress is dropped here.
  const seenFilm = useRef(props.film);
  useLayoutEffect(() => {
    if (seenFilm.current === props.film) return;
    seenFilm.current = props.film;
    setPicked(null);
    setWhole(null);
    engine.pause();
    engine.seek(props.clock?.at(props.film ?? "") ?? 0);
  }, [props.film]);

  // Nothing pending is dropped: a half-typed note, a range or ticked marks hold the film and the tab. A layout effect,
  // so the hold is in place before the next key (`]` straight after `I`) is handled.
  const pending = !readOnly && notePending({ range, marks, hasText: noteHasText });
  useLayoutEffect(() => {
    onPendingChange?.(pending);
  }, [pending]);
  useEffect(() => () => onPendingChange?.(false), []);

  // ---- the note's target, read at `at` (the playhead now) ----
  const targetItem = selectedItem ?? items.find((it) => it.key === list.defaultKey) ?? null;
  const cue = selectedItem && picked?.cue && selectedItem.cues.some((c) => c.id === picked.cue) ? picked.cue : null;
  const marked = range.in !== null && range.out !== null ? { t: range.in, tOut: range.out } : null;
  /** A point (at the playhead, or a cue's time) unless the menu says the whole take: a point once the playhead has moved off zero or a point was clicked. */
  const pointAt = (at: number) => (whole !== null ? !whole : cue !== null || !!(selectedItem && picked?.clicked) || snap(at, fps) > 0);
  const targetAt = (at: number) => {
    if (!targetItem) {
      const when = marked ? noteTime(marked.t, marked.tOut) : timecode(snap(at, fps), fps);
      return { stage, on: null, scope: (marked ? "range" : "point") as Scope, t: marked?.t ?? snap(at, fps), tOut: marked?.tOut ?? null, label: `${when} · ${title}`, when, name: title };
    }
    // A cue is a point at its own time; chosen whole, the note is on the pass, not the cue.
    const point = marked !== null || pointAt(at);
    const onCue = point ? cue : null;
    const on = onCue ? `${targetItem.key}:${onCue}` : targetItem.key;
    const name = targetName(targetItem, onCue);
    if (marked) return noteTarget({ kind: "take", stage, on, name, t: marked.t, tOut: marked.tOut }, null, fps);
    const t = point ? (onCue ? targetItem.cues.find((c) => c.id === onCue)!.t : snap(at, fps)) : null;
    return noteTarget({ kind: "take", stage, on, name, t }, null, fps);
  };
  const placeholderAt = (at: number) => {
    if (range.in !== null && range.out === null) return "Set an Out point";
    const target = targetAt(at);
    if (target.scope === "whole") return `Note on ${props.wholeLabel.toLowerCase()}`;
    if (target.scope === "range") return `Note on ${noteTime(target.t, target.tOut)}`;
    return `Note at ${fmt(target.t ?? snap(at, fps))}`;
  };
  // Lets go of the take and the menu's choice; a marked range and its ticked marks stay (Clear range is their control).
  const clearAim = () => {
    setPicked(null);
    setWhole(null);
  };

  // ---- the stretch of the cut on screen (Red, 16 Nov 2026: the sound tabs zoom and scroll as the Timeline does) ----
  const tv = useTimeView(length, null, `${props.film ?? ""}:${preview?.version.id ?? ""}`);
  const tvRef = useRef(tv);
  tvRef.current = tv;

  // ---- the playheads and the muted picture: refs, never per-frame state ----
  const takesRoot = useRef<HTMLDivElement>(null);
  const heads = useRef<HTMLElement[]>([]);
  const video = useRef<HTMLVideoElement>(null);
  // The picture starts when the audio clock does, not when Play is pressed (see paint).
  const pvStarted = useRef(false);
  const lastPaintT = useRef(0);
  const paint = (t: number) => {
    const len = engine.length;
    const tvNow = tvRef.current;
    // Zoomed, the playheads sit on the stretch on screen, and the view pages along to keep the playhead in it.
    if (tvNow?.zoomed) tvNow.follow(t);
    const left = tvNow?.zoomed ? `${viewPct(Math.min(t, len), tvNow.view)}%` : `${len > 0 ? (Math.min(t, len) / len) * 100 : 0}%`;
    for (const h of heads.current) h.style.left = left;
    // The picture follows the audio clock: seeked back once it's more than a frame off (§17.2).
    const v = video.current;
    if (v && v.readyState >= 1 && !v.seeking && needsVideoSync(v.currentTime, t, fps)) {
      v.currentTime = Math.min(t, Number.isFinite(v.duration) ? v.duration : t);
    }
    // Audio can take a moment to start after Play (WebKit's especially, under load). A picture already running would get
    // ahead of a clock still at the start and be pulled back, again and again; so it's started on the first frame the
    // clock has actually moved.
    if (v && engine.playing && !pvStarted.current && t > lastPaintT.current) {
      pvStarted.current = true;
      void v.play().catch(() => undefined);
    }
    lastPaintT.current = t;
  };
  const paintRef = useRef(paint);
  paintRef.current = paint;
  useLayoutEffect(() => {
    heads.current = takesRoot.current ? [...takesRoot.current.querySelectorAll<HTMLElement>(".playhead")] : [];
    paint(engine.time);
  });
  useEffect(() => engine.subscribe((t) => paintRef.current(t)), [engine]);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    // Playing, paint() starts the picture (or a newly chosen one) once the audio clock moves.
    pvStarted.current = false;
    if (!playing) {
      v.pause();
      paintRef.current(engine.time);
    }
  }, [playing, file]);

  // ---- transport and tools ----
  const toggle = () => (engine.playing ? engine.pause() : engine.play());
  const step = (n: number) => {
    engine.pause();
    engine.seek(stepFrame(engine.time, fps, n, engine.length));
  };
  const seek = (t: number) => engine.seek(t);
  const setIn = () => {
    if (readOnly) return;
    setRange({ in: snap(engine.time, fps), out: null });
  };
  const setOut = () => {
    if (readOnly) return;
    const at = snap(engine.time, fps);
    const start = range.in ?? 0;
    if (at <= start) return toast("Out has to come after In");
    setRange({ in: start, out: at });
  };
  const clearRange = () => {
    setRange(NO_RANGE);
    setMarks([]);
  };
  const marking = range.in !== null && range.out === null;
  const tool: Tool = noteFocused ? "note" : marking ? "range" : "select";
  const selectTool = () => {
    clearAim();
    if (marking) clearRange();
    if (input.current && document.activeElement === input.current) input.current.blur();
  };
  const fullScreen = () => {
    const el = monitorRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void el.requestFullscreen?.().catch(() => toast("Couldn't go full screen"));
  };

  // A take's name selects it whole, its block a point (and the playhead goes there), a cue that cue at its time. It is
  // heard in the click itself (a 4 ms gain ramp, the playhead untouched by the name), never a render later.
  const select = (it: TakeItem, t: number | null, cueId?: string) => {
    setPicked({ key: it.key, cue: cueId ?? null, clicked: t !== null });
    setWhole(null);
    engine.selectVariant(stage, it.key);
    if (t !== null) engine.seek(t);
  };
  const pick = async (it: TakeItem, variant: string | null) => {
    try {
      await setPick(props.film ?? undefined, it.take.lane, variant);
    } catch (e) {
      toast(`Couldn't ${variant === null ? "clear" : "set"} the pick: ${(e as Error).message}`);
    }
    onChanged();
  };
  const away = async (it: TakeItem, to: boolean) => {
    // A take other films share comes off this film only; it stays on the rest (Takes.archiveTakesOff).
    if (to && it.films && archiveTakesOff(it)) {
      const c = it.films;
      const here = c.films.find((f) => f.here)!.id;
      const rest = c.films.filter((f) => f.id !== here && c.on.includes(f.id)).map((f) => f.name);
      c.onChange(c.on.filter((id) => id !== here));
      toast(`Taken off this film. Still on ${rest.join(", ")}.`);
      return;
    }
    try {
      await putAway(it.take.lane, it.take.variant.id, to);
    } catch (e) {
      toast(`Couldn't ${to ? "archive it" : "restore it"}: ${(e as Error).message}`);
    }
    onChanged();
  };

  // ---- keyboard: Space, ←/→ (Shift: ten), I, O, N, V, F, Esc ----
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKeyRef.current = (e: KeyboardEvent) => {
    if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.key === " ") {
      // A focused button (Blind, Archive, a circle) is pressed by Space, not played over (§19.8).
      if (spacePressesButton(e.target)) return;
      e.preventDefault();
      toggle();
    }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(e.shiftKey ? -10 : -1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(e.shiftKey ? 10 : 1); }
    else if (k === "v") selectTool();
    else if (escapeIsFree(e)) clearAim();
    else if (k === "f" && preview) { e.preventDefault(); if (!e.repeat) fullScreen(); }
    else if (k === "i") setIn();
    else if (k === "o") setOut();
    else if (k === "n" && !readOnly) { e.preventDefault(); openNoteBox(); }
    else if (e.key === "=" || e.key === "+") { e.preventDefault(); tv.set(zoomView(tv.view, length, 0.5, engine.time)); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); tv.set(zoomView(tv.view, length, 2, engine.time)); }
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
    if (range.in !== null && range.out === null) throw new Error("set an Out point for the range");
    const target = targetAt(engine.time);
    await api.post("/api/notes", {
      stage,
      video: props.film,
      version: preview?.version.id ?? null,
      on: target.on,
      scope: target.scope,
      t: target.t,
      tOut: target.tOut,
      text,
      marks: rangeMarks && target.scope === "range" ? marks : [],
    });
    setRange(NO_RANGE);
    setMarks([]);
    onChanged();
  };
  // Audio times are the audio's own: they don't move with the cut, so they're drawn as saved: a point at its time, a range
  // (on every sound's tab, Voice too since round 1) as a span from In to Out.
  const drawn: Record<string, TakeMark[]> = {};
  const timed: Note[] = [];
  for (const n of notes) {
    if (n.scope === "whole" || n.t === null) continue;
    const key = noteRow(n);
    if (key === null) continue;
    const tOut = n.scope === "range" ? n.tOut : null;
    (drawn[key] ??= []).push({ id: n.id, t: n.t, tOut, status: noteState(n), text: n.text });
    timed.push({ ...n, tOut });
  }
  const timedText = new Map(timed.map((n) => [n.id, n.text]));
  const rulerMarkers: RulerMarker[] = rulerMarks(timed, length, tv.view).map((m) => ({ ...m, ring: false, title: timedText.get(m.id) ?? "" }));
  const pctOf = (s: number) => (tv.zoomed ? viewPct(Math.min(length, Math.max(0, s)), tv.view) : pctOfLength(s, length));
  const liveRange = range.in !== null ? { left: pctOf(range.in), width: pctOf(range.out ?? range.in + 0.2) - pctOf(range.in) } : null;
  const rangeLabel = range.in === null ? null : range.out === null ? `${fmt(range.in)} →` : noteTime(range.in, range.out);
  const shots = preview ? preview.version.shots.filter((s) => !length || s.start < length) : [];
  const menuLabels = [{ value: "point", label: cue ? "This cue" : "This moment" }, { value: "whole", label: props.wholeLabel }];

  // The preview: the cut chosen in the Cut menu, muted, at its own shape across the right column; the no-cut slate before
  // there is one. It is what goes full screen.
  const previewBox = (
    <div class={`monitor spreview${preview ? "" : " noslot"}`} ref={monitorRef} style={preview ? { "--ar": String(aspect) } : undefined}>
      {preview ? (
        <>
          <div class="framebox">
            <div class="fitbox">
              <div class="frame" style={{ aspectRatio: String(aspect), "--ar": String(aspect) }}>
                <video
                  ref={video}
                  src={mediaUrl(preview.version.file)}
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
                  onClick={toggle}
                />
                <Clocked engine={engine}>
                  {(t) => {
                    const shot = shotAt(shots, snap(t, fps));
                    return <div class="tcover">f{frameAt(t, fps)}{shot && ` · shot ${shotLabel(shot.n)}`}</div>;
                  }}
                </Clocked>
              </div>
            </div>
          </div>
          <button
            type="button"
            class="spfull"
            data-tip="Full screen · F"
            aria-label="Full screen · F"
            onClick={(e) => {
              if (e.detail > 0) (e.currentTarget as HTMLElement).blur();
              fullScreen();
            }}
          >
            <Icon name="expand" />
          </button>
        </>
      ) : (
        <NoCutSlate prompt={props.prompt} toast={toast} then="Until then the takes play here on their own." />
      )}
    </div>
  );

  return (
    <div
      class={`split deskcols soundcols${preview && previewSize.size !== null ? " pvsized" : ""}`}
      style={preview && previewSize.size !== null ? { "--pv": String(previewSize.size), "--ar": String(aspect) } : undefined}
    >
      <div class="tl soundtab">
        <Clocked engine={engine}>
          {(t) => (
            <Transport
              t={t}
              duration={length}
              playing={playing}
              onToggle={toggle}
              onStep={step}
              rangeLabel={rangeLabel}
              onClearRange={clearRange}
              volume={sound.level}
              muted={sound.muted}
              onVolume={(level) => setSound({ level, muted: level === 0 ? sound.muted : false })}
              onMute={() => setSound({ ...sound, muted: !sound.muted })}
            />
          )}
        </Clocked>

        {/* The tool strip keeps the Timeline's place, down the left edge, here beside the ruler, the Picture row and the takes. */}
        <div class="kbody">
          <ToolStrip
            active={tool}
            readOnly={readOnly}
            grabbing={false}
            tools={["select", "note", "range"]}
            onSelect={selectTool}
            onNote={openNoteBox}
            onRange={() => (marking ? setOut() : setIn())}
            onBox={() => undefined}
            onGrab={() => undefined}
          />
          <div class={`tlpanel takespanel${tv.zoomed ? " zoomed" : ""}`} onWheel={(e) => timelineWheel(e, tv, length)}>
            <div class="kstick">
              <div class="trow rrow">
                <div class="thead">
                  <span class="kttl">{title}</span>
                  <span class="sp" />
                  {props.headerExtra}
                </div>
                <Clocked engine={engine}>
                  {(t) => (
                    <Ruler duration={length} t={t} marks={rulerMarkers} live={liveRange} view={tv.view} onSeek={seek} onMark={(id) => {
                      const n = timed.find((x) => x.id === id);
                      if (n?.t != null) {
                        engine.pause();
                        seek(n.t);
                      }
                    }} />
                  )}
                </Clocked>
              </div>
            </div>
            <div ref={takesRoot}>
              <Takes
                label={`${title} takes`}
                color={COLOR[stage]}
                sections={list.sections}
                away={{ items: list.away, open: showAway, dot: notes.some((n) => n.status === "todo" && list.away.some((it) => it.key === noteRow(n))), onToggle: () => toggleSet(awayOpen) }}
                loose={{ ...props.loose, open: looseOpen.has(stage), onToggle: () => toggleSet(looseOpen) }}
                none={props.none}
                length={length}
                view={tv.zoomed ? tv.view : undefined}
                media={media}
                selected={selectedItem?.key ?? null}
                marks={drawn}
                range={range}
                layers={props.layers}
                onSelect={select}
                onPick={(it) => void pick(it, it.take.variant.id)}
                onUnpick={(it) => void pick(it, null)}
                onPutAway={(it, to) => void away(it, to)}
                toast={toast}
              />
            </div>
            {/* Red, 16 Nov 2026: the scenes under the takes, out of their way, then the zoom bar, as on the Timeline. */}
            <div class="kfoot">
              {preview && (
                <Clocked engine={engine}>
                  {(t) => (
                    <PictureTrack
                      shots={shots}
                      duration={length}
                      view={tv.view}
                      t={t}
                      current={shotAt(shots, snap(t, fps))?.n ?? null}
                      cutLabel={shortLabel(preview.version) || preview.version.id}
                      locked={preview.locked}
                      onSeek={(start) => {
                        engine.pause();
                        seek(shotSeek(start, fps));
                      }}
                    />
                  )}
                </Clocked>
              )}
              <Clocked engine={engine}>{(t) => <ZoomRow tv={tv} duration={length} t={t} />}</Clocked>
            </div>
          </div>
        </div>
      </div>

      {/* The right column: the preview above the notes panel; with the panel hidden, the preview alone at the same width. */}
      <div class="soundside" ref={sideRef}>
        {previewBox}
        {preview && <PreviewDivider column={sideRef} preview={monitorRef} size={previewSize} />}
        <ClockedBy engine={engine} by={(t) => `${targetAt(t).label}\n${placeholderAt(t)}`}>
          {(t) => {
            const target = targetAt(t);
            if (hook) hook.panelRenders++;
            return (
              <NotesPanel
                notes={notes}
                version={preview?.version.id ?? null}
                placeholder={placeholderAt(t)}
                inputRef={input}
                toast={toast}
                onAdd={add}
                onChanged={onChanged}
                onTextChange={setNoteHasText}
                fixedTimes
                onSeek={(to) => engine.seek(to)}
                target={{
                  label: target.label,
                  when: target.when,
                  name: target.name,
                  menu: targetItem && !marked ? { value: target.scope === "whole" ? "whole" : "point", options: menuLabels, onChange: (v) => setWhole(v === "whole") } : undefined,
                  onClear: selectedItem || whole !== null ? clearAim : undefined,
                }}
                marks={!rangeMarks || target.scope !== "range" ? undefined : { value: marks, onChange: setMarks }}
                onLabel={onLabel}
                readOnly={readOnly}
              />
            );
          }}
        </ClockedBy>
      </div>
    </div>
  );
}
