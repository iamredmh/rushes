import { describe, expect, it } from "vitest";
import { makeWav } from "../../e2e/fixtures/wav.js";

describe("makeWav (e2e fixture)", () => {
  it("writes a mono 16-bit PCM header at 22050 Hz", () => {
    const wav = makeWav({ seconds: 1, freq: 440 });
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.readUInt32LE(16)).toBe(16); // fmt chunk size
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(22050); // sample rate
    expect(wav.readUInt32LE(28)).toBe(22050 * 2); // byte rate
    expect(wav.readUInt16LE(32)).toBe(2); // block align
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(22050 * 2);
    expect(wav.length).toBe(44 + 22050 * 2);
  });

  it("takes another sample rate and length", () => {
    const wav = makeWav({ seconds: 0.5, freq: 220, sampleRate: 8000 });
    expect(wav.readUInt32LE(24)).toBe(8000);
    expect(wav.readUInt32LE(40)).toBe(4000 * 2);
  });

  it("is deterministic and holds the tone", () => {
    const a = makeWav({ seconds: 0.25, freq: 440 });
    const b = makeWav({ seconds: 0.25, freq: 440 });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(makeWav({ seconds: 0.25, freq: 660 }))).toBe(false);
    expect(a.readInt16LE(44)).toBe(0); // sin(0)
    let peak = 0;
    for (let i = 44; i < a.length; i += 2) peak = Math.max(peak, Math.abs(a.readInt16LE(i)));
    expect(peak).toBeGreaterThan(16000); // default amplitude 0.5
    expect(peak).toBeLessThanOrEqual(16384);
  });
});
