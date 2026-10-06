import { describe, expect, it } from "vitest";
import { FALLBACK_MAX_BYTES, cachedWave, hasCachedWave, loadWave, normalisePeaks, rememberWave, watchPixelRatio, waveKey, type WaveDeps } from "../../web/src/peaks.js";

const CUT = { peaksUrl: "/api/videos/hero/versions/v1/peaks", mediaUrl: "/media?path=renders%2Fhero.mp4", size: 1_000_000 };

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Answers the peaks route with `peaks`, and /media with some bytes; records every URL asked for. */
function deps(peaks: () => Response, decode: WaveDeps["decode"] = async () => ({ channels: [new Float32Array([0.1, -0.4, 0.2, 0.05])], duration: 2 })) {
  const asked: string[] = [];
  const d: WaveDeps = {
    async fetch(url) {
      asked.push(url);
      return url.startsWith("/media") ? new Response(new Uint8Array([1, 2, 3])) : peaks();
    },
    decode,
  };
  return { d, asked };
}

const signal = () => new AbortController().signal;

describe("loadWave (§19.9)", () => {
  it("200 is the server's peaks", async () => {
    const { d, asked } = deps(() => json(200, { v: 1, buckets: 3, duration: 1.5, peaks: [0, 0.5, 1] }));
    const out = await loadWave(CUT, d, signal());
    expect(out.kind).toBe("wave");
    if (out.kind !== "wave") return;
    expect(Array.from(out.wave.peaks)).toEqual([0, 0.5, 1]);
    expect(out.wave.duration).toBe(1.5);
    expect(asked).toEqual([CUT.peaksUrl]);
  });

  it("202 is still being made; 204 (no audio), 404 and 422 draw nothing", async () => {
    expect((await loadWave(CUT, deps(() => json(202, { state: "computing" })).d, signal())).kind).toBe("pending");
    for (const status of [204, 404, 422]) {
      const { d, asked } = deps(() => (status === 204 ? new Response(null, { status }) : json(status, { error: "x" })));
      expect((await loadWave(CUT, d, signal())).kind).toBe("none");
      expect(asked).toEqual([CUT.peaksUrl]);
    }
  });

  it("a 200 that isn't a peaks file draws nothing", async () => {
    expect((await loadWave(CUT, deps(() => json(200, { v: 1, peaks: "no" })).d, signal())).kind).toBe("none");
  });

  it("501 falls back to decoding the cut in the browser, normalised, when it's under about 100 MB", async () => {
    const { d, asked } = deps(() => json(501, { error: "no_ffmpeg" }));
    const out = await loadWave(CUT, d, signal());
    expect(asked).toEqual([CUT.peaksUrl, CUT.mediaUrl]);
    expect(out.kind).toBe("wave");
    if (out.kind !== "wave") return;
    // Four samples, fewer than the bucket count: one bucket each, the loudest at 1.
    expect(Array.from(out.wave.peaks).map((p) => Math.round(p * 1000) / 1000)).toEqual([0.25, 1, 0.5, 0.125]);
    expect(out.wave.duration).toBe(2);
  });

  it("501 with a file of 100 MB or more, or of unknown size, draws nothing and never fetches it", async () => {
    for (const size of [FALLBACK_MAX_BYTES, FALLBACK_MAX_BYTES * 3, null]) {
      const { d, asked } = deps(() => json(501, { error: "no_ffmpeg" }));
      expect((await loadWave({ ...CUT, size }, d, signal())).kind).toBe("none");
      expect(asked).toEqual([CUT.peaksUrl]);
    }
  });

  it("501 with a file the browser can't decode (no audio track) draws nothing", async () => {
    const { d } = deps(() => json(501, { error: "no_ffmpeg" }), async () => {
      throw new DOMException("Unable to decode audio data", "EncodingError");
    });
    expect((await loadWave(CUT, d, signal())).kind).toBe("none");
    const empty = deps(() => json(501, { error: "no_ffmpeg" }), async () => ({ channels: [], duration: 0 }));
    expect((await loadWave(CUT, empty.d, signal())).kind).toBe("none");
  });

  it("a network blip is retried later, not taken as no waveform", async () => {
    const d: WaveDeps = { fetch: async () => { throw new TypeError("Failed to fetch"); }, decode: async () => ({ channels: [], duration: 0 }) };
    expect((await loadWave(CUT, d, signal())).kind).toBe("pending");
  });

  it("an aborted load (the cut changed) rejects rather than answering for the old cut", async () => {
    const ac = new AbortController();
    const d: WaveDeps = {
      fetch: async () => {
        ac.abort();
        throw new DOMException("aborted", "AbortError");
      },
      decode: async () => ({ channels: [], duration: 0 }),
    };
    await expect(loadWave(CUT, d, ac.signal)).rejects.toThrow();
  });
});

describe("the waveform cache", () => {
  it("is keyed by film, version, file and the file's revision", () => {
    const a = waveKey("hero", "v1", "renders/hero.mp4", "2026-10-06T10:00:00.000Z");
    expect(a).not.toBe(waveKey("hero", "v2", "renders/hero.mp4", "2026-10-06T10:00:00.000Z"));
    expect(a).not.toBe(waveKey("hero", "v1", "renders/hero.mp4", "2026-10-06T11:00:00.000Z"));
    expect(a).not.toBe(waveKey("other", "v1", "renders/hero.mp4", "2026-10-06T10:00:00.000Z"));
    const wave = { peaks: new Float32Array([1]), duration: 1 };
    expect(hasCachedWave(a)).toBe(false);
    rememberWave(a, wave);
    expect(cachedWave(a)).toBe(wave);
    // "No waveform" is remembered too, so a cut with no audio isn't asked about again.
    const b = waveKey("hero", "v3", "renders/hero.mp4", undefined);
    rememberWave(b, null);
    expect(hasCachedWave(b)).toBe(true);
    expect(cachedWave(b)).toBeNull();
  });

  it("normalisePeaks scales the loudest to 1, leaving silence at 0", () => {
    expect(Array.from(normalisePeaks(new Float32Array([0.2, 0.4])))).toEqual([0.5, 1]);
    expect(Array.from(normalisePeaks(new Float32Array([0, 0])))).toEqual([0, 0]);
  });
});

describe("watchPixelRatio (fix round 2)", () => {
  /** A window whose devicePixelRatio the test sets, with matchMedia lists it can fire. */
  function fakeWindow(dpr: number) {
    const lists: { query: string; listeners: Set<() => void> }[] = [];
    const win = {
      devicePixelRatio: dpr,
      matchMedia(query: string) {
        const entry = { query, listeners: new Set<() => void>() };
        lists.push(entry);
        return {
          addEventListener: (_: "change", fn: () => void) => entry.listeners.add(fn),
          removeEventListener: (_: "change", fn: () => void) => entry.listeners.delete(fn),
        };
      },
    };
    const live = () => lists.filter((l) => l.listeners.size > 0);
    return { win, live, fire: () => [...live()].forEach((l) => [...l.listeners].forEach((fn) => fn())) };
  }

  it("calls back when the pixel ratio changes, and listens again at the new ratio", () => {
    const { win, live, fire } = fakeWindow(1);
    const seen: number[] = [];
    const stop = watchPixelRatio(win, (dpr) => seen.push(dpr));
    expect(live().map((l) => l.query)).toEqual(["(resolution: 1dppx)"]);
    win.devicePixelRatio = 2;
    fire();
    expect(seen).toEqual([2]);
    expect(live().map((l) => l.query)).toEqual(["(resolution: 2dppx)"]);
    win.devicePixelRatio = 1.5;
    fire();
    expect(seen).toEqual([2, 1.5]);
    expect(live().map((l) => l.query)).toEqual(["(resolution: 1.5dppx)"]);
    stop();
    expect(live()).toEqual([]);
  });
});
