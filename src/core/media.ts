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

/** Read duration, frame rate, codec, size and pixel format with ffprobe. Returns nulls when ffprobe is missing or fails. */
export async function probe(file: string): Promise<Probe> {
  if (!(await hasFfprobe())) return { ...NO_PROBE };
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate",
      "-of", "json",
      file,
    ]);
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
