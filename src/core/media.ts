import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Probe {
  duration: number | null;
  fps: number | null;
  /** ffprobe's codec_name for the first video stream, e.g. "h264", "prores", "hevc". */
  codec: string | null;
  width: number | null;
  height: number | null;
  /** e.g. "yuv420p", "yuv422p10le". */
  pixFmt: string | null;
}

const NO_PROBE: Probe = { duration: null, fps: null, codec: null, width: null, height: null, pixFmt: null };

let ffprobeChecked: Promise<boolean> | null = null;

/** True when ffprobe is on PATH. Checked once per process. */
export function hasFfprobe(): Promise<boolean> {
  ffprobeChecked ??= run("ffprobe", ["-version"]).then(
    () => true,
    () => false,
  );
  return ffprobeChecked;
}

/** "30000/1001" -> 29.97. Returns null for "0/0" or junk. */
export function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [a, b] = rate.split("/").map(Number);
  const v = b ? a / b : a;
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : null;
}

/** How long one ffprobe may run before it's killed and treated as no probe (a stalled network volume, say). */
export const PROBE_TIMEOUT_MS = 20_000;

/** How long past its timeout a probe is waited for before Rushes stops waiting. */
export const GIVE_UP_GRACE_MS = 1_000;

/**
 * Waits for `work` (an ffprobe run), but not past `timeout` + GIVE_UP_GRACE_MS and not past
 * `signal` aborting: then it answers `gaveUp(why)` instead. execFile kills ffprobe at its timeout
 * or on abort, but only answers once ffprobe has exited, and a process stuck in an uninterruptible
 * read (a stalled network drive) can outlive SIGKILL. Every ffprobe in Rushes waits through this.
 */
export async function giveUpAfter<T>(
  work: Promise<T>,
  opts: { timeout: number; signal?: AbortSignal; gaveUp: (why: "timeout" | "aborted") => T },
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const giveUp = new Promise<T>((res) => {
    timer = setTimeout(() => res(opts.gaveUp("timeout")), opts.timeout + GIVE_UP_GRACE_MS);
    onAbort = () => res(opts.gaveUp("aborted"));
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, giveUp]);
  } finally {
    clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Read duration, frame rate, codec, size and pixel format with ffprobe. Returns nulls when ffprobe
 * is missing or fails, takes longer than `timeout` (default 20 s), or `signal` aborts.
 */
export async function probe(file: string, opts: { timeout?: number; signal?: AbortSignal } = {}): Promise<Probe> {
  if (opts.signal?.aborted || !(await hasFfprobe())) return { ...NO_PROBE };
  const timeout = opts.timeout ?? PROBE_TIMEOUT_MS;
  return giveUpAfter(readProbe(file, timeout, opts.signal), { timeout, signal: opts.signal, gaveUp: () => ({ ...NO_PROBE }) });
}

async function readProbe(file: string, timeout: number, signal: AbortSignal | undefined): Promise<Probe> {
  try {
    const { stdout } = await run(
      "ffprobe",
      [
        "-v", "error",
        // Local files only: a playlist or container that names a URL is never followed.
        "-protocol_whitelist", "file",
        "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate",
        "-of", "json",
        file,
      ],
      { timeout, killSignal: "SIGKILL", signal },
    );
    const j = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: {
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        pix_fmt?: string;
        avg_frame_rate?: string;
        r_frame_rate?: string;
      }[];
    };
    const video = j.streams?.find((s) => s.codec_type === "video");
    const duration = j.format?.duration ? Number(j.format.duration) : null;
    return {
      duration: duration !== null && Number.isFinite(duration) ? duration : null,
      fps: parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate),
      codec: video?.codec_name ?? null,
      width: positiveInt(video?.width),
      height: positiveInt(video?.height),
      pixFmt: video?.pix_fmt ?? null,
    };
  } catch {
    return { ...NO_PROBE };
  }
}

function positiveInt(n: unknown): number | null {
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

/** §21.6: the extensions a cut or a format may have. Anything else isn't video. */
export const VIDEO_EXT: ReadonlySet<string> = new Set(["mp4", "mov", "m4v", "webm", "mkv"]);

/** §21.3: a render's shape on screen, its length and rate, or why it can't be a format. */
export type VideoProbe =
  | { ok: true; width: number; height: number; duration: number | null; fps: number | null }
  | { ok: false; code: "no_ffprobe" | "not_video" | "unreadable"; reason: string };
/** Reads a render. `signal` aborts the read (the server closing, or a sibling file refused). */
export type VideoProber = (abs: string, signal?: AbortSignal) => Promise<VideoProbe>;

interface FfStream {
  codec_type?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
  disposition?: { attached_pic?: number };
}

/**
 * ffprobe's `-show_format -show_streams` JSON as a VideoProbe. The size is the one on screen (Review
 * Focus 2): non-square pixels widen it, and a quarter turn of rotation metadata swaps its sides.
 */
export function parseVideoProbe(json: unknown): VideoProbe {
  const j = (json ?? {}) as { format?: { duration?: string; format_name?: string }; streams?: FfStream[] };
  if (/(^|,)image2(,|$)|_pipe(,|$)/.test(j.format?.format_name ?? "")) return { ok: false, code: "not_video", reason: "it's a still image" };
  const s = j.streams?.find((x) => x.codec_type === "video" && x.disposition?.attached_pic !== 1);
  if (!s) return { ok: false, code: "not_video", reason: "it has no video stream" };
  const w = positiveInt(s.width);
  const h = positiveInt(s.height);
  if (w === null || h === null) return { ok: false, code: "unreadable", reason: "it has no picture size" };
  const sar = /^(\d+):(\d+)$/.exec(s.sample_aspect_ratio ?? "");
  const pixel = sar && Number(sar[1]) > 0 && Number(sar[2]) > 0 ? Number(sar[1]) / Number(sar[2]) : 1;
  let width = Math.round(w * pixel);
  let height = h;
  const rotation = s.side_data_list?.find((d) => typeof d.rotation === "number")?.rotation ?? Number(s.tags?.rotate ?? 0);
  if (Math.abs(Math.round(rotation)) % 180 === 90) [width, height] = [height, width];
  const d = j.format?.duration ? Number(j.format.duration) : Number.NaN;
  return { ok: true, width, height, duration: Number.isFinite(d) && d >= 0 ? d : null, fps: parseRate(s.avg_frame_rate) ?? parseRate(s.r_frame_rate) };
}

/** Why a render wasn't read, when the reading itself was cut short. */
const TOO_LONG: VideoProbe = { ok: false, code: "unreadable", reason: "ffprobe took too long" };
const STOPPED: VideoProbe = { ok: false, code: "unreadable", reason: "ffprobe was stopped" };

/** giveUpAfter's answer for a render: it took too long, or it was stopped. */
export function videoGaveUp(why: "timeout" | "aborted"): VideoProbe {
  return { ...(why === "timeout" ? TOO_LONG : STOPPED) };
}

/**
 * §21.3: reads a render with ffprobe, local files only. The reason never repeats the file's path.
 * Like `probe`, it gives up `timeout` (default 20 s) plus a second on, or when `signal` aborts.
 */
export async function probeVideo(file: string, opts: { timeout?: number; signal?: AbortSignal } = {}): Promise<VideoProbe> {
  if (opts.signal?.aborted) return videoGaveUp("aborted");
  if (!(await hasFfprobe())) return { ok: false, code: "no_ffprobe", reason: "needs ffprobe to read the ratio" };
  const timeout = opts.timeout ?? PROBE_TIMEOUT_MS;
  return giveUpAfter(readVideoProbe(file, timeout, opts.signal), { timeout, signal: opts.signal, gaveUp: videoGaveUp });
}

async function readVideoProbe(file: string, timeout: number, signal: AbortSignal | undefined): Promise<VideoProbe> {
  try {
    const { stdout } = await run(
      "ffprobe",
      // Local files only: a playlist or container that names a URL is never followed.
      ["-v", "error", "-protocol_whitelist", "file", "-show_format", "-show_streams", "-of", "json", file],
      { timeout, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, signal },
    );
    return parseVideoProbe(JSON.parse(stdout));
  } catch (e) {
    if (signal?.aborted) return videoGaveUp("aborted");
    // Killed at its timeout (execFile sets `killed`), so there are no last words to report.
    if ((e as { killed?: boolean }).killed) return videoGaveUp("timeout");
    const last = String((e as { stderr?: unknown }).stderr ?? "").trim().split("\n").pop() ?? "";
    const trimmed = last.startsWith(`${file}: `) ? last.slice(file.length + 2) : last;
    // Belt and braces: the path never appears anywhere in what goes back to the caller.
    const reason = trimmed.split(file).join("the file");
    return { ok: false, code: "unreadable", reason: reason.slice(0, 200) || "ffprobe couldn't read it" };
  }
}

// §19.5: when Rushes offers a proxy.
const PLAYABLE_CODECS = new Set(["h264", "vp9", "av1"]);
const MAX_EDGE = 3000;
const MAX_BYTES = 1.5e9;

/** ffprobe codec names in plain words. */
const CODEC_NAMES: Record<string, string> = {
  prores: "ProRes",
  dnxhd: "DNx",
  hevc: "HEVC",
  mpeg2video: "MPEG-2",
  mpeg4: "MPEG-4",
  mjpeg: "Motion JPEG",
  vp8: "VP8",
  cfhd: "CineForm",
  qtrle: "QuickTime Animation",
  png: "PNG",
  rawvideo: "uncompressed",
};

function codecWords(codec: string, pixFmt: string | null): string {
  const name = CODEC_NAMES[codec] ?? codec.toUpperCase();
  // "HEVC 10-bit": the case §19.5 names, and the one browsers fail on most.
  if (codec === "hevc" && pixFmt && /p10/.test(pixFmt)) return `${name} 10-bit`;
  return name;
}

/** "a" or "an" before `words`, by sound: "an HEVC", "an MPEG-2", "an uncompressed", "a ProRes". */
function article(words: string): string {
  const first = words.split(/[\s-]/)[0];
  if (/^[aeiou]/.test(first)) return "an";
  // An acronym read letter by letter: "an HEVC", "an MPEG-2", "an F…".
  if (/^[A-Z0-9]+$/.test(first) && /^[AEFHILMNORSX]/.test(first)) return "an";
  return "a";
}

/** "2.3 GB", in decimal gigabytes (the same unit the 1.5 GB threshold uses). */
function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/**
 * Why a cut is likely to play badly in a browser (§19.5), in a few plain words -- or null when it
 * should play fine, or when nothing is known about it (no ffprobe). The reasons combine:
 * "It's a 4K ProRes file (2.3 GB), which browsers struggle with".
 */
export function proxyNeed(p: Probe, bytes: number | null): { reason: string } | null {
  const big = (p.width ?? 0) > MAX_EDGE || (p.height ?? 0) > MAX_EDGE;
  const heavy = bytes !== null && bytes > MAX_BYTES;
  const codec = p.codec !== null && !PLAYABLE_CODECS.has(p.codec) ? codecWords(p.codec, p.pixFmt) : null;
  if (!big && !heavy && !codec) return null;
  const words = [big ? "4K" : null, codec].filter(Boolean).join(" ");
  const what = words ? `${article(words)} ${words} file` : "a large file";
  const size = heavy ? ` (${gigabytes(bytes!)})` : "";
  return { reason: `It's ${what}${size}, which browsers struggle with` };
}
