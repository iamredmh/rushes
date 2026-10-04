import { describe, expect, it } from "vitest";
import { proxyNeed, type Probe } from "../../src/core/media.js";

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
