// §19.9: a quiet waveform of the cut's own audio inside Picture's timeline bar, under the note
// markers, ranges, shot ticks and playhead. A canvas sized for the screen's pixel ratio, redrawn
// only when its peaks, its size or the timeline's length change: never per frame.
import { useEffect, useRef, useState } from "preact/hooks";
import { mediaUrl, projectId } from "../api.js";
import { testFlags } from "../lib.js";
import { cachedWave, FALLBACK_RATE, hasCachedWave, loadWave, rememberWave, watchPixelRatio, waveKey, type Wave, type WaveDeps } from "../peaks.js";
import type { Version } from "../types.js";

/** The first retry while the server is still making the peaks; it doubles up to RETRY_MAX_MS. A `change` asks sooner. */
const RETRY_MS = 1500;
const RETRY_MAX_MS = 15_000;
/** How long a no-ffmpeg fallback waits for the player to learn the cut's length. */
const LENGTH_WAIT_MS = 15_000;

const browserDeps: WaveDeps = {
  fetch(url, init) {
    const id = projectId();
    return fetch(url, { signal: init.signal, headers: id ? { "x-rushes-project": id } : {} });
  },
  async decode(data) {
    const Offline = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    const ctx = new Offline(1, 1, FALLBACK_RATE);
    const buffer = await ctx.decodeAudioData(data);
    const channels: Float32Array[] = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
    return { channels, duration: buffer.duration };
  },
};

/**
 * The waveform for the cut on screen, or null while it loads and when there's nothing to draw.
 * Only ever this cut's: an answer for a version or film you've since left is dropped. `version`
 * is a new object on every state refresh, which is how a `change` (the server's peaks landing)
 * prompts an early retry.
 */
export function usePictureWave(video: string, version: Version, size: number | null, rev: string | undefined, length: number): Wave | null {
  const key = waveKey(video, version.id, version.file, rev);
  // The player's length (0 until its metadata loads), for the no-ffmpeg fallback's 15-minute cap:
  // a fallback waits for it, and gives up after LENGTH_WAIT_MS.
  const lengthRef = useRef(length);
  const lengthWaiters = useRef<((n: number) => void)[]>([]);
  useEffect(() => {
    lengthRef.current = length;
    if (length > 0) for (const w of lengthWaiters.current.splice(0)) w(length);
  }, [length]);
  const knownLength = (): Promise<number | null> =>
    lengthRef.current > 0
      ? Promise.resolve(lengthRef.current)
      : new Promise((res) => {
          lengthWaiters.current.push(res);
          window.setTimeout(() => res(null), LENGTH_WAIT_MS);
        });
  const [shown, setShown] = useState<{ key: string; wave: Wave | null } | null>(() => (hasCachedWave(key) ? { key, wave: cachedWave(key) } : null));
  const retryNow = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (hasCachedWave(key)) {
      setShown({ key, wave: cachedWave(key) });
      return;
    }
    const ac = new AbortController();
    let timer: number | undefined;
    let delay = RETRY_MS;
    const cut = {
      peaksUrl: `/api/videos/${encodeURIComponent(video)}/versions/${encodeURIComponent(version.id)}/peaks`,
      mediaUrl: mediaUrl(version.file),
      size,
      duration: knownLength,
    };
    const attempt = async () => {
      retryNow.current = null;
      clearTimeout(timer);
      let out;
      try {
        out = await loadWave(cut, browserDeps, ac.signal);
      } catch {
        return; // aborted: this cut is no longer on screen
      }
      if (ac.signal.aborted) return;
      if (out.kind === "pending") {
        retryNow.current = () => void attempt();
        timer = window.setTimeout(() => void attempt(), delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
        return;
      }
      const wave = out.kind === "wave" ? out.wave : null;
      rememberWave(key, wave);
      setShown({ key, wave });
    };
    void attempt();
    return () => {
      ac.abort();
      clearTimeout(timer);
      retryNow.current = null;
    };
  }, [key]);

  useEffect(() => {
    retryNow.current?.();
  }, [version]);

  return shown && shown.key === key ? shown.wave : null;
}

// Test-only (`?test=1`): how many times the Picture waveform has been drawn, so e2e can check
// that playback never redraws it.
let draws = 0;
declare global {
  interface Window {
    __rushesPicture?: { waveDraws(): number };
  }
}
if (typeof location !== "undefined" && testFlags(location.search).test) window.__rushesPicture = { waveDraws: () => draws };

const BAR = 3;
const BAR_WIDTH = 2;

/** The canvas. `length` is the timeline's length in seconds (the peaks' own when it isn't known yet). */
export function PictureWave({ wave, length }: { wave: Wave; length: number }) {
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
    // A move to a screen with another pixel ratio changes no CSS size, so ResizeObserver misses it.
    const stopRatio = watchPixelRatio(window, measure);
    return () => {
      ro.disconnect();
      stopRatio();
    };
  }, []);

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
    const span = length > 0 ? length : wave.duration;
    const n = wave.peaks.length;
    if (!(span > 0) || !(wave.duration > 0) || n === 0) return;
    // The colour comes from CSS (a muted grey-blue), so it follows the theme.
    x.fillStyle = getComputedStyle(c).color;
    const perBucket = wave.duration / n;
    for (let left = 0; left < size.w; left += BAR) {
      const t0 = (left / size.w) * span;
      if (t0 >= wave.duration) break;
      const t1 = ((left + BAR) / size.w) * span;
      const a = Math.min(n - 1, Math.floor(t0 / perBucket));
      const b = Math.min(n, Math.max(a + 1, Math.ceil(t1 / perBucket)));
      let amp = 0;
      for (let j = a; j < b; j++) if (wave.peaks[j] > amp) amp = wave.peaks[j];
      const h = Math.max(1, Math.min(1, amp) * size.h);
      x.fillRect(left, (size.h - h) / 2, BAR_WIDTH, h);
    }
  }, [size, wave, length]);

  return <canvas ref={ref} class="pwave" aria-hidden="true" />;
}
