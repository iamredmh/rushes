import { describe, expect, it } from "vitest";
import { PeakReducer, peaksArgs } from "../../src/server/peaks.js";

/** Samples as ffmpeg's `-f f32le` writes them. */
function f32(samples: number[]): Buffer {
  const b = Buffer.alloc(samples.length * 4);
  samples.forEach((s, i) => b.writeFloatLE(s, i * 4));
  return b;
}

describe("PeakReducer (§19.9): streaming f32le into peak buckets", () => {
  it("keeps each bucket's largest absolute amplitude, normalised so the loudest is 1", () => {
    const r = new PeakReducer(4, 8);
    // Four buckets of two samples each: peaks 0.2, 0.5 (a negative sample counts by its size), 0.1, 0.25.
    r.push(f32([0.1, 0.2, -0.5, 0.3, 0.05, 0.1, 0.25, -0.2]));
    const out = r.finish();
    expect(out.samples).toBe(8);
    expect(out.duration).toBe(1);
    expect(out.peaks).toEqual([0.4, 1, 0.2, 0.5]);
  });

  it("rounds to 3 decimals and never goes outside 0..1, even for samples past full scale", () => {
    const r = new PeakReducer(3, 3);
    r.push(f32([0.3333333, -2, 1.23456]));
    const { peaks } = r.finish();
    expect(peaks).toEqual([0.167, 1, 0.617]);
    for (const p of peaks) expect(p >= 0 && p <= 1).toBe(true);
  });

  it("copes with a float split across two chunks", () => {
    const whole = f32([0.5, -1, 0.25, 0.125]);
    const r = new PeakReducer(4, 4);
    r.push(whole.subarray(0, 3));
    r.push(whole.subarray(3, 9));
    r.push(whole.subarray(9));
    expect(r.finish().peaks).toEqual([0.5, 1, 0.25, 0.125]);
  });

  it("never holds more than twice the bucket count, however long the stream", () => {
    const r = new PeakReducer(10, 1000);
    // 100 000 samples, one loud one at 3/4 of the way in.
    const chunk = new Array(1000).fill(0.01);
    for (let i = 0; i < 100; i++) r.push(f32(i === 75 ? [...chunk.slice(0, 500), 0.9, ...chunk.slice(501)] : chunk));
    expect(r.held()).toBeLessThanOrEqual(20);
    const out = r.finish();
    expect(out.peaks).toHaveLength(10);
    expect(out.duration).toBe(100);
    // The loud sample lands in the bucket for 75.5 s of 100 s: the eighth.
    expect(out.peaks.indexOf(1)).toBe(7);
    expect(out.peaks.filter((p) => p === 1)).toHaveLength(1);
    expect(Math.max(...out.peaks.filter((p) => p !== 1))).toBeCloseTo(0.011, 3);
  });

  it("a short file with fewer samples than buckets gets one bucket per sample", () => {
    const r = new PeakReducer(2000, 8000);
    r.push(f32([0.5, -0.25, 1]));
    const out = r.finish();
    expect(out.peaks).toEqual([0.5, 0.25, 1]);
    expect(out.samples).toBe(3);
  });

  it("silence is all zeros, not a division by zero", () => {
    const r = new PeakReducer(4, 8);
    r.push(f32(new Array(16).fill(0)));
    expect(r.finish().peaks).toEqual([0, 0, 0, 0]);
  });

  it("no samples at all is an empty result", () => {
    const r = new PeakReducer();
    r.push(Buffer.alloc(2));
    expect(r.finish()).toEqual({ peaks: [], samples: 0, duration: 0 });
  });

  it("a NaN or infinite sample counts as silence", () => {
    const r = new PeakReducer(3, 3);
    r.push(f32([NaN, Infinity, 0.5]));
    expect(r.finish().peaks).toEqual([0, 0, 1]);
  });
});

describe("peaksArgs", () => {
  it("reads only local files in ordinary containers, decodes the first audio stream from 0:00, mono at 8 kHz, as raw floats on stdout", () => {
    expect(peaksArgs("/films/a b.mov")).toEqual([
      "-hide_banner", "-nostdin", "-v", "error",
      // No network, and no playlists or concat lists that would open other files (fix round 3, M8).
      "-protocol_whitelist", "file,pipe",
      "-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts,mxf,wav,w64,aiff,mp3,aac,flac,ogg,caf,asf,mpeg,flv,dv",
      "-i", "/films/a b.mov",
      // The first audio stream, if there is one (M7); padded with silence from 0:00 when it starts late (I1).
      "-map", "0:a:0?", "-vn", "-sn", "-dn",
      "-af", "aresample=async=1:first_pts=0",
      "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1",
    ]);
  });
});
