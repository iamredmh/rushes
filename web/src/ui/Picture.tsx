import { useEffect, useRef, useState } from "preact/hooks";
import { api, mediaUrl, originalFrame } from "../api.js";
import { boxFrom, contentRect, fmt, frameAt, noteTime, placeNote, shotAt, shotLabel, shotSeek, snap, spacePressesButton, stepFrame, type ProxyProgress } from "../lib.js";
import type { Note, ProxyJob, Video, Version } from "../types.js";
import { Icon } from "./Icon.js";
import { Notes } from "./Notes.js";
import { ProxyBar } from "./ProxyBar.js";
import { PictureWave, usePictureWave } from "./PictureWave.js";
import { usePlayerFloor } from "./playerFloor.js";

/** Which file the player shows when the cut has a proxy (§19.5). */
export type Source = "proxy" | "original";

type Box = { x: number; y: number; w: number; h: number };

export interface PictureProps {
  video: Video;
  version: Version;
  fps: number;
  notes: Note[];
  toast(message: string): void;
  onChanged(): void;
  /** Whether an In/Out, box or half-typed note is waiting to be submitted. A grab alone
   *  doesn't count: the file is already saved, so there's nothing left to lose. */
  onPendingChange?(pending: boolean): void;
  /** Where to seek to once this cut's metadata has loaded (restoring a film's playhead on return). */
  startAt?: number;
  /** This film's pending grab, owned by the caller: the single source of truth, so a remount
   *  (switching films, or leaving and returning to this tab) never has a stale copy to drift
   *  against. */
  grab: string | null;
  /** Tells the caller whenever the pending grab changes, so it can remember it per film. */
  onGrabChange(video: string, grab: string | null): void;
  /** Forwards the underlying <video> element up, so a caller can read its live time or pause it directly. */
  playerRef?: { current: HTMLVideoElement | null };
  /** §19.5: the server has ffmpeg (proxies are offered, and Grab Frame takes stills from the original). */
  ffmpeg?: boolean;
  /** project.autoProxy, for the proxy bar's checkbox. */
  autoProxy?: boolean;
  /** This cut's proxy job, as this tab last heard of it. */
  proxyJob?: ProxyProgress;
  noteProxyJob?(job: ProxyJob): void;
  /** This film's Proxy/Original choice, remembered by the caller. Proxy unless you've picked Original. */
  source?: Source;
  onSourceChange?(video: string, source: Source): void;
  /** §19.9: the cut's file size (null when unknown), for the waveform's no-ffmpeg fallback. */
  fileSize?: number | null;
  /** The cut's file revision (its modified time), so a file re-rendered in place gets a fresh waveform. */
  fileRev?: string;
}

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** The cut, with notes down the right: frame stepping, In/Out ranges, a box on the frame and frame grabs. */
export function Picture({
  video, version, fps, notes, toast, onChanged, onPendingChange, startAt, grab, onGrabChange, playerRef,
  ffmpeg = false, autoProxy = false, proxyJob, noteProxyJob, source = "proxy", onSourceChange, fileSize = null, fileRev,
}: PictureProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [t, setT] = useState(0);
  const [duration, setDuration] = useState(version.duration ?? 0);
  // Which cut `duration` was read from: until a new cut's metadata loads, it's still the last one's.
  const [durationOf, setDurationOf] = useState<string | null>(version.duration ? version.file : null);
  // The frame's shape: the video's own aspect ratio once metadata loads, 16:9 before then.
  const [aspect, setAspect] = useState(16 / 9);
  const [playing, setPlaying] = useState(false);
  const [broken, setBroken] = useState(false);
  const [range, setRange] = useState<{ in: number | null; out: number | null }>({ in: null, out: null });
  const [boxMode, setBoxMode] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number; w: number; h: number } | null>(null);
  // The overlay's size, kept only so the picture's rect (below) follows a resized window.
  const [overlaySize, setOverlaySize] = useState({ w: 0, h: 0 });
  const [box, setBox] = useState<Box | null>(null);
  const [shown, setShown] = useState<Box | null>(null);
  const [noteHasText, setNoteHasText] = useState(false);
  // Fix round 3 (M2): in a very short window the player column holds what's in it.
  const stackRef = useRef<HTMLDivElement>(null);
  usePlayerFloor(stackRef);
  // §19.9: the cut's own audio, drawn quietly in the timeline. Always the original's, even with a proxy.
  const wave = usePictureWave(video.id, version, fileSize, fileRev, durationOf === version.file ? duration : (version.duration ?? 0));
  // The click that ends a box drag shouldn't also start playback.
  const justDrew = useRef(false);
  // startAt restores a film's remembered playhead, but only once: the first metadata load
  // after this component mounts (i.e. after a film switch, since Picture is keyed by video
  // id). A later cut within the same film — a new version picked, or a new render arriving —
  // must start at 0, as in Plan 2, not reuse the old restore point forever.
  const startApplied = useRef(false);
  // The shot strip's cards, keyed by shot number, so the current one can be scrolled into view.
  const shotRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  // Read inside an effect instead of added as a dependency, so the strip scrolls only when the
  // current shot changes, never merely because playback started or stopped.
  const playingRef = useRef(playing);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  // True until this Picture instance unmounts (a film switch: Picture is keyed by video id,
  // so each film gets its own instance). Guards a grab whose POST is still in flight when you
  // switch films: the response must never attach to whatever film is now on screen.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  // The version on screen right now, read by a grab whose POST is still in flight when the
  // version changes under it (a new cut arriving, or picking another one by hand) -- without
  // unmounting, since that only happens on a film switch. A grab started against v1 must never
  // attach to v2's note box.
  const versionRef = useRef(version.id);
  useEffect(() => { versionRef.current = version.id; }, [version.id]);

  // Tell the parent whether there's anything here it would be wrong to discard by
  // jumping to a newer cut: an In/Out, a box or a half-typed note. A grab alone is excluded:
  // the frame is already saved to screenshots/, so nothing is lost if a newer cut arrives.
  useEffect(() => {
    const pending = range.in !== null || box !== null || noteHasText;
    onPendingChange?.(pending);
    return () => onPendingChange?.(false);
  }, [range.in, box, noteHasText]);

  // A new cut: start again from the top, with nothing pending. A file the browser
  // can't decode can fail before any handler is attached, so check the element too.
  // The grab is the exception: on this component's first run (a fresh mount, e.g. after
  // switching films) it keeps whatever the caller is holding for this film, rather than being
  // wiped by this same effect running on mount. Only a genuinely new cut arriving on an
  // already-mounted film clears it.
  const mountedFile = useRef<string | undefined>(undefined);
  useEffect(() => {
    setBroken(false);
    setT(0);
    setAspect(16 / 9);
    setRange({ in: null, out: null });
    setBox(null);
    if (mountedFile.current !== undefined) onGrabChange(video.id, null);
    mountedFile.current = version.file;
    setShown(null);
  }, [version.file]);

  // §19.5: the proxy plays unless you've picked Original. The switch never changes the cut, so
  // notes, timecodes and frame numbers are the same on both.
  const playsProxy = !!version.proxy && source !== "original";
  const src = mediaUrl(playsProxy ? version.proxy!.file : version.file);

  // When the file changes under the same cut (the switch, or a proxy arriving), the new one picks
  // up where the old one was: its time, and whether it was playing. That's read off the element
  // here, during render, before the new src resets it, and applied once the new file's metadata
  // loads. A file the browser can't play never loads, so the restore point waits, and switching
  // back still lands in the same place. A new cut starts from the top instead.
  const resume = useRef<{ t: number; play: boolean } | null>(null);
  const shownSrc = useRef<{ cut: string; src: string } | null>(null);
  if (shownSrc.current && shownSrc.current.src !== src) {
    const v = ref.current;
    if (shownSrc.current.cut !== version.file) resume.current = null;
    else if (!resume.current && v) resume.current = { t: v.error ? t : v.currentTime, play: !v.paused && !v.error };
  }
  shownSrc.current = { cut: version.file, src };

  // A file the browser can't decode can fail before any handler is attached, so check the element too.
  useEffect(() => {
    setBroken(false);
    const v = ref.current;
    if (!v) return;
    const fail = () => setBroken(true);
    if (v.error) fail();
    v.addEventListener("error", fail);
    return () => v.removeEventListener("error", fail);
  }, [src]);

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

  // The element's time (or, while a switched file is still loading, the time it will resume at).
  // Key handlers can run before a re-render, so never trust `t` for this.
  const liveTime = () => resume.current?.t ?? ref.current?.currentTime ?? t;
  // The same, snapped to its frame.
  const now = () => snap(liveTime(), fps);

  const seek = (to: number) => {
    const v = ref.current;
    if (!v) return;
    const at = Math.min(Math.max(0, to), duration || v.duration || to);
    if (resume.current) {
      // The file isn't playable yet: move where it will resume instead.
      resume.current.t = at;
      setT(at);
      return;
    }
    v.currentTime = at;
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
    seek(stepFrame(liveTime(), fps, n, duration));
  };
  const setIn = () => setRange({ in: now(), out: null });
  const setOut = () => {
    const at = now();
    const start = range.in ?? 0;
    if (at <= start) return toast("Out has to come after In");
    setRange({ in: start, out: at });
  };
  const clearRange = () => setRange({ in: null, out: null });

  // Every grab is numbered, and only the latest one's result is shown and attached: an ffmpeg
  // grab can take a moment, so an earlier one finishing late must never replace a later one.
  const grabSeq = useRef(0);
  // How many ffmpeg grabs are still being made: the camera button shows it's busy meanwhile.
  const [grabbing, setGrabbing] = useState(0);

  const grabFrame = async () => {
    const v = ref.current;
    const at = now();
    const forVideo = video.id;
    const forVersion = version.id;
    const n = ++grabSeq.current;
    let extracting = false;
    try {
      let frame = frameAt(at, fps);
      let png: string;
      if (ffmpeg) {
        // §19.5: the still always comes from the original, at full quality, whichever file is
        // playing: the server extracts that exact frame with ffmpeg.
        extracting = true;
        setGrabbing((g) => g + 1);
        const still = await originalFrame(forVideo, forVersion, at);
        frame = still.frame ?? frame;
        png = still.png;
      } else {
        if (!v || !v.videoWidth) return toast("Nothing to grab yet");
        const canvas = document.createElement("canvas");
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        canvas.getContext("2d")!.drawImage(v, 0, 0);
        png = canvas.toDataURL("image/png");
      }
      const r = await api.post<{ grab: string }>("/api/grabs", { video: forVideo, version: forVersion, frame, png });
      if (n !== grabSeq.current) {
        // Superseded by a later grab: its file is saved all the same, so Assets still hears of it.
        onChanged();
        return;
      }
      toast(`Saved to ${r.grab}`);
      // The screenshot is a new asset on disk: refresh so the Assets tab unlocks and shows
      // it right away, without waiting for a server change event (grabs don't send one).
      onChanged();
      // The file is saved either way, but only offer it as a pending attachment if you're
      // still on the film and version it was taken on: a switch away while this request was
      // in flight must never have it land in another film's note box (or this film's, on a
      // later return -- by then nothing was watching to carry it across the switch), and nor
      // must it attach to a different cut of the same film that's since come on screen.
      if (mountedRef.current && forVersion === versionRef.current) onGrabChange(forVideo, r.grab);
    } catch (e) {
      if (n === grabSeq.current) toast((e as Error).message);
    } finally {
      if (extracting && mountedRef.current) setGrabbing((g) => g - 1);
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
    onGrabChange(video.id, null);
    onChanged();
  };

  // Keyboard: Space, ←/→, I, O, G, B and N, unless you're typing. The handler is refreshed on
  // every render (so it never acts on a stale closure), but the listener is bound once: the
  // playhead re-renders this component every frame while playing.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKeyRef.current = (e: KeyboardEvent) => {
    if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.key === " ") {
      // A focused button (Create proxy, say) is pressed by Space, not played over (§19.8).
      if (spacePressesButton(e.target)) return;
      e.preventDefault();
      toggle();
    }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(e.shiftKey ? -10 : -1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(e.shiftKey ? 10 : 1); }
    else if (k === "i") setIn();
    else if (k === "o") setOut();
    // Holding G repeats the key: each repeat would be another full decode and PNG round-trip.
    else if (k === "g" && !e.repeat) void grabFrame();
    else if (k === "b") setBoxMode((m) => !m);
    else if (k === "n") { e.preventDefault(); input.current?.focus(); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Drawing a box on the frame. Boxes are measured against the picture itself -- where the
  // video's pixels actually are inside the element under object-fit: contain -- never the
  // element's own box, which is wider than a vertical cut whenever the frame hasn't shrunk to
  // fit it (§19.4: Safari kept it 16:9). The maths is ours (contentRect), so no browser's
  // layout of the frame can change what a box means.
  const picture = (w: number, h: number) => {
    const v = ref.current;
    return contentRect(v?.videoWidth ?? 0, v?.videoHeight ?? 0, w, h);
  };
  const point = (e: PointerEvent) => {
    const r = overlay.current!.getBoundingClientRect();
    const c = picture(r.width, r.height);
    return { x: e.clientX - r.left - c.x, y: e.clientY - r.top - c.y, w: c.w, h: c.h };
  };
  useEffect(() => {
    const el = overlay.current;
    if (!el) return;
    const measure = () => setOverlaySize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const down = (e: PointerEvent) => {
    if (!boxMode) return;
    const p = point(e);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y, w: p.w, h: p.h });
  };
  const move = (e: PointerEvent) => {
    if (!drag) return;
    const p = point(e);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  };
  const up = (e: PointerEvent) => {
    if (!drag) return;
    const p = point(e);
    const b = boxFrom(drag.x0, drag.y0, p.x, p.y, drag.w, drag.h);
    setDrag(null);
    setBoxMode(false);
    justDrew.current = true;
    if (b.w > 0.01 && b.h > 0.01) setBox(b);
  };
  const live: Box | null = drag ? boxFrom(drag.x0, drag.y0, drag.x1, drag.y1, drag.w, drag.h) : null;
  // Read at render: `aspect` and `overlaySize` change whenever the picture's size or the
  // overlay's does, so this is never stale for long.
  const pic = picture(overlaySize.w, overlaySize.h);
  const style = (b: Box) => ({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });

  const pct = (s: number) => `${duration ? (s / duration) * 100 : 0}%`;
  // Belt-and-braces: an inherited shot that runs past a shorter cut's duration is hidden here
  // too, even though the server already trims these on addVersion.
  const shots = duration ? version.shots.filter((s) => s.start < duration) : version.shots;
  // The snapped time, not the raw playhead: a note taken right now would be stamped from this
  // same snapped time, so the strip and the timecode must agree with it rather than with `t`.
  const current = shotAt(shots, snap(t, fps));

  // Keeps the current card in view while playing, never merely because the player re-renders.
  useEffect(() => {
    if (!playingRef.current || current === null) return;
    shotRefs.current[current.n]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current?.n]);

  const placed = notes.map((n) => ({ n, at: placeNote(n, version.id) })).filter(({ at }) => at.t !== null);
  const rangeLabel = range.in === null ? null : range.out === null ? `${fmt(range.in)} →` : noteTime(range.in, range.out);
  const placeholder = range.in !== null && range.out === null ? "Set an Out point" : `Note at ${rangeLabel && range.out !== null ? rangeLabel : fmt(t)}`;

  /** Duration, aspect and the once-only start seek, read off a <video> that's reached
   *  HAVE_METADATA. Shared between the element's own onLoadedMetadata handler and the ref
   *  callback below, which catches up on a video whose metadata was already available (a tiny
   *  local file can finish loading before this component's listener is even attached, especially
   *  under load -- loadedmetadata only ever fires once, so missing it would otherwise leave the
   *  frame letterboxed at the 16:9 default forever). */
  const applyMetadata = (v: HTMLVideoElement) => {
    setDuration(v.duration || version.duration || 0);
    setDurationOf(version.file);
    if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
    if (!startApplied.current) {
      startApplied.current = true;
      if (startAt) {
        v.currentTime = Math.min(startAt, v.duration || startAt);
        setT(v.currentTime);
      }
    }
    // A switched file picks up where the last one was (see `resume`).
    const r = resume.current;
    if (r) {
      resume.current = null;
      v.currentTime = Math.min(r.t, v.duration || r.t);
      setT(r.t);
      if (r.play) void v.play().catch(() => undefined);
    }
  };

  const choose = (to: Source) => {
    if (to !== source) onSourceChange?.(video.id, to);
  };

  return (
    <div class="split">
      <div class="stack" ref={stackRef}>
        {/* The box's height is written out in full rather than through a custom property: Chromium
            doesn't always redo a container-unit height when only the variable inside it changes. */}
        <div class="framebox" style={{ height: `min(640px, 70vh, calc(100cqw / ${aspect}))` }}>
          <div class="frame" style={{ aspectRatio: String(aspect), "--ar": String(aspect) }}>
            {/* One message, never two: with ffmpeg, the proxy offer under the player speaks for a
                file that won't play. Only the original, with a proxy to switch back to, says so here. */}
            {broken && !ffmpeg && <div class="msg">This file won't play in a browser. Ask your agent for an H.264 MP4 of this cut.</div>}
            {broken && ffmpeg && version.proxy && !playsProxy && <div class="msg">This file won't play in a browser.</div>}
            <video
              hidden={broken}
              ref={(el) => {
                ref.current = el;
                if (playerRef) playerRef.current = el;
                // Catches up a video that reached HAVE_METADATA (or further) before this ref ran
                // -- see applyMetadata's comment. Harmless to repeat on every re-render once
                // that's already happened: setDuration/setAspect bail out on an equal value, and
                // startApplied guards the once-only seek.
                if (el && el.readyState >= 1) applyMetadata(el);
              }}
              src={src}
              preload="auto"
              playsInline
              onLoadedMetadata={(e) => applyMetadata(e.target as HTMLVideoElement)}
              onTimeUpdate={(e) => !playing && !resume.current && setT((e.target as HTMLVideoElement).currentTime)}
              onSeeked={(e) => !resume.current && setT((e.target as HTMLVideoElement).currentTime)}
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
              <div class="pic" style={{ left: `${pic.x}px`, top: `${pic.y}px`, width: `${pic.w}px`, height: `${pic.h}px` }}>
                {shown && <div class="bx saved" style={style(shown)} />}
                {box && <div class="bx" style={style(box)} />}
                {live && <div class="bx" style={style(live)} />}
              </div>
            </div>
            <div class="tcover">f{frameAt(t, fps)}{current && ` · shot ${shotLabel(current.n)}`}</div>
            {version.proxy && (
              <div class="srcswitch" role="group" aria-label="Which file plays">
                <button
                  type="button"
                  class="tip-below tip-start tip-wrap"
                  aria-pressed={playsProxy}
                  aria-label="Proxy"
                  data-tip="Playing the lightweight copy. Notes and timings are the same."
                  onClick={(e) => { (e.currentTarget as HTMLElement).blur(); choose("proxy"); }}
                >
                  Proxy
                </button>
                <button
                  type="button"
                  class="tip-below tip-start tip-wrap"
                  aria-pressed={!playsProxy}
                  aria-label="Original"
                  data-tip="Play the full-quality file. It may stutter."
                  onClick={(e) => { (e.currentTarget as HTMLElement).blur(); choose("original"); }}
                >
                  Original
                </button>
              </div>
            )}
          </div>
        </div>

        {noteProxyJob && (
          <ProxyBar
            key={version.id}
            video={video}
            version={version}
            ffmpeg={ffmpeg}
            autoProxy={autoProxy}
            job={proxyJob}
            broken={broken && !playsProxy}
            duration={duration}
            toast={toast}
            onChanged={onChanged}
            noteProxyJob={noteProxyJob}
          />
        )}

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
          <button class="btn ghost ib" data-tip="Grab frame  G" aria-label="Grab frame" aria-busy={grabbing > 0} onClick={() => void grabFrame()}><Icon name="camera" /></button>
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
          {wave && <PictureWave wave={wave} length={duration} />}
          {placed.map(({ n, at }) => at.tOut !== null && <div class={`span ${n.status}`} style={{ left: pct(at.t!), width: pct(at.tOut - at.t!) }} />)}
          {range.in !== null && <div class="span live" style={{ left: pct(range.in), width: pct((range.out ?? range.in + 0.2) - range.in) }} />}
          {shots.filter((s) => s.start > 0).map((s) => <div class="tick" style={{ left: pct(s.start) }} />)}
          {placed.map(({ n, at }) => <div class={`mk ${n.status}`} style={{ left: pct(at.t!) }} title={n.text} />)}
          <div class="playhead" style={{ left: pct(t) }} />
        </div>
        <div class="ends"><span>0:00</span><span>{fmt(duration)}</span></div>
      </div>

      {/* Outside the player's column, so the note box stays level with the timeline: the strip
          may run below the window on a tall cut (fix round 1). */}
      {shots.length > 0 && (
        <div class="shots" data-player>
          {shots.map((s) => (
            <button
              type="button"
              class="shot"
              ref={(el) => { shotRefs.current[s.n] = el; }}
              aria-current={current?.n === s.n ? "true" : undefined}
              onClick={() => { ref.current?.pause(); seek(shotSeek(s.start, fps)); }}
            >
              <span class="mono">{shotLabel(s.n)} · {s.start.toFixed(2)}s</span>
              <span class="name">{s.name}</span>
              {s.tag && <span class="tag">{s.tag}</span>}
            </button>
          ))}
        </div>
      )}

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
              <span class="chipx"><Icon name="image" />Frame {grab.match(/_f(\d+)\.png$/)?.[1]}<button aria-label="Remove frame" onClick={() => onGrabChange(video.id, null)}><Icon name="x" /></button></span>
            )}
          </>
        )}
      />
    </div>
  );
}
