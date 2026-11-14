// §27, 5.6: the audio engine on the Timeline tab, following the picture. The video element is the clock: the engine
// plays `clips` and is kept within STREAM_DRIFT_SECONDS of `video.currentTime`, started, stopped and moved by the
// video's own events (play, pause, seeking, waiting, ratechange, ended) and re-seated when a timeupdate finds it further
// out. While the picture seeks or stalls the engine holds, so it never runs on ahead.
// What to do is `followerAction`'s decision; this hook only applies it.
//
// One engine per mount (useAudioStage): leaving the tab disposes it, which stops it and closes its context.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AudioEngine, LoadResult } from "./engine.js";
import { type Clip, followerAction, SEEK_COOLDOWN_SECONDS } from "./timeline.js";
import { useAudioStage } from "./useAudioStage.js";

export interface Follower {
  /** Each clip file's load result once known, or "error" when it can't be played at all, by `mediaKey`. */
  media: Record<string, LoadResult | "error">;
  /** The engine's timeline length: the cut's, once the video knows it. */
  length: number;
  /** The engine itself, for the `?test=1` hook. */
  engine: AudioEngine;
}

const EVENTS = ["play", "playing", "pause", "seeking", "seeked", "waiting", "canplay", "ratechange", "timeupdate", "ended", "loadedmetadata", "durationchange", "emptied"] as const;
/** HTMLMediaElement.HAVE_FUTURE_DATA: below it the picture is stalled, waiting for data. */
const MOVING = 3;

export function useFollower(video: { current: HTMLVideoElement | null }, clips: Clip[], gains: Record<string, number>): Follower {
  const { engine, length, media } = useAudioStage(clips);
  const hasClips = useRef(clips.length > 0);
  hasClips.current = clips.length > 0;

  // The lane gains: only what changed, each a 4 ms ramp on the engine's clock, never a restart. A layout effect, so a
  // mute is heard in the same commit that shows M pressed.
  const applied = useRef<Record<string, number>>({});
  const gainKey = JSON.stringify(gains);
  useLayoutEffect(() => {
    for (const [lane, gain] of Object.entries(gains)) {
      if (applied.current[lane] === gain) continue;
      applied.current[lane] = gain;
      engine.setLaneGain(lane, gain);
    }
  }, [engine, gainKey]);

  // Follows the element on screen. It is checked after each render, so a remounted <video> is picked up; a file swapped
  // under the same element (proxy, format) fires its own events (emptied, loadedmetadata) and is followed the same way.
  const [target, setTarget] = useState<HTMLVideoElement | null>(null);
  useLayoutEffect(() => {
    if (video.current !== target) setTarget(video.current);
  });
  const lastSeek = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    const v = target;
    if (!v) return;
    const follow = (e?: Event) => {
      const d = v.duration;
      engine.setVideoDuration(Number.isFinite(d) && d > 0 ? d : null);
      // The picture only counts as playing while it moves: not while a seek lands or it waits for data, when the
      // engine would otherwise run on ahead of it.
      const playing = !v.paused && !v.ended && !v.seeking && v.readyState >= MOVING;
      const at = v.currentTime;
      const action = followerAction(at, engine.time, playing, engine.playing);
      if (action === "play") {
        // With nothing to play, the engine stays asleep: no audio context outside a gesture, no frame loop over silence.
        // A take picked while the picture plays is started by the next timeupdate.
        if (!hasClips.current) return;
        // At (or past) the cut's end there's nothing left to play: the engine would start again from the top.
        if (engine.length > 0 && at >= engine.length) return;
        engine.play(at);
        lastSeek.current = performance.now() / 1000;
      } else if (action === "pause") {
        engine.pause();
        engine.seek(at);
      } else if (action === "seek") {
        // A timeupdate while both play only re-seats once a re-seat has had time to land, so a slow start can't loop.
        const now = performance.now() / 1000;
        if (e?.type === "timeupdate" && playing && now - lastSeek.current < SEEK_COOLDOWN_SECONDS) return;
        engine.seek(at);
        lastSeek.current = now;
      }
    };
    for (const type of EVENTS) v.addEventListener(type, follow);
    follow();
    return () => {
      for (const type of EVENTS) v.removeEventListener(type, follow);
    };
  }, [engine, target]);

  // A browser starts audio only inside a click or a key press. The video's `play` event is neither, so the engine's
  // context is readied on the gesture that pressed Play (or anything else), before the video starts.
  useEffect(() => {
    const ready = () => {
      if (hasClips.current) engine.resume();
    };
    window.addEventListener("pointerdown", ready, true);
    window.addEventListener("keydown", ready, true);
    return () => {
      window.removeEventListener("pointerdown", ready, true);
      window.removeEventListener("keydown", ready, true);
    };
  }, [engine]);

  return { media, length, engine };
}
