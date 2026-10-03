import { describe, expect, it } from "vitest";
import {
  activeVariantGain, assetRev, type Clip, computePeaks, HAVE_FUTURE_DATA, laneGains, MAX_DECODE_BYTES,
  MAX_DECODED_SECONDS, mediaKey, mixPeaks, needsVideoSync, peakBuckets, resolveDurations, SEEK_COOLDOWN_SECONDS,
  setStreamThreshold, shouldStream, startPlan, streamStep, timelineLength, tooLargeToDecode, variantGains,
} from "../../web/src/audio/timeline.js";

const clip = (id: string, offset: number, duration: number, lane = "music"): Clip => ({ id, lane, path: `${id}.wav`, offset, duration });

describe("laneGains", () => {
  it("plays every lane when nothing is muted or soloed", () => {
    expect(laneGains([{ id: "vo" }, { id: "music" }, { id: "sfx" }])).toEqual({ vo: 1, music: 1, sfx: 1 });
  });
  it("silences a muted lane", () => {
    expect(laneGains([{ id: "vo" }, { id: "music", muted: true }, { id: "sfx" }])).toEqual({ vo: 1, music: 0, sfx: 1 });
  });
  it("plays only the soloed lanes", () => {
    expect(laneGains([{ id: "vo", solo: true }, { id: "music" }, { id: "sfx", solo: true }])).toEqual({ vo: 1, music: 0, sfx: 1 });
  });
  it("lets solo win over mute, on the same lane and across lanes", () => {
    expect(laneGains([{ id: "vo", solo: true, muted: true }, { id: "music", muted: true }, { id: "sfx" }]))
      .toEqual({ vo: 1, music: 0, sfx: 0 });
  });
  it("handles no lanes", () => {
    expect(laneGains([])).toEqual({});
  });
});

describe("variant gains", () => {
  it("is 1 for the selected variant and 0 for the rest", () => {
    expect(activeVariantGain("b", "b")).toBe(1);
    expect(activeVariantGain("b", "a")).toBe(0);
  });
  it("selects one clip per lane, and plays every clip of a lane with no selection", () => {
    const clips = [clip("a", 0, 4), clip("b", 0, 4), clip("s1", 0, 2, "vo"), clip("s2", 2, 2, "vo")];
    expect(variantGains(clips, { music: "b" })).toEqual({ a: 0, b: 1, s1: 1, s2: 1 });
    expect(variantGains(clips, {})).toEqual({ a: 1, b: 1, s1: 1, s2: 1 });
  });
});

describe("startPlan", () => {
  it("starts a clip under the playhead now, at the matching point in its buffer", () => {
    expect(startPlan([clip("a", 0, 4)], 1.5)).toEqual([{ id: "a", when: 0, offset: 1.5 }]);
  });
  it("starts a later clip after a delay, from its beginning", () => {
    expect(startPlan([clip("c", 3, 1)], 1)).toEqual([{ id: "c", when: 2, offset: 0 }]);
  });
  it("skips clips that already ended, and handles a mix", () => {
    const plan = startPlan([clip("old", 0, 1), clip("a", 0, 4), clip("b", 1, 2), clip("c", 5, 1)], 2);
    expect(plan).toEqual([
      { id: "a", when: 0, offset: 2 },
      { id: "b", when: 0, offset: 1 },
      { id: "c", when: 3, offset: 0 },
    ]);
  });
  it("treats a clip's end as exclusive and its start as inclusive", () => {
    expect(startPlan([clip("a", 0, 2)], 2)).toEqual([]);
    expect(startPlan([clip("b", 2, 1)], 2)).toEqual([{ id: "b", when: 0, offset: 0 }]);
  });
  it("skips clips with no length", () => {
    expect(startPlan([clip("z", 0, 0)], 0)).toEqual([]);
  });
});

describe("needsVideoSync", () => {
  it("leaves the picture alone within one frame", () => {
    expect(needsVideoSync(2, 2, 30)).toBe(false);
    expect(needsVideoSync(2 + 1 / 30, 2, 30)).toBe(false);
    expect(needsVideoSync(2 - 1 / 30, 2, 30)).toBe(false);
  });
  it("seeks the picture once it's more than a frame off, either way", () => {
    expect(needsVideoSync(2 + 1 / 30 + 0.001, 2, 30)).toBe(true);
    expect(needsVideoSync(2 - 1 / 30 - 0.001, 2, 30)).toBe(true);
    expect(needsVideoSync(1.05, 1, 25)).toBe(true);
    expect(needsVideoSync(1.03, 1, 25)).toBe(false);
  });
});

describe("peaks", () => {
  it("takes the largest absolute sample per bucket", () => {
    const signal = new Float32Array([0.1, -0.5, 0.2, 0.3, -0.9, 0.4, 0, 0]);
    const peaks = Array.from(computePeaks(signal, 4));
    [0.5, 0.3, 0.9, 0].forEach((want, i) => expect(peaks[i]).toBeCloseTo(want, 6));
  });
  it("finds the amplitude of a known sine", () => {
    const n = 22050;
    const sine = new Float32Array(n);
    for (let i = 0; i < n; i++) sine[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 22050);
    const peaks = computePeaks(sine, 10);
    expect(peaks).toHaveLength(10);
    for (const p of peaks) expect(p).toBeCloseTo(0.5, 2);
  });
  it("never leaves a bucket empty when there are fewer samples than buckets", () => {
    expect(Array.from(computePeaks(new Float32Array([0.25, -0.75]), 4))).toEqual([0.25, 0.25, 0.75, 0.75]);
  });
  it("handles empty input", () => {
    expect(Array.from(computePeaks(new Float32Array(0), 3))).toEqual([0, 0, 0]);
    expect(computePeaks(new Float32Array([1]), 0)).toHaveLength(0);
  });
  it("takes the max across channels", () => {
    const l = new Float32Array([0.1, 0.9, 0, 0]);
    const r = new Float32Array([-0.5, 0, 0, -0.2]);
    const peaks = mixPeaks([l, r], 2);
    expect(peaks).toHaveLength(2);
    expect(peaks[0]).toBeCloseTo(0.9, 6);
    expect(peaks[1]).toBeCloseTo(0.2, 6);
    expect(mixPeaks([], 2)).toHaveLength(2);
  });
  it("sizes peaks to the file, at least one bucket and capped", () => {
    expect(peakBuckets(0)).toBe(1);
    expect(peakBuckets(2)).toBe(100);
    expect(peakBuckets(60 * 60 * 10)).toBeLessThanOrEqual(60_000);
  });
});

describe("streaming fallback", () => {
  it("decodes files up to 15 minutes and streams longer or undecodable ones", () => {
    expect(MAX_DECODED_SECONDS).toBe(15 * 60);
    expect(shouldStream(30, true)).toBe(false);
    expect(shouldStream(15 * 60, true)).toBe(false);
    expect(shouldStream(15 * 60 + 1, true)).toBe(true);
    expect(shouldStream(null, false)).toBe(true);
    expect(shouldStream(10, false)).toBe(true);
    expect(shouldStream(null, true)).toBe(false);
  });
  it("lets a test build lower the threshold, and restores it", () => {
    setStreamThreshold(1);
    try {
      expect(shouldStream(3, true)).toBe(true);
      expect(shouldStream(0.5, true)).toBe(false);
    } finally {
      setStreamThreshold(null);
    }
    expect(shouldStream(3, true)).toBe(false);
  });
  it("starts, corrects drift past 50 ms, and stops a streamed element", () => {
    // In range and paused: start it.
    expect(streamStep(1, 10, { time: 0, paused: true })).toBe("play");
    // Playing and within 50 ms: leave it.
    expect(streamStep(1, 10, { time: 1.04, paused: false })).toBe("none");
    expect(streamStep(1, 10, { time: 0.951, paused: false })).toBe("none");
    // Playing and off by more than 50 ms: seek.
    expect(streamStep(1, 10, { time: 1.06, paused: false })).toBe("seek");
    expect(streamStep(1, 10, { time: 0.9, paused: false })).toBe("seek");
    // Out of the clip: pause it if it's playing, otherwise nothing.
    expect(streamStep(-0.5, 10, { time: 0, paused: false })).toBe("pause");
    expect(streamStep(10, 10, { time: 9.99, paused: false })).toBe("pause");
    expect(streamStep(-0.5, 10, { time: 0, paused: true })).toBe("none");
  });
  it("never re-seeks an element that's still seeking or buffering", () => {
    expect(streamStep(1, 10, { time: 3, paused: false, seeking: true, readyState: 4 })).toBe("none");
    expect(streamStep(1, 10, { time: 3, paused: false, seeking: false, readyState: 2 })).toBe("none");
    expect(streamStep(1, 10, { time: 3, paused: false, seeking: false, readyState: HAVE_FUTURE_DATA })).toBe("seek");
    // Still stops one that's left its clip, seeking or not.
    expect(streamStep(11, 10, { time: 3, paused: false, seeking: true, readyState: 1 })).toBe("pause");
  });
  it("waits out a cooldown after a seek before seeking again", () => {
    expect(SEEK_COOLDOWN_SECONDS).toBeGreaterThanOrEqual(0.25);
    const drifted = { time: 3, paused: false, seeking: false, readyState: 4 };
    expect(streamStep(1, 10, drifted, 0.1)).toBe("none");
    expect(streamStep(1, 10, drifted, SEEK_COOLDOWN_SECONDS - 0.001)).toBe("none");
    expect(streamStep(1, 10, drifted, SEEK_COOLDOWN_SECONDS)).toBe("seek");
    expect(streamStep(1, 10, drifted)).toBe("seek");
  });
  it("streams a file too big to have been under 15 minutes, before downloading it", () => {
    expect(tooLargeToDecode(null)).toBe(false);
    expect(tooLargeToDecode(50 * 1024 * 1024)).toBe(false);
    expect(tooLargeToDecode(MAX_DECODE_BYTES)).toBe(false);
    expect(tooLargeToDecode(MAX_DECODE_BYTES + 1)).toBe(true);
  });
});

describe("revisions", () => {
  it("keys a file on its path and revision", () => {
    expect(mediaKey({ path: "music/a.wav" })).toBe("music/a.wav");
    expect(mediaKey({ path: "music/a.wav", rev: "2026-10-03T10:00:00Z" })).toBe("music/a.wav#2026-10-03T10:00:00Z");
  });
  it("takes an asset's modified time, else its size", () => {
    expect(assetRev({ modified: "2026-10-03T10:00:00Z", size: 10 })).toBe("2026-10-03T10:00:00Z");
    expect(assetRev({ modified: null, size: 1234 })).toBe("1234");
    expect(assetRev({ modified: null, size: null })).toBeUndefined();
  });
  it("fills durations by revision", () => {
    const c = { ...clip("a", 0, 0), rev: "r2" };
    expect(resolveDurations([c], { "a.wav#r1": 3, "a.wav#r2": 5 })[0].duration).toBe(5);
  });
});

describe("durations", () => {
  it("fills a clip with no known length from the decoded file", () => {
    const clips = [clip("a", 0, 0), clip("b", 1, 3), { ...clip("c", 2, Number.NaN) }];
    expect(resolveDurations(clips, { "a.wav": 5, "c.wav": 2 }).map((c) => c.duration)).toEqual([5, 3, 2]);
    expect(resolveDurations([clip("d", 0, 0)], {}).map((c) => c.duration)).toEqual([0]);
  });
  it("uses the cut's length when there is one, else the longest audio", () => {
    expect(timelineLength(12.5, [clip("a", 0, 30)])).toBe(12.5);
    expect(timelineLength(null, [clip("a", 0, 4), clip("b", 3, 5)])).toBe(8);
    expect(timelineLength(0, [clip("a", 1, 4)])).toBe(5);
    expect(timelineLength(null, [])).toBe(0);
  });
});
