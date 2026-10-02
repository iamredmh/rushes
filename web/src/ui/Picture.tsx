import { useEffect, useRef, useState } from "preact/hooks";
import { api, mediaUrl } from "../api.js";
import { boxFrom, fmt, frameAt, noteTime, placeNote, shotAt, shotLabel, snap, stepFrame } from "../lib.js";
import type { Note, Video, Version } from "../types.js";
import { Icon } from "./Icon.js";
import { Notes } from "./Notes.js";

type Box = { x: number; y: number; w: number; h: number };

export interface PictureProps {
  video: Video;
  version: Version;
  fps: number;
  notes: Note[];
  toast(message: string): void;
  onChanged(): void;
  /** Whether an In/Out, box, grab or half-typed note is waiting to be submitted. */
  onPendingChange?(pending: boolean): void;
  /** Where to seek to once this cut's metadata has loaded (restoring a film's playhead on return). */
  startAt?: number;
  /** Forwards the underlying <video> element up, so a caller can read its live time or pause it directly. */
  playerRef?: { current: HTMLVideoElement | null };
}

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** The cut, with notes down the right: frame stepping, In/Out ranges, a box on the frame and frame grabs. */
export function Picture({ video, version, fps, notes, toast, onChanged, onPendingChange, startAt, playerRef }: PictureProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [t, setT] = useState(0);
  const [duration, setDuration] = useState(version.duration ?? 0);
  // The frame's shape: the video's own aspect ratio once metadata loads, 16:9 before then.
  const [aspect, setAspect] = useState(16 / 9);
  const [playing, setPlaying] = useState(false);
  const [broken, setBroken] = useState(false);
  const [range, setRange] = useState<{ in: number | null; out: number | null }>({ in: null, out: null });
  const [boxMode, setBoxMode] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [grab, setGrab] = useState<string | null>(null);
  const [shown, setShown] = useState<Box | null>(null);
  const [noteHasText, setNoteHasText] = useState(false);
  // The click that ends a box drag shouldn't also start playback.
  const justDrew = useRef(false);
  // The shot strip's cards, keyed by shot number, so the current one can be scrolled into view.
  const shotRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  // Read inside an effect instead of added as a dependency, so the strip scrolls only when the
  // current shot changes, never merely because playback started or stopped.
  const playingRef = useRef(playing);
  useEffect(() => { playingRef.current = playing; }, [playing]);

  // Tell the parent whether there's anything here it would be wrong to discard by
  // jumping to a newer cut: an In/Out, a box, a grab or a half-typed note.
  useEffect(() => {
    const pending = range.in !== null || box !== null || grab !== null || noteHasText;
    onPendingChange?.(pending);
    return () => onPendingChange?.(false);
  }, [range.in, box, grab, noteHasText]);

  // A new cut: start again from the top, with nothing pending. A file the browser
  // can't decode can fail before any handler is attached, so check the element too.
  useEffect(() => {
    setBroken(false);
    setT(0);
    setAspect(16 / 9);
    setRange({ in: null, out: null });
    setBox(null);
    setGrab(null);
    setShown(null);
    const v = ref.current;
    if (!v) return;
    const fail = () => setBroken(true);
    if (v.error) fail();
    v.addEventListener("error", fail);
    return () => v.removeEventListener("error", fail);
  }, [version.file]);

  // Smooth playhead while playing.
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const loop = () => {
      if (ref.current) setT(ref.current.currentTime);
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [playing]);

  // The element's time, snapped to its frame. Key handlers can run before a re-render, so never trust `t` for this.
  const now = () => snap(ref.current?.currentTime ?? t, fps);

  const seek = (to: number) => {
    const v = ref.current;
    if (!v) return;
    v.currentTime = Math.min(Math.max(0, to), duration || v.duration || to);
    setT(v.currentTime);
  };
  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => toast("Couldn't play this file"));
    else v.pause();
  };
  const step = (n: number) => {
    ref.current?.pause();
    seek(stepFrame(ref.current?.currentTime ?? t, fps, n, duration));
  };
  const setIn = () => setRange({ in: now(), out: null });
  const setOut = () => {
    const at = now();
    const start = range.in ?? 0;
    if (at <= start) return toast("Out has to come after In");
    setRange({ in: start, out: at });
  };
  const clearRange = () => setRange({ in: null, out: null });

  const grabFrame = async () => {
    const v = ref.current;
    if (!v || !v.videoWidth) return toast("Nothing to grab yet");
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")!.drawImage(v, 0, 0);
    const frame = frameAt(now(), fps);
    try {
      const r = await api.post<{ grab: string }>("/api/grabs", { video: video.id, version: version.id, frame, png: canvas.toDataURL("image/png") });
      setGrab(r.grab);
      toast(`Frame ${frame} saved`);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const add = async (text: string) => {
    const isRange = range.in !== null && range.out !== null;
    const at = isRange ? range.in! : now();
    await api.post("/api/notes", {
      stage: "picture",
      video: video.id,
      version: version.id,
      scope: isRange ? "range" : "point",
      t: at,
      tOut: isRange ? range.out : null,
      frame: frameAt(at, fps),
      text,
      box,
      grab,
    });
    clearRange();
    setBox(null);
    setGrab(null);
    onChanged();
  };

  // Keyboard: Space, ←/→, I, O, G, B and N, unless you're typing. The handler is refreshed on
  // every render (so it never acts on a stale closure), but the listener is bound once: the
  // playhead re-renders this component every frame while playing.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKeyRef.current = (e: KeyboardEvent) => {
    if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.key === " ") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(e.shiftKey ? -10 : -1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(e.shiftKey ? 10 : 1); }
    else if (k === "i") setIn();
    else if (k === "o") setOut();
    else if (k === "g") void grabFrame();
    else if (k === "b") setBoxMode((m) => !m);
    else if (k === "n") { e.preventDefault(); input.current?.focus(); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Drawing a box on the frame.
  const point = (e: PointerEvent) => {
    const r = overlay.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  };
  const down = (e: PointerEvent) => {
    if (!boxMode) return;
    const p = point(e);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const move = (e: PointerEvent) => {
    if (!drag) return;
    const p = point(e);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  };
  const up = (e: PointerEvent) => {
    if (!drag) return;
    const p = point(e);
    const b = boxFrom(drag.x0, drag.y0, p.x, p.y, p.w, p.h);
    setDrag(null);
    setBoxMode(false);
    justDrew.current = true;
    if (b.w > 0.01 && b.h > 0.01) setBox(b);
  };
  const live: Box | null = drag && overlay.current
    ? boxFrom(drag.x0, drag.y0, drag.x1, drag.y1, overlay.current.clientWidth, overlay.current.clientHeight)
    : null;
  const style = (b: Box) => ({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });

  const pct = (s: number) => `${duration ? (s / duration) * 100 : 0}%`;
  const shots = version.shots;
  const current = shotAt(shots, t);

  // Keeps the current card in view while playing, never merely because the player re-renders.
  useEffect(() => {
    if (!playingRef.current || current === null) return;
    shotRefs.current[current.n]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current?.n]);

  const placed = notes.map((n) => ({ n, at: placeNote(n, version.id) })).filter(({ at }) => at.t !== null);
  const rangeLabel = range.in === null ? null : range.out === null ? `${fmt(range.in)} →` : noteTime(range.in, range.out);
  const placeholder = range.in !== null && range.out === null ? "Set an Out point" : `Note at ${rangeLabel && range.out !== null ? rangeLabel : fmt(t)}`;

  return (
    <div class="split">
      <div class="stack">
        <div class="framebox">
          <div class="frame" style={{ aspectRatio: String(aspect) }}>
            {broken && <div class="msg">This file won't play in a browser. Ask your agent for an H.264 MP4 of this cut.</div>}
            <video
              hidden={broken}
              ref={(el) => { ref.current = el; if (playerRef) playerRef.current = el; }}
              src={mediaUrl(version.file)}
              preload="auto"
              playsInline
              onLoadedMetadata={(e) => {
                const v = e.target as HTMLVideoElement;
                setDuration(v.duration || version.duration || 0);
                if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
                if (startAt) {
                  v.currentTime = Math.min(startAt, v.duration || startAt);
                  setT(v.currentTime);
                }
              }}
              onTimeUpdate={(e) => !playing && setT((e.target as HTMLVideoElement).currentTime)}
              onSeeked={(e) => setT((e.target as HTMLVideoElement).currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
            />
            <div
              ref={overlay}
              class={`overlay${boxMode ? " drawing" : ""}`}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={up}
              onClick={() => {
                if (justDrew.current) justDrew.current = false;
                else if (!boxMode) toggle();
              }}
            >
              {shown && <div class="bx saved" style={style(shown)} />}
              {box && <div class="bx" style={style(box)} />}
              {live && <div class="bx" style={style(live)} />}
            </div>
            <div class="tcover">f{frameAt(t, fps)}{current && ` · shot ${shotLabel(current.n)}`}</div>
          </div>
        </div>

        <div class="bar">
          <button class="btn ghost ib" data-tip="Back one frame  ←" aria-label="Back one frame" onClick={() => step(-1)}><Icon name="prev" /></button>
          <button class="btn ib" data-tip="Play  Space" aria-label={playing ? "Pause" : "Play"} onClick={toggle}><Icon name={playing ? "pause" : "play"} /></button>
          <button class="btn ghost ib" data-tip="Forward one frame  →" aria-label="Forward one frame" onClick={() => step(1)}><Icon name="next" /></button>
          <span class="tc" aria-label="Timecode">{fmt(t)}<small>/ {fmt(duration)}</small></span>
          <span class="sp" />
          {rangeLabel && (
            <span class="chipx">
              <span class="mono">{rangeLabel}</span>
              <button aria-label="Clear range" onClick={clearRange}><Icon name="x" /></button>
            </span>
          )}
          <button class="btn ghost ib" data-tip="Set in  I" aria-label="Set in point" onClick={setIn}><Icon name="in" /></button>
          <button class="btn ghost ib" data-tip="Set out  O" aria-label="Set out point" onClick={setOut}><Icon name="out" /></button>
          <span class="vsep" />
          <button class="btn ghost ib" data-tip="Draw a box  B" aria-label="Draw a box" aria-pressed={boxMode} onClick={() => setBoxMode(!boxMode)}><Icon name="box" /></button>
          <button class="btn ghost ib" data-tip="Grab frame  G" aria-label="Grab frame" onClick={() => void grabFrame()}><Icon name="camera" /></button>
        </div>

        <div
          class="track"
          role="slider"
          aria-label="Timeline"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={t}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            seek(((e.clientX - r.left) / r.width) * duration);
          }}
        >
          {placed.map(({ n, at }) => at.tOut !== null && <div class={`span ${n.status}`} style={{ left: pct(at.t!), width: pct(at.tOut - at.t!) }} />)}
          {range.in !== null && <div class="span live" style={{ left: pct(range.in), width: pct((range.out ?? range.in + 0.2) - range.in) }} />}
          {shots.filter((s) => s.start > 0).map((s) => <div class="tick" style={{ left: pct(s.start) }} />)}
          {placed.map(({ n, at }) => <div class={`mk ${n.status}`} style={{ left: pct(at.t!) }} title={n.text} />)}
          <div class="playhead" style={{ left: pct(t) }} />
        </div>
        <div class="ends"><span>0:00</span><span>{fmt(duration)}</span></div>

        {shots.length > 0 && (
          <div class="shots">
            {shots.map((s) => (
              <button
                type="button"
                class="shot"
                ref={(el) => { shotRefs.current[s.n] = el; }}
                aria-current={current?.n === s.n ? "true" : undefined}
                onClick={() => { ref.current?.pause(); seek(s.start); }}
              >
                <span class="mono">{shotLabel(s.n)} · {s.start.toFixed(2)}s</span>
                <span class="name">{s.name}</span>
                {s.tag && <span class="tag">{s.tag}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <Notes
        notes={notes}
        version={version.id}
        placeholder={placeholder}
        inputRef={input}
        toast={toast}
        onAdd={add}
        onChanged={onChanged}
        onTextChange={setNoteHasText}
        onSeek={(to, n) => {
          ref.current?.pause();
          seek(to);
          setShown(n.box && (!n.version || n.version === version.id) ? n.box : null);
        }}
        attachments={(box || grab) && (
          <>
            {box && (
              <span class="chipx"><Icon name="box" />Box<button aria-label="Remove box" onClick={() => setBox(null)}><Icon name="x" /></button></span>
            )}
            {grab && (
              <span class="chipx"><Icon name="image" />Frame {grab.match(/_f(\d+)\.png$/)?.[1]}<button aria-label="Remove frame" onClick={() => setGrab(null)}><Icon name="x" /></button></span>
            )}
          </>
        )}
      />
    </div>
  );
}
