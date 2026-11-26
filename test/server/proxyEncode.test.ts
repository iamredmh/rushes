// §36.8: the encode check. Each preset, run through the real ffmpeg on a high-motion clip, must hold its peak: the most
// bits in any 1 s window of video packets is within 15% of the preset's cap. Also the sizes: short edge, never upscaled.
// Skipped without ffmpeg and ffprobe.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { PRESETS, PROXY_PRESETS } from "../../src/core/proxyPresets.js";
import { defaultFfmpeg, encodeArgs, parseFfmpegVersion } from "../../src/server/proxy.js";

function has(bin: string): boolean {
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const FFMPEG = has("ffmpeg") && has("ffprobe");

/** Video packets' times and sizes, by ffprobe. */
function packets(file: string): { t: number; bytes: number }[] {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,size", "-of", "json", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return (JSON.parse(out).packets as { pts_time?: string; size: string }[])
    .filter((p) => p.pts_time !== undefined && p.pts_time !== "N/A")
    .map((p) => ({ t: Number(p.pts_time), bytes: Number(p.size) }))
    .sort((a, b) => a.t - b.t);
}

/** Average and the 1 s peak, in Mbit/s: the most bits in any window of 1 s, sliding packet by packet. */
export function rates(ps: { t: number; bytes: number }[]): { avg: number; peak: number } {
  const span = ps[ps.length - 1].t - ps[0].t;
  const total = ps.reduce((n, p) => n + p.bytes, 0) * 8;
  let peak = 0;
  let acc = 0;
  let j = 0;
  for (let i = 0; i < ps.length; i++) {
    acc += ps[i].bytes;
    while (ps[i].t - ps[j].t >= 1 - 1e-9) acc -= ps[j++].bytes;
    if (ps[i].t - ps[0].t >= 0.99) peak = Math.max(peak, acc * 8);
  }
  return { avg: total / span / 1e6, peak: peak / 1e6 };
}

function size(file: string): { width: number; height: number } {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file], { encoding: "utf8" });
  const s = JSON.parse(out).streams[0];
  return { width: s.width, height: s.height };
}

function lavfi(out: string, w: number, h: number, seconds: number, noise: boolean): void {
  const src = `testsrc2=size=${w}x${h}:rate=30${noise ? ",noise=alls=25:allf=t+u" : ""}`;
  execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", src, "-f", "lavfi", "-i", "sine=f=440:r=48000", "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out]);
}

describe.skipIf(!FFMPEG)("§36.8 encode check (real ffmpeg)", () => {
  let dir = "";
  let version: ReturnType<typeof parseFfmpegVersion> = null;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "rushes-proxy-encode-"));
    // 5 s of 1080p: a moving test pattern under full-frame noise that changes every frame -- the hardest picture to hold.
    lavfi(join(dir, "motion.mp4"), 1920, 1080, 5, true);
    lavfi(join(dir, "tall.mp4"), 1080, 1920, 1, false);
    lavfi(join(dir, "square.mp4"), 1200, 1200, 1, false);
    lavfi(join(dir, "small.mp4"), 640, 360, 1, false);
    version = parseFfmpegVersion(execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }));
  }, 120_000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  for (const preset of PROXY_PRESETS) {
    it(`${PRESETS[preset].label} holds its ${PRESETS[preset].peakKbps / 1000} Mbps peak within 15% over 1 s windows`, async () => {
      const out = join(dir, `motion_${preset}.mp4`);
      const r = await defaultFfmpeg(encodeArgs(join(dir, "motion.mp4"), out, version, preset), { onStdout: () => undefined });
      expect(r.code, r.stderr).toBe(0);
      const { avg, peak } = rates(packets(out));
      const cap = PRESETS[preset].peakKbps / 1000;
      console.log(`§36.8 ${PRESETS[preset].label}: avg ${avg.toFixed(2)} Mbps, peak ${peak.toFixed(2)} Mbps (cap ${cap})`);
      expect(peak).toBeLessThanOrEqual(cap * 1.15);
      expect(avg).toBeLessThanOrEqual((PRESETS[preset].avgKbps / 1000) * 1.15);
      expect(size(out)).toEqual(PRESETS[preset].shortEdge === 1080 ? { width: 1920, height: 1080 } : { width: 1280, height: 720 });
    }, 120_000);
  }

  it("sizes portrait and square by the short edge, and never upscales a smaller source", async () => {
    const run = async (src: string, preset: (typeof PROXY_PRESETS)[number]) => {
      const out = join(dir, `${src}_${preset}.mp4`);
      const r = await defaultFfmpeg(encodeArgs(join(dir, `${src}.mp4`), out, version, preset), { onStdout: () => undefined });
      expect(r.code, r.stderr).toBe(0);
      return size(out);
    };
    expect(await run("tall", "720l")).toEqual({ width: 720, height: 1280 });
    expect(await run("tall", "1080l")).toEqual({ width: 1080, height: 1920 });
    expect(await run("square", "1080h")).toEqual({ width: 1080, height: 1080 });
    expect(await run("small", "1080h")).toEqual({ width: 640, height: 360 });
    expect(await run("small", "720l")).toEqual({ width: 640, height: 360 });
  }, 120_000);
});
