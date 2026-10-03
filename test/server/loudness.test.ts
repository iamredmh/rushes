import { describe, expect, it, vi } from "vitest";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Only `stat` is wrapped as a spy-able vi.fn (defaulting to the real implementation); every
// other export, including the ones test/helpers/tmp.ts and this file's own fixture() rely on, is
// passed through untouched. Lets one test simulate cacheKey's stat() losing a TOCTOU race without
// touching the filesystem it runs against.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});
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

// A real summary block for digital silence (ruling 6 / I1), captured by hand from:
//   ffmpeg -hide_banner -nostats -f lavfi -i "anullsrc=r=44100:cl=mono:duration=1" \
//     -filter_complex "ebur128=peak=true" -f null -
// This ffmpeg build floors "I:" at the -70 LUFS absolute gate rather than printing -inf there,
// but "Peak:" genuinely reports -inf -- real proof the parser must accept "-inf" at all.
const REAL_SILENT_SUMMARY = `[Parsed_ebur128_0 @ 0x7f0000000001] Summary:

  Integrated loudness:
    I:         -70.0 LUFS
    Threshold:   0.0 LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold:   0.0 LUFS
    LRA low:     0.0 LUFS
    LRA high:    0.0 LUFS

  True peak:
    Peak:       -inf dBFS
`;

// A synthetic block (same shape, documented as such) for the "I: -inf LUFS" branch: some ffmpeg
// versions/inputs report it when there's no measurable block at all, which this build's test
// signal never produced.
const SYNTHETIC_FULLY_SILENT_SUMMARY = `  Integrated loudness:
    I:         -inf LUFS
    Threshold:   0.0 LUFS

  True peak:
    Peak:       -inf dBFS
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

  it("reads a real -inf true peak as -Infinity, not null (I1)", () => {
    expect(parseEbur128(REAL_SILENT_SUMMARY)).toEqual({ integrated: -70, truePeak: -Infinity });
  });

  it("reads -inf integrated loudness as -Infinity too", () => {
    expect(parseEbur128(SYNTHETIC_FULLY_SILENT_SUMMARY)).toEqual({ integrated: -Infinity, truePeak: -Infinity });
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

  // No voice lane pick here on purpose: the default fixture exercises the assembled-read path.
  // The "picked voice variant replaces the assembled read" test below overrides this.
  const picks: Picks = {
    schema: 1,
    rev: 0,
    lanes: { music: "b" }, // sfx has no pick -> falls back to its first variant
    sections: { s2: "u1" }, // s1 has no pick -> falls back to its newest take
  };

  return { root, project, script, picks };
}

describe("mixInputs", () => {
  it("resolves each section's picked take or its newest, the picked/first music and sfx variant, and skips missing files", async () => {
    const { root, project, script, picks } = await fixture();
    const inputs = mixInputs(project, script, picks, ["voice", "music", "sfx"], root);
    expect(inputs).toEqual([
      { file: join(root, "audio", "s1-t2.wav"), offset: 0, stage: "voice" }, // s1: no pick -> newest (t2)
      { file: join(root, "audio", "s2-u1.wav"), offset: 5, stage: "voice" }, // s2: picked (u1)
      // s3's only take points nowhere on disk -- left out entirely.
      { file: join(root, "audio", "music-b.wav"), offset: 0, stage: "music" }, // picked music variant
      { file: join(root, "audio", "sfx-pass1.wav"), offset: 0, stage: "sfx" }, // sfx: no pick -> first
    ]);
  });

  it("never falls back to the first voice variant when none is picked -- the assembled read is used instead", async () => {
    const { root, project, script, picks } = await fixture();
    const files = mixInputs(project, script, picks, ["voice"], root).map((i) => i.file);
    expect(files).not.toContain(join(root, "audio", "voice-alt.wav"));
    expect(files).toEqual([join(root, "audio", "s1-t2.wav"), join(root, "audio", "s2-u1.wav")]);
  });

  it("a picked voice variant replaces the assembled read entirely (controller ruling)", async () => {
    const { root, project, script, picks } = await fixture();
    const withPick: Picks = { ...picks, lanes: { ...picks.lanes, voice: "alt" } };
    const inputs = mixInputs(project, script, withPick, ["voice"], root);
    expect(inputs).toEqual([{ file: join(root, "audio", "voice-alt.wav"), offset: 0, stage: "voice" }]);
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
    expect(result).toEqual({ available: false, integrated: null, truePeak: null, musicUnderVo: null, silent: false });
  });

  it("measures the full mix, and the VO and music alone over the VO's span, caching the result per runner", async () => {
    const { root, project, script, picks } = await fixture();
    const voAbs = join(root, "audio", "s1-t2.wav");
    const vo2Abs = join(root, "audio", "s2-u1.wav");
    const musicAbs = join(root, "audio", "music-b.wav");

    const calls: string[][] = [];
    const run: LoudnessRunner = async (args) => {
      calls.push(args);
      if (args[0] === "-version") return { code: 0, stderr: "" };
      const hasVoice = args.includes(voAbs) || args.includes(vo2Abs);
      const hasMusic = args.includes(musicAbs);
      if (hasVoice && hasMusic) return { code: 0, stderr: ebur(-20) };
      if (hasVoice) return { code: 0, stderr: ebur(-18) };
      if (hasMusic) return { code: 0, stderr: ebur(-14) };
      return { code: 0, stderr: "" };
    };

    const result = await measureMix(project, script, picks, ["voice", "music"], root, run);
    expect(result).toEqual({ available: true, integrated: -20, truePeak: -6, musicUnderVo: 4, silent: false }); // -14 - (-18)
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
    expect(result).toEqual({ available: true, integrated: -16, truePeak: -6, musicUnderVo: null, silent: false });
  });

  it("reports silence as null + silent: true, never a bare -Infinity (I1)", async () => {
    const { root, project, script, picks } = await fixture();
    const run: LoudnessRunner = async (args) => (args[0] === "-version" ? { code: 0, stderr: "" } : { code: 0, stderr: REAL_SILENT_SUMMARY });
    const result = await measureMix(project, script, picks, ["music"], root, run);
    expect(result).toEqual({ available: true, integrated: null, truePeak: null, musicUnderVo: null, silent: true });
  });

  it("never lets a silent lane's -Infinity leak into musicUnderVo's subtraction", async () => {
    const { root, project, script, picks } = await fixture();
    const run: LoudnessRunner = async (args) => {
      if (args[0] === "-version") return { code: 0, stderr: "" };
      // Full mix: not silent. But the VO-alone and music-alone passes can't be told apart from
      // the full-mix call by content alone here, so make every non-version call report silence
      // for the two solo passes by checking argument count (solo passes have 1 -i each).
      const inputCount = args.filter((a) => a === "-i").length;
      if (inputCount === 1) return { code: 0, stderr: SYNTHETIC_FULLY_SILENT_SUMMARY };
      return { code: 0, stderr: ebur(-18) };
    };
    const result = await measureMix(project, script, picks, ["voice", "music"], root, run);
    expect(result.musicUnderVo).toBeNull();
  });

  it("only counts a take whose file exists when working out the VO span used to trim the music-alone pass", async () => {
    const { root, project, picks } = await fixture();
    // s1 (on disk, duration 4) is the real span; s2's only take has a huge recorded duration but
    // no file on disk at all, so it must never stretch the trim past s1's own 4 seconds.
    const script: Script = {
      schema: 1,
      rev: 0,
      wordsPerSecond: 2.6,
      sections: [
        { id: "s1", start: 0, end: 5, current: "A", proposed: null, direction: "", status: "draft", takes: [{ id: "t1", file: "audio/s1-t1.wav", duration: 4, forText: "A" }] },
        { id: "s2", start: 5, end: 10, current: "B", proposed: null, direction: "", status: "draft", takes: [{ id: "u1", file: "audio/missing-span.wav", duration: 100, forText: "B" }] },
      ],
    };
    const p: Picks = { ...picks, sections: {} };
    let trimArgs: string[] | undefined;
    const run: LoudnessRunner = async (args) => {
      if (args[0] === "-version") return { code: 0, stderr: "" };
      if (args.includes("-t")) trimArgs = args;
      return { code: 0, stderr: ebur(-20) };
    };
    await measureMix(project, script, p, ["voice", "music"], root, run);
    expect(trimArgs).toBeDefined();
    expect(trimArgs![trimArgs!.indexOf("-t") + 1]).toBe("4.000");
  });

  it("aborts the runner's signal on timeout, so a hung ffmpeg is actually killed, and rejects with a 504", async () => {
    const { root, project, script, picks } = await fixture();
    let aborted = false;
    const run: LoudnessRunner = (args, signal) => {
      if (args[0] === "-version") return Promise.resolve({ code: 0, stderr: "" });
      return new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          // A real killed process reports its exit asynchronously, well after SIGTERM is sent.
          // Resolving here only in response to the abort (and only after a tick) proves the fake
          // completes BECAUSE it was aborted, not because it raced ahead of the timeout.
          setTimeout(() => resolve({ code: 137, stderr: "" }), 0);
        });
      });
    };
    await expect(measureMix(project, script, picks, ["music"], root, run, 50)).rejects.toMatchObject({
      status: 504,
      code: "loudness_timeout",
    });
    expect(aborted).toBe(true);
    expect(await expect(measureMix(project, script, picks, ["music"], root, run, 50)).rejects.toBeInstanceOf(LoudnessTimeoutError));
  });

  it("never 500s when a file's stat fails after mixInputs already found it on disk (a TOCTOU race)", async () => {
    const { root, project, script, picks } = await fixture();
    // mixInputs' own existsSync check still sees the file (it's never deleted); only cacheKey's
    // very next stat() call fails, simulating the race it can lose. measureMix must still return
    // a real result -- just not cache it -- rather than ever surfacing as a 500.
    vi.mocked(stat).mockRejectedValueOnce(new Error("ENOENT (simulated race)"));
    const run: LoudnessRunner = async (args) => (args[0] === "-version" ? { code: 0, stderr: "" } : { code: 0, stderr: ebur(-20) });
    await expect(measureMix(project, script, picks, ["music"], root, run)).resolves.toMatchObject({ available: true, integrated: -20 });
  });
});
