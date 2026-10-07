import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { GIVE_UP_GRACE_MS, PROBE_TIMEOUT_MS, giveUpAfter, parseVideoProbe, probe as mediaProbe, probeVideo, proxyNeed, type Probe } from "../../src/core/media.js";

const probe = (p: Partial<Probe>): Probe => ({ duration: 10, fps: 25, codec: "h264", width: 1920, height: 1080, pixFmt: "yuv420p", ...p });

describe("proxyNeed (§19.5)", () => {
  it("offers one for a 4K h264 file", () => {
    const need = proxyNeed(probe({ width: 3840, height: 2160 }), 400e6);
    expect(need?.reason).toContain("4K");
    expect(need?.reason).toBe("It's a 4K file, which browsers struggle with");
  });

  it("offers one for a tall 4K file too (either edge)", () => {
    expect(proxyNeed(probe({ width: 2160, height: 3840 }), 400e6)?.reason).toContain("4K");
  });

  it("offers nothing for 1080p h264 at 200 MB", () => {
    expect(proxyNeed(probe({}), 200e6)).toBeNull();
  });

  it("offers nothing at exactly 3000 px or 1.5 GB", () => {
    expect(proxyNeed(probe({ width: 3000, height: 3000 }), 1.5e9)).toBeNull();
  });

  it("names a codec browsers can't play in plain words", () => {
    expect(proxyNeed(probe({ codec: "prores" }), 200e6)?.reason).toBe("It's a ProRes file, which browsers struggle with");
    expect(proxyNeed(probe({ codec: "dnxhd" }), 200e6)?.reason).toBe("It's a DNx file, which browsers struggle with");
    expect(proxyNeed(probe({ codec: "hevc" }), 200e6)?.reason).toBe("It's an HEVC file, which browsers struggle with");
    expect(proxyNeed(probe({ codec: "hevc", pixFmt: "yuv420p10le" }), 200e6)?.reason).toBe("It's an HEVC 10-bit file, which browsers struggle with");
  });

  it("leaves h264, vp9 and av1 alone", () => {
    for (const codec of ["h264", "vp9", "av1"]) expect(proxyNeed(probe({ codec }), 200e6)).toBeNull();
  });

  it("offers one for a file over 1.5 GB, giving its size", () => {
    expect(proxyNeed(probe({}), 2.04e9)?.reason).toBe("It's a large file (2.0 GB), which browsers struggle with");
  });

  it("combines the reasons", () => {
    const need = proxyNeed(probe({ codec: "prores", width: 3840, height: 2160 }), 2.3e9);
    expect(need?.reason).toBe("It's a 4K ProRes file (2.3 GB), which browsers struggle with");
    expect(need?.reason).toMatch(/4K ProRes .*\(2\.3 GB\)/);
  });

  it("offers nothing when nothing is known (no ffprobe)", () => {
    expect(proxyNeed({ duration: null, fps: null, codec: null, width: null, height: null, pixFmt: null }, null)).toBeNull();
  });
});

describe("probe: a hung ffprobe never holds a slot for good (Minor 8)", () => {
  /** Puts a fake `ffprobe` first on PATH that answers -version, then hangs on any real probe. */
  async function withHangingFfprobe(fn: () => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "rushes-ffprobe-"));
    const bin = join(dir, "ffprobe");
    await writeFile(bin, '#!/bin/sh\nif [ "$1" = "-version" ]; then echo "ffprobe version 8.1"; exit 0; fi\nexec sleep 30\n', "utf8");
    await chmod(bin, 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${dir}${delimiter}${path ?? ""}`;
    try {
      await fn();
    } finally {
      process.env.PATH = path;
      await rm(dir, { recursive: true, force: true });
    }
  }

  it.runIf(process.platform !== "win32")("gives up after its timeout and reports nothing known", async () => {
    await withHangingFfprobe(async () => {
      const started = Date.now();
      expect(await mediaProbe("/nowhere.mov", { timeout: 300 })).toEqual({ duration: null, fps: null, codec: null, width: null, height: null, pixFmt: null });
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  }, 10_000);

  it.runIf(process.platform !== "win32")("stops when its signal aborts", async () => {
    await withHangingFfprobe(async () => {
      const controller = new AbortController();
      const p = mediaProbe("/nowhere.mov", { signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      expect((await p).duration).toBeNull();
    });
  }, 10_000);

  it("waits 20 s by default", () => {
    expect(PROBE_TIMEOUT_MS).toBe(20_000);
  });

  // Review I2: probeVideo gives up the same way, so a stalled drive never holds a request.
  it.runIf(process.platform !== "win32")("probeVideo gives up after its timeout and says so", async () => {
    await withHangingFfprobe(async () => {
      const started = Date.now();
      expect(await probeVideo("/nowhere.mp4", { timeout: 300 })).toEqual({ ok: false, code: "unreadable", reason: "ffprobe took too long" });
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  }, 10_000);

  it.runIf(process.platform !== "win32")("probeVideo stops when its signal aborts", async () => {
    await withHangingFfprobe(async () => {
      const controller = new AbortController();
      const p = probeVideo("/nowhere.mp4", { signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      expect(await p).toEqual({ ok: false, code: "unreadable", reason: "ffprobe was stopped" });
      expect(await probeVideo("/nowhere.mp4", { signal: controller.signal })).toEqual({ ok: false, code: "unreadable", reason: "ffprobe was stopped" });
    });
  }, 10_000);
});

describe("giveUpAfter: one give-up rule for every ffprobe (review I2)", () => {
  const never = new Promise<string>(() => undefined);

  it("answers about a second after the timeout even when the work never settles (a child that outlives SIGKILL)", async () => {
    const started = Date.now();
    expect(await giveUpAfter(never, { timeout: 50, gaveUp: (why) => why })).toBe("timeout");
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(GIVE_UP_GRACE_MS + 40);
    expect(took).toBeLessThan(GIVE_UP_GRACE_MS + 1_000);
  });

  it("answers at once when the signal aborts, or has already", async () => {
    const c = new AbortController();
    const p = giveUpAfter(never, { timeout: 60_000, signal: c.signal, gaveUp: (why) => why });
    setTimeout(() => c.abort(), 20);
    expect(await p).toBe("aborted");
    expect(await giveUpAfter(never, { timeout: 60_000, signal: c.signal, gaveUp: (why) => why })).toBe("aborted");
  });

  it("passes the work's own answer straight through", async () => {
    expect(await giveUpAfter(Promise.resolve("done"), { timeout: 50, gaveUp: (why) => why })).toBe("done");
  });
});

describe("probe: only local files (the scan runs it on every media file it finds)", () => {
  it.runIf(process.platform !== "win32")("restricts ffprobe's protocols to file, ahead of the file name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rushes-ffprobe-"));
    const log = join(dir, "args.txt");
    const bin = join(dir, "ffprobe");
    await writeFile(bin, `#!/bin/sh\nif [ "$1" = "-version" ]; then echo "ffprobe version 8.1"; exit 0; fi\nprintf '%s\\n' "$@" > "${log}"\necho '{}'\n`, "utf8");
    await chmod(bin, 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${dir}${delimiter}${path ?? ""}`;
    try {
      await mediaProbe("/some/where/a.wav");
      const args = (await readFile(log, "utf8")).trim().split("\n");
      const at = args.indexOf("-protocol_whitelist");
      expect(at).toBeGreaterThan(-1);
      expect(args[at + 1]).toBe("file");
      expect(at).toBeLessThan(args.indexOf("/some/where/a.wav"));
    } finally {
      process.env.PATH = path;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseVideoProbe (§21.3)", () => {
  const stream = (over: Record<string, unknown> = {}) => ({ codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30/1", ...over });
  const json = (streams: unknown[], format: Record<string, unknown> = { duration: "8.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" }) => ({ streams, format });

  it("reads the size, length and rate", () => {
    expect(parseVideoProbe(json([stream()]))).toEqual({ ok: true, width: 1920, height: 1080, duration: 8, fps: 30 });
  });
  it("stands a quarter-turned phone video upright, from side data or the older rotate tag", () => {
    expect(parseVideoProbe(json([stream({ side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] })]))).toMatchObject({ width: 1080, height: 1920 });
    expect(parseVideoProbe(json([stream({ tags: { rotate: "270" } })]))).toMatchObject({ width: 1080, height: 1920 });
    expect(parseVideoProbe(json([stream({ side_data_list: [{ rotation: 180 }] })]))).toMatchObject({ width: 1920, height: 1080 });
  });
  it("widens non-square pixels to the shape on screen", () => {
    expect(parseVideoProbe(json([stream({ width: 1440, height: 1080, sample_aspect_ratio: "4:3" })]))).toMatchObject({ width: 1920, height: 1080 });
    expect(parseVideoProbe(json([stream({ sample_aspect_ratio: "0:1" })]))).toMatchObject({ width: 1920 });
  });
  it("skips cover art, and refuses audio, stills and a stream with no size", () => {
    expect(parseVideoProbe(json([{ codec_type: "audio" }]))).toEqual({ ok: false, code: "not_video", reason: "it has no video stream" });
    expect(parseVideoProbe(json([{ codec_type: "audio" }, stream({ disposition: { attached_pic: 1 } })]))).toMatchObject({ ok: false, code: "not_video" });
    expect(parseVideoProbe(json([stream()], { format_name: "png_pipe" }))).toEqual({ ok: false, code: "not_video", reason: "it's a still image" });
    expect(parseVideoProbe(json([stream({ width: 0 })]))).toMatchObject({ ok: false, code: "unreadable" });
  });
});

const hasFf = ["ffmpeg", "ffprobe"].every((b) => spawnSync(b, ["-version"], { stdio: "ignore" }).status === 0);

describe.skipIf(!hasFf)("probeVideo with the real ffprobe", () => {
  const make = (dir: string, name: string, args: string[]) => {
    const out = join(dir, name);
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args, out]);
    if (r.status !== 0) throw new Error(String(r.stderr));
    return out;
  };
  it("reads a 9:16 render and an anamorphic one, and refuses a still and a file that isn't video", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rushes probe "));
    try {
      const tall = make(dir, "tall.mp4", ["-f", "lavfi", "-i", "testsrc=size=180x320:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
      expect(await probeVideo(tall)).toMatchObject({ ok: true, width: 180, height: 320, fps: 30 });
      const ana = make(dir, "ana.mp4", ["-f", "lavfi", "-i", "testsrc=size=240x240:rate=30:duration=1", "-vf", "setsar=4/3", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
      expect(await probeVideo(ana)).toMatchObject({ ok: true, width: 320, height: 240 });
      // Review M5: a phone held upright. The stored picture is 320×180; the rotation tag turns it.
      const wide = make(dir, "wide.mp4", ["-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
      expect(await probeVideo(wide)).toMatchObject({ ok: true, width: 320, height: 180 });
      const turned = make(dir, "turned.mp4", ["-display_rotation", "90", "-i", wide, "-c", "copy"]);
      expect(await probeVideo(turned)).toMatchObject({ ok: true, width: 180, height: 320 });
      const still = make(dir, "still.png", ["-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", "1"]);
      expect(await probeVideo(still)).toMatchObject({ ok: false, code: "not_video" });
      const junk = join(dir, "junk.mp4");
      await writeFile(junk, "not a video at all");
      const r = await probeVideo(junk);
      expect(r).toMatchObject({ ok: false, code: "unreadable" });
      expect(r.ok ? "" : r.reason).not.toContain(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
