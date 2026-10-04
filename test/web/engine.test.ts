// A smoke test of the Web Audio layer against a minimal fake AudioContext: the clock, sample-locked
// scheduling, 4 ms gain ramps, the streamed fallback, the one-player bus and clean disposal.
// The real-browser checks live in the Music tab's e2e tests (Task 3).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claim, owner, release } from "../../web/src/audio/bus.js";
import {
  AudioEngine, clearPeaksCache, IDLE_BYTES_LIMIT, IDLE_FILES_LIMIT, liveContexts, PEAKS_CACHE_LIMIT, peaksCacheSize, RAMP_SECONDS, START_LEAD, type EngineOptions,
} from "../../web/src/audio/engine.js";
import type { Clip } from "../../web/src/audio/timeline.js";

type Call = [string, ...number[]];

class FakeParam {
  calls: Call[] = [];
  constructor(public value: number) {}
  cancelScheduledValues(t: number) { this.calls.push(["cancel", t]); }
  setValueAtTime(v: number, t: number) { this.calls.push(["set", v, t]); this.value = v; }
  linearRampToValueAtTime(v: number, t: number) { this.calls.push(["ramp", v, t]); this.value = v; }
}
/** A param with cancelAndHoldAtTime, as Chromium has. */
class HoldParam extends FakeParam {
  cancelAndHoldAtTime(t: number) { this.calls.push(["hold", t]); }
}
class FakeNode {
  out: FakeNode[] = [];
  disconnected = false;
  connect(n: FakeNode) { this.out.push(n); this.disconnected = false; return n; }
  disconnect() { this.out = []; this.disconnected = true; }
}
class FakeGain extends FakeNode {
  gain: FakeParam;
  constructor(hold = false) { super(); this.gain = hold ? new HoldParam(1) : new FakeParam(1); }
}
class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  started: [number, number, number] | null = null;
  stopped = false;
  onended: (() => void) | null = null;
  start(when: number, offset: number, duration: number) { this.started = [when, offset, duration]; }
  stop() { this.stopped = true; }
}
interface FakeBuffer { duration: number; length: number; numberOfChannels: number; getChannelData(i: number): Float32Array; tag: string }
class FakeMedia {
  currentTime = 0;
  paused = true;
  seeking = false;
  readyState = 4;
  src: string;
  preload = "";
  constructor(url: string) { this.src = url; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
  load() {}
}
class FakeElementSource extends FakeNode { constructor(public el: FakeMedia) { super(); } }

class FakeCtx {
  currentTime = 0;
  state: "running" | "suspended" | "closed" = "running";
  destination = new FakeNode();
  gains: FakeGain[] = [];
  sources: FakeSource[] = [];
  elementSources: FakeElementSource[] = [];
  decodes = 0;
  holdParams = false;
  createGain() { const g = new FakeGain(this.holdParams); this.gains.push(g); return g; }
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s; }
  createMediaElementSource(el: FakeMedia) { const s = new FakeElementSource(el); this.elementSources.push(s); return s; }
  // The fake "file" is its duration as text; "bad" won't decode.
  decodeAudioData(bytes: ArrayBuffer): Promise<FakeBuffer> {
    this.decodes++;
    const tag = new TextDecoder().decode(bytes);
    if (tag.startsWith("bad")) return Promise.reject(new Error("EncodingError"));
    const duration = Number(tag);
    const data = new Float32Array(Math.max(1, Math.round(duration * 100))).fill(0.25);
    // `length` as at 48 kHz, so a buffer's size in memory is real; the samples behind it are few.
    return Promise.resolve({ duration, length: Math.round(duration * 48_000), numberOfChannels: 1, getChannelData: () => data, tag });
  }
  resume() { this.state = "running"; return Promise.resolve(); }
  close() { this.state = "closed"; return Promise.resolve(); }
}

let ctxs: FakeCtx[];
let media: FakeMedia[];
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const files: Record<string, string> = {
  "/m/a.wav": "4", "/m/b.wav": "4", "/m/c.wav": "1", "/m/d.wav": "6", "/m/bad.wav": "bad", "/m/long.wav": "1000",
  "/m/huge.wav": "2000", "/m/slow.wav": "2",
};
const probed: Record<string, number> = { "/m/bad.wav": 3, "/m/long.wav": 1000, "/m/huge.wav": 2000 };
const sizes: Record<string, number> = { "/m/huge.wav": 400 * 1024 * 1024 };

interface FetchCall { url: string; signal?: AbortSignal; bodyRead: boolean }
let fetches: FetchCall[];
/** Fetches of these URLs wait until the test opens the gate. */
let gates: Record<string, { wait: Promise<void>; open(): void }>;
function gate(url: string) {
  let open!: () => void;
  const wait = new Promise<void>((r) => { open = r; });
  gates[url] = { wait, open };
}

function options(): EngineOptions {
  return {
    createContext: () => { const c = new FakeCtx(); ctxs.push(c); return c as unknown as AudioContext; },
    url: (path) => `/m/${path}`,
    fetch: (async (url: string, init?: RequestInit) => {
      const call: FetchCall = { url, signal: init?.signal ?? undefined, bodyRead: false };
      fetches.push(call);
      if (gates[url]) await gates[url].wait;
      await Promise.resolve();
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return {
        ok: url in files,
        status: url in files ? 200 : 404,
        headers: { get: (h: string) => (h === "content-length" && sizes[url] ? String(sizes[url]) : null) },
        arrayBuffer: async () => { call.bodyRead = true; return new TextEncoder().encode(files[url]).buffer; },
      };
    }) as unknown as typeof fetch,
    probe: async (url) => {
      // huge.wav's metadata is slow, so only its size can send it straight to streaming.
      if (url === "/m/huge.wav") await new Promise((r) => setTimeout(r, 5));
      return probed[url] ?? null;
    },
    createMedia: (url) => { const m = new FakeMedia(url); media.push(m); return m as unknown as HTMLAudioElement; },
    raf: (cb) => { const id = ++nextFrame; frames.set(id, cb); return id; },
    caf: (id) => { frames.delete(id); },
  };
}
/** Run one animation frame. */
function frame() {
  const due = [...frames.values()];
  frames.clear();
  for (const cb of due) cb(0);
}
const clip = (id: string, offset: number, duration: number, lane = "music"): Clip => ({ id, lane, path: `${id}.wav`, offset, duration });

beforeEach(() => {
  ctxs = [];
  media = [];
  frames = new Map();
  nextFrame = 0;
  fetches = [];
  gates = {};
  clearPeaksCache();
});
afterEach(() => {
  release(owner());
});

async function ready(clips: Clip[]) {
  const engine = new AudioEngine(undefined, options());
  engine.setClips(clips);
  await Promise.all([...new Map(clips.map((c) => [`${c.path}#${c.rev}`, c])).values()].map((c) => engine.load(c.path, c.rev)));
  return { engine, ctx: ctxs[0] };
}

describe("AudioEngine: the context", () => {
  it("creates no AudioContext until the first load, and closes it on dispose", async () => {
    const engine = new AudioEngine(undefined, options());
    engine.setClips([clip("a", 0, 4)]);
    engine.selectVariant("music", "a");
    engine.setLaneGain("music", 0.5);
    expect(ctxs).toHaveLength(0);
    expect(liveContexts()).toBe(0);
    await engine.load("a.wav");
    expect(ctxs).toHaveLength(1);
    expect(liveContexts()).toBe(1);
    engine.dispose();
    expect(ctxs[0].state).toBe("closed");
    expect(liveContexts()).toBe(0);
    engine.dispose(); // idempotent
    expect(liveContexts()).toBe(0);
  });

  it("creates the context on play when nothing was loaded first", () => {
    const engine = new AudioEngine(undefined, options());
    engine.play(0);
    expect(ctxs).toHaveLength(1);
    engine.dispose();
  });

  it("never piles up contexts across remounts", async () => {
    for (let i = 0; i < 10; i++) {
      const { engine } = await ready([clip("a", 0, 4)]);
      engine.play(0);
      expect(liveContexts()).toBe(1);
      engine.dispose();
    }
    expect(liveContexts()).toBe(0);
    expect(ctxs.every((c) => c.state === "closed")).toBe(true);
  });

  it("adopts a context it's given", async () => {
    const given = new FakeCtx();
    const engine = new AudioEngine(given as unknown as AudioContext, options());
    await engine.load("a.wav");
    expect(ctxs).toHaveLength(0);
    expect(liveContexts()).toBe(1);
    engine.dispose();
    expect(given.state).toBe("closed");
    expect(liveContexts()).toBe(0);
  });

  it("refuses to load once disposed", async () => {
    const engine = new AudioEngine(undefined, options());
    engine.dispose();
    await expect(engine.load("a.wav")).rejects.toThrow(/disposed/);
    expect(ctxs).toHaveLength(0);
  });
});

describe("AudioEngine: one clock, sample-locked", () => {
  it("starts every source against the same origin, at the right buffer offsets", async () => {
    const { engine, ctx } = await ready([clip("a", 0, 4), clip("b", 0, 4), clip("c", 2, 1, "sfx")]);
    ctx.currentTime = 10;
    engine.play(1);
    const base = 10 + START_LEAD;
    const started = ctx.sources.map((s) => [s.buffer!.tag, ...s.started!]);
    expect(started).toEqual([
      ["4", base, 1, 3],
      ["4", base, 1, 3],
      ["1", base + 1, 0, 1],
    ]);
    expect(engine.playing).toBe(true);
    expect(engine.inspect().sources).toBe(3);
  });

  it("derives time from the context clock and never runs backwards", async () => {
    const { engine, ctx } = await ready([clip("a", 0, 4)]);
    ctx.currentTime = 10;
    engine.play(1);
    expect(engine.time).toBe(1);
    ctx.currentTime = 10 + START_LEAD / 2;
    expect(engine.time).toBe(1);
    ctx.currentTime = 10 + START_LEAD + 0.5;
    expect(engine.time).toBeCloseTo(1.5, 9);
  });

  it("switches variants with a 4 ms ramp, without touching the sources or the playhead", async () => {
    const { engine, ctx } = await ready([clip("a", 0, 4), clip("b", 0, 4)]);
    engine.selectVariant("music", "a");
    ctx.currentTime = 10;
    engine.play(0);
    ctx.currentTime = 11;
    const before = engine.time;
    const sources = ctx.sources.length;
    engine.selectVariant("music", "b");
    expect(engine.time).toBe(before);
    expect(ctx.sources.length).toBe(sources);
    expect(ctx.sources.some((s) => s.stopped)).toBe(false);
    const gains = engine.inspect().gains;
    expect(gains).toEqual({ a: 0, b: 1 });
    // Each source connects into its own clip's variant GainNode (clip order: a, then b).
    const [ga, gb] = ctx.sources.map((s) => s.out[0] as FakeGain);
    expect(ga.gain.calls.slice(-3)).toEqual([["cancel", 11], ["set", 1, 11], ["ramp", 0, 11 + RAMP_SECONDS]]);
    expect(gb.gain.calls.slice(-3)).toEqual([["cancel", 11], ["set", 0, 11], ["ramp", 1, 11 + RAMP_SECONDS]]);
  });

  it("chains variant gain into the lane gain, and ramps the lane gain", async () => {
    const { engine, ctx } = await ready([clip("a", 0, 4)]);
    ctx.currentTime = 5;
    engine.play(0);
    const variant = ctx.sources[0].out[0] as FakeGain;
    const lane = variant.out[0] as FakeGain;
    expect(lane).toBeInstanceOf(FakeGain);
    ctx.currentTime = 6;
    engine.setLaneGain("music", 0);
    expect(lane.gain.calls.slice(-3)).toEqual([["cancel", 6], ["set", 1, 6], ["ramp", 0, 6 + RAMP_SECONDS]]);
    expect(engine.inspect().lanes).toEqual({ music: 0 });
  });

  it("applies a gain set before the nodes exist", async () => {
    const engine = new AudioEngine(undefined, options());
    engine.setClips([clip("a", 0, 4), clip("b", 0, 4)]);
    engine.setLaneGain("music", 0.25);
    engine.selectVariant("music", "b");
    await engine.load("a.wav");
    await engine.load("b.wav");
    engine.play(0);
    const ctx = ctxs[0];
    const [va, vb] = ctx.sources.map((s) => s.out[0] as FakeGain);
    expect(va.gain.value).toBe(0);
    expect(vb.gain.value).toBe(1);
    expect((va.out[0] as FakeGain).gain.value).toBe(0.25);
    engine.selectVariant("music", null);
    expect(engine.inspect().gains).toEqual({ a: 1, b: 1 });
    engine.dispose();
  });

  it("restarts every source on seek, and holds time on pause", async () => {
    const { engine, ctx } = await ready([clip("a", 0, 4)]);
    ctx.currentTime = 10;
    engine.play(0);
    ctx.currentTime = 11;
    engine.seek(2.5);
    expect(ctx.sources[0].stopped).toBe(true);
    expect(ctx.sources[0].disconnected).toBe(true);
    expect(ctx.sources[1].started).toEqual([11 + START_LEAD, 2.5, 1.5]);
    expect(engine.inspect().sources).toBe(1);
    ctx.currentTime = 11 + START_LEAD + 0.5;
    engine.pause();
    expect(engine.time).toBeCloseTo(3, 9);
    expect(ctx.sources[1].stopped).toBe(true);
    ctx.currentTime = 20;
    expect(engine.time).toBeCloseTo(3, 9);
    expect(engine.inspect().sources).toBe(0);
    engine.seek(1);
    expect(engine.time).toBe(1);
    expect(ctx.sources).toHaveLength(2);
  });

  it("ticks while playing, then stops at the end and says so", async () => {
    const { engine, ctx } = await ready([clip("a", 0, 4), clip("c", 2, 1, "sfx")]);
    expect(engine.length).toBe(4);
    const ticks: number[] = [];
    const ended = vi.fn();
    engine.onTick((t) => ticks.push(t));
    engine.onEnded(ended);
    ctx.currentTime = 10;
    engine.play(3);
    ctx.currentTime = 10 + START_LEAD + 0.5;
    frame();
    expect(ticks.at(-1)).toBeCloseTo(3.5, 9);
    ctx.currentTime = 10 + START_LEAD + 2;
    expect(engine.time).toBe(4);
    frame();
    expect(engine.playing).toBe(false);
    expect(engine.time).toBe(4);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    // Play from the end starts again from the top.
    engine.play(engine.time);
    expect(engine.time).toBe(0);
  });

  it("uses the cut's length when it's set", async () => {
    const { engine } = await ready([clip("a", 0, 4)]);
    engine.setVideoDuration(2);
    expect(engine.length).toBe(2);
    engine.seek(9);
    expect(engine.time).toBe(2);
    engine.setVideoDuration(null);
    expect(engine.length).toBe(4);
  });

  it("fills a clip's unknown length from the decoded file", async () => {
    const { engine, ctx } = await ready([clip("d", 1, 0)]);
    expect(engine.length).toBe(7);
    engine.play(2);
    expect(ctx.sources[0].started![1]).toBe(1);
    expect(ctx.sources[0].started![2]).toBe(5);
  });

  it("keeps unchanged clips playing when the clip list changes, and starts new ones on the clock", async () => {
    const { engine, ctx } = await ready([clip("a", 0, 4), clip("b", 0, 4)]);
    ctx.currentTime = 10;
    engine.play(0);
    ctx.currentTime = 11;
    engine.setClips([clip("a", 0, 4), { ...clip("b", 0, 4), id: "b2" }]);
    expect(ctx.sources[0].stopped).toBe(false);
    expect(ctx.sources[1].stopped).toBe(true);
    const fresh = ctx.sources[2];
    // Starts START_LEAD from now, at the timeline point that moment maps to.
    expect(fresh.started![0]).toBeCloseTo(11 + START_LEAD, 9);
    expect(fresh.started![1]).toBeCloseTo(1, 9);
    expect(engine.inspect().sources).toBe(2);
  });

  it("starts a clip whose file loads mid-play, locked to the clock", async () => {
    const engine = new AudioEngine(undefined, options());
    engine.setClips([clip("a", 0, 4), clip("b", 0, 4)]);
    await engine.load("a.wav");
    const ctx = ctxs[0];
    ctx.currentTime = 10;
    engine.play(0);
    expect(ctx.sources).toHaveLength(1);
    ctx.currentTime = 10.5;
    await engine.load("b.wav");
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[1].started![0]).toBeCloseTo(10.5 + START_LEAD, 9);
    expect(ctx.sources[1].started![1]).toBeCloseTo(0.5, 9);
    engine.dispose();
  });
});

describe("AudioEngine: loading", () => {
  it("returns duration and peaks, caching peaks per path for the session", async () => {
    const one = new AudioEngine(undefined, options());
    const first = await one.load("a.wav");
    expect(first).toMatchObject({ duration: 4, streamed: false });
    expect(first.peaks.length).toBeGreaterThan(0);
    expect(first.peaks[0]).toBeCloseTo(0.25, 6);
    expect(await one.load("a.wav")).toBe(first);
    one.dispose();
    const two = new AudioEngine(undefined, options());
    const again = await two.load("a.wav");
    expect(again.peaks).toBe(first.peaks);
    two.dispose();
  });

  it("streams a file that won't decode, with drift correction", async () => {
    const { engine, ctx } = await ready([{ ...clip("bad", 1, 0) }]);
    expect(await engine.load("bad.wav")).toMatchObject({ duration: 3, streamed: true });
    expect((await engine.load("bad.wav")).peaks).toHaveLength(0);
    expect(engine.length).toBe(4);
    ctx.currentTime = 10;
    engine.play(2);
    const el = media.at(-1)!;
    expect(ctx.elementSources.map((s) => s.el)).toContain(el);
    expect(el.paused).toBe(false);
    // It starts now, START_LEAD early in its file, so it lines up when the buffer sources start.
    expect(el.currentTime).toBeCloseTo(1 - START_LEAD, 9);
    // It drifts 200 ms: the next tick seeks it back.
    ctx.currentTime = 10 + START_LEAD + 0.5;
    el.currentTime = 1.7;
    frame();
    expect(el.currentTime).toBeCloseTo(1.5, 9);
    // Within 50 ms: left alone.
    el.currentTime = 1.53;
    frame();
    expect(el.currentTime).toBe(1.53);
    // Drifted again, but inside the cooldown after that seek: left alone.
    ctx.currentTime += 0.1;
    el.currentTime = 2.5;
    frame();
    expect(el.currentTime).toBe(2.5);
    // Past the cooldown but still seeking or buffering: left alone, every frame.
    ctx.currentTime += 0.5;
    el.seeking = true;
    frame();
    frame();
    expect(el.currentTime).toBe(2.5);
    el.seeking = false;
    el.readyState = 2;
    frame();
    expect(el.currentTime).toBe(2.5);
    // Ready again: one seek back to the clock.
    el.readyState = 4;
    frame();
    expect(el.currentTime).toBeCloseTo(engine.time - 1, 9);
    engine.pause();
    expect(el.paused).toBe(true);
    expect(engine.inspect().streamed).toEqual(["bad.wav"]);
  });

  it("streams a file over 15 minutes", async () => {
    const engine = new AudioEngine(undefined, options());
    expect(await engine.load("long.wav")).toMatchObject({ duration: 1000, streamed: true });
    engine.dispose();
  });

  it("rejects a file that neither decodes nor plays", async () => {
    const engine = new AudioEngine(undefined, options());
    await expect(engine.load("missing.wav")).rejects.toThrow();
    engine.dispose();
  });
});

describe("AudioEngine: the one-player bus and disposal", () => {
  it("claims the bus on play and stops whoever was playing", async () => {
    const { engine } = await ready([clip("a", 0, 4)]);
    const stopAssets = vi.fn();
    claim("assets", stopAssets);
    engine.play(0);
    expect(stopAssets).toHaveBeenCalledTimes(1);
    expect(owner()).toBe(engine);
    claim("assets", vi.fn());
    expect(engine.playing).toBe(false);
  });

  it("tells listeners when it starts and stops", async () => {
    const { engine } = await ready([clip("a", 0, 4)]);
    const changed = vi.fn();
    const off = engine.onChange(changed);
    engine.play(0);
    engine.pause();
    expect(changed).toHaveBeenCalledTimes(2);
    off();
    engine.play(0);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("stops sources, disconnects every node and releases the bus on dispose", async () => {
    const { engine, ctx } = await ready([clip("a", 0, 4), clip("bad", 0, 0, "sfx")]);
    await engine.load("bad.wav");
    const ticks = vi.fn();
    engine.onTick(ticks);
    ctx.currentTime = 1;
    engine.play(0);
    engine.dispose();
    expect(ctx.sources.every((s) => s.stopped && s.disconnected)).toBe(true);
    expect(ctx.gains.every((g) => g.disconnected)).toBe(true);
    expect(ctx.elementSources.every((s) => s.disconnected)).toBe(true);
    expect(media.every((m) => m.paused && m.src === "")).toBe(true);
    expect(owner()).toBeNull();
    expect(frames.size).toBe(0);
    expect(engine.playing).toBe(false);
    engine.play(0);
    expect(engine.playing).toBe(false);
    expect(ticks).not.toHaveBeenCalled();
  });
});

describe("AudioEngine: fix round 1", () => {
  it("frees a lane's old files when its clips are replaced", async () => {
    const { engine } = await ready([clip("a", 0, 4), clip("b", 0, 4)]);
    expect(engine.inspect().media.sort()).toEqual(["a.wav", "b.wav"]);
    engine.setClips([clip("c", 0, 1)]);
    expect(engine.inspect().media).toEqual([]);
    await engine.load("c.wav");
    expect(engine.inspect().media).toEqual(["c.wav"]);
    // A freed path waits idle (§19.8), so bringing it back fetches nothing.
    engine.setClips([clip("a", 0, 4)]);
    await engine.load("a.wav");
    expect(fetches.filter((f) => f.url === "/m/a.wav")).toHaveLength(1);
  });

  it("aborts a load in flight when its path is dropped", async () => {
    const engine = new AudioEngine(undefined, options());
    gate("/m/slow.wav");
    engine.setClips([clip("slow", 0, 2)]);
    const loading = engine.load("slow.wav");
    await Promise.resolve();
    engine.setClips([]);
    expect(fetches[0].signal?.aborted).toBe(true);
    gates["/m/slow.wav"].open();
    await expect(loading).rejects.toThrow();
    expect(engine.inspect().media).toEqual([]);
    engine.dispose();
  });

  it("aborts every load in flight on dispose", async () => {
    const engine = new AudioEngine(undefined, options());
    gate("/m/slow.wav");
    const loading = engine.load("slow.wav");
    await Promise.resolve();
    engine.dispose();
    expect(fetches[0].signal?.aborted).toBe(true);
    gates["/m/slow.wav"].open();
    await expect(loading).rejects.toThrow();
  });

  it("caps the peak cache, dropping the least recently used file revision first (M5)", async () => {
    const engine = new AudioEngine(undefined, options());
    const r0 = (await engine.load("a.wav", "r0")).peaks;
    const r1 = (await engine.load("a.wav", "r1")).peaks;
    for (let i = 2; i < PEAKS_CACHE_LIMIT; i++) await engine.load("a.wav", `r${i}`);
    expect(peaksCacheSize()).toBe(PEAKS_CACHE_LIMIT);
    engine.dispose();
    // r0 is used again (a hit), so r1 is now the least recently used; one more revision evicts it.
    const next = new AudioEngine(undefined, options());
    expect((await next.load("a.wav", "r0")).peaks).toBe(r0);
    await next.load("a.wav", "new");
    expect(peaksCacheSize()).toBe(PEAKS_CACHE_LIMIT);
    next.dispose();
    const later = new AudioEngine(undefined, options());
    expect((await later.load("a.wav", "r0")).peaks).toBe(r0);
    // r1's peaks were dropped, so they're worked out afresh.
    expect((await later.load("a.wav", "r1")).peaks).not.toBe(r1);
    later.dispose();
  });

  it("keys files on their revision: a re-render in place decodes afresh with new peaks", async () => {
    const { engine } = await ready([{ ...clip("a", 0, 4), rev: "r1" }]);
    const first = await engine.load("a.wav", "r1");
    engine.setClips([{ ...clip("a", 0, 4), rev: "r2" }]);
    expect(engine.inspect().media).toEqual([]);
    const second = await engine.load("a.wav", "r2");
    expect(second).not.toBe(first);
    expect(second.peaks).not.toBe(first.peaks);
    expect(engine.inspect().media).toEqual(["a.wav#r2"]);
    expect(fetches.filter((f) => f.url === "/m/a.wav")).toHaveLength(2);
    // The same revision in a later engine reuses the cached peaks.
    const other = new AudioEngine(undefined, options());
    expect((await other.load("a.wav", "r2")).peaks).toBe(second.peaks);
    other.dispose();
  });

  it("streams a file whose size rules out 15 minutes, without downloading or decoding it", async () => {
    const engine = new AudioEngine(undefined, options());
    expect(await engine.load("huge.wav")).toMatchObject({ duration: 2000, streamed: true });
    expect(fetches[0].bodyRead).toBe(false);
    expect(ctxs[0].decodes).toBe(0);
    engine.dispose();
  });

  it("streams without decoding when the metadata says it's long first", async () => {
    const engine = new AudioEngine(undefined, options());
    expect(await engine.load("long.wav")).toMatchObject({ duration: 1000, streamed: true });
    expect(ctxs[0].decodes).toBe(0);
    engine.dispose();
  });

  it("stops when the timeline's length drops to 0 mid-play", async () => {
    const { engine, ctx } = await ready([clip("a", 0, 4)]);
    ctx.currentTime = 10;
    engine.play(0);
    engine.setClips([]);
    frame();
    expect(engine.playing).toBe(false);
    expect(frames.size).toBe(0);
  });

  it("keeps ticking when one listener throws", async () => {
    const { engine, ctx } = await ready([clip("a", 0, 4)]);
    const good = vi.fn();
    engine.onTick(() => { throw new Error("listener"); });
    engine.onTick(good);
    ctx.currentTime = 10;
    engine.play(0);
    ctx.currentTime = 10.5;
    expect(() => frame()).not.toThrow();
    frame();
    expect(good).toHaveBeenCalledTimes(2);
    expect(engine.playing).toBe(true);
  });

  it("counts only live sources: one that ends drops out", async () => {
    const { engine, ctx } = await ready([clip("a", 0, 4), clip("c", 0, 1, "sfx")]);
    ctx.currentTime = 10;
    engine.play(0);
    expect(engine.inspect().sources).toBe(2);
    ctx.sources[1].onended!();
    expect(engine.inspect().sources).toBe(1);
    expect(ctx.sources[1].disconnected).toBe(true);
  });

  it("holds the current value with cancelAndHoldAtTime where the browser has it", async () => {
    const given = new FakeCtx();
    given.holdParams = true;
    const engine = new AudioEngine(given as unknown as AudioContext, options());
    engine.setClips([clip("a", 0, 4), clip("b", 0, 4)]);
    await engine.load("a.wav");
    await engine.load("b.wav");
    given.currentTime = 10;
    engine.play(0);
    given.currentTime = 11;
    engine.selectVariant("music", "b");
    const ga = given.sources[0].out[0] as FakeGain;
    expect(ga.gain.calls.slice(-2)).toEqual([["hold", 11], ["ramp", 0, 11 + RAMP_SECONDS]]);
    engine.setLaneGain("music", 0.5);
    expect((ga.out[0] as FakeGain).gain.calls.slice(-2)).toEqual([["hold", 11], ["ramp", 0.5, 11 + RAMP_SECONDS]]);
    engine.dispose();
  });

  it("tells a subscriber the time on every tick and on a seek while paused", async () => {
    const { engine, ctx } = await ready([clip("a", 0, 4)]);
    const seen: number[] = [];
    const off = engine.subscribe((t) => seen.push(t));
    engine.seek(1.25);
    expect(seen.at(-1)).toBe(1.25);
    ctx.currentTime = 10;
    engine.play(1.25);
    ctx.currentTime = 10 + START_LEAD + 0.25;
    frame();
    expect(seen.at(-1)).toBeCloseTo(1.5, 9);
    off();
    const n = seen.length;
    frame();
    expect(seen).toHaveLength(n);
  });
});

describe("AudioEngine: follow-ups (§19.8)", () => {
  it("keeps a dropped file idle, so bringing it back needs no fetch or decode", async () => {
    const { engine, ctx } = await ready([clip("a", 0, 4), clip("b", 0, 4)]);
    const first = await engine.load("a.wav");
    engine.setClips([clip("b", 0, 4)]);
    expect(engine.inspect().media).toEqual(["b.wav"]);
    expect(engine.inspect().idle).toEqual(["a.wav"]);
    engine.setClips([clip("a", 0, 4), clip("b", 0, 4)]);
    // Back at once: no load to wait on, the same result and no second fetch or decode.
    expect(engine.inspect().media.sort()).toEqual(["a.wav", "b.wav"]);
    expect(engine.inspect().idle).toEqual([]);
    expect(await engine.load("a.wav")).toBe(first);
    expect(fetches.filter((f) => f.url === "/m/a.wav")).toHaveLength(1);
    expect(ctx.decodes).toBe(2);
    engine.dispose();
  });

  it(`releases idle files beyond ${IDLE_FILES_LIMIT}, the least recently dropped first`, async () => {
    const n = IDLE_FILES_LIMIT + 2;
    for (let i = 0; i < n; i++) files[`/m/f${i}.wav`] = "1";
    const clips = Array.from({ length: n }, (_, i) => clip(`f${i}`, 0, 1));
    const engine = new AudioEngine(undefined, options());
    // Dropped one at a time, oldest first.
    for (let i = 0; i < n; i++) {
      engine.setClips([clips[i]]);
      await engine.load(clips[i].path);
    }
    engine.setClips([]);
    const idle = engine.inspect().idle;
    expect(idle).toHaveLength(IDLE_FILES_LIMIT);
    expect(idle).not.toContain("f0.wav");
    expect(idle).not.toContain("f1.wav");
    expect(idle).toContain(`f${n - 1}.wav`);
    // A released file is fetched again; an idle one isn't.
    engine.setClips([clips[0], clips[n - 1]]);
    await engine.load("f0.wav");
    await engine.load(`f${n - 1}.wav`);
    expect(fetches.filter((f) => f.url === "/m/f0.wav")).toHaveLength(2);
    expect(fetches.filter((f) => f.url === `/m/f${n - 1}.wav`)).toHaveLength(1);
    engine.dispose();
    for (let i = 0; i < n; i++) delete files[`/m/f${i}.wav`];
  });

  it("brings a file back from idle before applying the limit, so it's never the one released", async () => {
    const n = IDLE_FILES_LIMIT + 1;
    for (let i = 0; i < n; i++) files[`/m/f${i}.wav`] = "1";
    const clips = Array.from({ length: n }, (_, i) => clip(`f${i}`, 0, 1));
    const engine = new AudioEngine(undefined, options());
    for (let i = 0; i < n; i++) {
      engine.setClips([clips[i]]);
      await engine.load(clips[i].path);
    }
    // Idle is full (f0…f11). Dropping f12 while bringing back f0, the oldest, keeps f0.
    expect(engine.inspect().idle).toHaveLength(IDLE_FILES_LIMIT);
    engine.setClips([clips[0]]);
    expect(engine.inspect().media).toEqual(["f0.wav"]);
    await engine.load("f0.wav");
    expect(fetches.filter((f) => f.url === "/m/f0.wav")).toHaveLength(1);
    expect(engine.inspect().idle).toHaveLength(IDLE_FILES_LIMIT);
    expect(engine.inspect().idle).toContain(`f${n - 1}.wav`);
    engine.dispose();
    for (let i = 0; i < n; i++) delete files[`/m/f${i}.wav`];
  });

  it(`caps idle decoded audio at ${IDLE_BYTES_LIMIT / 1024 / 1024} MB, releasing the least recently dropped first`, async () => {
    // Ten minutes of mono at 48 kHz: 115.2 MB decoded, so three don't fit idle together.
    for (let i = 0; i < 3; i++) files[`/m/big${i}.wav`] = "600";
    const engine = new AudioEngine(undefined, options());
    for (let i = 0; i < 3; i++) {
      engine.setClips([clip(`big${i}`, 0, 0)]);
      await engine.load(`big${i}.wav`);
    }
    engine.setClips([]);
    expect(engine.inspect().idle).toEqual(["big1.wav", "big2.wav"]);
    engine.dispose();
    for (let i = 0; i < 3; i++) delete files[`/m/big${i}.wav`];
  });

  it("never keeps a superseded revision idle", async () => {
    const { engine } = await ready([{ ...clip("a", 0, 4), rev: "r1" }]);
    engine.setClips([{ ...clip("a", 0, 4), rev: "r2" }]);
    expect(engine.inspect().idle).toEqual([]);
    engine.dispose();
  });

  it("keeps the heard clip's source when other clips leave", async () => {
    const { engine, ctx } = await ready([clip("a", 0, 4, "x"), clip("b", 0, 4, "y")]);
    ctx.currentTime = 10;
    engine.play(0);
    const voice = engine.inspect().voices.a;
    ctx.currentTime = 10.5;
    engine.setClips([clip("a", 0, 4, "x")]);
    expect(engine.inspect().voices).toEqual({ a: voice });
    engine.setClips([clip("a", 0, 4, "x"), clip("b", 0, 4, "y")]);
    // b comes back from idle and joins on the clock; a is untouched.
    expect(engine.inspect().voices.a).toBe(voice);
    expect(engine.inspect().voices.b).toBeGreaterThan(voice);
    expect(ctx.sources.at(-1)!.started![1]).toBeCloseTo(0.5, 9);
    engine.dispose();
  });

  it("keeps playing through a re-render of the only clip: silent until it decodes, then back at the right place", async () => {
    const { engine, ctx } = await ready([{ ...clip("a", 0, 4), rev: "r1" }]);
    ctx.currentTime = 10;
    engine.play(0);
    ctx.currentTime = 11;
    gate("/m/a.wav");
    engine.setClips([{ ...clip("a", 0, 4), rev: "r2" }]);
    const loading = engine.load("a.wav", "r2");
    frame();
    expect(engine.playing).toBe(true);
    expect(engine.inspect().sources).toBe(0);
    // The length holds while the new file decodes, so the clock runs on.
    expect(engine.length).toBe(4);
    ctx.currentTime = 11.5;
    frame();
    expect(engine.playing).toBe(true);
    expect(engine.time).toBeCloseTo(1.5 - START_LEAD, 9);
    gates["/m/a.wav"].open();
    await loading;
    expect(engine.inspect().sources).toBe(1);
    const fresh = ctx.sources.at(-1)!;
    expect(fresh.started![0]).toBeCloseTo(11.5 + START_LEAD, 9);
    expect(fresh.started![1]).toBeCloseTo(1.5, 9);
    expect(engine.playing).toBe(true);
    engine.dispose();
  });

  it("keeps playing through a re-render of a clip whose length was never given", async () => {
    const { engine, ctx } = await ready([{ ...clip("a", 0, 0), rev: "r1" }]);
    ctx.currentTime = 10;
    engine.play(0);
    ctx.currentTime = 11;
    gate("/m/a.wav");
    engine.setClips([{ ...clip("a", 0, 0), rev: "r2" }]);
    const loading = engine.load("a.wav", "r2");
    frame();
    expect(engine.playing).toBe(true);
    expect(engine.length).toBe(4);
    gates["/m/a.wav"].open();
    await loading;
    expect(engine.inspect().sources).toBe(1);
    engine.dispose();
  });

  it("keeps the clock running while the only clip's new file loads, then starts it in place", async () => {
    const { engine, ctx } = await ready([clip("a", 0, 0)]);
    ctx.currentTime = 10;
    engine.play(0);
    ctx.currentTime = 11;
    gate("/m/b.wav");
    engine.setClips([clip("b", 0, 0)]);
    const loading = engine.load("b.wav");
    expect(engine.length).toBe(0);
    frame();
    expect(engine.playing).toBe(true);
    gates["/m/b.wav"].open();
    await loading;
    expect(ctx.sources.at(-1)!.started![1]).toBeCloseTo(1, 9);
    engine.dispose();
  });

  it("re-rendered twice before the first decodes: the first load is aborted, one source joins", async () => {
    const { engine, ctx } = await ready([{ ...clip("a", 0, 0), rev: "r1" }]);
    ctx.currentTime = 10;
    engine.play(0);
    ctx.currentTime = 11;
    gate("/m/a.wav");
    engine.setClips([{ ...clip("a", 0, 0), rev: "r2" }]);
    const second = engine.load("a.wav", "r2");
    await Promise.resolve();
    engine.setClips([{ ...clip("a", 0, 0), rev: "r3" }]);
    const third = engine.load("a.wav", "r3");
    expect(fetches[1].signal?.aborted).toBe(true);
    frame();
    expect(engine.playing).toBe(true);
    expect(engine.length).toBe(4);
    gates["/m/a.wav"].open();
    await expect(second).rejects.toThrow();
    await third;
    expect(engine.inspect().sources).toBe(1);
    expect(engine.inspect().media).toEqual(["a.wav#r3"]);
    expect(ctx.sources.filter((s) => s.started && !s.stopped)).toHaveLength(1);
    engine.dispose();
  });

  it("a re-render shorter than the playhead ends playback cleanly once it decodes", async () => {
    const { engine, ctx } = await ready([{ ...clip("a", 0, 0), rev: "r1" }]);
    const ended = vi.fn();
    engine.onEnded(ended);
    ctx.currentTime = 10;
    engine.play(0);
    ctx.currentTime = 13;
    files["/m/a.wav"] = "1";
    engine.setClips([{ ...clip("a", 0, 0), rev: "r2" }]);
    await engine.load("a.wav", "r2");
    // The new file ends before the playhead: nothing starts, and the next frame ends the run.
    expect(engine.inspect().sources).toBe(0);
    expect(engine.length).toBe(1);
    frame();
    expect(engine.playing).toBe(false);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    files["/m/a.wav"] = "4";
    engine.dispose();
  });

  it("stops when a re-rendered only clip fails to load", async () => {
    const { engine, ctx } = await ready([{ ...clip("a", 0, 0), rev: "r1" }]);
    ctx.currentTime = 10;
    engine.play(0);
    files["/m/a.wav"] = "bad";
    probed["/m/a.wav"] = 0;
    engine.setClips([{ ...clip("a", 0, 0), rev: "r2" }]);
    await expect(engine.load("a.wav", "r2")).rejects.toThrow();
    frame();
    expect(engine.playing).toBe(false);
    files["/m/a.wav"] = "4";
    delete probed["/m/a.wav"];
    engine.dispose();
  });
});
