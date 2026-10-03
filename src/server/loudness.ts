import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { RushesError } from "../core/errors.js";
import { fromManifestPath } from "../core/paths.js";
import type { LaneStage, Picks, Project, Script } from "../core/schema.js";

export interface LoudnessRunner {
  (args: string[], signal?: AbortSignal): Promise<{ code: number; stderr: string }>;
}

/** Grace period between SIGTERM and SIGKILL when a run is aborted. */
const KILL_GRACE_MS = 2_000;

/**
 * Spawns ffmpeg with an argument array -- never through a shell (global constraints). The
 * locale is pinned to `C` so ffmpeg's own text (decimal points, "LUFS"/"dBFS"/"-inf") is never
 * localised out from under `parseEbur128`. When `signal` aborts (the timeout in
 * `runWithTimeout` firing), the child is sent SIGTERM, then SIGKILL after a grace period if it's
 * still alive -- a timed-out ffmpeg must never keep running in the background.
 */
export const defaultRunner: LoudnessRunner = (args, signal) =>
  new Promise((resolve) => {
    let stderr = "";
    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
    });
    const onData = (d: Buffer) => {
      stderr += d.toString();
    };
    child.stderr.on("data", onData);

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        // Still alive past the grace period (SIGTERM ignored or still shutting down): escalate.
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
    };
    signal?.addEventListener("abort", onAbort);

    const cleanup = () => {
      child.stderr.off("data", onData);
      signal?.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
    };
    // ENOENT (ffmpeg not on PATH) and any other spawn failure both just mean "not available".
    child.on("error", () => {
      cleanup();
      resolve({ code: 1, stderr });
    });
    child.on("close", (code) => {
      cleanup();
      resolve({ code: code ?? 1, stderr });
    });
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
 * - voice: a picked whole-read voice variant *replaces* the assembled read entirely; otherwise
 *   each script section's picked take (or its newest) at the section's start. A voice variant is
 *   never used just because it's the only one, or the first -- only an explicit pick swaps in a
 *   whole alternative read.
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
    let pickedVoiceVariant: { file: string } | undefined;
    for (const lane of project.lanes) {
      if (lane.stage !== "voice") continue;
      const pickedId = picks.lanes[lane.id];
      const variant = pickedId ? lane.variants.find((v) => v.id === pickedId) : undefined;
      if (variant) {
        pickedVoiceVariant = variant;
        break;
      }
    }
    if (pickedVoiceVariant) {
      add(pickedVoiceVariant.file, 0, "voice");
    } else {
      for (const s of script.sections) {
        if (s.takes.length === 0) continue;
        const pickedId = picks.sections[s.id];
        const take = (pickedId && s.takes.find((t) => t.id === pickedId)) || s.takes[s.takes.length - 1];
        add(take.file, s.start, "voice");
      }
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

/**
 * Pulls the integrated loudness (LUFS) and true peak (dBTP) out of an `ebur128=peak=true`
 * summary block. ffmpeg prints `-inf` for either value on a fully silent mix (observed in the
 * wild for "Peak:", and documented for "I:" too on a track with no measurable blocks at all) --
 * returned here as `-Infinity`, a real (if non-finite) number, rather than `null`: `null` means
 * "couldn't find this in the output at all", `-Infinity` means "ffmpeg measured it, and it's
 * silence". `measureMix` is the layer that turns `-Infinity` into the public `silent` flag.
 */
export function parseEbur128(stderr: string): { integrated: number | null; truePeak: number | null } {
  const integrated = stderr.match(/Integrated loudness:\s*I:\s*(-inf|-?\d+(?:\.\d+)?)\s*LUFS/);
  const truePeak = stderr.match(/True peak:\s*Peak:\s*(-inf|-?\d+(?:\.\d+)?)\s*dBFS/);
  const toNumber = (m: RegExpMatchArray | null): number | null => (m ? (m[1] === "-inf" ? -Infinity : Number(m[1])) : null);
  return { integrated: toNumber(integrated), truePeak: toNumber(truePeak) };
}

export class LoudnessTimeoutError extends RushesError {
  constructor(ms: number) {
    super(`ffmpeg didn't finish within ${ms} ms`, 504, "loudness_timeout");
  }
}

/** `null` when `n` isn't a real, finite measurement (ffmpeg's `-inf`, or no reading at all). */
function finite(n: number | null): number | null {
  return n !== null && Number.isFinite(n) ? n : null;
}

/** Runs `run(args)` racing a `timeoutMs` clock. On timeout, aborts the signal passed to `run` --
 *  `defaultRunner` uses that to SIGTERM (then SIGKILL) the ffmpeg process -- and rejects with a
 *  `LoudnessTimeoutError` (504) rather than leaving the run abandoned in the background. */
async function runWithTimeout(run: LoudnessRunner, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
  const controller = new AbortController();
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LoudnessTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(args, controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The VO's own span: from 0 to the latest point any used take reaches, worked out from script
 *  data alone (never a probe) -- a take's known duration, or its section's length when the
 *  take's duration isn't known yet. Only counts a section whose resolved take file actually
 *  exists on disk, the same rule `mixInputs` applies, so a missing take never stretches (or
 *  shrinks) the span it's not actually contributing to the mix. */
function voSpanSeconds(script: Script, picks: Picks, root: string): number {
  let end = 0;
  for (const s of script.sections) {
    if (s.takes.length === 0) continue;
    const pickedId = picks.sections[s.id];
    const take = (pickedId && s.takes.find((t) => t.id === pickedId)) || s.takes[s.takes.length - 1];
    if (!existsSync(fromManifestPath(root, take.file))) continue;
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
  /** True when the full mix measured as digital silence (ffmpeg's `-inf`): `integrated` and
   *  `truePeak` are `null` in that case, not a stray `-Infinity` leaking into the response. */
  silent: boolean;
}

const NOT_MEASURED: Omit<LoudnessResult, "available"> = { integrated: null, truePeak: null, musicUnderVo: null, silent: false };

// Keyed by runner identity, same reasoning as `availability` above: one cache per server, capped
// at 50 entries. A real LRU -- both a hit and a set move the entry to the end of the Map's
// iteration order, so eviction (when over the cap) always drops the one actually least recently
// touched, not just the one least recently written.
const CACHE_LIMIT = 50;
const mixCaches = new WeakMap<LoudnessRunner, Map<string, LoudnessResult>>();

function cacheGet(run: LoudnessRunner, key: string): LoudnessResult | undefined {
  const cache = mixCaches.get(run);
  const value = cache?.get(key);
  if (cache && value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

function cacheSet(run: LoudnessRunner, key: string, value: LoudnessResult): void {
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

/**
 * Sorted (abs path, mtime, offset) for every input, plus the lanes asked for -- or `null` when a
 * file's `stat` fails (it existed a moment ago for `mixInputs`' own check, but could have been
 * removed since). `null` means "don't cache this one", never a thrown error: a loudness request
 * racing a file deletion must still get an answer, not a 500.
 */
async function cacheKey(inputs: MixInput[], lanes: LaneStage[]): Promise<string | null> {
  const stats: { file: string; offset: number; mtimeMs: number }[] = [];
  for (const i of inputs) {
    try {
      stats.push({ file: i.file, offset: i.offset, mtimeMs: (await stat(i.file)).mtimeMs });
    } catch {
      return null;
    }
  }
  stats.sort((a, b) => a.file.localeCompare(b.file) || a.offset - b.offset);
  return JSON.stringify({ lanes: [...lanes].sort(), inputs: stats });
}

/**
 * Mixes the picked files for `lanes` and measures loudness: `integrated` (LUFS) and `truePeak`
 * (dBTP) over the whole mix, plus `musicUnderVo` -- the music's level relative to the VO, each
 * measured alone over the VO's own span -- whenever both a voice and a music lane are present
 * among the inputs. Runs at most three ffmpeg invocations, each through `run`; each is aborted,
 * and its process killed, if it runs past `timeoutMs`, rather than left running in the
 * background. Results are cached per `run`, by the inputs' paths, mtimes and offsets plus the
 * lanes asked for (skipped when a file can't be stat'ed any more). Returns
 * `{ available: false, ... }` without touching the filesystem further when ffmpeg isn't on PATH.
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
  if (!(await ffmpegAvailable(run))) return { available: false, ...NOT_MEASURED };

  const inputs = mixInputs(project, script, picks, lanes, root);
  if (inputs.length === 0) return { available: true, ...NOT_MEASURED };

  const key = await cacheKey(inputs, lanes);
  const cached = key ? cacheGet(run, key) : undefined;
  if (cached) return cached;

  const full = parseEbur128((await runWithTimeout(run, loudnessArgs(inputs), timeoutMs)).stderr);
  // Either reading hitting -inf means there's nothing there to measure -- treat the whole
  // full-mix reading as silence rather than keeping a merely-finite other field (ffmpeg's own
  // integrated-loudness gate floors at -70 LUFS even when the true peak is genuinely -inf), which
  // would otherwise show a stray number next to `silent: true` that looks like it contradicts it.
  const silent = full.integrated === -Infinity || full.truePeak === -Infinity;

  const voiceInputs = inputs.filter((i) => i.stage === "voice");
  const musicInputs = inputs.filter((i) => i.stage === "music");
  let musicUnderVo: number | null = null;
  if (voiceInputs.length > 0 && musicInputs.length > 0) {
    const span = voSpanSeconds(script, picks, root);
    const vo = finite(parseEbur128((await runWithTimeout(run, loudnessArgs(voiceInputs), timeoutMs)).stderr).integrated);
    const music = finite(
      parseEbur128((await runWithTimeout(run, loudnessArgsTrimmed(musicInputs, span), timeoutMs)).stderr).integrated,
    );
    if (vo !== null && music !== null) musicUnderVo = music - vo;
  }

  const result: LoudnessResult = {
    available: true,
    integrated: silent ? null : finite(full.integrated),
    truePeak: silent ? null : finite(full.truePeak),
    musicUnderVo,
    silent,
  };
  if (key) cacheSet(run, key, result);
  return result;
}
