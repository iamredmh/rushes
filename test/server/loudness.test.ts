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
import type { Picks, Project } from "../../src/core/schema.js";
import { AUDIO_FORMATS } from "../../src/core/media.js";
import { defaultRunner } from "../../src/server/loudness.js";
import { spawnSync } from "node:child_process";

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
  it("builds the exact ffmpeg argument array for 3 inputs, each at 0 dB with no level set", () => {
    const inputs: MixInput[] = [
      { file: "/abs/vo.wav", offset: 0, stage: "voice", gainDb: 0 },
      { file: "/abs/music.wav", offset: 0, stage: "music", gainDb: 0 },
      { file: "/abs/sfx.wav", offset: 2.5, stage: "sfx", gainDb: 0 },
    ];
    // Each input reads local files only, and only as an audio container (a playlist named .wav is refused).
    const only = ["-protocol_whitelist", "file", "-format_whitelist", AUDIO_FORMATS];
    expect(loudnessArgs(inputs)).toEqual([
      "-nostats",
      ...only,
      "-i",
      "/abs/vo.wav",
      ...only,
      "-i",
      "/abs/music.wav",
      ...only,
      "-i",
      "/abs/sfx.wav",
      "-filter_complex",
      "[0]adelay=0:all=1,volume=0dB[a0];[1]adelay=0:all=1,volume=0dB[a1];[2]adelay=2500:all=1,volume=0dB[a2];[a0][a1][a2]amix=inputs=3:normalize=0,ebur128=peak=true",
      "-f",
      "null",
      "-",
    ]);
  });

  it("puts each input's level (§19.6) in its own volume filter", () => {
    const inputs: MixInput[] = [
      { file: "/abs/vo.wav", offset: 0, stage: "voice", gainDb: 0 },
      { file: "/abs/music.wav", offset: 0, stage: "music", gainDb: -14 },
      { file: "/abs/sfx.wav", offset: 0, stage: "sfx", gainDb: -6.5 },
    ];
    const filter = loudnessArgs(inputs)[loudnessArgs(inputs).indexOf("-filter_complex") + 1];
    expect(filter).toContain("volume=0dB[a0]");
    expect(filter).toContain("volume=-14dB[a1]");
    expect(filter).toContain("volume=-6.5dB[a2]");
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

// Final review I1, last follow-up: the mix's inputs are read only as audio containers, so a
// playlist named .wav can never make the mix read the files it names.
describe.skipIf(!hasFfmpeg)("the mix with the real ffmpeg", () => {
  it("mixes wav, mp3, m4a, aif, flac, ogg and opus, and refuses an ffconcat playlist named .wav", async () => {
    const { root } = await tmpProject("mix");
    const make = (name: string, args: string[] = []) =>
      spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", ...args, join(root, name)]).status === 0;
    const input = (file: string): MixInput => ({ file: join(root, file), offset: 0, stage: "music", gainDb: 0 });
    const kinds = ["a.wav", "a.mp3", "a.m4a", "a.aif", "a.flac", "a.ogg", "a.opus"];
    const made = kinds.filter((k) => make(k));
    // The ones ffmpeg encodes itself are always there; the others need its usual libraries.
    for (const k of ["a.wav", "a.m4a", "a.aif", "a.flac"]) expect(made).toContain(k);
    for (const k of made) {
      const r = await defaultRunner(loudnessArgs([input(k)]));
      expect(r.code, k).toBe(0);
      expect(Number.isFinite(parseEbur128(r.stderr).integrated), k).toBe(true);
    }
    const all = await defaultRunner(loudnessArgs(made.map(input)));
    expect(all.code).toBe(0);
    expect(Number.isFinite(parseEbur128(all.stderr).integrated)).toBe(true);
    // Without the whitelist, ffmpeg reads this "wav" by its content and mixes inner.wav through it.
    make("inner.wav");
    await writeFile(join(root, "list.wav"), "ffconcat version 1.0\nfile inner.wav\n");
    const list = await defaultRunner(loudnessArgs([input("list.wav")]));
    expect(list.code).not.toBe(0);
    expect(list.stderr).toMatch(/not on whitelist/i);
    expect(parseEbur128(list.stderr)).toEqual({ integrated: null, truePeak: null });
    // One bad input refuses the whole mix: nothing is measured from the others either.
    const mixed = await defaultRunner(loudnessArgs([input("a.wav"), input("list.wav")]));
    expect(mixed.code).not.toBe(0);
    expect(parseEbur128(mixed.stderr).integrated).toBeNull();
  }, 30_000);
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
    autoProxy: false,
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

  // No voice lane pick here on purpose: with takes in the picks but no round picked, there is no VO.
  const picks: Picks = {
    schema: 1,
    rev: 0,
    lanes: { music: "b" }, // sfx has no pick -> falls back to its first variant
    sections: { s2: "u1" }, // an older take pick, which the mix never uses (§18.4)
    levels: {},
  };

  return { root, project, picks };
}

describe("mixInputs", () => {
  it("leaves out voice entirely when no round has a pick (takes are never mixed, §18.4), and resolves the picked music variant, skipping missing files", async () => {
    const { root, project, picks } = await fixture();
    const inputs = mixInputs(project, picks, ["voice", "music", "sfx"], root);
    expect(inputs).toEqual([
      { file: join(root, "audio", "music-b.wav"), offset: 0, stage: "music", gainDb: 0 }, // picked music variant
      // voice: no round has a pick, so nothing plays even though the sections have takes.
      // sfx has no pick: Mix plays nothing on it, so it's never stood in for by its first pass.
    ]);
  });

  it("with two music lanes and only one picked, uses just the picked one, as Mix plays (I2)", async () => {
    const { root, project, picks } = await fixture();
    project.lanes.push({
      id: "sting",
      stage: "music",
      name: "Sting",
      variants: [{ id: "a", name: "A", file: "audio/music-a.wav", meta: {}, cues: [] }],
    });
    // "music" (the bed) is picked; "sting" isn't.
    expect(mixInputs(project, picks, ["music"], root)).toEqual([
      { file: join(root, "audio", "music-b.wav"), offset: 0, stage: "music", gainDb: 0 },
    ]);
    // Picking the sting too adds it.
    const both: Picks = { ...picks, lanes: { ...picks.lanes, sting: "a" } };
    expect(mixInputs(project, both, ["music"], root).map((i) => i.file)).toEqual([
      join(root, "audio", "music-b.wav"),
      join(root, "audio", "music-a.wav"),
    ]);
  });

  it("sets each input's gainDb from picks.levels, 0 when a lane has none (§19.6)", async () => {
    const { root, project, picks } = await fixture();
    const withLevels: Picks = { ...picks, lanes: { ...picks.lanes, sfx: "pass1" }, levels: { music: -14, sfx: -6 } };
    const inputs = mixInputs(project, withLevels, ["music", "sfx"], root);
    expect(inputs.find((i) => i.stage === "music")?.gainDb).toBe(-14);
    expect(inputs.find((i) => i.stage === "sfx")?.gainDb).toBe(-6);
    // voice has no level set: defaults to 0.
    const withPick: Picks = { ...withLevels, lanes: { ...withLevels.lanes, voice: "alt" } };
    expect(mixInputs(project, withPick, ["voice"], root)[0].gainDb).toBe(0);
  });

  it("never falls back to the first voice variant when none is picked, and never to takes either (§18.4)", async () => {
    const { root, project, picks } = await fixture();
    const files = mixInputs(project, picks, ["voice"], root).map((i) => i.file);
    expect(files).not.toContain(join(root, "audio", "voice-alt.wav"));
    expect(files).toEqual([]);
  });

  it("a picked voice variant replaces the assembled read entirely (controller ruling)", async () => {
    const { root, project, picks } = await fixture();
    const withPick: Picks = { ...picks, lanes: { ...picks.lanes, voice: "alt" } };
    const inputs = mixInputs(project, withPick, ["voice"], root);
    expect(inputs).toEqual([{ file: join(root, "audio", "voice-alt.wav"), offset: 0, stage: "voice", gainDb: 0 }]);
  });

  it("includes only the lanes asked for", async () => {
    const { root, project, picks } = await fixture();
    expect(mixInputs(project, picks, ["music"], root)).toEqual([
      { file: join(root, "audio", "music-b.wav"), offset: 0, stage: "music", gainDb: 0 },
    ]);
    expect(mixInputs(project, picks, [], root)).toEqual([]);
  });

  it("leaves out a music/sfx lane with no variants at all", async () => {
    const { root, project, picks } = await fixture();
    project.lanes.push({ id: "empty-bed", stage: "music", name: "Empty", variants: [] });
    expect(mixInputs(project, picks, ["music"], root).map((i) => i.file)).toEqual([join(root, "audio", "music-b.wav")]);
  });

  it("VO is the pick of the newest round that has one; takes are never used (§18.4)", async () => {
    const { root, project } = await fixture();
    project.lanes = project.lanes.filter((l) => l.stage !== "voice");
    await mkdir(join(root, "audio"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "audio", "gerald.wav"), "x"),
      writeFile(join(root, "audio", "sombre.wav"), "x"),
    ]);
    project.lanes.push(
      { id: "round-1", stage: "voice", name: "Round 1", variants: [{ id: "gerald", name: "Gerald", file: "audio/gerald.wav", meta: {}, cues: [] }] },
      { id: "round-2", stage: "voice", name: "Round 2", variants: [{ id: "sombre", name: "More sombre", file: "audio/sombre.wav", meta: {}, cues: [] }] },
    );
    const inputs = mixInputs(project, { schema: 1, rev: 0, lanes: { "round-1": "gerald" }, sections: {}, levels: {} }, ["voice"], root);
    expect(inputs.map((i) => i.file)).toEqual([join(root, "audio", "gerald.wav")]);
  });

  it("with no round picked there is no VO input, even when takes exist", async () => {
    const { root, project } = await fixture();
    const inputs = mixInputs(project, { schema: 1, rev: 0, lanes: {}, sections: {}, levels: {} }, ["voice"], root);
    expect(inputs).toEqual([]);
  });

  it("a newer round's pick wins over an older one", async () => {
    const { root, project } = await fixture();
    project.lanes = project.lanes.filter((l) => l.stage !== "voice");
    await mkdir(join(root, "audio"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "audio", "gerald.wav"), "x"),
      writeFile(join(root, "audio", "sombre.wav"), "x"),
    ]);
    project.lanes.push(
      { id: "round-1", stage: "voice", name: "Round 1", variants: [{ id: "gerald", name: "Gerald", file: "audio/gerald.wav", meta: {}, cues: [] }] },
      { id: "round-2", stage: "voice", name: "Round 2", variants: [{ id: "sombre", name: "More sombre", file: "audio/sombre.wav", meta: {}, cues: [] }] },
    );
    const inputs = mixInputs(project, { schema: 1, rev: 0, lanes: { "round-1": "gerald", "round-2": "sombre" }, sections: {}, levels: {} }, ["voice"], root);
    expect(inputs.map((i) => i.file)).toEqual([join(root, "audio", "sombre.wav")]);
  });

  it("falls through to an older round when the newest round's pick is stale (names a variant that no longer exists) (§18.4)", async () => {
    const { root, project, picks: basePicks } = await fixture();
    project.lanes = project.lanes.filter((l) => l.stage !== "voice");
    await writeFile(join(root, "audio", "gerald.wav"), "x");
    project.lanes.push(
      { id: "round-1", stage: "voice", name: "Round 1", variants: [{ id: "gerald", name: "Gerald", file: "audio/gerald.wav", meta: {}, cues: [] }] },
      { id: "round-2", stage: "voice", name: "Round 2", variants: [] }, // the variant this round's pick named is gone
    );
    const picks: Picks = { ...basePicks, lanes: { ...basePicks.lanes, "round-1": "gerald", "round-2": "gone" } };
    const inputs = mixInputs(project, picks, ["voice"], root);
    expect(inputs.map((i) => i.file)).toEqual([join(root, "audio", "gerald.wav")]);

    // The same fall-through on the voSpan/musicUnderVo path: round 1's Gerald is still the VO
    // span the music-under-VO pass is trimmed to, even though the newest round's pick is stale.
    let trimArgs: string[] | undefined;
    const run: LoudnessRunner = async (args) => {
      if (args[0] === "-version") return { code: 0, stderr: "" };
      if (args.includes("-t")) trimArgs = args;
      return { code: 0, stderr: ebur(-20) };
    };
    const result = await measureMix(project, picks, ["voice", "music"], root, run, 60_000, async () => 3);
    expect(trimArgs).toBeDefined();
    expect(trimArgs![trimArgs!.indexOf("-t") + 1]).toBe("3.000");
    expect(result.musicUnderVo).not.toBeNull();
  });
});

describe("measureMix", () => {
  it("returns available: false, touching nothing else, when ffmpeg is missing", async () => {
    const run: LoudnessRunner = async () => ({ code: 1, stderr: "" });
    const result = await measureMix(
      { schema: 1, rev: 0, name: "demo", fps: 30, videos: [], lanes: [], files: [], autoProxy: false },
      { schema: 1, rev: 0, lanes: {}, sections: {}, levels: {} },
      ["voice", "music", "sfx"],
      "/nonexistent",
      run,
    );
    expect(result).toEqual({ available: false, integrated: null, truePeak: null, musicUnderVo: null, silent: false });
  });

  it("measures the full mix, and the VO and music alone over the VO's span, caching the result per runner", async () => {
    const { root, project, picks: basePicks } = await fixture();
    const picks: Picks = { ...basePicks, lanes: { ...basePicks.lanes, voice: "alt" } };
    const voAbs = join(root, "audio", "voice-alt.wav");
    const musicAbs = join(root, "audio", "music-b.wav");

    const calls: string[][] = [];
    const run: LoudnessRunner = async (args) => {
      calls.push(args);
      if (args[0] === "-version") return { code: 0, stderr: "" };
      const hasVoice = args.includes(voAbs);
      const hasMusic = args.includes(musicAbs);
      if (hasVoice && hasMusic) return { code: 0, stderr: ebur(-20) };
      if (hasVoice) return { code: 0, stderr: ebur(-18) };
      if (hasMusic) return { code: 0, stderr: ebur(-14) };
      return { code: 0, stderr: "" };
    };

    const result = await measureMix(project, picks, ["voice", "music"], root, run, 60_000, async () => 2);
    expect(result).toEqual({ available: true, integrated: -20, truePeak: -6, musicUnderVo: 4, silent: false }); // -14 - (-18)
    // version probe, full mix, VO alone, music alone -- at most 3 ffmpeg invocations (ruling 2).
    expect(calls).toHaveLength(4);

    const callsSoFar = calls.length;
    const again = await measureMix(project, picks, ["voice", "music"], root, run, 60_000, async () => 2);
    expect(again).toEqual(result);
    expect(calls).toHaveLength(callsSoFar); // cache hit: the runner isn't called again at all
  });

  it("a level change changes the cache key, so it's measured again rather than served stale (§19.6)", async () => {
    const { root, project, picks } = await fixture();
    let calls = 0;
    const run: LoudnessRunner = async (args) => {
      if (args[0] !== "-version") calls++;
      return args[0] === "-version" ? { code: 0, stderr: "" } : { code: 0, stderr: ebur(-16) };
    };
    await measureMix(project, picks, ["music"], root, run);
    expect(calls).toBe(1);
    // A second, identical request is a cache hit.
    await measureMix(project, picks, ["music"], root, run);
    expect(calls).toBe(1);
    // Same files, same offsets, same runner -- only the level differs: not served from cache.
    const leveled: Picks = { ...picks, levels: { music: -14 } };
    const result = await measureMix(project, leveled, ["music"], root, run);
    expect(calls).toBe(2);
    expect(result.integrated).not.toBeNull();
  });

  it("leaves musicUnderVo null when only one of voice/music is present", async () => {
    const { root, project, picks } = await fixture();
    const run: LoudnessRunner = async (args) => (args[0] === "-version" ? { code: 0, stderr: "" } : { code: 0, stderr: ebur(-16) });
    const result = await measureMix(project, picks, ["music"], root, run);
    expect(result).toEqual({ available: true, integrated: -16, truePeak: -6, musicUnderVo: null, silent: false });
  });

  it("reports silence as null + silent: true, never a bare -Infinity (I1)", async () => {
    const { root, project, picks } = await fixture();
    const run: LoudnessRunner = async (args) => (args[0] === "-version" ? { code: 0, stderr: "" } : { code: 0, stderr: REAL_SILENT_SUMMARY });
    const result = await measureMix(project, picks, ["music"], root, run);
    expect(result).toEqual({ available: true, integrated: null, truePeak: null, musicUnderVo: null, silent: true });
  });

  it("never lets a silent lane's -Infinity leak into musicUnderVo's subtraction", async () => {
    const { root, project, picks: basePicks } = await fixture();
    const picks: Picks = { ...basePicks, lanes: { ...basePicks.lanes, voice: "alt" } };
    const run: LoudnessRunner = async (args) => {
      if (args[0] === "-version") return { code: 0, stderr: "" };
      // Full mix: not silent. But the VO-alone and music-alone passes can't be told apart from
      // the full-mix call by content alone here, so make every non-version call report silence
      // for the two solo passes by checking argument count (solo passes have 1 -i each).
      const inputCount = args.filter((a) => a === "-i").length;
      if (inputCount === 1) return { code: 0, stderr: SYNTHETIC_FULLY_SILENT_SUMMARY };
      return { code: 0, stderr: ebur(-18) };
    };
    const result = await measureMix(project, picks, ["voice", "music"], root, run, 60_000, async () => 2);
    expect(result.musicUnderVo).toBeNull();
  });

  it("excludes a round's pick whose file is missing from disk, leaving musicUnderVo unmeasured (§18.4)", async () => {
    const { root, project, picks: basePicks } = await fixture();
    project.lanes = project.lanes.filter((l) => l.stage !== "voice");
    project.lanes.push({ id: "voice", stage: "voice", name: "Voiceover", variants: [{ id: "alt", name: "Alt read", file: "audio/does-not-exist-vo.wav", meta: {}, cues: [] }] });
    const picks: Picks = { ...basePicks, lanes: { ...basePicks.lanes, voice: "alt" } };
    const run: LoudnessRunner = async (args) => (args[0] === "-version" ? { code: 0, stderr: "" } : { code: 0, stderr: ebur(-20) });
    const result = await measureMix(project, picks, ["voice", "music"], root, run);
    expect(result.musicUnderVo).toBeNull();
  });

  it("trims music-under-VO to a picked voice variant's own length, not the takes' span (I1)", async () => {
    const { root, project, picks } = await fixture();
    const withPick: Picks = { ...picks, lanes: { ...picks.lanes, voice: "alt" } };
    const probed: string[] = [];
    const durationOf = async (file: string) => {
      probed.push(file);
      return 7.5;
    };
    let trimArgs: string[] | undefined;
    const run: LoudnessRunner = async (args) => {
      if (args[0] === "-version") return { code: 0, stderr: "" };
      if (args.includes("-t")) trimArgs = args;
      return { code: 0, stderr: ebur(args.includes("-t") ? -14 : -18) };
    };
    const result = await measureMix(project, withPick, ["voice", "music"], root, run, 60_000, durationOf);
    expect(probed).toEqual([join(root, "audio", "voice-alt.wav")]);
    // The takes would give 8 s (s2 at 5, plus its 3 s); the variant read is 7.5 s.
    expect(trimArgs![trimArgs!.indexOf("-t") + 1]).toBe("7.500");
    expect(result.musicUnderVo).toBe(4);
  });

  it("measures music under a whole-read voice variant even with no takes at all (I1)", async () => {
    const { root, project, picks } = await fixture();
    const withPick: Picks = { ...picks, lanes: { ...picks.lanes, voice: "alt" } };
    let trimArgs: string[] | undefined;
    const run: LoudnessRunner = async (args) => {
      if (args[0] === "-version") return { code: 0, stderr: "" };
      if (args.includes("-t")) trimArgs = args;
      return { code: 0, stderr: ebur(args.includes("-t") ? -14 : -18) };
    };
    const result = await measureMix(project, withPick, ["voice", "music"], root, run, 60_000, async () => 12);
    expect(trimArgs![trimArgs!.indexOf("-t") + 1]).toBe("12.000");
    expect(result.musicUnderVo).toBe(4);
  });

  it("leaves music-under-VO null when a picked voice variant's length can't be told", async () => {
    const { root, project, picks } = await fixture();
    const withPick: Picks = { ...picks, lanes: { ...picks.lanes, voice: "alt" } };
    const calls: string[][] = [];
    const run: LoudnessRunner = async (args) => {
      calls.push(args);
      return args[0] === "-version" ? { code: 0, stderr: "" } : { code: 0, stderr: ebur(-16) };
    };
    const result = await measureMix(project, withPick, ["voice", "music"], root, run, 60_000, async () => null);
    expect(result).toEqual({ available: true, integrated: -16, truePeak: -6, musicUnderVo: null, silent: false });
    expect(calls.filter((a) => a.includes("-t"))).toEqual([]); // never trimmed to a guess
  });

  it("re-measures when a newer round's pick takes over, since the VO span moved (M1, §18.4)", async () => {
    const { root, project, picks } = await fixture();
    project.lanes = project.lanes.filter((l) => l.stage !== "voice");
    project.lanes.push(
      { id: "round-1", stage: "voice", name: "Round 1", variants: [{ id: "a", name: "A", file: "audio/voice-alt.wav", meta: {}, cues: [] }] },
      { id: "round-2", stage: "voice", name: "Round 2", variants: [{ id: "b", name: "B", file: "audio/music-a.wav", meta: {}, cues: [] }] },
    );
    const trims: string[] = [];
    const run: LoudnessRunner = async (args) => {
      if (args[0] === "-version") return { code: 0, stderr: "" };
      if (args.includes("-t")) trims.push(args[args.indexOf("-t") + 1]);
      return { code: 0, stderr: ebur(-20) };
    };
    const durationOf = async (file: string) => (file.endsWith("voice-alt.wav") ? 5 : 6);
    // Round 1 has the only pick: its variant's own length is the span.
    await measureMix(project, { ...picks, lanes: { ...picks.lanes, "round-1": "a" } }, ["voice", "music"], root, run, 60_000, durationOf);
    // Round 2 (newer) now has a pick too, so it wins and the span moves to its own length.
    await measureMix(project, { ...picks, lanes: { ...picks.lanes, "round-1": "a", "round-2": "b" } }, ["voice", "music"], root, run, 60_000, durationOf);
    expect(trims).toEqual(["5.000", "6.000"]);
  });

  it("never caches a run ffmpeg failed, so a later request measures again (M2)", async () => {
    const { root, project, picks } = await fixture();
    let attempts = 0;
    const run: LoudnessRunner = async (args) => {
      if (args[0] === "-version") return { code: 0, stderr: "" };
      attempts++;
      // First attempt: an older ffmpeg rejecting the filter graph -- nonzero, nothing parsed.
      return attempts === 1 ? { code: 1, stderr: "Option 'normalize' not found" } : { code: 0, stderr: ebur(-16) };
    };
    const first = await measureMix(project, picks, ["music"], root, run);
    expect(first.integrated).toBeNull();
    const second = await measureMix(project, picks, ["music"], root, run);
    expect(second.integrated).toBe(-16);
    expect(attempts).toBe(2);
    // A good reading is cached as before.
    await measureMix(project, picks, ["music"], root, run);
    expect(attempts).toBe(2);
  });

  it("two requests for the same mix while it's measuring share one ffmpeg run (M3)", async () => {
    const { root, project, picks } = await fixture();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const run: LoudnessRunner = async (args) => {
      if (args[0] === "-version") return { code: 0, stderr: "" };
      runs++;
      await gate;
      return { code: 0, stderr: ebur(-16) };
    };
    const a = measureMix(project, picks, ["music"], root, run);
    const b = measureMix(project, picks, ["music"], root, run);
    // Let both requests get past their stat() and cache lookups before the run finishes.
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(runs).toBe(1);
  });

  it("aborts the runner's signal on timeout, so a hung ffmpeg is actually killed, and rejects with a 504", async () => {
    const { root, project, picks } = await fixture();
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
    await expect(measureMix(project, picks, ["music"], root, run, 50)).rejects.toMatchObject({
      status: 504,
      code: "loudness_timeout",
    });
    expect(aborted).toBe(true);
    expect(await expect(measureMix(project, picks, ["music"], root, run, 50)).rejects.toBeInstanceOf(LoudnessTimeoutError));
  });

  it("never 500s when a file's stat fails after mixInputs already found it on disk (a TOCTOU race)", async () => {
    const { root, project, picks } = await fixture();
    // mixInputs' own existsSync check still sees the file (it's never deleted); only cacheKey's
    // very next stat() call fails, simulating the race it can lose. measureMix must still return
    // a real result -- just not cache it -- rather than ever surfacing as a 500.
    vi.mocked(stat).mockRejectedValueOnce(new Error("ENOENT (simulated race)"));
    const run: LoudnessRunner = async (args) => (args[0] === "-version" ? { code: 0, stderr: "" } : { code: 0, stderr: ebur(-20) });
    await expect(measureMix(project, picks, ["music"], root, run)).resolves.toMatchObject({ available: true, integrated: -20 });
  });
});
