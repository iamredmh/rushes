import { describe, expect, it } from "vitest";
import { BALANCE, balance, balanceSummary, effectHits, parseFrames, spokenLines, toLevel, trimmed, type Frame, type Reading } from "../../src/core/balance.js";

// A reading built from stretches: [from s, to s, momentary LUFS, short-term LUFS], silence (-120) elsewhere, 0.1 s frames.
function reading(length: number, parts: [number, number, number, number?][], integrated: number | null): Reading {
  const frames: Frame[] = [];
  for (let i = 1; i <= Math.round(length * 10); i++) {
    const t = Math.round(i) / 10;
    const part = parts.find(([a, b]) => t >= a - 1e-9 && t <= b + 1e-9);
    frames.push({ t, m: part ? part[2] : -120, s: part ? (part[3] ?? part[2]) : -120 });
  }
  return { integrated, frames };
}

describe("spokenLines (§29)", () => {
  it("joins a short pause, splits at a longer one, and drops a blip", () => {
    const v = reading(10, [[1, 2, -20], [2.3, 3, -20], [5, 6, -20], [8, 8.1, -20]], -20);
    const lines = spokenLines(v);
    expect(lines.map((l) => [l.start, l.end])).toEqual([[1, 3], [5, 6]]);
  });
  it("is empty for a silent voice", () => {
    expect(spokenLines(reading(5, [], null))).toEqual([]);
  });
});

describe("effectHits (§29)", () => {
  it("finds each hit and its loudest moment, ignoring what is 30 dB under the loudest", () => {
    const s = reading(10, [[1, 1.2, -30], [4, 4.1, -25], [4.2, 4.2, -22], [7, 7.1, -70]], -35);
    const hits = effectHits(s);
    expect(hits.map((h) => [h.t, h.peak])).toEqual([[1, -30], [4.2, -22]]);
  });
});

describe("balance (§29)", () => {
  const voice = (vI = -22, band?: Reading) => ({ full: reading(20, [[1, 9, vI], [11, 19, vI]], vI), band });
  const music = (mI: number, band?: Reading) => ({ full: reading(20, [[0.1, 20, mI]], mI), band });

  it("keeps the voice at 0 and sets the music level with it", () => {
    const r = balance({ voice: voice(-22), music: music(-30) });
    expect(r.levels).toEqual({ voice: 0, music: 8 });
    expect(r.report.music).toMatchObject({ level: 8, by: "voice" });
  });

  it("holds the music back so the voice clears it in the speech band on every line", () => {
    // In the band the voice is -24 and the music -27: 3 LU apart at 0 dB, so the music may come up only 2 dB (1 LU clearance).
    const vb = reading(20, [[1, 9, -24], [11, 19, -24]], -24);
    const mb = reading(20, [[0.1, 20, -27]], -27);
    const r = balance({ voice: voice(-22, vb), music: music(-30, mb) });
    expect(r.levels.music).toBe(3 - BALANCE.voiceClearance);
    expect(r.report.music).toMatchObject({ by: "clearance", clearance: BALANCE.voiceClearance });
  });

  it("sets music with no voice to the set level", () => {
    const r = balance({ music: music(-26) });
    expect(r.levels).toEqual({ music: BALANCE.musicAlone + 26 });
    expect(r.report.music?.by).toBe("alone");
  });

  it("puts each effect just under the music around it, after the music's own move", () => {
    const sfx = { full: reading(20, [[3, 3.1, -30], [8, 8.1, -28], [15, 15.1, -32]], -35) };
    // Music -30 integrated and short-term, moved +8 to sit level with a -22 voice: the groove is -22, so the median hit
    // (-30) goes to -23.
    const r = balance({ voice: voice(-22), music: music(-30), sfx });
    expect(r.levels.sfx).toBe(-22 - BALANCE.sfxUnderGroove + 30);
    expect(r.report.sfx).toMatchObject({ hits: 3, by: "music" });
  });

  it("sets effects under the voice with no music, and at the set level with neither", () => {
    const sfx = { full: reading(10, [[3, 3.1, -30]], -35) };
    expect(balance({ voice: voice(-22), sfx }).levels.sfx).toBe(-22 - BALANCE.sfxUnderVoice + 30);
    expect(balance({ sfx }).levels.sfx).toBe(BALANCE.sfxAlone + 30);
  });

  it("stops at the end of the fader and says the take needs re-rendering", () => {
    const r = balance({ voice: voice(-14), music: music(-40) });
    expect(r.levels.music).toBe(12);
    expect(r.report.clamped).toEqual(["music"]);
    expect(balanceSummary(r.report)).toMatch(/Music hit the end of the fader/);
  });

  it("leaves out a silent sound", () => {
    const r = balance({ voice: voice(-22), music: { full: reading(5, [], null) }, sfx: { full: reading(5, [], null) } });
    expect(r.levels).toEqual({ voice: 0 });
    expect(balanceSummary(r.report)).toBe("Only the voice is in use: nothing to balance against it.");
  });

  it("says what it did", () => {
    const sfx = { full: reading(20, [[3, 3.1, -40]], -45) };
    expect(balanceSummary(balance({ voice: voice(-22), music: music(-30), sfx }).report)).toBe(
      "Music +8 dB, level with the voice. Effects +12 dB: 1 hit just under the music around them. Effects hit the end of the fader: that take needs re-rendering at a different level.",
    );
  });
});

describe("trimmed (§29)", () => {
  const b = () => balance({ voice: { full: reading(10, [[1, 9, -22]], -22) }, music: { full: reading(10, [[0.1, 10, -30]], -30) } });
  it("brings every sound down together, to the step, when the mix would peak over the ceiling", () => {
    const t = trimmed(b(), BALANCE.peakCeiling + 1.2);
    expect(t.levels).toEqual({ voice: -1.5, music: 6.5 });
    expect(t.report.trim).toBe(-1.5);
    expect(t.report.music?.level).toBe(6.5);
    expect(balanceSummary(t.report)).toBe("Music +6.5 dB, level with the voice. Everything \u22121.5 dB so the mix doesn't clip.");
  });
  it("leaves a balance alone under the ceiling, or with no reading", () => {
    expect(trimmed(b(), -3).levels).toEqual({ voice: 0, music: 8 });
    expect(trimmed(b(), null).report.trim).toBe(0);
  });
});

describe("toLevel (§29)", () => {
  it("snaps to the 0.5 dB step and the fader's range, never -0", () => {
    expect(toLevel(2.74)).toBe(2.5);
    expect(toLevel(2.76)).toBe(3);
    expect(toLevel(40)).toBe(12);
    expect(toLevel(-40)).toBe(-24);
    expect(Object.is(toLevel(-0.1), 0)).toBe(true);
  });
});

describe("parseFrames (§29)", () => {
  it("reads ffmpeg's per-frame lines, silence included", () => {
    const err = [
      "[Parsed_ebur128_0 @ 0x1] t: 0.1        TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU",
      "[Parsed_ebur128_0 @ 0x1] t: 0.2        TARGET:-23 LUFS    M: -21.4 S: -inf      I: -21.4 LUFS       LRA:   0.0 LU",
      "[Parsed_ebur128_0 @ 0x1] Summary:",
    ].join("\n");
    expect(parseFrames(err)).toEqual([
      { t: 0.1, m: -120.7, s: -120.7 },
      { t: 0.2, m: -21.4, s: -120 },
    ]);
  });
});
