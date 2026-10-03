// The audio engine's pure half (spec §17.2, §17.5): gains, scheduling, drift, peaks and the
// assembled VO read. Nothing here touches Web Audio or the DOM, so all of it is unit-tested.
import { readTake } from "../lib.js";
import type { Section } from "../types.js";

/** One piece of audio on the timeline. */
export interface Clip {
  /** Unique across the whole clip list. */
  id: string;
  /** The engine lane it plays through (one mute/solo gain stage per lane). */
  lane: string;
  /** Project-relative file path, as registered with the server. */
  path: string;
  /** Where it starts on the timeline, in seconds. */
  offset: number;
  /** Its length in seconds. 0 (or not finite) means "unknown": the engine uses the file's own length. */
  duration: number;
  /** For the assembled read: the script section and take this clip came from. */
  section?: string;
  take?: string;
  /** The file's revision (an asset's `modified` time, else its size). A file re-rendered in place
   *  gets a new revision, so it's decoded afresh with fresh peaks. */
  rev?: string;
}

/** The cache key for a clip's file: its path, plus its revision when it has one. */
export function mediaKey(c: { path: string; rev?: string }): string {
  return c.rev ? `${c.path}#${c.rev}` : c.path;
}

/** A revision for an asset: its modified time, else its size. */
export function assetRev(a: { modified: string | null; size: number | null }): string | undefined {
  if (a.modified) return a.modified;
  return a.size !== null ? String(a.size) : undefined;
}

/** One source to start: `when` is the delay from the shared start time, `offset` is into the buffer. */
export interface PlannedStart {
  id: string;
  when: number;
  offset: number;
}

/** A file over this many seconds isn't decoded into memory; it streams through `<audio>` instead. */
export const MAX_DECODED_SECONDS = 15 * 60;
/** A streamed element further than this from the audio clock is seeked back. */
export const STREAM_DRIFT_SECONDS = 0.05;
/** After seeking a streamed element, wait this long before seeking it again. */
export const SEEK_COOLDOWN_SECONDS = 0.25;
/** HTMLMediaElement.HAVE_FUTURE_DATA: below this an element is still buffering. */
export const HAVE_FUTURE_DATA = 3;
/**
 * A file bigger than this can't be under 15 minutes in any format we'd decode: it's what 15
 * minutes of 48 kHz stereo costs decoded (32-bit float), and no encoded file is larger than that.
 */
export const MAX_DECODE_BYTES = MAX_DECODED_SECONDS * 48_000 * 2 * 4;
/** Waveform resolution, and the most buckets a file ever gets. */
export const PEAKS_PER_SECOND = 50;
export const MAX_PEAK_BUCKETS = 60_000;

/** Lane gains from mute and solo. Solo wins: with any lane soloed, only soloed lanes play, muted or not. */
export function laneGains(lanes: { id: string; muted?: boolean; solo?: boolean }[]): Record<string, number> {
  const anySolo = lanes.some((l) => l.solo);
  const out: Record<string, number> = {};
  for (const l of lanes) out[l.id] = anySolo ? (l.solo ? 1 : 0) : l.muted ? 0 : 1;
  return out;
}

/** The selected variant plays at 1, every other variant in its lane at 0. */
export function activeVariantGain(selected: string, variantId: string): 0 | 1 {
  return selected === variantId ? 1 : 0;
}

/** Every clip's variant gain. A lane with no selection plays all its clips (the assembled read, say). */
export function variantGains(clips: Clip[], selection: Record<string, string | undefined>): Record<string, 0 | 1> {
  const out: Record<string, 0 | 1> = {};
  for (const c of clips) {
    const selected = selection[c.lane];
    out[c.id] = selected === undefined ? 1 : activeVariantGain(selected, c.id);
  }
  return out;
}

/**
 * The sources to start when playback begins at timeline time `at`: clips under the playhead start
 * now, partway in; later clips start after a delay, from their beginning; finished clips are skipped.
 * A clip covers [offset, offset + duration).
 */
export function startPlan(clips: Clip[], at: number): PlannedStart[] {
  const plan: PlannedStart[] = [];
  for (const c of clips) {
    if (!(c.duration > 0)) continue;
    const end = c.offset + c.duration;
    if (end <= at) continue;
    if (c.offset <= at) plan.push({ id: c.id, when: 0, offset: at - c.offset });
    else plan.push({ id: c.id, when: c.offset - at, offset: 0 });
  }
  return plan;
}

/** Does the picture need seeking back to the audio clock? Only once it's more than one frame off. */
export function needsVideoSync(videoTime: number, audioTime: number, fps: number): boolean {
  // A hair of tolerance so a drift of exactly one frame, give or take float error, doesn't count.
  return Math.abs(videoTime - audioTime) > 1 / fps + 1e-9;
}

/** The largest |sample| per bucket. Every bucket covers at least one sample when there are any. */
export function computePeaks(channel: Float32Array, buckets: number): Float32Array {
  const n = Math.max(0, Math.floor(buckets));
  const out = new Float32Array(n);
  const len = channel.length;
  if (len === 0) return out;
  for (let i = 0; i < n; i++) {
    const start = Math.min(len - 1, Math.floor((i * len) / n));
    const end = Math.min(len, Math.max(start + 1, Math.floor(((i + 1) * len) / n)));
    let peak = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(channel[j]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
  }
  return out;
}

/** Peaks across all channels: the max of each channel's peaks, bucket by bucket. */
export function mixPeaks(channels: Float32Array[], buckets: number): Float32Array {
  const out = new Float32Array(Math.max(0, Math.floor(buckets)));
  for (const ch of channels) {
    const p = computePeaks(ch, buckets);
    for (let i = 0; i < out.length; i++) if (p[i] > out[i]) out[i] = p[i];
  }
  return out;
}

/** How many peak buckets a file of this length gets. */
export function peakBuckets(duration: number): number {
  return Math.min(MAX_PEAK_BUCKETS, Math.max(1, Math.round(duration * PEAKS_PER_SECOND)));
}

/** Stream (rather than decode) a file that wouldn't decode, or runs over 15 minutes. */
export function shouldStream(duration: number | null, decoded: boolean): boolean {
  return !decoded || (duration !== null && duration > streamThreshold);
}

// The length past which a file streams. Only a test build moves it (`?test=1&streamOver=1`), so the
// streamed path can be exercised in a real browser without a 15-minute fixture.
let streamThreshold = MAX_DECODED_SECONDS;
/** Test-only: stream files longer than `seconds` (null restores the 15-minute default). */
export function setStreamThreshold(seconds: number | null): void {
  streamThreshold = seconds ?? MAX_DECODED_SECONDS;
}

/** Skip downloading a file whose size (from `content-length`) rules out 15 minutes. */
export function tooLargeToDecode(bytes: number | null): boolean {
  return bytes !== null && bytes > MAX_DECODE_BYTES;
}

/** A streamed element's state, as `streamStep` reads it. */
export interface StreamedElement {
  time: number;
  paused: boolean;
  seeking?: boolean;
  /** HTMLMediaElement.readyState; missing counts as ready. */
  readyState?: number;
}

/**
 * What to do with a streamed `<audio>` element this tick. `expected` is where it should be in its
 * file (timeline time minus the clip's offset); outside [0, duration) it shouldn't be playing.
 * A drift correction never fires while the element is seeking or buffering, nor within
 * SEEK_COOLDOWN_SECONDS of the last seek (`sinceSeek`), so a slow seek can't turn into a seek loop.
 */
export function streamStep(
  expected: number,
  duration: number,
  el: StreamedElement,
  sinceSeek = Number.POSITIVE_INFINITY,
  tolerance = STREAM_DRIFT_SECONDS,
): "play" | "pause" | "seek" | "none" {
  if (expected < 0 || expected >= duration) return el.paused ? "none" : "pause";
  if (el.paused) return "play";
  if (el.seeking) return "none";
  if (el.readyState !== undefined && el.readyState < HAVE_FUTURE_DATA) return "none";
  if (sinceSeek < SEEK_COOLDOWN_SECONDS) return "none";
  return Math.abs(el.time - expected) > tolerance ? "seek" : "none";
}

/** Clips with an unknown length take their file's decoded length (0 while it isn't known), by `mediaKey`. */
export function resolveDurations(clips: Clip[], durations: Record<string, number | undefined>): Clip[] {
  return clips.map((c) => (c.duration > 0 ? c : { ...c, duration: durations[mediaKey(c)] ?? 0 }));
}

/** The cut's length when there is one, otherwise the end of the longest audio. */
export function timelineLength(videoDuration: number | null, clips: Clip[]): number {
  if (videoDuration !== null && videoDuration > 0) return videoDuration;
  let end = 0;
  for (const c of clips) if (c.duration > 0) end = Math.max(end, c.offset + c.duration);
  return end;
}

/**
 * The assembled read (§17.5): for each section, its `readTake` (its picked take, or its newest when
 * none is picked or the pick is gone), placed at the section's start. Sections without takes are
 * left out. Take ids are only unique within a section, so a clip's id is `section:take`.
 *
 * Each clip's length is the file's own (`duration: 0`), never the script's recorded `duration`:
 * the server mixes the whole file, and a take re-rendered in place can change length without the
 * script knowing.
 */
export function assembleRead(
  sections: Pick<Section, "id" | "start" | "takes">[],
  picks: Record<string, string>,
  lane = "vo",
): Clip[] {
  const out: Clip[] = [];
  for (const s of sections) {
    const take = readTake(s, picks);
    if (!take) continue;
    out.push({ id: `${s.id}:${take.id}`, lane, path: take.file, offset: s.start, duration: 0, section: s.id, take: take.id });
  }
  return out;
}
