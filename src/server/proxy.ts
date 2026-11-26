import { renameRetry } from "../core/fsRetry.js";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { RushesError, NotFoundError } from "../core/errors.js";
import { VIDEO_FORMATS, hasFfprobe, probe as ffprobe, proxyNeed, type Probe } from "../core/media.js";
import { fromManifestPath } from "../core/paths.js";
import { DEFAULT_PROXY_PRESET, PRESETS, PROXY_AUDIO_KBPS, type ProxyPreset } from "../core/proxyPresets.js";
import type { Project, Version } from "../core/schema.js";
import type { ChangeEvent, Store } from "../core/store.js";

// §19.5 and §36: proxies. One job per cut, queued and run one at a time, newest cut first, with progress over SSE and a
// Cancel that kills the process and deletes the half-written file. A version's `proxy` record is set only once a render
// has completed and been renamed into place, so a `*.partial.mp4` never poses as a proxy. §36: each is made at one of
// four presets, and making one at another preset replaces the old.

/**
 * Spawns ffmpeg with an argument array, never through a shell (global constraints). Same contract
 * as loudness.ts's runner, plus stdout: `onStdout` receives it as it arrives (the `-progress
 * pipe:1` key=value lines, a PNG's bytes, or `-version`'s text). When `signal` aborts, the child
 * gets SIGTERM, then SIGKILL after a grace period if it's still alive. Tests inject a fake.
 */
export interface FfmpegRunner {
  (args: string[], opts?: { signal?: AbortSignal; onStdout?: (chunk: Buffer) => void }): Promise<{ code: number; stderr: string }>;
}

/** Grace period between SIGTERM and SIGKILL when a job is cancelled. */
export const KILL_GRACE_MS = 2_000;
/** Only the tail of ffmpeg's stderr is kept: a long encode prints a stats line twice a second. */
const STDERR_TAIL = 16_384;

/** How a runner starts a process: `child_process.spawn`'s shape, narrowed. Tests pass a fake child. */
export type Spawner = (cmd: string, args: string[], opts: { stdio: ["ignore", "pipe" | "ignore", "pipe"]; env: NodeJS.ProcessEnv }) => ChildProcess;

/** A runner over `spawn`. `defaultFfmpeg` is this over Node's own; tests drive the kill logic with a fake child. */
export function makeFfmpegRunner(spawn: Spawner = nodeSpawn as unknown as Spawner): FfmpegRunner {
  return (args, opts = {}) =>
    new Promise((resolve) => {
      const { signal, onStdout } = opts;
      if (signal?.aborted) {
        resolve({ code: 1, stderr: "" });
        return;
      }
      let stderr = "";
      const child = spawn("ffmpeg", args, {
        stdio: ["ignore", onStdout ? "pipe" : "ignore", "pipe"],
        env: { ...process.env, LC_ALL: "C" },
      });
      const onErr = (d: Buffer) => {
        stderr += d.toString();
        if (stderr.length > STDERR_TAIL * 2) stderr = stderr.slice(-STDERR_TAIL);
      };
      const onOut = (d: Buffer) => onStdout?.(d);
      child.stderr?.on("data", onErr);
      child.stdout?.on("data", onOut);

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
        child.stderr?.off("data", onErr);
        child.stdout?.off("data", onOut);
        signal?.removeEventListener("abort", onAbort);
        if (killTimer) clearTimeout(killTimer);
      };
      child.on("error", () => {
        cleanup();
        resolve({ code: 1, stderr });
      });
      child.on("close", (code) => {
        cleanup();
        resolve({ code: code ?? 1, stderr: stderr.slice(-STDERR_TAIL) });
      });
    });
}

export const defaultFfmpeg: FfmpegRunner = makeFfmpegRunner();

/** The visible folder proxies live in, at the project root. */
export const PROXY_DIR = "proxies";
/**
 * A proxy file this server writes: proxies/<film-slug>_<version>_proxy-<preset>.mp4 (§36.4), or §19.5's
 * proxies/<film-slug>_<version>_proxy.mp4, which still plays and can still be deleted.
 */
export const PROXY_PATH = /^proxies\/[a-z0-9][a-z0-9-]*_v\d+_proxy(?:-(?:1080h|1080l|720h|720l))?\.mp4$/;

/** "proxies/hero-60s_v3_proxy-1080l.mp4"; without a preset, §19.5's "proxies/hero-60s_v3_proxy.mp4". */
export function proxyPath(video: string, version: string, preset?: ProxyPreset): string {
  return `${PROXY_DIR}/${video}_${version}_proxy${preset ? `-${preset}` : ""}.mp4`;
}

/** The half-written file for `proxyPath`: never recorded, deleted on cancel, failure and start-up. */
export function partialPath(video: string, version: string, preset?: ProxyPreset): string {
  return `${PROXY_DIR}/${video}_${version}_proxy${preset ? `-${preset}` : ""}.partial.mp4`;
}

export interface FfmpegVersion {
  major: number;
  minor: number;
}

/** "ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright …" -> 4.4. Null for a git build ("N-112345-g…") or junk. */
export function parseFfmpegVersion(text: string): FfmpegVersion | null {
  const m = /ffmpeg version n?(\d+)\.(\d+)/.exec(text);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/** `-fps_mode` arrived in ffmpeg 5.1; before that the same option is `-vsync`. An unknown version is taken as current. */
export function hasFpsMode(v: FfmpegVersion | null): boolean {
  return v === null || v.major > 5 || (v.major === 5 && v.minor >= 1);
}

/** The H.264 encoders a proxy can be made with (§36.3). */
export type ProxyEncoder = "libx264" | "h264_videotoolbox";

/**
 * §36.3, measured on the Mac mini (ffmpeg 9.0.2): h264_videotoolbox ignores `-maxrate` (a 5 Mbps cap peaked at
 * 14 Mbps over 1 s windows; its constant-bitrate mode at 16). Every preset is capped, so VideoToolbox is never chosen
 * while this is false. Set it true only after measuring an ffmpeg that holds the cap.
 */
export const VIDEOTOOLBOX_HONOURS_PEAK = false;

/**
 * Which encoder makes a capped proxy: VideoToolbox when ffmpeg has it and it holds the peak (macOS only), otherwise
 * libx264. `encoders` is the names `ffmpeg -encoders` lists.
 */
export function chooseEncoder(encoders: readonly string[], honoursPeak = VIDEOTOOLBOX_HONOURS_PEAK): ProxyEncoder {
  return honoursPeak && encoders.includes("h264_videotoolbox") ? "h264_videotoolbox" : "libx264";
}

/** "V....D h264_videotoolbox  VideoToolbox H.264 Encoder" lines -> ["h264_videotoolbox", …]. */
export function parseEncoders(text: string): string[] {
  return text
    .split("\n")
    .map((l) => /^\s*[VAS][.A-Z]{5}\s+(\S+)/.exec(l)?.[1])
    .filter((n): n is string => !!n);
}

/**
 * §36.3: the encoder's `-maxrate`, 90% of the preset's peak. With a half-second buffer, a 1 s window can run above
 * `-maxrate` when a busy shot follows a quiet one, and how far varies between x264 builds (a Windows nightly ran 720p
 * High 16% over with the cap at the peak). The 10% headroom keeps the measured peak at or near the stated one.
 */
export const MAXRATE_SHARE = 0.9;
export function maxrateKbps(preset: ProxyPreset): number {
  return Math.round(PRESETS[preset].peakKbps * MAXRATE_SHARE);
}

/** The scale filter for a preset (§36.3): the short edge at most `shortEdge`, never upscaled, both sides even. */
export function scaleFilter(shortEdge: number): string {
  // Landscape: the height is the short edge; portrait and square: the width. -2 keeps the shape, rounded to even.
  return `scale=w='if(gt(iw,ih),-2,trunc(min(${shortEdge},iw)/2)*2)':h='if(gt(iw,ih),trunc(min(${shortEdge},ih)/2)*2,-2)'`;
}

/**
 * §36.3's encode for a preset: H.264, the short edge at most the preset's (never upscaled), a capped bitrate (`-b:v`
 * the average, `-maxrate` the peak, `-bufsize` half a second of the peak), a keyframe every 2 s, same frame rate and
 * length, yuv420p, AAC 256 kbps, faststart. On ffmpeg before 5.1, `-vsync passthrough` stands in for `-fps_mode
 * passthrough`, which it doesn't know.
 */
export function encodeArgs(
  orig: string,
  out: string,
  version: FfmpegVersion | null = null,
  preset: ProxyPreset = DEFAULT_PROXY_PRESET,
  encoder: ProxyEncoder = "libx264",
): string[] {
  const passthrough = hasFpsMode(version) ? ["-fps_mode", "passthrough"] : ["-vsync", "passthrough"];
  const spec = PRESETS[preset];
  const codec = encoder === "libx264" ? ["-c:v", "libx264", "-preset", "veryfast"] : ["-c:v", "h264_videotoolbox"];
  return [
    // Local files only, and only video containers (follow-up to final review I1): a cut that is
    // really a playlist (ffconcat named .mp4) is refused, never encoded from the files it names.
    "-hide_banner", "-y", "-protocol_whitelist", "file", "-format_whitelist", VIDEO_FORMATS, "-i", orig,
    "-vf", scaleFilter(spec.shortEdge),
    ...codec,
    "-b:v", `${spec.avgKbps}k`, "-maxrate", `${maxrateKbps(preset)}k`, "-bufsize", `${Math.round(maxrateKbps(preset) / 2)}k`,
    "-force_key_frames", "expr:gte(t,n_forced*2)",
    "-pix_fmt", "yuv420p", ...passthrough,
    "-c:a", "aac", "-b:a", `${PROXY_AUDIO_KBPS}k`, "-movflags", "+faststart",
    "-progress", "pipe:1", out,
  ];
}

/** The proxy's size from the original's, by the same rule as the scale filter (§36.3). */
export function scaledSize(width: number, height: number, shortEdge = 1080): { width: number; height: number } {
  const even = (n: number) => Math.max(2, Math.trunc(n / 2) * 2);
  const evenRound = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  if (width > height) {
    const h = even(Math.min(shortEdge, height));
    return { width: evenRound((width * h) / height), height: h };
  }
  const w = even(Math.min(shortEdge, width));
  return { width: w, height: evenRound((height * w) / width) };
}

export type ProxyJobState = "queued" | "running" | "done" | "failed" | "cancelled";

/** A proxy job, as the routes return it. */
export interface ProxyJob {
  id: string;
  video: string;
  version: string;
  /** §36: the quality it is made at. */
  preset: ProxyPreset;
  /** 0–100. Never goes down. */
  pct: number;
  state: ProxyJobState;
  /** Why it failed, in plain words. */
  reason?: string;
}

/** The SSE `proxy` event's payload. */
export interface ProxyEvent {
  job: string;
  video: string;
  version: string;
  preset: ProxyPreset;
  pct: number;
  state: ProxyJobState;
  reason?: string;
}

export interface ProxyJobsOptions {
  /** Runs ffmpeg. Defaults to a real spawn. */
  run?: FfmpegRunner;
  /** Reads a file's duration, codec and size, stopping when `signal` aborts. Defaults to ffprobe. */
  probe?: (abs: string, signal?: AbortSignal) => Promise<Probe>;
  /** Whether ffmpeg and ffprobe are both on PATH. Defaults to checking each once. */
  available?: () => Promise<boolean>;
  /** How many file revisions' needs are remembered. Defaults to 500. */
  needCacheLimit?: number;
  /** How many proxies are made at once. Defaults to PROXY_CONCURRENCY (§36.6). */
  concurrency?: number;
  /** The encoders ffmpeg lists. Read only when VideoToolbox could be chosen; tests inject a list. */
  encoders?: () => Promise<string[]>;
  /** Whether VideoToolbox holds the peak. Defaults to VIDEOTOOLBOX_HONOURS_PEAK; tests turn it on to cover that path. */
  videotoolboxHonoursPeak?: boolean;
}

/** §36.6: one proxy at a time. An encode already uses every core libx264 is given; a second halves both. */
export const PROXY_CONCURRENCY = 1;

interface Running {
  job: ProxyJob;
  controller: AbortController;
  /** Set once the encode is over and the file is being recorded: Cancel no longer applies. */
  committing: boolean;
  cancelled: boolean;
  settled: Promise<ProxyJob>;
  /** Ends `settled`, for a job that never left the queue. */
  settle(job: ProxyJob): void;
  /** The cut's addedAt, for the queue's newest-first order. */
  addedAt: string;
  /** Enqueue order: among cuts added at the same moment, the later ask goes first. */
  seq: number;
}

export const NEED_CACHE_LIMIT = 500;
/** Background probes for GET /api/state run this many at a time. */
export const PROBE_CONCURRENCY = 2;

/**
 * The proxy jobs of one server, at most one per cut. Progress and the end state of every job go
 * out as a `proxy` event on the store, which the SSE route broadcasts to every open tab.
 */
export class ProxyJobs {
  readonly run: FfmpegRunner;
  private readonly probeFile: (abs: string, signal?: AbortSignal) => Promise<Probe>;
  private readonly isAvailable: () => Promise<boolean>;
  private availableOnce: Promise<boolean> | null = null;
  private versionOnce: Promise<{ ok: boolean; version: FfmpegVersion | null }> | null = null;
  private readonly byVersion = new Map<string, Running>();
  private readonly byId = new Map<string, Running>();
  /** Jobs waiting for a slot, in no order: pump() picks the newest cut. */
  private readonly pending: Running[] = [];
  private active = 0;
  private seq = 0;
  private readonly concurrency: number;
  private readonly honoursPeak: boolean;
  private readonly listEncoders: (() => Promise<string[]>) | undefined;
  private encoderOnce: Promise<ProxyEncoder> | null = null;
  private closing = false;
  // Why each file (by path, size and mtime) needs a proxy, so a file revision is probed once.
  private readonly needs = new Map<string, string | null>();
  private readonly needCacheLimit: number;
  // Background probes: queued by revision key, run PROBE_CONCURRENCY at a time.
  private readonly probeQueue = new Map<string, { abs: string; size: number }>();
  private readonly probing = new Set<string>();
  private probeIdle: { promise: Promise<void>; resolve: () => void } | null = null;
  // Frame extractions in flight, by original and time: identical requests share one ffmpeg.
  private readonly frames = new Map<string, Promise<Buffer | null>>();
  // Every frame extraction and probe in flight, so close() can stop them rather than leave orphans.
  private readonly inflight = new Set<AbortController>();

  constructor(
    private readonly store: Store,
    opts: ProxyJobsOptions = {},
  ) {
    this.run = opts.run ?? defaultFfmpeg;
    // Everything this probes is a cut (or a proxy of one), so it is read only as a video container.
    this.probeFile = opts.probe ?? ((abs, signal) => ffprobe(abs, { signal, formats: VIDEO_FORMATS }));
    this.needCacheLimit = opts.needCacheLimit ?? NEED_CACHE_LIMIT;
    this.concurrency = Math.max(1, opts.concurrency ?? PROXY_CONCURRENCY);
    this.honoursPeak = opts.videotoolboxHonoursPeak ?? VIDEOTOOLBOX_HONOURS_PEAK;
    this.listEncoders = opts.encoders;
    const injected = opts.available;
    this.isAvailable = () =>
      injected
        ? injected()
        : (async () => {
            const [{ ok }, probeOk] = await Promise.all([this.ffmpegInfo(), hasFfprobe()]);
            return ok && probeOk;
          })();
  }

  /** `ffmpeg -version`, run once: whether it ran, and its version (null when unparseable). */
  private ffmpegInfo(): Promise<{ ok: boolean; version: FfmpegVersion | null }> {
    this.versionOnce ??= (async () => {
      let text = "";
      try {
        const r = await this.run(["-version"], { onStdout: (c) => (text += c.toString()) });
        return { ok: r.code === 0, version: parseFfmpegVersion(text) };
      } catch {
        return { ok: false, version: null };
      }
    })();
    return this.versionOnce;
  }

  /**
   * The encoder proxies are made with (§36.3), worked out once. `ffmpeg -encoders` is only asked when VideoToolbox
   * could be chosen (it holds the peak, on macOS); otherwise it is libx264 without asking.
   */
  encoder(): Promise<ProxyEncoder> {
    this.encoderOnce ??= (async () => {
      if (!this.honoursPeak) return "libx264";
      if (!this.listEncoders && process.platform !== "darwin") return "libx264";
      try {
        const names = this.listEncoders
          ? await this.listEncoders()
          : await (async () => {
              let text = "";
              const r = await this.run(["-hide_banner", "-encoders"], { onStdout: (c) => (text += c.toString()) });
              return r.code === 0 ? parseEncoders(text) : [];
            })();
        return chooseEncoder(names, this.honoursPeak);
      } catch {
        return "libx264";
      }
    })();
    return this.encoderOnce;
  }

  /** Whether ffmpeg and ffprobe are both there. Checked once per server. */
  available(): Promise<boolean> {
    this.availableOnce ??= Promise.resolve()
      .then(() => this.isAvailable())
      .catch(() => false);
    return this.availableOnce;
  }

  /** Throws 501 `no_ffmpeg` when ffmpeg or ffprobe is missing. */
  async requireFfmpeg(): Promise<void> {
    if (!(await this.available())) {
      throw new RushesError("Proxies and full-quality frames need ffmpeg, which isn't installed. Run `rushes doctor` for how to add it.", 501, "no_ffmpeg");
    }
  }

  /** True once the server has started closing: no new job starts. */
  get isClosing(): boolean {
    return this.closing;
  }

  /** The running job for a cut, if there is one. */
  find(video: string, version: string): ProxyJob | undefined {
    const r = this.byVersion.get(key(video, version));
    return r ? { ...r.job } : undefined;
  }

  /** Every queued and running job, for GET /api/state. */
  list(): ProxyJob[] {
    return [...this.byId.values()].filter((r) => this.byVersion.get(key(r.job.video, r.job.version)) === r).map((r) => ({ ...r.job }));
  }

  /**
   * Queues a proxy for a cut at `preset` (§36.6), or returns the job already there (Review Focus 2: two tabs or a
   * double click get one job between them). One job per cut: a queued one at another preset takes the new preset; a
   * running one at another preset is cancelled and the new one queued. With a slot free it starts at once. The caller
   * checks the cut exists first. Refused (503 `closing`) once the server has started closing.
   */
  start(video: string, version: string, opts: { preset?: ProxyPreset; addedAt?: string } = {}): ProxyJob {
    const preset = opts.preset ?? DEFAULT_PROXY_PRESET;
    const k = key(video, version);
    const existing = this.byVersion.get(k);
    if (existing && existing.job.preset === preset && !existing.cancelled) return { ...existing.job };
    if (existing && existing.job.state === "queued") {
      existing.job.preset = preset;
      this.emit(existing.job);
      return { ...existing.job };
    }
    if (this.closing) throw new RushesError("Rushes is closing, so it isn't starting a proxy", 503, "closing");
    if (existing && !existing.committing) {
      existing.cancelled = true;
      existing.controller.abort();
    }
    const job: ProxyJob = { id: randomUUID(), video, version, preset, pct: 0, state: "queued" };
    let settle!: (j: ProxyJob) => void;
    const settled = new Promise<ProxyJob>((res) => (settle = res));
    const r: Running = { job, controller: new AbortController(), committing: false, cancelled: false, settled, settle, addedAt: opts.addedAt ?? "", seq: ++this.seq };
    this.byVersion.set(k, r);
    this.byId.set(job.id, r);
    void settled.then(() => {
      if (this.byVersion.get(k) === r) this.byVersion.delete(k);
      this.byId.delete(job.id);
    });
    this.pending.push(r);
    // A free slot starts it now (state "running" from its first event); otherwise it says it's queued.
    if (!this.pump(r)) this.emit(job);
    return { ...job };
  }

  /**
   * Starts the newest queued cuts while there are slots. Returns whether `first` was started (so start() doesn't
   * announce it as queued as well).
   */
  private pump(first?: Running): boolean {
    let startedFirst = false;
    while (this.active < this.concurrency && this.pending.length > 0 && !this.closing) {
      // Newest cut first; among equals, the later ask.
      this.pending.sort((a, b) => (a.addedAt === b.addedAt ? b.seq - a.seq : a.addedAt < b.addedAt ? 1 : -1));
      const r = this.pending.shift()!;
      if (r === first) startedFirst = true;
      this.active++;
      r.job.state = "running";
      this.emit(r.job);
      void this.execute(r).then((end) => {
        this.active--;
        r.settle(end);
        this.pump();
      });
    }
    return startedFirst;
  }

  /** Resolves with the job's end state. Throws 404 when no such job is running. */
  wait(jobId: string): Promise<ProxyJob> {
    const r = this.byId.get(jobId);
    if (!r) throw new NotFoundError("proxy job", jobId);
    return r.settled;
  }

  /**
   * Stops a job: SIGTERM, then SIGKILL after 2 s, and the partial file deleted. Resolves once
   * it's all cleaned up, with the job's end state -- `done`, not `cancelled`, if the encode had
   * already finished and was being recorded (nothing is left to kill then).
   */
  async cancel(jobId: string): Promise<ProxyJob> {
    const r = this.byId.get(jobId);
    if (!r) throw new NotFoundError("proxy job", jobId);
    const waiting = this.pending.indexOf(r);
    if (waiting >= 0) {
      // Still queued: it simply leaves the queue. Nothing was spawned or written.
      this.pending.splice(waiting, 1);
      r.cancelled = true;
      r.job.state = "cancelled";
      this.emit(r.job);
      r.settle({ ...r.job });
      return r.settled;
    }
    if (!r.committing) {
      r.cancelled = true;
      r.controller.abort();
    }
    return r.settled;
  }

  /** Stops taking new jobs, cancels every running one, and stops every frame extraction and probe in flight. Used when the server closes. */
  async close(): Promise<void> {
    this.closing = true;
    for (const c of this.inflight) c.abort();
    await Promise.all([...this.byId.keys()].map((id) => this.cancel(id).catch(() => undefined)));
  }

  /**
   * Runs `work` with a signal close() aborts. Once closing, the signal starts aborted. The app
   * reads formats' renders through this too (§21), so closing the server stops those reads.
   */
  async tracked<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const c = new AbortController();
    if (this.closing) c.abort();
    this.inflight.add(c);
    try {
      return await work(c.signal);
    } finally {
      this.inflight.delete(c);
    }
  }

  /** A file's duration, codec and size (ffprobe, unless a test injects a fake). Stopped by close(): nothing known then. */
  probe(abs: string): Promise<Probe> {
    return this.tracked((signal) => this.probeFile(abs, signal));
  }

  /**
   * Why a cut needs a proxy (§19.5), or null, without waiting on a probe (ruling B): a file
   * revision (path, size and mtime) already probed is answered from the cache; one not yet probed
   * is null for now and queued for a background probe, two at a time. When that probe finds a
   * need, a `change` event goes out so every tab reads the state again. Null without ffmpeg, and
   * for a file that isn't there.
   */
  async needNow(abs: string): Promise<string | null> {
    if (!(await this.available())) return null;
    const rev = await revision(abs);
    if (!rev) return null;
    if (this.needs.has(rev.key)) return this.needs.get(rev.key)!;
    if (!this.probing.has(rev.key) && !this.probeQueue.has(rev.key)) {
      this.probeQueue.set(rev.key, { abs, size: rev.size });
      this.pumpProbes();
    }
    return null;
  }

  /** As `needNow`, from a probe the caller already has (adding a cut): no second probe, no waiting. */
  async needFrom(abs: string, known: Probe): Promise<string | null> {
    if (!(await this.available())) return null;
    const rev = await revision(abs);
    if (!rev) return null;
    const reason = proxyNeed(known, rev.size)?.reason ?? null;
    this.remember(rev.key, reason);
    return reason;
  }

  /** Resolves once no background probe is queued or running. For tests. */
  probesIdle(): Promise<void> {
    if (this.probing.size === 0 && this.probeQueue.size === 0) return Promise.resolve();
    if (!this.probeIdle) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      this.probeIdle = { promise, resolve };
    }
    return this.probeIdle.promise;
  }

  private remember(k: string, reason: string | null): void {
    this.needs.delete(k);
    this.needs.set(k, reason);
    while (this.needs.size > this.needCacheLimit) this.needs.delete(this.needs.keys().next().value!);
  }

  private pumpProbes(): void {
    while (this.probing.size < PROBE_CONCURRENCY && this.probeQueue.size > 0) {
      const [k, item] = this.probeQueue.entries().next().value!;
      this.probeQueue.delete(k);
      this.probing.add(k);
      void (async () => {
        let reason: string | null = null;
        try {
          const p = await this.probe(item.abs);
          reason = proxyNeed(p, item.size)?.reason ?? null;
        } catch {
          reason = null;
        }
        this.remember(k, reason);
        // Announced before the slot is freed, so "no probe running" (probesIdle) also means
        // every change a probe owed has gone out.
        if (reason !== null) await this.announceNeed();
        this.probing.delete(k);
        this.pumpProbes();
        if (this.probing.size === 0 && this.probeQueue.size === 0 && this.probeIdle) {
          this.probeIdle.resolve();
          this.probeIdle = null;
        }
      })();
    }
  }

  /** A `change` for project.json at its current rev, so every tab reads the state (and the new need) again. */
  private async announceNeed(): Promise<void> {
    try {
      const { rev } = await this.store.read("project");
      this.store.emit("change", { file: "project", rev } satisfies ChangeEvent);
    } catch {
      // project.json unreadable right now: the watcher reports that; nothing to announce.
    }
  }

  /**
   * The PNG of the frame at `seconds` in `orig`. Identical requests in flight share one ffmpeg
   * (Grab Frame pressed twice, or two tabs on the same frame), so a burst never stacks up decodes.
   */
  frame(orig: string, seconds: number): Promise<Buffer | null> {
    const k = `${orig}\0${seconds.toFixed(6)}`;
    const flying = this.frames.get(k);
    if (flying) return flying;
    if (this.closing) return Promise.resolve(null);
    const flight = this.tracked((signal) => extractFrame(this.run, orig, seconds, FRAME_TIMEOUT_MS, signal)).finally(() => this.frames.delete(k));
    this.frames.set(k, flight);
    return flight;
  }

  private emit(job: ProxyJob): void {
    const e: ProxyEvent = { job: job.id, video: job.video, version: job.version, preset: job.preset, pct: job.pct, state: job.state };
    if (job.reason !== undefined) e.reason = job.reason;
    this.store.emit("proxy", e);
  }

  private async execute(r: Running): Promise<ProxyJob> {
    const { job } = r;
    const root = this.store.root;
    const preset = job.preset;
    const named = proxyPath(job.video, job.version, preset);
    const partial = fromManifestPath(root, partialPath(job.video, job.version, preset));
    const final = fromManifestPath(root, named);
    const end = (state: ProxyJobState, reason?: string): ProxyJob => {
      job.state = state;
      if (state === "done") job.pct = 100;
      if (reason !== undefined) job.reason = reason;
      this.emit(job);
      return { ...job };
    };
    const fail = async (reason: string) => {
      await rm(partial, { force: true }).catch(() => undefined);
      return end("failed", reason);
    };
    const cancelled = async () => {
      await rm(partial, { force: true }).catch(() => undefined);
      return end("cancelled");
    };

    try {
      const project = await this.store.read("project");
      const version = findVersion(project, job.video, job.version);
      if (!version) return await fail("That cut isn't in the project any more");
      // A hand-edited id ("../x") must never put a file outside proxies/.
      if (!PROXY_PATH.test(named)) return await fail("Rushes can't name a proxy for this cut");
      const orig = fromManifestPath(root, version.file);
      if (!(await readableFile(orig))) return await fail("The original file is missing");

      const [origProbe, ffmpeg, encoder] = await Promise.all([this.probe(orig).catch(() => null), this.ffmpegInfo(), this.encoder()]);
      const duration = version.duration ?? origProbe?.duration ?? null;
      await mkdir(join(root, PROXY_DIR), { recursive: true });
      if (r.cancelled) return await cancelled();

      let buffered = "";
      const onStdout = (chunk: Buffer) => {
        buffered += chunk.toString();
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          const m = /^out_time_us=(\d+)/.exec(line.trim());
          // With no known length (null, or 0), progress stays at 0 until the job is done.
          if (!m || !duration) continue;
          const pct = Math.min(99, Math.floor((Number(m[1]) / 1e6 / duration) * 100));
          if (pct > job.pct && job.state === "running" && !r.cancelled) {
            job.pct = pct;
            this.emit(job);
          }
        }
      };
      let res = await this.run(encodeArgs(orig, partial, ffmpeg.version, preset, encoder), { signal: r.controller.signal, onStdout });
      // §36.3: a VideoToolbox encode that fails (no session free, an odd source) is made again with libx264, once.
      if (res.code !== 0 && encoder !== "libx264" && !r.cancelled) {
        res = await this.run(encodeArgs(orig, partial, ffmpeg.version, preset, "libx264"), { signal: r.controller.signal, onStdout });
      }
      if (r.cancelled) return await cancelled();
      if (res.code !== 0) return await fail(ffmpegReason(res.stderr));

      r.committing = true;
      let made;
      try {
        made = await stat(partial);
      } catch {
        return await fail("ffmpeg finished without writing the proxy");
      }
      // Rename first, record second: a record only ever points at a whole file.
      await renameRetry(partial, final);
      // Not stopped by close(): a committing job runs to the end, and this probe is of a local file it just wrote.
      const out = await this.probeFile(final).catch(() => null);
      const size =
        out?.width && out?.height
          ? { width: out.width, height: out.height }
          : origProbe?.width && origProbe?.height
            ? scaledSize(origProbe.width, origProbe.height, PRESETS[preset].shortEdge)
            : null;
      if (!size) {
        await this.dropUnrecorded(final, job);
        return await fail("Couldn't read the proxy's size");
      }
      let recorded = false;
      // §36.4: one proxy per cut. The one it replaces (another preset, or §19.5's) is deleted once the new one is recorded.
      let replaced: string | null = null;
      try {
        await this.store.update("project", (p) => {
          const v = findVersion(p, job.video, job.version);
          if (!v) return;
          replaced = v.proxy && v.proxy.file !== named ? v.proxy.file : null;
          v.proxy = { file: named, width: size.width, height: size.height, bytes: made.size, createdAt: new Date().toISOString(), preset };
          recorded = true;
        });
      } catch (e) {
        await this.dropUnrecorded(final, job);
        return await fail(`Couldn't record the proxy: ${(e as Error).message}`);
      }
      if (!recorded) {
        await this.dropUnrecorded(final, job);
        return await fail("That cut isn't in the project any more");
      }
      // Only ever a file this server wrote into proxies/: never the original, even from a hand-edited record.
      const old: string | null = replaced;
      if (old && PROXY_PATH.test(old)) await rm(fromManifestPath(root, old), { force: true }).catch(() => undefined);
      return end("done");
    } catch (e) {
      if (r.cancelled && !r.committing) return await cancelled();
      return await fail(`Couldn't make the proxy: ${(e as Error).message}`);
    }
  }

  /**
   * A proxy that was renamed into place but couldn't be recorded is removed -- unless the cut's
   * existing record already points at that same file (a re-render): then the file is a valid
   * proxy the record still describes, and deleting it would leave the record pointing at nothing.
   */
  private async dropUnrecorded(final: string, job: ProxyJob): Promise<void> {
    let keep = false;
    try {
      const v = findVersion(await this.store.read("project"), job.video, job.version);
      keep = v?.proxy?.file === proxyPath(job.video, job.version, job.preset);
    } catch {
      keep = false;
    }
    if (!keep) await rm(final, { force: true }).catch(() => undefined);
  }
}

function key(video: string, version: string): string {
  return `${video}/${version}`;
}

/** A file's revision key (path, size and mtime) and size, or null when it isn't a file. */
async function revision(abs: string): Promise<{ key: string; size: number } | null> {
  try {
    const info = await stat(abs);
    if (!info.isFile()) return null;
    return { key: `${abs}\0${info.size}\0${info.mtimeMs}`, size: info.size };
  } catch {
    return null;
  }
}

export function findVersion(p: Project, video: string, version: string): Version | undefined {
  return p.videos.find((v) => v.id === video)?.versions.find((v) => v.id === version);
}

async function readableFile(abs: string): Promise<boolean> {
  try {
    const info = await stat(abs);
    if (!info.isFile()) return false;
    await access(abs, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** ffmpeg's last words, in a sentence. */
function ffmpegReason(stderr: string): string {
  const lines = stderr
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(frame=|size=|video:|\[out#)/.test(l));
  const last = lines[lines.length - 1];
  return last ? `ffmpeg stopped: ${last.slice(0, 300)}` : "ffmpeg stopped with an error";
}

/**
 * Start-up clean-up (Review Focus 1): a server that stopped mid-proxy leaves a `*.partial.mp4`
 * behind. Nothing ever recorded it, so it's deleted. Returns the names removed.
 */
export async function removePartials(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(root, PROXY_DIR));
  } catch {
    return [];
  }
  const partials = names.filter((n) => n.endsWith(".partial.mp4"));
  await Promise.all(partials.map((n) => rm(join(root, PROXY_DIR, n), { force: true }).catch(() => undefined)));
  return partials;
}

/** The PNG for one frame, as ffmpeg writes it. */
export function frameArgs(orig: string, seconds: number): string[] {
  return [
    "-hide_banner", "-v", "error",
    // Local files only, as for ffprobe: a container that names a URL is never followed. An input
    // option, so the PNG still goes out through pipe:1.
    "-protocol_whitelist", "file",
    // Only video containers (final review I1): a cut or format that is really a playlist (ffconcat
    // named .mp4) or a GIF is refused, never read through to the files it names.
    "-format_whitelist", VIDEO_FORMATS,
    // -ss before -i seeks fast to the keyframe before, then accurate_seek decodes forward to the exact frame.
    "-accurate_seek", "-ss", seconds.toFixed(6), "-i", orig,
    "-frames:v", "1", "-an", "-pix_fmt", "rgb24", "-c:v", "png", "-f", "image2pipe", "pipe:1",
  ];
}

/** How long a single-frame extraction may take before it's killed. */
export const FRAME_TIMEOUT_MS = 30_000;

/** Runs `frameArgs` and collects the PNG. Null when ffmpeg failed or wrote nothing (a time past the end). */
export async function extractFrame(run: FfmpegRunner, orig: string, seconds: number, timeoutMs = FRAME_TIMEOUT_MS, signal?: AbortSignal): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const stop = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const res = await run(frameArgs(orig, seconds), { signal: controller.signal, onStdout: (c) => chunks.push(c) });
    if (res.code !== 0 || controller.signal.aborted) return null;
    const png = Buffer.concat(chunks);
    return png.length > 0 ? png : null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}
