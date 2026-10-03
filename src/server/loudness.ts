import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { RushesError } from "../core/errors.js";
import { fromManifestPath } from "../core/paths.js";
import type { LaneStage, Picks, Project, Script } from "../core/schema.js";

export interface LoudnessRunner {
  (args: string[]): Promise<{ code: number; stderr: string }>;
}

/** Spawns ffmpeg with an argument array -- never through a shell (global constraints). */
export const defaultRunner: LoudnessRunner = (args) =>
  new Promise((resolve) => {
    let stderr = "";
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    // ENOENT (ffmpeg not on PATH) and any other spawn failure both just mean "not available".
    child.on("error", () => resolve({ code: 1, stderr }));
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });

// "Detect it once per server": keyed by the runner's own identity, so the one shared
// defaultRunner (and whichever single fake a test or a server instance injects) is probed at
// most once for its lifetime, while two different runners -- two tests' two fakes, say -- never
// share a result.
const availability = new WeakMap<LoudnessRunner, Promise<boolean>>();

export function ffmpegAvailable(run: LoudnessRunner = defaultRunner): Promise<boolean> {
  let cached = availability.get(run);
  if (!cached) {
    cached = run(["-version"]).then(
      (r) => r.code === 0,
      () => false,
    );
    availability.set(run, cached);
  }
  return cached;
}

export interface MixInput {
  /** Absolute path. */
  file: string;
  /** Seconds from the start of the mix. */
  offset: number;
  stage: LaneStage;
}

/**
 * The files and offsets a mix of `lanes` is made from (§17.6):
 * - voice: each script section's picked take (or its newest) at the section's start, plus any
 *   picked whole-read voice variant at 0;
 * - music: the picked (or first) variant of each music lane, at 0;
 * - sfx: the picked (or first) variant of each sfx lane, at 0.
 *
 * A manifest entry whose file is missing from disk is left out rather than handed to ffmpeg.
 */
export function mixInputs(project: Project, script: Script, picks: Picks, lanes: LaneStage[], root: string): MixInput[] {
  const want = new Set(lanes);
  const out: MixInput[] = [];
  const add = (file: string, offset: number, stage: LaneStage) => {
    const abs = fromManifestPath(root, file);
    if (existsSync(abs)) out.push({ file: abs, offset, stage });
  };

  if (want.has("voice")) {
    for (const s of script.sections) {
      if (s.takes.length === 0) continue;
      const pickedId = picks.sections[s.id];
      const take = (pickedId && s.takes.find((t) => t.id === pickedId)) || s.takes[s.takes.length - 1];
      add(take.file, s.start, "voice");
    }
    for (const lane of project.lanes) {
      if (lane.stage !== "voice") continue;
      const pickedId = picks.lanes[lane.id];
      const variant = pickedId ? lane.variants.find((v) => v.id === pickedId) : undefined;
      if (variant) add(variant.file, 0, "voice");
    }
  }

  for (const stage of ["music", "sfx"] as const) {
    if (!want.has(stage)) continue;
    for (const lane of project.lanes) {
      if (lane.stage !== stage || lane.variants.length === 0) continue;
      const pickedId = picks.lanes[lane.id];
      const variant = (pickedId && lane.variants.find((v) => v.id === pickedId)) || lane.variants[0];
      add(variant.file, 0, stage);
    }
  }

  return out;
}

function inputArgs(inputs: MixInput[]): string[] {
  return inputs.flatMap((i) => ["-i", i.file]);
}

function filterComplex(inputs: MixInput[]): string {
  const delays = inputs.map((inp, i) => `[${i}]adelay=${Math.round(inp.offset * 1000)}:all=1[a${i}]`);
  const labels = inputs.map((_, i) => `[a${i}]`).join("");
  return `${delays.join(";")};${labels}amix=inputs=${inputs.length}:normalize=0,ebur128=peak=true`;
}

/** The ffmpeg argument array that mixes `inputs` down at their offsets and measures loudness over all of it. */
export function loudnessArgs(inputs: MixInput[]): string[] {
  return ["-nostats", ...inputArgs(inputs), "-filter_complex", filterComplex(inputs), "-f", "null", "-"];
}

/** As `loudnessArgs`, but stops measuring at `seconds` -- used to compare a lane against the VO's own span. */
function loudnessArgsTrimmed(inputs: MixInput[], seconds: number): string[] {
  return ["-nostats", ...inputArgs(inputs), "-filter_complex", filterComplex(inputs), "-t", seconds.toFixed(3), "-f", "null", "-"];
}

/** Pulls the integrated loudness (LUFS) and true peak (dBTP) out of an `ebur128=peak=true` summary block. */
export function parseEbur128(stderr: string): { integrated: number | null; truePeak: number | null } {
  const integrated = stderr.match(/Integrated loudness:\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  const truePeak = stderr.match(/True peak:\s*Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/);
  return {
    integrated: integrated ? Number(integrated[1]) : null,
    truePeak: truePeak ? Number(truePeak[1]) : null,
  };
}

export class LoudnessTimeoutError extends RushesError {
  constructor(ms: number) {
    super(`ffmpeg didn't finish within ${ms} ms`, 504, "loudness_timeout");
  }
}

async function runWithTimeout(run: LoudnessRunner, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LoudnessTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([run(args), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The VO's own span: from 0 to the latest point any used take reaches, worked out from script
 *  data alone (never a probe) -- a take's known duration, or its section's length when the
 *  take's duration isn't known yet. */
function voSpanSeconds(script: Script, picks: Picks): number {
  let end = 0;
  for (const s of script.sections) {
    if (s.takes.length === 0) continue;
    const pickedId = picks.sections[s.id];
    const take = (pickedId && s.takes.find((t) => t.id === pickedId)) || s.takes[s.takes.length - 1];
    const duration = take.duration ?? s.end - s.start;
    end = Math.max(end, s.start + duration);
  }
  return end;
}

export interface LoudnessResult {
  available: boolean;
  integrated: number | null;
  truePeak: number | null;
  musicUnderVo: number | null;
}

// Keyed by runner identity, same reasoning as `availability` above: one cache per server, capped
// at 50 entries (simple insertion-order eviction -- re-set on a hit to refresh its recency).
const CACHE_LIMIT = 50;
const mixCaches = new WeakMap<LoudnessRunner, Map<string, LoudnessResult>>();

function remember(run: LoudnessRunner, key: string, value: LoudnessResult): void {
  let cache = mixCaches.get(run);
  if (!cache) {
    cache = new Map();
    mixCaches.set(run, cache);
  }
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Sorted (abs path, mtime, offset) for every input, plus the lanes asked for. */
async function cacheKey(inputs: MixInput[], lanes: LaneStage[]): Promise<string> {
  const stats = await Promise.all(
    inputs.map(async (i) => ({ file: i.file, offset: i.offset, mtimeMs: (await stat(i.file)).mtimeMs })),
  );
  stats.sort((a, b) => a.file.localeCompare(b.file) || a.offset - b.offset);
  return JSON.stringify({ lanes: [...lanes].sort(), inputs: stats });
}

/**
 * Mixes the picked files for `lanes` and measures loudness: `integrated` (LUFS) and `truePeak`
 * (dBTP) over the whole mix, plus `musicUnderVo` -- the music's level relative to the VO, each
 * measured alone over the VO's own span -- whenever both a voice and a music lane are present
 * among the inputs. Runs at most three ffmpeg invocations, each through `run` and each killed
 * after `timeoutMs`. Results are cached per `run`, by the inputs' paths, mtimes and offsets plus
 * the lanes asked for. Returns `{ available: false, ... }` without touching the filesystem
 * further when ffmpeg isn't on PATH.
 */
export async function measureMix(
  project: Project,
  script: Script,
  picks: Picks,
  lanes: LaneStage[],
  root: string,
  run: LoudnessRunner = defaultRunner,
  timeoutMs = 60_000,
): Promise<LoudnessResult> {
  if (!(await ffmpegAvailable(run))) return { available: false, integrated: null, truePeak: null, musicUnderVo: null };

  const inputs = mixInputs(project, script, picks, lanes, root);
  if (inputs.length === 0) return { available: true, integrated: null, truePeak: null, musicUnderVo: null };

  const key = await cacheKey(inputs, lanes);
  const cached = mixCaches.get(run)?.get(key);
  if (cached) return cached;

  const full = parseEbur128((await runWithTimeout(run, loudnessArgs(inputs), timeoutMs)).stderr);

  const voiceInputs = inputs.filter((i) => i.stage === "voice");
  const musicInputs = inputs.filter((i) => i.stage === "music");
  let musicUnderVo: number | null = null;
  if (voiceInputs.length > 0 && musicInputs.length > 0) {
    const span = voSpanSeconds(script, picks);
    const vo = parseEbur128((await runWithTimeout(run, loudnessArgs(voiceInputs), timeoutMs)).stderr).integrated;
    const music = parseEbur128((await runWithTimeout(run, loudnessArgsTrimmed(musicInputs, span), timeoutMs)).stderr).integrated;
    if (vo !== null && music !== null) musicUnderVo = music - vo;
  }

  const result: LoudnessResult = { available: true, integrated: full.integrated, truePeak: full.truePeak, musicUnderVo };
  remember(run, key, result);
  return result;
}
