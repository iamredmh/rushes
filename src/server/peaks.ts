import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AUDIO_FORMATS } from "../core/media.js";
import { fromManifestPath } from "../core/paths.js";
import { RUSHES_DIR, type ChangeEvent, type Store } from "../core/store.js";
import type { Project } from "../core/schema.js";
import { defaultFfmpeg, type FfmpegRunner } from "./proxy.js";

// §19.9: the Picture waveform. When a cut is added (or the dashboard asks for one that has none
// yet), ffmpeg decodes the original's audio, mono at 8 kHz, and the server reduces it to about
// 2000 peaks while it streams, so a long film never sits in memory. The result is a small JSON
// file in .rushes/peaks/, named for the cut and the file's revision, written to a temp name and
// renamed into place: a temp file never poses as a result.

/** How many peaks a cut gets, at most. */
export const PEAK_BUCKETS = 2000;
/** The sample rate ffmpeg resamples to: plenty for a 2000-bucket outline, and quick to decode. */
export const PEAK_RATE = 8000;
/** Inside .rushes/: .rushes/peaks/<video>_<version>_<hash>.json */
export const PEAKS_DIR = "peaks";
/** Waveforms are made this many at a time, like the proxy-need probes. */
export const PEAKS_CONCURRENCY = 2;
/** A decode is given at least this long, and never more than PEAKS_TIMEOUT_MAX_MS. */
export const PEAKS_TIMEOUT_MS = 5 * 60_000;
export const PEAKS_TIMEOUT_MAX_MS = 60 * 60_000;
/** The slowest a decode is expected to read the original: 5 MB a second, a slow network volume. */
const PEAKS_READ_BYTES_PER_S = 5e6;

/** How long a decode of a file this size may run before it's killed: 60 s plus the size read at 5 MB/s, held to 5–60 minutes. */
export function peaksTimeoutMs(bytes: number): number {
  const ms = 60_000 + (Math.max(0, bytes) / PEAKS_READ_BYTES_PER_S) * 1000;
  return Math.round(Math.min(PEAKS_TIMEOUT_MAX_MS, Math.max(PEAKS_TIMEOUT_MS, ms)));
}
/** A peaks file is at most this big (2000 peaks are about 12 KB); anything larger isn't read. */
export const PEAKS_MAX_BYTES = 64 * 1024;
/** How many failed revisions are remembered (so a broken file isn't decoded on every request). */
const FAILED_LIMIT = 500;
/** ffmpeg's words for a file with no audio stream to decode ("Output file #0 does not contain any stream" before 7.0). */
const NO_AUDIO = /does not contain any stream/i;

const VIDEO_ID = /^[a-z0-9][a-z0-9-]*$/;
const VERSION_ID = /^v\d+$/;
/** A peaks file this server writes. */
export const PEAKS_FILE = /^[a-z0-9][a-z0-9-]*_v\d+_[0-9a-f]{16}\.json$/;

/** The file format, version 1. A cut with no audio stream gets `{ v: 1, audio: false }`, so it isn't decoded again. */
export type PeaksFile = { v: 1; buckets: number; duration: number; peaks: number[] } | { v: 1; audio: false };

/**
 * The containers a cut may be read as: the ordinary video and audio ones. Playlist and list
 * formats (HLS, concat, and the like) are left out, so a "cut" that is really a list can't make
 * ffmpeg open other files (fix round 3, M8). One list with the probe's audio list (media.ts).
 */
export const PEAKS_FORMATS = AUDIO_FORMATS;

/**
 * ffmpeg's arguments. Only local files (`file`, and `pipe` for stdout) in ordinary containers are
 * read. The first audio stream is decoded, if there is one (`-map 0:a:0?`; with none, ffmpeg says
 * the output "does not contain any stream", which is recorded as no audio). `aresample` pads with
 * silence from 0:00 when the audio starts late, so the peaks line up with the picture. Then it's
 * mixed to mono at 8 kHz and written as raw 32-bit floats on stdout.
 */
export function peaksArgs(abs: string): string[] {
  return [
    "-hide_banner", "-nostdin", "-v", "error",
    "-protocol_whitelist", "file,pipe",
    "-format_whitelist", PEAKS_FORMATS,
    "-i", abs,
    "-map", "0:a:0?", "-vn", "-sn", "-dn",
    "-af", "aresample=async=1:first_pts=0",
    "-ac", "1", "-ar", String(PEAK_RATE), "-f", "f32le", "pipe:1",
  ];
}

/**
 * Reduces a stream of f32le samples to at most `buckets` peaks (the largest absolute amplitude in
 * each), without knowing the length up front. Samples go into blocks; when 2 × `buckets` blocks
 * are full, neighbouring pairs merge and the block size doubles, so memory stays fixed however
 * long the film. `finish` maps the blocks onto the buckets by time and normalises to 0..1.
 */
export class PeakReducer {
  private readonly cap: number;
  private readonly blocks: Float64Array;
  private count = 0;
  private blockSize = 1;
  private inBlock = 0;
  private current = 0;
  private carry: Buffer | null = null;
  private samples = 0;

  constructor(
    readonly buckets = PEAK_BUCKETS,
    readonly rate = PEAK_RATE,
  ) {
    this.cap = Math.max(2, buckets * 2);
    this.blocks = new Float64Array(this.cap);
  }

  /** Adds a chunk of stdout. A float split across two chunks is carried over to the next. */
  push(chunk: Buffer): void {
    let buf = chunk;
    if (this.carry) {
      buf = Buffer.concat([this.carry, chunk]);
      this.carry = null;
    }
    const whole = buf.length - (buf.length % 4);
    for (let o = 0; o < whole; o += 4) this.sample(buf.readFloatLE(o));
    if (whole < buf.length) this.carry = Buffer.from(buf.subarray(whole));
  }

  /** How many blocks are held right now (never more than 2 × buckets). For tests. */
  held(): number {
    return this.count;
  }

  private sample(v: number): void {
    const a = Number.isFinite(v) ? Math.abs(v) : 0;
    if (a > this.current) this.current = a;
    this.samples++;
    if (++this.inBlock === this.blockSize) this.close();
  }

  private close(): void {
    this.blocks[this.count++] = this.current;
    this.current = 0;
    this.inBlock = 0;
    if (this.count === this.cap) {
      for (let i = 0; i < this.cap / 2; i++) this.blocks[i] = Math.max(this.blocks[2 * i], this.blocks[2 * i + 1]);
      this.count = this.cap / 2;
      this.blockSize *= 2;
    }
  }

  /** The peaks, normalised so the loudest is 1 and rounded to 3 decimals; silence is all zeros. */
  finish(): { peaks: number[]; samples: number; duration: number } {
    if (this.inBlock > 0) this.close();
    const total = this.samples;
    const n = Math.min(this.buckets, this.count);
    const raw = new Array<number>(n).fill(0);
    const size = this.blockSize;
    for (let i = 0; i < n; i++) {
      // Each block belongs to the bucket its first sample falls in, so a loud moment lands in one bucket.
      const from = (i * total) / n;
      const to = ((i + 1) * total) / n;
      let a = Math.ceil(from / size);
      let b = Math.min(this.count, Math.ceil(to / size));
      if (b <= a) {
        a = Math.min(this.count - 1, Math.floor(from / size));
        b = a + 1;
      }
      let peak = 0;
      for (let k = a; k < b; k++) if (this.blocks[k] > peak) peak = this.blocks[k];
      raw[i] = peak;
    }
    const max = raw.reduce((m, p) => (p > m ? p : m), 0);
    const peaks = raw.map((p) => (max > 0 ? Math.round((p / max) * 1000) / 1000 : 0));
    return { peaks, samples: total, duration: Math.round((total / this.rate) * 1000) / 1000 };
  }
}

/** A revision of the original: path, size and mtime, as a short hash for the file name. */
export function peaksHash(file: string, size: number, mtimeMs: number): string {
  return createHash("sha256").update(`${file}\0${size}\0${mtimeMs}`).digest("hex").slice(0, 16);
}

/** What the route answers for a cut. */
export type PeaksAnswer =
  | { state: "ready"; data: Extract<PeaksFile, { peaks: number[] }> }
  | { state: "computing" }
  | { state: "silent" }
  | { state: "missing" }
  | { state: "failed"; reason: string };

export interface PeakJobsOptions {
  /** Runs ffmpeg. Defaults to a real spawn. */
  run?: FfmpegRunner;
  /** Whether ffmpeg is there. Defaults to running `ffmpeg -version` once. */
  available?: () => Promise<boolean>;
  /** Kills a decode after this long. Defaults to `peaksTimeoutMs` of the original's size. */
  timeoutMs?: number;
  /** Peaks per cut. Defaults to 2000. */
  buckets?: number;
}

interface Item {
  size: number;
  video: string;
  version: string;
  file: string;
  abs: string;
  hash: string;
  name: string;
}

/**
 * The waveform jobs of one server: a queue, two at a time, never awaited by GET /api/state.
 * Every decode is killed when the server closes. When a peaks file lands, a `change` goes out so
 * every open tab asks again.
 */
export class PeakJobs {
  private readonly run: FfmpegRunner;
  private readonly isAvailable: () => Promise<boolean>;
  private availableOnce: Promise<boolean> | null = null;
  private readonly timeoutMs: number | undefined;
  private readonly buckets: number;
  private readonly queue = new Map<string, Item>();
  private readonly running = new Map<string, AbortController>();
  private readonly failed = new Map<string, string>();
  private closing = false;
  private idleWaiter: { promise: Promise<void>; resolve: () => void } | null = null;

  constructor(
    private readonly store: Store,
    opts: PeakJobsOptions = {},
  ) {
    this.run = opts.run ?? defaultFfmpeg;
    this.timeoutMs = opts.timeoutMs;
    // Never more than PEAK_BUCKETS: readSaved refuses anything longer, so a bigger file would be made forever.
    this.buckets = Math.max(1, Math.min(PEAK_BUCKETS, Math.floor(opts.buckets ?? PEAK_BUCKETS)));
    const run = this.run;
    this.isAvailable = opts.available ?? (async () => (await run(["-version"])).code === 0);
  }

  /** .rushes/peaks */
  get dir(): string {
    return join(this.store.dir, PEAKS_DIR);
  }

  /** Whether ffmpeg is there. Checked once per server. */
  available(): Promise<boolean> {
    this.availableOnce ??= Promise.resolve()
      .then(() => this.isAvailable())
      .catch(() => false);
    return this.availableOnce;
  }

  /**
   * The waveform for a cut: ready, still being made, none (no audio stream), or why not. A cut
   * with nothing on disk yet is queued and answered "computing" straight away: nothing here
   * waits on ffmpeg.
   */
  async answer(video: string, version: string, file: string): Promise<PeaksAnswer> {
    if (!(await this.available())) return { state: "failed", reason: "ffmpeg isn't installed" };
    const item = await this.item(video, version, file);
    if (!item) return { state: "missing" };
    if (item === "unnamed") return { state: "failed", reason: "Rushes can't name a waveform for this cut" };
    if (this.queue.has(item.name) || this.running.has(item.name)) return { state: "computing" };
    const reason = this.failed.get(item.name);
    if (reason !== undefined) return { state: "failed", reason };
    const saved = await this.readSaved(item.name);
    if (saved) return "audio" in saved ? { state: "silent" } : { state: "ready", data: saved };
    this.enqueue(item);
    return { state: "computing" };
  }

  /** Queues a cut that has no waveform yet (a cut just added). Returns once queued; never waits on the decode. */
  async queueCut(video: string, version: string, file: string): Promise<void> {
    if (this.closing || !(await this.available())) return;
    const item = await this.item(video, version, file);
    if (!item || item === "unnamed") return;
    if (this.queue.has(item.name) || this.running.has(item.name) || this.failed.has(item.name)) return;
    if (await this.readSaved(item.name)) return;
    this.enqueue(item);
  }

  /** Resolves once nothing is queued or running. For tests. */
  idle(): Promise<void> {
    if (this.queue.size === 0 && this.running.size === 0) return Promise.resolve();
    if (!this.idleWaiter) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      this.idleWaiter = { promise, resolve };
    }
    return this.idleWaiter.promise;
  }

  /** Stops taking new work, drops the queue and kills every decode in flight. Used when the server closes. */
  async close(): Promise<void> {
    this.closing = true;
    this.queue.clear();
    for (const c of this.running.values()) c.abort();
    await this.idle();
  }

  private async item(video: string, version: string, file: string): Promise<Item | "unnamed" | null> {
    // A hand-edited id ("../x") must never name a file outside peaks/.
    if (!VIDEO_ID.test(video) || !VERSION_ID.test(version)) return "unnamed";
    const abs = fromManifestPath(this.store.root, file);
    let info;
    try {
      info = await stat(abs);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;
    const hash = peaksHash(file, info.size, info.mtimeMs);
    return { video, version, file, abs, hash, size: info.size, name: `${video}_${version}_${hash}.json` };
  }

  /** A peaks file on disk, or null when there's none (or it doesn't read as one: it's made again). */
  private async readSaved(name: string): Promise<PeaksFile | null> {
    let text: string;
    try {
      const path = join(this.dir, name);
      const info = await stat(path);
      if (!info.isFile() || info.size > PEAKS_MAX_BYTES) return null;
      text = await readFile(path, "utf8");
    } catch {
      return null;
    }
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      if (j.v !== 1) return null;
      if (j.audio === false) return { v: 1, audio: false };
      const peaks = j.peaks;
      if (
        typeof j.duration === "number" && Number.isFinite(j.duration) && j.duration >= 0 &&
        Array.isArray(peaks) && peaks.length > 0 && peaks.length <= PEAK_BUCKETS && peaks.length === j.buckets &&
        peaks.every((p) => typeof p === "number" && p >= 0 && p <= 1)
      ) {
        return { v: 1, buckets: peaks.length, duration: j.duration, peaks: peaks as number[] };
      }
    } catch {
      /* not JSON: made again */
    }
    return null;
  }

  private enqueue(item: Item): void {
    // Two callers (an add and a tab, or two tabs) can both get here for the same cut: one decode.
    if (this.closing || this.queue.has(item.name) || this.running.has(item.name)) return;
    this.queue.set(item.name, item);
    this.pump();
  }

  private pump(): void {
    while (!this.closing && this.running.size < PEAKS_CONCURRENCY && this.queue.size > 0) {
      const [name, item] = this.queue.entries().next().value!;
      this.queue.delete(name);
      const controller = new AbortController();
      this.running.set(name, controller);
      void this.make(item, controller).finally(() => {
        if (this.running.get(name) === controller) this.running.delete(name);
        this.pump();
        if (this.queue.size === 0 && this.running.size === 0 && this.idleWaiter) {
          this.idleWaiter.resolve();
          this.idleWaiter = null;
        }
      });
    }
  }

  private remember(name: string, reason: string): void {
    this.failed.delete(name);
    this.failed.set(name, reason);
    while (this.failed.size > FAILED_LIMIT) this.failed.delete(this.failed.keys().next().value!);
  }

  private async make(item: Item, controller: AbortController): Promise<void> {
    const reducer = new PeakReducer(this.buckets);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs ?? peaksTimeoutMs(item.size));
    let res: { code: number; stderr: string };
    try {
      res = await this.run(peaksArgs(item.abs), { signal: controller.signal, onStdout: (c) => reducer.push(c) });
    } catch (e) {
      res = { code: 1, stderr: (e as Error).message };
    } finally {
      clearTimeout(timer);
    }
    // Closing: nothing is recorded, and the next start makes it again.
    if (this.closing && !timedOut) return;
    if (timedOut) return this.remember(item.name, "ffmpeg took too long reading the audio");

    let record: PeaksFile;
    if (res.code !== 0) {
      if (!NO_AUDIO.test(res.stderr)) return this.remember(item.name, lastLine(res.stderr));
      record = { v: 1, audio: false };
    } else {
      const out = reducer.finish();
      record = out.samples === 0 ? { v: 1, audio: false } : { v: 1, buckets: out.peaks.length, duration: out.duration, peaks: out.peaks };
    }

    // The file changed while it was being read: this answer is for a revision that's gone.
    const now = await this.item(item.video, item.version, item.file).catch(() => null);
    if (!now || now === "unnamed" || now.name !== item.name) return;

    const tmp = join(this.dir, `.${item.name}.${randomUUID()}.tmp`);
    try {
      // Not recursive: if .rushes/ itself has gone, nothing is written.
      await mkdir(this.dir).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "EEXIST") throw e;
      });
      if (!(await realPeaksDir(this.dir))) throw new Error(".rushes/peaks isn't a folder Rushes can write to");
      await writeFile(tmp, JSON.stringify(record));
      await rename(tmp, join(this.dir, item.name));
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      return this.remember(item.name, `Couldn't save the waveform: ${(e as Error).message}`);
    }
    await this.removeStale(item);
    await this.announce();
  }

  /** Every other revision's peaks for the same cut. */
  private async removeStale(item: Item): Promise<void> {
    const prefix = `${item.video}_${item.version}_`;
    if (!(await realPeaksDir(this.dir))) return;
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    const stale = names.filter((n) => n !== item.name && n.startsWith(prefix) && PEAKS_FILE.test(n));
    await Promise.all(stale.map((n) => rm(join(this.dir, n), { force: true }).catch(() => undefined)));
  }

  /** A `change` for project.json at its current rev, so every tab asks for its waveform again. */
  private async announce(): Promise<void> {
    try {
      const { rev } = await this.store.read("project");
      this.store.emit("change", { file: "project", rev } satisfies ChangeEvent);
    } catch {
      // project.json unreadable right now: the watcher reports that.
    }
  }
}

/**
 * Whether .rushes/peaks is a real folder, not a link to one somewhere else (fix round 3, M3).
 * Nothing is saved into, swept from or cleaned out of a peaks folder that isn't.
 */
async function realPeaksDir(dir: string): Promise<boolean> {
  const info = await lstat(dir).catch(() => null);
  return !!info && info.isDirectory() && !info.isSymbolicLink();
}

function lastLine(stderr: string): string {
  const lines = stderr.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  return last ? `ffmpeg couldn't read the audio: ${last.slice(0, 300)}` : "ffmpeg couldn't read the audio";
}

/**
 * Start-up clean-up: a server stopped while saving a waveform may leave a temp file behind in
 * .rushes/peaks/. Nothing reads one, but it goes. Returns the names removed.
 */
export async function removePeakTemps(root: string): Promise<string[]> {
  const dir = join(root, RUSHES_DIR, PEAKS_DIR);
  if (!(await realPeaksDir(dir))) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const temps = names.filter((n) => n.endsWith(".tmp"));
  await Promise.all(temps.map((n) => rm(join(dir, n), { force: true }).catch(() => undefined)));
  return temps;
}

/**
 * Start-up clean-up: a peaks file whose cut is no longer in the project (a film or version
 * removed by hand) is deleted. A file belongs to a cut when it starts `<video>_<version>_`, the
 * trailing underscore included, so v1 never claims v10's file. Only files with a name Rushes
 * writes (PEAKS_FILE), directly inside a real .rushes/peaks/ folder, are ever removed. Returns
 * the names removed.
 */
export async function removeOrphanPeaks(root: string, project: Project): Promise<string[]> {
  const dir = join(root, RUSHES_DIR, PEAKS_DIR);
  if (!(await realPeaksDir(dir))) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const owners = project.videos.flatMap((v) => v.versions.map((ver) => `${v.id}_${ver.id}_`));
  const orphans: string[] = [];
  for (const n of names) {
    // Only names Rushes writes; anything else in the folder is someone else's.
    if (!PEAKS_FILE.test(n) || owners.some((prefix) => n.startsWith(prefix))) continue;
    const info = await lstat(join(dir, n)).catch(() => null);
    if (!info || info.isDirectory()) continue;
    orphans.push(n);
  }
  await Promise.all(orphans.map((n) => rm(join(dir, n), { force: true }).catch(() => undefined)));
  return orphans;
}
