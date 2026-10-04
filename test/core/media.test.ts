import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PROBE_TIMEOUT_MS, probe as mediaProbe, proxyNeed, type Probe } from "../../src/core/media.js";

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
});
