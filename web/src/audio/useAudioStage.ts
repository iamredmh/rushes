// One AudioEngine per mounted audio tab. It's created on mount, loads every clip's file, and is
// disposed on unmount, which stops playback and closes its AudioContext, so switching tabs never
// piles up contexts.
import { useEffect, useRef, useState } from "preact/hooks";
import { AudioEngine, type LoadResult } from "./engine.js";
import type { Clip } from "./timeline.js";

export interface AudioStage {
  engine: AudioEngine;
  /** Engine time, updated every frame while playing and on every seek. */
  time: number;
  playing: boolean;
  length: number;
  /** Each clip file's load result once known, or "error" when it can't be played at all. */
  media: Record<string, LoadResult | "error">;
}

const clipKey = (clips: Clip[]) =>
  clips.map((c) => `${c.id}\u0000${c.lane}\u0000${c.path}\u0000${c.offset}\u0000${c.duration}`).join("\u0001");

export function useAudioStage(clips: Clip[], videoDuration: number | null = null): AudioStage {
  const ref = useRef<AudioEngine | null>(null);
  if (!ref.current) ref.current = new AudioEngine();
  const engine = ref.current;
  const alive = useRef(true);
  const [time, setTime] = useState(0);
  const [, setVersion] = useState(0);
  const [media, setMedia] = useState<Record<string, LoadResult | "error">>({});

  useEffect(() => {
    alive.current = true;
    const offChange = engine.onChange(() => {
      setTime(engine.time);
      setVersion((n) => n + 1);
    });
    const offTick = engine.onTick(setTime);
    return () => {
      alive.current = false;
      offChange();
      offTick();
      engine.dispose();
      if (ref.current === engine) ref.current = null;
    };
  }, [engine]);

  const key = clipKey(clips);
  useEffect(() => {
    engine.setClips(clips);
    for (const path of new Set(clips.map((c) => c.path))) {
      engine.load(path).then(
        (r) => alive.current && setMedia((m) => (m[path] === r ? m : { ...m, [path]: r })),
        () => alive.current && setMedia((m) => ({ ...m, [path]: "error" })),
      );
    }
    // Keyed on the clips' content, not the array's identity, so a re-render doesn't reset anything.
  }, [engine, key]);

  useEffect(() => {
    engine.setVideoDuration(videoDuration);
  }, [engine, videoDuration]);

  return { engine, time, playing: engine.playing, length: engine.length, media };
}
