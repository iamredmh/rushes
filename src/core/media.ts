import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Probe {
  duration: number | null;
  fps: number | null;
}

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

/** Read duration and frame rate with ffprobe. Returns nulls when ffprobe is missing or fails. */
export async function probe(file: string): Promise<Probe> {
  if (!(await hasFfprobe())) return { duration: null, fps: null };
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,avg_frame_rate,r_frame_rate",
      "-of", "json",
      file,
    ]);
    const j = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string; avg_frame_rate?: string; r_frame_rate?: string }[];
    };
    const video = j.streams?.find((s) => s.codec_type === "video");
    const duration = j.format?.duration ? Number(j.format.duration) : null;
    return {
      duration: duration !== null && Number.isFinite(duration) ? duration : null,
      fps: parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate),
    };
  } catch {
    return { duration: null, fps: null };
  }
}
