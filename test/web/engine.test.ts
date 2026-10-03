// A smoke test of the Web Audio layer against a minimal fake AudioContext: the clock, sample-locked
// scheduling, 4 ms gain ramps, the streamed fallback, the one-player bus and clean disposal.
// The real-browser checks live in the Music tab's e2e tests (Task 3).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claim, owner, release } from "../../web/src/audio/bus.js";
import { AudioEngine, clearPeaksCache, liveContexts, RAMP_SECONDS, START_LEAD, type EngineOptions } from "../../web/src/audio/engine.js";
import type { Clip } from "../../web/src/audio/timeline.js";

type Call = [string, ...number[]];

class FakeParam {
  calls: Call[] = [];
  constructor(public value: number) {}
  cancelScheduledValues(t: number) { this.calls.push(["cancel", t]); }
  setValueAtTime(v: number, t: number) { this.calls.push(["set", v, t]); this.value = v; }
  linearRampToValueAtTime(v: number, t: number) { this.calls.push(["ramp", v, t]); this.value = v; }
}
class FakeNode {
  out: FakeNode[] = [];
  disconnected = false;
  connect(n: FakeNode) { this.out.push(n); this.disconnected = false; return n; }
  disconnect() { this.out = []; this.disconnected = true; }
}
class FakeGain extends FakeNode { gain = new FakeParam(1); }
class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  started: [number, number, number] | null = null;
  stopped = false;
  onended: (() => void) | null = null;
  start(when: number, offset: number, duration: number) { this.started = [when, offset, duration]; }
  stop() { this.stopped = true; }
}
interface FakeBuffer { duration: number; numberOfChannels: number; getChannelData(i: number): Float32Array; tag: string }
class FakeMedia {
  currentTime = 0;
  paused = true;
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
  createGain() { const g = new FakeGain(); this.gains.push(g); return g; }
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s; }
  createMediaElementSource(el: FakeMedia) { const s = new FakeElementSource(el); this.elementSources.push(s); return s; }
  // The fake "file" is its duration as text; "bad" won't decode.
  decodeAudioData(bytes: ArrayBuffer): Promise<FakeBuffer> {
    const tag = new TextDecoder().decode(bytes);
    if (tag.startsWith("bad")) return Promise.reject(new Error("EncodingError"));
    const duration = Number(tag);
    const data = new Float32Array(Math.max(1, Math.round(duration * 100))).fill(0.25);
    return Promise.resolve({ duration, numberOfChannels: 1, getChannelData: () => data, tag });
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
};
const probed: Record<string, number> = { "/m/bad.wav": 3, "/m/long.wav": 1000 };

function options(): EngineOptions {
  return {
    createContext: () => { const c = new FakeCtx(); ctxs.push(c); return c as unknown as AudioContext; },
    url: (path) => `/m/${path}`,
    fetch: (async (url: string) => ({
      ok: url in files,
      status: url in files ? 200 : 404,
      arrayBuffer: async () => new TextEncoder().encode(files[url]).buffer,
    })) as unknown as typeof fetch,
    probe: async (url) => probed[url] ?? null,
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
  clearPeaksCache();
});
afterEach(() => {
  release(owner());
});

async function ready(clips: Clip[]) {
  const engine = new AudioEngine(undefined, options());
  engine.setClips(clips);
  await Promise.all([...new Set(clips.map((c) => c.path))].map((p) => engine.load(p)));
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
    expect(el.currentTime).toBe(1);
    // It drifts 200 ms: the next tick seeks it back.
    ctx.currentTime = 10 + START_LEAD + 0.5;
    el.currentTime = 1.7;
    frame();
    expect(el.currentTime).toBeCloseTo(1.5, 9);
    // Within 50 ms: left alone.
    el.currentTime = 1.53;
    frame();
    expect(el.currentTime).toBe(1.53);
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
