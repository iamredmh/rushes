// The audio engine's Web Audio half (spec §8, §17.2), kept thin: the decisions live in timeline.ts.
//
// One AudioContext is the master clock. Every clip plays during playback through its own GainNode
// (its variant gain: 1 when it's the lane's selected variant, else 0), then through its lane's
// GainNode (mute/solo), so a clip's effective gain is variant x lane. Every source is started
// against one shared origin in one tick, so switching a variant is just a 4 ms gain ramp:
// sample-locked, and the playhead never moves. Seek and play restart the sources.
import { mediaUrl } from "../api.js";
import { claim, release } from "./bus.js";
import {
  type Clip, mixPeaks, peakBuckets, resolveDurations, shouldStream, startPlan, streamStep, timelineLength, variantGains,
} from "./timeline.js";

/** Sources are scheduled this far ahead of `currentTime`, so all of them land on the same sample. */
export const START_LEAD = 0.03;
/** Gain changes (variant switches, mute, solo) ramp over this long. */
export const RAMP_SECONDS = 0.004;
/** Give up waiting on a file's metadata after this long. */
const PROBE_TIMEOUT_MS = 15_000;

export interface LoadResult {
  duration: number;
  /** Max |sample| per bucket across channels; empty for a streamed file. */
  peaks: Float32Array;
  /** True when the file plays through `<audio>` (over 15 minutes, or it won't decode): switching isn't sample-exact. */
  streamed: boolean;
}

/** What the engine is doing, for tests and debugging. */
export interface EngineSnapshot {
  playing: boolean;
  time: number;
  length: number;
  /** Buffer sources held for the current run. */
  sources: number;
  /** Each clip's variant gain target (0 or 1). */
  gains: Record<string, number>;
  /** Lane gain targets that have been set. */
  lanes: Record<string, number>;
  /** Paths playing through `<audio>`. */
  streamed: string[];
}

/** Everything the engine reaches outside itself, injectable for tests. Defaults are the browser's. */
export interface EngineOptions {
  createContext?: () => AudioContext;
  /** Path to a URL the browser can fetch. Defaults to `mediaUrl`, which carries the project id. */
  url?: (path: string) => string;
  fetch?: typeof fetch;
  /** A file's duration from its metadata alone, or null. */
  probe?: (url: string) => Promise<number | null>;
  createMedia?: (url: string) => HTMLAudioElement;
  raf?: (cb: FrameRequestCallback) => number;
  caf?: (id: number) => void;
}

// Contexts held by live engines. Chromium caps a page at about six, so a remount must never leak one.
let live = 0;
/** How many AudioContexts engines currently hold open. */
export function liveContexts(): number {
  return live;
}

// Waveform peaks, per path, for the session (§17.2).
const peaksCache = new Map<string, Float32Array>();
export function clearPeaksCache(): void {
  peaksCache.clear();
}

interface Media {
  duration: number;
  buffer: AudioBuffer | null;
  streamed: boolean;
}
/** A clip's persistent nodes: its variant gain, and for a streamed file its element. */
interface ClipNodes {
  gain: GainNode;
  el?: HTMLAudioElement;
  elSource?: MediaElementAudioSourceNode;
}

function defaultProbe(createMedia: (url: string) => HTMLAudioElement) {
  return (url: string) =>
    new Promise<number | null>((resolve) => {
      const el = createMedia(url);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (d: number | null) => {
        clearTimeout(timer);
        el.removeAttribute("src");
        el.load();
        resolve(d);
      };
      el.preload = "metadata";
      el.addEventListener("loadedmetadata", () => done(Number.isFinite(el.duration) ? el.duration : null), { once: true });
      el.addEventListener("error", () => done(null), { once: true });
      timer = setTimeout(() => done(null), PROBE_TIMEOUT_MS);
    });
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private disposed = false;
  private readonly opts: Required<EngineOptions>;

  private clips: Clip[] = [];
  private videoDuration: number | null = null;
  private readonly media = new Map<string, Media>();
  private readonly loads = new Map<string, Promise<LoadResult>>();
  private selection: Record<string, string> = {};
  private readonly laneTargets: Record<string, number> = {};
  private readonly laneNodes = new Map<string, GainNode>();
  private readonly clipNodes = new Map<string, ClipNodes>();
  /** Buffer sources started for the current run, by clip id. */
  private readonly voices = new Map<string, AudioBufferSourceNode>();

  private _playing = false;
  /** Timeline time at `startedAt`. */
  private startOffset = 0;
  /** Context time the current run's sources start at. */
  private startedAt = 0;
  private frame: number | null = null;

  private readonly tickListeners = new Set<(t: number) => void>();
  private readonly endedListeners = new Set<() => void>();
  private readonly changeListeners = new Set<() => void>();

  /** A context passed in is adopted: the engine closes it on dispose. Otherwise one is made on first load or play. */
  constructor(ctx?: AudioContext, options: EngineOptions = {}) {
    const createMedia = options.createMedia ?? ((url: string) => new Audio(url));
    this.opts = {
      createContext: options.createContext ?? (() => new AudioContext()),
      url: options.url ?? mediaUrl,
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      probe: options.probe ?? defaultProbe(createMedia),
      createMedia,
      raf: options.raf ?? ((cb) => requestAnimationFrame(cb)),
      caf: options.caf ?? ((id) => cancelAnimationFrame(id)),
    };
    if (ctx) {
      this.ctx = ctx;
      live++;
    }
  }

  // ---- state ----

  get playing(): boolean {
    return this._playing;
  }

  /** `startOffset + (currentTime - startedAt)` while playing, clamped to the timeline. */
  get time(): number {
    if (!this._playing || !this.ctx) return this.startOffset;
    const t = this.startOffset + Math.max(0, this.ctx.currentTime - this.startedAt);
    const len = this.length;
    return len > 0 ? Math.min(t, len) : t;
  }

  /** The cut's length when set, otherwise the end of the longest clip. */
  get length(): number {
    return timelineLength(this.videoDuration, this.resolved());
  }

  inspect(): EngineSnapshot {
    return {
      playing: this._playing,
      time: this.time,
      length: this.length,
      sources: this.voices.size,
      gains: variantGains(this.clips, this.selection),
      lanes: { ...this.laneTargets },
      streamed: [...this.media].filter(([, m]) => m.streamed).map(([p]) => p),
    };
  }

  onTick(cb: (t: number) => void): () => void {
    this.tickListeners.add(cb);
    return () => this.tickListeners.delete(cb);
  }
  onEnded(cb: () => void): () => void {
    this.endedListeners.add(cb);
    return () => this.endedListeners.delete(cb);
  }
  /** Play, pause, seek, the clip list, a load or the length changed. */
  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  // ---- loading ----

  /** Decode a file (or fall back to streaming it) and compute its peaks. Repeat calls share one load. */
  load(path: string): Promise<LoadResult> {
    if (this.disposed) return Promise.reject(new Error("The audio engine was disposed"));
    let p = this.loads.get(path);
    if (!p) {
      p = this.loadOnce(path);
      this.loads.set(path, p);
      p.catch(() => this.loads.delete(path));
    }
    return p;
  }

  private async loadOnce(path: string): Promise<LoadResult> {
    const ctx = this.ensureContext();
    const url = this.opts.url(path);
    // Read the duration from metadata alongside the fetch, so a long file is never fully decoded.
    const abort = new AbortController();
    const probe = this.opts.probe(url).then(
      (d) => {
        if (shouldStream(d, true)) abort.abort();
        return d;
      },
      () => null,
    );
    let buffer: AudioBuffer | null = null;
    try {
      const res = await this.opts.fetch(url, { signal: abort.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buffer = await ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      buffer = null;
    }
    if (this.disposed) throw new Error("The audio engine was disposed");

    let result: LoadResult;
    if (buffer && !shouldStream(buffer.duration, true)) {
      let peaks = peaksCache.get(path);
      if (!peaks) {
        const channels: Float32Array[] = [];
        for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
        peaks = mixPeaks(channels, peakBuckets(buffer.duration));
        peaksCache.set(path, peaks);
      }
      this.media.set(path, { duration: buffer.duration, buffer, streamed: false });
      result = { duration: buffer.duration, peaks, streamed: false };
    } else {
      const duration = buffer ? buffer.duration : await probe;
      if (this.disposed) throw new Error("The audio engine was disposed");
      if (duration === null || !(duration > 0)) throw new Error(`Couldn't load ${path}`);
      this.media.set(path, { duration, buffer: null, streamed: true });
      result = { duration, peaks: new Float32Array(0), streamed: true };
    }
    this.afterLoad(path);
    return result;
  }

  /** A file arriving mid-play joins in, locked to the clock. */
  private afterLoad(path: string): void {
    if (this._playing) {
      for (const c of this.resolved()) if (c.path === path && !this.voices.has(c.id)) this.startLate(c);
      this.syncStreams(this.time);
    }
    this.emitChange();
  }

  // ---- the clip list and gains ----

  setClips(clips: Clip[]): void {
    const next = new Map(clips.map((c) => [c.id, c]));
    for (const old of this.clips) {
      const now = next.get(old.id);
      const same = now && now.lane === old.lane && now.path === old.path && now.offset === old.offset && now.duration === old.duration;
      if (!same) this.dropClip(old.id);
    }
    this.clips = clips.slice();
    if (this._playing) {
      for (const c of this.resolved()) if (!this.voices.has(c.id)) this.startLate(c);
      this.syncStreams(this.time);
    }
    this.emitChange();
  }

  /** The cut being previewed sets the timeline's length; null means the longest audio does. */
  setVideoDuration(seconds: number | null): void {
    this.videoDuration = seconds;
    if (!this._playing) this.startOffset = this.clampTime(this.startOffset);
    this.emitChange();
  }

  /** Mute/solo stage for a lane, ramped over 4 ms on the context clock. */
  setLaneGain(lane: string, gain: number): void {
    this.laneTargets[lane] = gain;
    const node = this.laneNodes.get(lane);
    if (node) this.ramp(node.gain, gain);
  }

  /** Make `clipId` the lane's audible variant (others go to 0); null plays every clip in the lane. */
  selectVariant(lane: string, clipId: string | null): void {
    if (clipId === null) delete this.selection[lane];
    else this.selection[lane] = clipId;
    const gains = variantGains(this.clips, this.selection);
    for (const c of this.clips) {
      if (c.lane !== lane) continue;
      const nodes = this.clipNodes.get(c.id);
      if (nodes) this.ramp(nodes.gain.gain, gains[c.id]);
    }
  }

  // ---- transport ----

  play(at: number = this.time): void {
    if (this.disposed) return;
    const ctx = this.ensureContext();
    const len = this.length;
    if (len <= 0) return;
    let from = this.clampTime(at);
    if (from >= len) from = 0;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    claim(this, () => this.pause());
    this._playing = true;
    this.restart(from);
    this.startLoop();
    this.emitChange();
  }

  pause(): void {
    if (!this._playing) return;
    this.startOffset = this.time;
    this._playing = false;
    this.stopVoices();
    this.pauseStreams();
    this.stopLoop();
    release(this);
    this.emitChange();
  }

  seek(t: number): void {
    if (this.disposed) return;
    const to = this.clampTime(t);
    if (this._playing) this.restart(to);
    else this.startOffset = to;
    this.emitChange();
  }

  /** Stops sources, disconnects every node, closes the context. The engine is unusable afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this._playing = false;
    this.stopLoop();
    this.stopVoices();
    for (const id of [...this.clipNodes.keys()]) this.dropClip(id);
    for (const node of this.laneNodes.values()) node.disconnect();
    this.laneNodes.clear();
    this.media.clear();
    this.loads.clear();
    release(this);
    this.tickListeners.clear();
    this.endedListeners.clear();
    this.changeListeners.clear();
    this.disposed = true;
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
      live--;
    }
  }

  // ---- internals ----

  private ensureContext(): AudioContext {
    if (this.disposed) throw new Error("The audio engine was disposed");
    if (!this.ctx) {
      this.ctx = this.opts.createContext();
      live++;
    }
    return this.ctx;
  }

  private resolved(): Clip[] {
    const durations: Record<string, number> = {};
    for (const [path, m] of this.media) durations[path] = m.duration;
    return resolveDurations(this.clips, durations);
  }

  private clampTime(t: number): number {
    const len = this.length;
    const lo = Math.max(0, Number.isFinite(t) ? t : 0);
    return len > 0 ? Math.min(lo, len) : lo;
  }

  /** Stop the run and start every source again from timeline time `at`, all on one origin. */
  private restart(at: number): void {
    const ctx = this.ctx!;
    this.stopVoices();
    this.startOffset = at;
    this.startedAt = ctx.currentTime + START_LEAD;
    const clips = this.resolved();
    const byId = new Map(clips.map((c) => [c.id, c]));
    for (const p of startPlan(clips, at)) {
      const c = byId.get(p.id)!;
      this.startVoice(c, this.startedAt + p.when, p.offset);
    }
    this.syncStreams(at);
  }

  /** Start one clip mid-run, on the same origin as the rest. */
  private startLate(c: Clip): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const base = Math.max(this.startedAt, ctx.currentTime + START_LEAD);
    const at = this.startOffset + (base - this.startedAt);
    for (const p of startPlan([c], at)) this.startVoice(c, base + p.when, p.offset);
  }

  private startVoice(c: Clip, when: number, offset: number): void {
    const m = this.media.get(c.path);
    if (!this.ctx || !m || m.streamed || !m.buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = m.buffer;
    src.connect(this.nodesFor(c).gain);
    src.start(when, offset, c.duration - offset);
    this.voices.set(c.id, src);
  }

  private stopVoices(): void {
    for (const src of this.voices.values()) {
      try {
        src.stop();
      } catch {
        // Already stopped.
      }
      src.disconnect();
    }
    this.voices.clear();
  }

  /** Streamed clips: start, stop and drift-correct their elements against the clock. */
  private syncStreams(t: number): void {
    for (const c of this.resolved()) {
      const m = this.media.get(c.path);
      if (!m?.streamed) continue;
      const existing = this.clipNodes.get(c.id)?.el;
      const expected = t - c.offset;
      const step = streamStep(expected, c.duration, existing ? { time: existing.currentTime, paused: existing.paused } : { time: 0, paused: true });
      if (step === "none") continue;
      const el = existing ?? this.nodesFor(c).el!;
      if (step === "pause") el.pause();
      else {
        el.currentTime = expected;
        if (step === "play") el.play().catch(() => {});
      }
    }
  }

  private pauseStreams(): void {
    for (const n of this.clipNodes.values()) n.el?.pause();
  }

  private laneNode(lane: string): GainNode {
    let node = this.laneNodes.get(lane);
    if (!node) {
      node = this.ctx!.createGain();
      node.gain.value = this.laneTargets[lane] ?? 1;
      node.connect(this.ctx!.destination);
      this.laneNodes.set(lane, node);
    }
    return node;
  }

  private nodesFor(c: Clip): ClipNodes {
    let nodes = this.clipNodes.get(c.id);
    if (!nodes) {
      const ctx = this.ctx!;
      const gain = ctx.createGain();
      gain.gain.value = variantGains([c], this.selection)[c.id];
      gain.connect(this.laneNode(c.lane));
      nodes = { gain };
      if (this.media.get(c.path)?.streamed) {
        const el = this.opts.createMedia(this.opts.url(c.path));
        el.preload = "auto";
        nodes.el = el;
        nodes.elSource = ctx.createMediaElementSource(el);
        nodes.elSource.connect(gain);
      }
      this.clipNodes.set(c.id, nodes);
    }
    return nodes;
  }

  private dropClip(id: string): void {
    const src = this.voices.get(id);
    if (src) {
      try {
        src.stop();
      } catch {
        // Already stopped.
      }
      src.disconnect();
      this.voices.delete(id);
    }
    const nodes = this.clipNodes.get(id);
    if (!nodes) return;
    nodes.elSource?.disconnect();
    if (nodes.el) {
      nodes.el.pause();
      nodes.el.removeAttribute("src");
      nodes.el.load();
    }
    nodes.gain.disconnect();
    this.clipNodes.delete(id);
  }

  /** A 4 ms linear ramp from the current value, starting now on the context clock. */
  private ramp(param: AudioParam, target: number): void {
    const now = this.ctx!.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + RAMP_SECONDS);
  }

  private startLoop(): void {
    if (this.frame === null) this.frame = this.opts.raf(this.tick);
  }

  private stopLoop(): void {
    if (this.frame !== null) this.opts.caf(this.frame);
    this.frame = null;
  }

  private readonly tick = (): void => {
    this.frame = null;
    if (!this._playing) return;
    const t = this.time;
    this.syncStreams(t);
    for (const cb of this.tickListeners) cb(t);
    const len = this.length;
    if (len > 0 && t >= len) {
      this.pause();
      for (const cb of this.endedListeners) cb();
      return;
    }
    if (this._playing) this.frame = this.opts.raf(this.tick);
  };

  private emitChange(): void {
    for (const cb of this.changeListeners) cb();
  }
}
