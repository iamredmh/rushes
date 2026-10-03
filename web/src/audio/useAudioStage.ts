// One AudioEngine per mounted audio tab. It's created on mount, loads every clip's file, and is
// disposed on unmount, which stops playback and closes its AudioContext, so switching tabs never
// piles up contexts.
//
// The hook never sets state per frame. `playing`, `length` and `media` are state (they change
// rarely); the playhead and timecode follow the clock through `engine.subscribe`, updating a ref:
//
//   useEffect(() => stage.engine.subscribe((t) => { timecode.current!.textContent = fmt(t); }), [stage.engine]);
import { useEffect, useRef, useState } from "preact/hooks";
import { AudioEngine, type LoadResult } from "./engine.js";
import { type Clip, mediaKey } from "./timeline.js";

export interface AudioStage {
  engine: AudioEngine;
  playing: boolean;
  length: number;
  /** Each clip file's load result once known, or "error" when it can't be played at all, by `mediaKey`. */
  media: Record<string, LoadResult | "error">;
}

const clipKey = (clips: Clip[]) =>
  clips.map((c) => [c.id, c.lane, c.path, c.rev ?? "", c.offset, c.duration].join("\u0000")).join("\u0001");

export function useAudioStage(clips: Clip[], videoDuration: number | null = null): AudioStage {
  const ref = useRef<AudioEngine | null>(null);
  if (!ref.current) ref.current = new AudioEngine();
  const engine = ref.current;
  const alive = useRef(true);
  const [playing, setPlaying] = useState(false);
  const [length, setLength] = useState(0);
  const [media, setMedia] = useState<Record<string, LoadResult | "error">>({});

  useEffect(() => {
    alive.current = true;
    // Preact skips the re-render when a value is unchanged, so this costs nothing per seek.
    const offChange = engine.onChange(() => {
      setPlaying(engine.playing);
      setLength(engine.length);
    });
    return () => {
      alive.current = false;
      offChange();
      engine.dispose();
      if (ref.current === engine) ref.current = null;
    };
  }, [engine]);

  const key = clipKey(clips);
  useEffect(() => {
    engine.setClips(clips);
    const files = new Map(clips.map((c) => [mediaKey(c), c]));
    // Drop results for files no clip uses any more (the engine has freed them too).
    setMedia((m) => {
      const kept = Object.fromEntries(Object.entries(m).filter(([k]) => files.has(k)));
      return Object.keys(kept).length === Object.keys(m).length ? m : kept;
    });
    for (const [k, c] of files) {
      engine.load(c.path, c.rev).then(
        (r) => alive.current && setMedia((m) => (m[k] === r ? m : { ...m, [k]: r })),
        (err: Error) => {
          // An aborted load was superseded (its file left the clip list), not a failure.
          if (alive.current && err.name !== "AbortError") setMedia((m) => ({ ...m, [k]: "error" }));
        },
      );
    }
    // Keyed on the clips' content, not the array's identity, so a re-render doesn't reset anything.
  }, [engine, key]);

  useEffect(() => {
    engine.setVideoDuration(videoDuration);
  }, [engine, videoDuration]);

  return { engine, playing, length, media };
}
