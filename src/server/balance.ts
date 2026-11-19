// §29: auto-balance on the server. Reads each take in use (voice, music, effects) with ffmpeg's ebur128 -- the full
// band, and for voice and music the speech band too -- and hands the readings to the house rule (core/balance.ts).
import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { balance, parseFrames, SPEECH_BAND, trimmed, type Balance, type Reading, type TakeReadings } from "../core/balance.js";
import { AUDIO_FORMATS } from "../core/media.js";
import { fromManifestPath } from "../core/paths.js";
import { inUse, inUseVariant } from "../core/picks.js";
import type { LaneStage, Picks, Project } from "../core/schema.js";
import { defaultRunner, ffmpegAvailable, loudnessArgs, LoudnessTimeoutError, parseEbur128, type LoudnessRunner, type MixInput } from "./loudness.js";

/** The ffmpeg arguments that read one file's loudness over time, optionally through the speech band. */
export function readingArgs(file: string, band: boolean): string[] {
  const filter = `${band ? `highpass=f=${SPEECH_BAND.low},lowpass=f=${SPEECH_BAND.high},` : ""}ebur128`;
  return ["-nostats", "-protocol_whitelist", "file", "-format_whitelist", AUDIO_FORMATS, "-i", file, "-af", filter, "-f", "null", "-"];
}

/** One ffmpeg run, killed (and a 504) past `timeoutMs`. */
async function timed(run: LoudnessRunner, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
  const controller = new AbortController();
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_r, reject) => {
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

async function read(run: LoudnessRunner, file: string, band: boolean, timeoutMs: number): Promise<Reading> {
  const r = await timed(run, readingArgs(file, band), timeoutMs);
  const { integrated } = parseEbur128(r.stderr);
  return { integrated: integrated !== null && Number.isFinite(integrated) ? integrated : null, frames: parseFrames(r.stderr) };
}

// One reading per (file, mtime, band), per runner: the same take is read once however often the balance runs.
const CACHE_LIMIT = 60;
const caches = new WeakMap<LoudnessRunner, Map<string, Reading>>();

async function cachedRead(run: LoudnessRunner, file: string, band: boolean, timeoutMs: number): Promise<Reading> {
  let key: string | null = null;
  try {
    key = JSON.stringify([file, (await stat(file)).mtimeMs, band]);
  } catch {
    key = null;
  }
  let cache = caches.get(run);
  if (!cache) caches.set(run, (cache = new Map()));
  if (key !== null) {
    const hit = cache.get(key);
    if (hit) return hit;
  }
  const reading = await read(run, file, band, timeoutMs);
  if (key !== null && reading.frames.length > 0) {
    cache.set(key, reading);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  }
  return reading;
}

/** Files (absolute) to balance, one per sound. */
export type BalanceFiles = Partial<Record<LaneStage, string>>;

/**
 * The house balance for these files. Voice and music are read in the speech band too. Then the balanced mix is measured
 * once, and brought down together if it would peak over BALANCE.peakCeiling.
 */
export async function balanceFiles(files: BalanceFiles, run: LoudnessRunner = defaultRunner, timeoutMs = 60_000): Promise<Balance> {
  const takes: Partial<Record<LaneStage, TakeReadings>> = {};
  await Promise.all(
    (Object.entries(files) as [LaneStage, string][]).map(async ([stage, file]) => {
      const banded = stage !== "sfx" && files.voice !== undefined && files.music !== undefined;
      const [full, band] = await Promise.all([cachedRead(run, file, false, timeoutMs), banded ? cachedRead(run, file, true, timeoutMs) : undefined]);
      takes[stage] = band ? { full, band } : { full };
    }),
  );
  const b = balance(takes);
  const inputs: MixInput[] = (Object.entries(files) as [LaneStage, string][])
    .filter(([stage]) => b.levels[stage] !== undefined)
    .map(([stage, file]) => ({ file, offset: 0, stage, gainDb: b.levels[stage]! }));
  if (inputs.length === 0) return b;
  const { truePeak } = parseEbur128((await timed(run, loudnessArgs(inputs), timeoutMs)).stderr);
  return trimmed(b, truePeak);
}

/** The take in use for each sound (as Mix plays them), whose file is on disk. */
export function takesInUse(project: Project, picks: Picks, root: string): BalanceFiles {
  const use = inUse(project, picks);
  const files: BalanceFiles = {};
  for (const stage of ["voice", "music", "sfx"] as const) {
    const taken = inUseVariant(project, use, stage);
    if (!taken) continue;
    const abs = fromManifestPath(root, taken.variant.file);
    if (existsSync(abs)) files[stage] = abs;
  }
  return files;
}

export type FilmBalance = ({ available: true } & Balance) | { available: false };

/** The house balance for a film's takes in use; `available: false` without ffmpeg. */
export async function balanceFilm(project: Project, picks: Picks, root: string, run: LoudnessRunner = defaultRunner, timeoutMs?: number): Promise<FilmBalance> {
  if (!(await ffmpegAvailable(run))) return { available: false };
  return { available: true, ...(await balanceFiles(takesInUse(project, picks, root), run, timeoutMs)) };
}
