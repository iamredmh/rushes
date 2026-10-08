import { basename } from "node:path";
import type { VideoProbe } from "../../src/core/media.js";

/**
 * A stand-in for ffprobe that answers from the file's name: "…1080x1920…" is that size, and
 * "@8.4" is that length (8 s by default). A name with no size can't be read.
 */
export async function sizedProbe(abs: string): Promise<VideoProbe> {
  const m = /(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?/.exec(basename(abs));
  if (!m) return { ok: false, code: "unreadable", reason: "Invalid data found when processing input" };
  return { ok: true, width: Number(m[1]), height: Number(m[2]), duration: m[3] ? Number(m[3]) : 8, fps: 30 };
}
