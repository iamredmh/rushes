import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { RushesError, NotFoundError } from "../core/errors.js";
import { hasFfprobe, probe as ffprobe, proxyNeed, type Probe } from "../core/media.js";
import { fromManifestPath } from "../core/paths.js";
import type { Project, Version } from "../core/schema.js";
import type { Store } from "../core/store.js";

// §19.5: opt-in proxies. One ffmpeg job per cut, with progress over SSE and a Cancel that kills
// the process and deletes the half-written file. A version's `proxy` record is set only once a
// render has completed and been renamed into place, so a `*.partial.mp4` never poses as a proxy.

/**
 * Spawns ffmpeg with an argument array, never through a shell (global constraints). Same contract
 * as loudness.ts's runner, plus stdout: `onStdout` receives it as it arrives (the `-progress
 * pipe:1` key=value lines, or a PNG's bytes). When `signal` aborts, the child gets SIGTERM, then
 * SIGKILL after a grace period if it's still alive. Tests inject a fake.
 */
export interface FfmpegRunner {
  (args: string[], opts?: { signal?: AbortSignal; onStdout?: (chunk: Buffer) => void }): Promise<{ code: number; stderr: string }>;
}

/** Grace period between SIGTERM and SIGKILL when a job is cancelled. */
const KILL_GRACE_MS = 2_000;
/** Only the tail of ffmpeg's stderr is kept: a long encode prints a stats line twice a second. */
const STDERR_TAIL = 16_384;

export const defaultFfmpeg: FfmpegRunner = (args, opts = {}) =>
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
    child.stderr!.on("data", onErr);
    child.stdout?.on("data", onOut);

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
    };
    signal?.addEventListener("abort", onAbort);

    const cleanup = () => {
      child.stderr!.off("data", onErr);
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

/** The visible folder proxies live in, at the project root. */
export const PROXY_DIR = "proxies";
/** A proxy file this server writes: proxies/<film-slug>_<version>_proxy.mp4. */
export const PROXY_PATH = /^proxies\/[a-z0-9][a-z0-9-]*_v\d+_proxy\.mp4$/;

/** "proxies/hero-60s_v3_proxy.mp4" */
export function proxyPath(video: string, version: string): string {
  return `${PROXY_DIR}/${video}_${version}_proxy.mp4`;
}

/** The half-written file for `proxyPath`: never recorded, deleted on cancel, failure and start-up. */
export function partialPath(video: string, version: string): string {
  return `${PROXY_DIR}/${video}_${version}_proxy.partial.mp4`;
}

/** §19.5's encode, exactly: H.264 at most 1920 px on the long edge, same frame rate and length, yuv420p, AAC, faststart. */
export function encodeArgs(orig: string, out: string): string[] {
  return [
    "-hide_banner", "-y", "-i", orig,
    "-vf", "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
    "-progress", "pipe:1", out,
  ];
}

/** The proxy's size from the original's, by the same rule as the scale filter (even, at most 1920 on the long edge). */
export function scaledSize(width: number, height: number): { width: number; height: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  if (width > height) {
    const w = Math.min(1920, width);
    return { width: w, height: w === width ? even(height) : even((height * w) / width) };
  }
  const h = Math.min(1920, height);
  return { width: h === height ? even(width) : even((width * h) / height), height: h };
}

export type ProxyJobState = "running" | "done" | "failed" | "cancelled";

/** A proxy job, as the routes return it. */
export interface ProxyJob {
  id: string;
  video: string;
  version: string;
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
  pct: number;
  state: ProxyJobState;
  reason?: string;
}

export interface ProxyJobsOptions {
  /** Runs ffmpeg. Defaults to a real spawn. */
  run?: FfmpegRunner;
  /** Reads a file's duration, codec and size. Defaults to ffprobe. */
  probe?: (abs: string) => Promise<Probe>;
  /** Whether ffmpeg and ffprobe are both on PATH. Defaults to checking each once. */
  available?: () => Promise<boolean>;
}

interface Running {
  job: ProxyJob;
  controller: AbortController;
  /** Set once the encode is over and the file is being recorded: Cancel no longer applies. */
  committing: boolean;
  cancelled: boolean;
  settled: Promise<ProxyJob>;
}

const NEED_CACHE_LIMIT = 500;

/**
 * The proxy jobs of one server, at most one per cut. Progress and the end state of every job go
 * out as a `proxy` event on the store, which the SSE route broadcasts to every open tab.
 */
export class ProxyJobs {
  readonly run: FfmpegRunner;
  readonly probe: (abs: string) => Promise<Probe>;
  private readonly isAvailable: () => Promise<boolean>;
  private availableOnce: Promise<boolean> | null = null;
  private readonly byVersion = new Map<string, Running>();
  private readonly byId = new Map<string, Running>();
  // Why each file (by path, size and mtime) needs a proxy, so GET /api/state never probes twice.
  private readonly needs = new Map<string, string | null>();
  private readonly needFlights = new Map<string, Promise<string | null>>();

  constructor(
    private readonly store: Store,
    opts: ProxyJobsOptions = {},
  ) {
    this.run = opts.run ?? defaultFfmpeg;
    this.probe = opts.probe ?? ffprobe;
    this.isAvailable =
      opts.available ??
      (async () => {
        const [ffmpeg, probeOk] = await Promise.all([
          this.run(["-version"]).then((r) => r.code === 0, () => false),
          hasFfprobe(),
        ]);
        return ffmpeg && probeOk;
      });
  }

  /** Whether ffmpeg and ffprobe are both there. Checked once per server. */
  available(): Promise<boolean> {
    this.availableOnce ??= this.isAvailable().catch(() => false);
    return this.availableOnce;
  }

  /** Throws 501 `no_ffmpeg` when ffmpeg or ffprobe is missing. */
  async requireFfmpeg(): Promise<void> {
    if (!(await this.available())) {
      throw new RushesError("Proxies and full-quality frames need ffmpeg, which isn't installed. Run `rushes doctor` for how to add it.", 501, "no_ffmpeg");
    }
  }

  /** The running job for a cut, if there is one. */
  find(video: string, version: string): ProxyJob | undefined {
    const r = this.byVersion.get(key(video, version));
    return r ? { ...r.job } : undefined;
  }

  /** Every running job, for GET /api/state. */
  list(): ProxyJob[] {
    return [...this.byId.values()].map((r) => ({ ...r.job }));
  }

  /**
   * Starts making a proxy for a cut, or returns the job already making one (Review Focus 2: two
   * tabs or a double click get one job between them). The caller checks the cut exists first.
   */
  start(video: string, version: string): ProxyJob {
    const existing = this.byVersion.get(key(video, version));
    if (existing) return { ...existing.job };
    const job: ProxyJob = { id: randomUUID(), video, version, pct: 0, state: "running" };
    const r: Running = { job, controller: new AbortController(), committing: false, cancelled: false, settled: undefined! };
    this.byVersion.set(key(video, version), r);
    this.byId.set(job.id, r);
    this.emit(job);
    r.settled = this.execute(r).finally(() => {
      this.byVersion.delete(key(video, version));
      this.byId.delete(job.id);
    });
    return { ...job };
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
   * already finished and was being recorded.
   */
  async cancel(jobId: string): Promise<ProxyJob> {
    const r = this.byId.get(jobId);
    if (!r) throw new NotFoundError("proxy job", jobId);
    if (!r.committing) {
      r.cancelled = true;
      r.controller.abort();
    }
    return r.settled;
  }

  /** Cancels every running job. Used when the server closes. */
  async cancelAll(): Promise<void> {
    await Promise.all([...this.byId.keys()].map((id) => this.cancel(id).catch(() => undefined)));
  }

  /**
   * Why a cut needs a proxy (§19.5), or null. Cached per file revision (path, size and mtime),
   * so the probe runs once per file version however often the state is read. Null without
   * ffmpeg, and for a file that isn't there.
   */
  async needFor(abs: string, known?: Probe): Promise<string | null> {
    if (!(await this.available())) return null;
    let info;
    try {
      info = await stat(abs);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;
    const k = `${abs}\0${info.size}\0${info.mtimeMs}`;
    if (this.needs.has(k)) return this.needs.get(k)!;
    const flying = this.needFlights.get(k);
    if (flying) return flying;
    const flight = (async () => {
      const p = known ?? (await this.probe(abs).catch(() => null));
      const reason = p ? (proxyNeed(p, info.size)?.reason ?? null) : null;
      this.needs.set(k, reason);
      if (this.needs.size > NEED_CACHE_LIMIT) this.needs.delete(this.needs.keys().next().value!);
      return reason;
    })();
    this.needFlights.set(k, flight);
    try {
      return await flight;
    } finally {
      this.needFlights.delete(k);
    }
  }

  private emit(job: ProxyJob): void {
    const e: ProxyEvent = { job: job.id, video: job.video, version: job.version, pct: job.pct, state: job.state };
    if (job.reason !== undefined) e.reason = job.reason;
    this.store.emit("proxy", e);
  }

  private async execute(r: Running): Promise<ProxyJob> {
    const { job } = r;
    const root = this.store.root;
    const partial = fromManifestPath(root, partialPath(job.video, job.version));
    const final = fromManifestPath(root, proxyPath(job.video, job.version));
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
      if (!PROXY_PATH.test(proxyPath(job.video, job.version))) return await fail("Rushes can't name a proxy for this cut");
      const orig = fromManifestPath(root, version.file);
      if (!(await readableFile(orig))) return await fail("The original file is missing");

      const origProbe = await this.probe(orig).catch(() => null);
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
          if (!m || !duration) continue;
          const pct = Math.min(99, Math.floor((Number(m[1]) / 1e6 / duration) * 100));
          if (pct > job.pct && job.state === "running" && !r.cancelled) {
            job.pct = pct;
            this.emit(job);
          }
        }
      };
      const res = await this.run(encodeArgs(orig, partial), { signal: r.controller.signal, onStdout });
      if (r.cancelled) return await cancelled();
      if (res.code !== 0) return await fail(ffmpegReason(res.stderr));

      r.committing = true;
      let made;
      try {
        made = await stat(partial);
      } catch {
        return await fail("ffmpeg finished without writing the proxy");
      }
      await rename(partial, final);
      const out = await this.probe(final).catch(() => null);
      const size =
        out?.width && out?.height
          ? { width: out.width, height: out.height }
          : origProbe?.width && origProbe?.height
            ? scaledSize(origProbe.width, origProbe.height)
            : null;
      if (!size) {
        await rm(final, { force: true });
        return await fail("Couldn't read the proxy's size");
      }
      let recorded = false;
      await this.store.update("project", (p) => {
        const v = findVersion(p, job.video, job.version);
        if (!v) return;
        v.proxy = { file: proxyPath(job.video, job.version), width: size.width, height: size.height, bytes: made.size, createdAt: new Date().toISOString() };
        recorded = true;
      });
      if (!recorded) {
        await rm(final, { force: true });
        return await fail("That cut isn't in the project any more");
      }
      return end("done");
    } catch (e) {
      if (r.cancelled) return await cancelled();
      return await fail(`Couldn't make the proxy: ${(e as Error).message}`);
    }
  }
}

function key(video: string, version: string): string {
  return `${video}/${version}`;
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
    // -ss before -i seeks fast to the keyframe before, then accurate_seek decodes forward to the exact frame.
    "-accurate_seek", "-ss", seconds.toFixed(6), "-i", orig,
    "-frames:v", "1", "-an", "-pix_fmt", "rgb24", "-c:v", "png", "-f", "image2pipe", "pipe:1",
  ];
}

/** How long a single-frame extraction may take before it's killed. */
export const FRAME_TIMEOUT_MS = 30_000;

/** Runs `frameArgs` and collects the PNG. Null when ffmpeg failed or wrote nothing (a time past the end). */
export async function extractFrame(run: FfmpegRunner, orig: string, seconds: number, timeoutMs = FRAME_TIMEOUT_MS): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await run(frameArgs(orig, seconds), { signal: controller.signal, onStdout: (c) => chunks.push(c) });
    if (res.code !== 0 || controller.signal.aborted) return null;
    const png = Buffer.concat(chunks);
    return png.length > 0 ? png : null;
  } finally {
    clearTimeout(timer);
  }
}
