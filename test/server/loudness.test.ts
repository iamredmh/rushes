import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import {
  LoudnessTimeoutError,
  ffmpegAvailable,
  loudnessArgs,
  measureMix,
  mixInputs,
  parseEbur128,
  type LoudnessRunner,
  type MixInput,
} from "../../src/server/loudness.js";
import type { Picks, Project, Script } from "../../src/core/schema.js";

// A real ffmpeg `ebur128=peak=true` summary block (ruling 6), captured by hand from:
//   ffmpeg -hide_banner -nostats -f lavfi -i "sine=frequency=440:duration=2" \
//     -filter_complex "ebur128=peak=true" -f null -
// The test suite itself never spawns ffmpeg; this is the only real-ffmpeg output it reads.
const REAL_EBUR128_SUMMARY = `[Parsed_ebur128_0 @ 0x7f0000000000] Summary:

  Integrated loudness:
    I:         -21.8 LUFS
    Threshold: -31.8 LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold:   0.0 LUFS
    LRA low:     0.0 LUFS
    LRA high:    0.0 LUFS

  True peak:
    Peak:      -18.1 dBFS
`;

/** A synthetic summary block in the same shape, for tests that only care about the numbers. */
function ebur(integrated: number, truePeak = -6): string {
  return `  Integrated loudness:\n    I:         ${integrated} LUFS\n    Threshold: -30.0 LUFS\n\n  True peak:\n    Peak:      ${truePeak} dBFS\n`;
}

describe("parseEbur128", () => {
  it("reads the integrated loudness and true peak out of a real ffmpeg summary block", () => {
    expect(parseEbur128(REAL_EBUR128_SUMMARY)).toEqual({ integrated: -21.8, truePeak: -18.1 });
  });

  it("returns nulls when the text has no summary block", () => {
    expect(parseEbur128("ffmpeg version 6.0\nsome unrelated stderr\n")).toEqual({ integrated: null, truePeak: null });
  });
});

describe("loudnessArgs", () => {
  it("builds the exact ffmpeg argument array for 3 inputs", () => {
    const inputs: MixInput[] = [
      { file: "/abs/vo.wav", offset: 0, stage: "voice" },
      { file: "/abs/music.wav", offset: 0, stage: "music" },
      { file: "/abs/sfx.wav", offset: 2.5, stage: "sfx" },
    ];
    expect(loudnessArgs(inputs)).toEqual([
      "-nostats",
      "-i",
      "/abs/vo.wav",
      "-i",
      "/abs/music.wav",
      "-i",
      "/abs/sfx.wav",
      "-filter_complex",
      "[0]adelay=0:all=1[a0];[1]adelay=0:all=1[a1];[2]adelay=2500:all=1[a2];[a0][a1][a2]amix=inputs=3:normalize=0,ebur128=peak=true",
      "-f",
      "null",
      "-",
    ]);
  });
});

describe("ffmpegAvailable", () => {
  it("resolves true on a zero exit, and caches so the runner is probed once", async () => {
    let calls = 0;
    const run: LoudnessRunner = async (args) => {
      calls++;
      expect(args).toEqual(["-version"]);
      return { code: 0, stderr: "ffmpeg version 6.0" };
    };
    expect(await ffmpegAvailable(run)).toBe(true);
    expect(await ffmpegAvailable(run)).toBe(true);
    expect(calls).toBe(1);
  });

  it("resolves false on a nonzero exit or a rejected run, never throwing", async () => {
    const bad: LoudnessRunner = async () => ({ code: 1, stderr: "command not found" });
    expect(await ffmpegAvailable(bad)).toBe(false);
    const throws: LoudnessRunner = async () => {
      throw new Error("ENOENT");
    };
    expect(await ffmpegAvailable(throws)).toBe(false);
  });
});

async function fixture() {
  const { root } = await tmpProject("loudness");
  await mkdir(join(root, "audio"), { recursive: true });
  const write = (name: string) => writeFile(join(root, "audio", name), "not real audio, just a stand-in file");
  await Promise.all(
    ["s1-t1.wav", "s1-t2.wav", "s2-u1.wav", "voice-alt.wav", "music-a.wav", "music-b.wav", "sfx-pass1.wav"].map(write),
  );

  const project: Project = {
    schema: 1,
    rev: 0,
    name: "demo",
    fps: 30,
    videos: [],
    files: [],
    lanes: [
      {
        id: "music",
        stage: "music",
        name: "Music",
        variants: [
          { id: "a", name: "A", file: "audio/music-a.wav", meta: {}, cues: [] },
          { id: "b", name: "B", file: "audio/music-b.wav", meta: {}, cues: [] },
        ],
      },
      {
        id: "sfx",
        stage: "sfx",
        name: "Sound effects",
        variants: [{ id: "pass1", name: "Pass 1", file: "audio/sfx-pass1.wav", meta: {}, cues: [] }],
      },
      {
        id: "voice",
        stage: "voice",
        name: "Voiceover",
        variants: [{ id: "alt", name: "Alt read", file: "audio/voice-alt.wav", meta: {}, cues: [] }],
      },
    ],
  };

  const script: Script = {
    schema: 1,
    rev: 0,
    wordsPerSecond: 2.6,
    sections: [
      {
        id: "s1",
        start: 0,
        end: 5,
        current: "Line one",
        proposed: null,
        direction: "",
        status: "draft",
        takes: [
          { id: "t1", file: "audio/s1-t1.wav", duration: 4, forText: "Line one" },
          { id: "t2", file: "audio/s1-t2.wav", duration: 4.2, forText: "Line one" },
        ],
      },
      {
        id: "s2",
        start: 5,
        end: 10,
        current: "Line two",
        proposed: null,
        direction: "",
        status: "draft",
        takes: [
          { id: "u1", file: "audio/s2-u1.wav", duration: 3, forText: "Line two" },
          { id: "u2", file: "audio/does-not-exist.wav", duration: 3, forText: "Line two" },
        ],
      },
      // No take on disk at all: proves a missing file is skipped rather than crashing mixInputs.
      {
        id: "s3",
        start: 10,
        end: 14,
        current: "Line three",
        proposed: null,
        direction: "",
        status: "draft",
        takes: [{ id: "v1", file: "audio/missing-entirely.wav", duration: 2, forText: "Line three" }],
      },
    ],
  };

  const picks: Picks = {
    schema: 1,
    rev: 0,
    lanes: { music: "b", voice: "alt" }, // sfx has no pick -> falls back to its first variant
    sections: { s2: "u1" }, // s1 has no pick -> falls back to its newest take
  };

  return { root, project, script, picks };
}

describe("mixInputs", () => {
  it("resolves each section's picked take or its newest, the picked voice variant, the picked/first music and sfx variant, and skips missing files", async () => {
    const { root, project, script, picks } = await fixture();
    const inputs = mixInputs(project, script, picks, ["voice", "music", "sfx"], root);
    expect(inputs).toEqual([
      { file: join(root, "audio", "s1-t2.wav"), offset: 0, stage: "voice" }, // s1: no pick -> newest (t2)
      { file: join(root, "audio", "s2-u1.wav"), offset: 5, stage: "voice" }, // s2: picked (u1)
      // s3's only take points nowhere on disk -- left out entirely.
      { file: join(root, "audio", "voice-alt.wav"), offset: 0, stage: "voice" }, // picked voice variant
      { file: join(root, "audio", "music-b.wav"), offset: 0, stage: "music" }, // picked music variant
      { file: join(root, "audio", "sfx-pass1.wav"), offset: 0, stage: "sfx" }, // sfx: no pick -> first
    ]);
  });

  it("includes only the lanes asked for", async () => {
    const { root, project, script, picks } = await fixture();
    expect(mixInputs(project, script, picks, ["music"], root)).toEqual([
      { file: join(root, "audio", "music-b.wav"), offset: 0, stage: "music" },
    ]);
    expect(mixInputs(project, script, picks, [], root)).toEqual([]);
  });

  it("leaves out a music/sfx lane with no variants at all", async () => {
    const { root, project, script, picks } = await fixture();
    project.lanes.push({ id: "empty-bed", stage: "music", name: "Empty", variants: [] });
    expect(mixInputs(project, script, picks, ["music"], root).map((i) => i.file)).toEqual([join(root, "audio", "music-b.wav")]);
  });
});

describe("measureMix", () => {
  it("returns available: false, touching nothing else, when ffmpeg is missing", async () => {
    const run: LoudnessRunner = async () => ({ code: 1, stderr: "" });
    const result = await measureMix(
      { schema: 1, rev: 0, name: "demo", fps: 30, videos: [], lanes: [], files: [] },
      { schema: 1, rev: 0, wordsPerSecond: 2.6, sections: [] },
      { schema: 1, rev: 0, lanes: {}, sections: {} },
      ["voice", "music", "sfx"],
      "/nonexistent",
      run,
    );
    expect(result).toEqual({ available: false, integrated: null, truePeak: null, musicUnderVo: null });
  });

  it("measures the full mix, and the VO and music alone over the VO's span, caching the result per runner", async () => {
    const { root, project, script, picks } = await fixture();
    const voAbs = join(root, "audio", "s1-t2.wav");
    const vo2Abs = join(root, "audio", "s2-u1.wav");
    const voAltAbs = join(root, "audio", "voice-alt.wav");
    const musicAbs = join(root, "audio", "music-b.wav");

    const calls: string[][] = [];
    const run: LoudnessRunner = async (args) => {
      calls.push(args);
      if (args[0] === "-version") return { code: 0, stderr: "" };
      const hasVoice = args.includes(voAbs) || args.includes(vo2Abs) || args.includes(voAltAbs);
      const hasMusic = args.includes(musicAbs);
      if (hasVoice && hasMusic) return { code: 0, stderr: ebur(-20) };
      if (hasVoice) return { code: 0, stderr: ebur(-18) };
      if (hasMusic) return { code: 0, stderr: ebur(-14) };
      return { code: 0, stderr: "" };
    };

    const result = await measureMix(project, script, picks, ["voice", "music"], root, run);
    expect(result).toEqual({ available: true, integrated: -20, truePeak: -6, musicUnderVo: 4 }); // -14 - (-18)
    // version probe, full mix, VO alone, music alone -- at most 3 ffmpeg invocations (ruling 2).
    expect(calls).toHaveLength(4);

    const callsSoFar = calls.length;
    const again = await measureMix(project, script, picks, ["voice", "music"], root, run);
    expect(again).toEqual(result);
    expect(calls).toHaveLength(callsSoFar); // cache hit: the runner isn't called again at all
  });

  it("leaves musicUnderVo null when only one of voice/music is present", async () => {
    const { root, project, script, picks } = await fixture();
    const run: LoudnessRunner = async (args) => (args[0] === "-version" ? { code: 0, stderr: "" } : { code: 0, stderr: ebur(-16) });
    const result = await measureMix(project, script, picks, ["music"], root, run);
    expect(result).toEqual({ available: true, integrated: -16, truePeak: -6, musicUnderVo: null });
  });

  it("rejects with a 504 LoudnessTimeoutError when a run exceeds the timeout", async () => {
    const { root, project, script, picks } = await fixture();
    const run: LoudnessRunner = (args) =>
      args[0] === "-version" ? Promise.resolve({ code: 0, stderr: "" }) : new Promise(() => {}); // never resolves
    await expect(measureMix(project, script, picks, ["music"], root, run, 50)).rejects.toMatchObject({
      status: 504,
      code: "loudness_timeout",
    });
    await expect(measureMix(project, script, picks, ["music"], root, run, 50)).rejects.toBeInstanceOf(LoudnessTimeoutError);
  });
});
