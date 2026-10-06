// §19.9: the Picture waveform's data. The server makes a cut's peaks with ffmpeg; without ffmpeg,
// a cut under about 100 MB is decoded here instead. Nothing in this file touches the DOM, so the
// whole decision is unit-tested; the browser's own fetch and decoder are passed in.
import { mixPeaks } from "./audio/timeline.js";

/** Peaks a cut gets at most, the same as the server makes. */
export const WAVE_BUCKETS = 2000;
/** Without ffmpeg, a cut this size or larger gets no waveform: it would mean fetching and decoding all of it. */
export const FALLBACK_MAX_BYTES = 100 * 1000 * 1000;
/** The browser decodes at this rate: plenty for the outline, and a fraction of the memory of 48 kHz. */
export const FALLBACK_RATE = 8000;

/** A cut's waveform: peaks 0..1 spread evenly over `duration` seconds. */
export interface Wave {
  peaks: Float32Array;
  duration: number;
}

/** What a load came to: a waveform, nothing to draw (no audio, too big, or it failed), or not ready yet. */
export type WaveLoad = { kind: "wave"; wave: Wave } | { kind: "none" } | { kind: "pending" };

export interface WaveDeps {
  fetch(url: string, init: { signal: AbortSignal }): Promise<Response>;
  /** Decodes a file's audio: each channel's samples and the length in seconds. Rejects when there's no audio to decode. */
  decode(data: ArrayBuffer): Promise<{ channels: Float32Array[]; duration: number }>;
}

/** The cut to load: where its peaks and its file are, and the file's size (null when unknown). */
export interface WaveCut {
  peaksUrl: string;
  mediaUrl: string;
  size: number | null;
}

const NONE: WaveLoad = { kind: "none" };
const PENDING: WaveLoad = { kind: "pending" };

/**
 * Asks the server for a cut's peaks: 200 is the waveform, 202 is "ask again soon", 501 (no ffmpeg)
 * decodes a small file here, and anything else (204 for no audio, a missing file, a failed decode)
 * draws nothing. Rejects only when `signal` aborts, so a late answer never lands on another cut.
 */
export async function loadWave(cut: WaveCut, deps: WaveDeps, signal: AbortSignal): Promise<WaveLoad> {
  let res: Response;
  try {
    res = await deps.fetch(cut.peaksUrl, { signal });
  } catch (e) {
    if (signal.aborted) throw e;
    return PENDING;
  }
  if (res.status === 202) return PENDING;
  if (res.status === 501) return fallback(cut, deps, signal);
  if (res.status !== 200) return NONE;
  try {
    const j = (await res.json()) as { duration?: unknown; peaks?: unknown };
    const peaks = j.peaks;
    if (!Array.isArray(peaks) || peaks.length === 0 || typeof j.duration !== "number" || !(j.duration > 0)) return NONE;
    if (!peaks.every((p) => typeof p === "number" && Number.isFinite(p))) return NONE;
    return { kind: "wave", wave: { peaks: Float32Array.from(peaks as number[]), duration: j.duration } };
  } catch (e) {
    if (signal.aborted) throw e;
    return NONE;
  }
}

async function fallback(cut: WaveCut, deps: WaveDeps, signal: AbortSignal): Promise<WaveLoad> {
  if (cut.size === null || !(cut.size < FALLBACK_MAX_BYTES)) return NONE;
  try {
    const res = await deps.fetch(cut.mediaUrl, { signal });
    if (!res.ok) return NONE;
    const { channels, duration } = await deps.decode(await res.arrayBuffer());
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const length = channels[0]?.length ?? 0;
    if (length === 0 || !(duration > 0)) return NONE;
    return { kind: "wave", wave: { peaks: normalisePeaks(mixPeaks(channels, Math.min(WAVE_BUCKETS, length))), duration } };
  } catch (e) {
    if (signal.aborted) throw e;
    return NONE;
  }
}

/** Scales peaks so the loudest is 1, as the server's are. Silence stays at 0. */
export function normalisePeaks(peaks: Float32Array): Float32Array {
  let max = 0;
  for (const p of peaks) if (p > max) max = p;
  if (max > 0) for (let i = 0; i < peaks.length; i++) peaks[i] /= max;
  return peaks;
}

// ---- the cache: per version and file revision, "no waveform" included ----

const CACHE_LIMIT = 40;
const cache = new Map<string, Wave | null>();

/** A cut's cache key: its film, version and file, plus the file's revision (re-rendered in place, it's new). */
export function waveKey(video: string, version: string, file: string, rev: string | undefined): string {
  return `${video}/${version}/${file}#${rev ?? ""}`;
}

export function hasCachedWave(key: string): boolean {
  return cache.has(key);
}

export function cachedWave(key: string): Wave | null {
  return cache.get(key) ?? null;
}

export function rememberWave(key: string, wave: Wave | null): void {
  cache.delete(key);
  cache.set(key, wave);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

// ---- the screen's pixel ratio ----

/** The part of `window` that watchPixelRatio needs, so it can be tested without a browser. */
export interface PixelRatioWindow {
  devicePixelRatio: number;
  matchMedia(query: string): { addEventListener(type: "change", fn: () => void): void; removeEventListener(type: "change", fn: () => void): void };
}

/**
 * Calls `onChange` with the new device pixel ratio whenever it changes (the window moved to a
 * screen with another density, or the page was zoomed), listening again at each new ratio, since a
 * `(resolution: Xdppx)` query only ever reports leaving X. Returns a function that stops listening.
 */
export function watchPixelRatio(win: PixelRatioWindow, onChange: (dpr: number) => void): () => void {
  let stop = () => undefined as void;
  const listen = () => {
    const list = win.matchMedia(`(resolution: ${win.devicePixelRatio}dppx)`);
    const fire = () => {
      stop();
      onChange(win.devicePixelRatio);
      listen();
    };
    list.addEventListener("change", fire);
    stop = () => list.removeEventListener("change", fire);
  };
  listen();
  return () => stop();
}
