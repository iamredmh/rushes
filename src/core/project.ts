import type { Cue, Lane, LaneStage, Project, Variant, Version, Video } from "./schema.js";
import { slugify, uniqueId } from "./ids.js";
import { InvalidError, NotFoundError } from "./errors.js";

export interface AddVersionInput {
  /** Video id or display name. A new video is created when no id matches. */
  video: string;
  /** Manifest path (already passed through toManifestPath). */
  file: string;
  note?: string;
  duration?: number | null;
  fps?: number | null;
}

export function addVersion(p: Project, input: AddVersionInput, now = new Date()): { video: Video; version: Version } {
  const vid = slugify(input.video);
  let video = p.videos.find((v) => v.id === input.video || v.id === vid);
  if (!video) {
    video = { id: uniqueId(vid, p.videos.map((v) => v.id)), name: input.video, versions: [] };
    p.videos.push(video);
  }
  const n = video.versions.reduce((max, v) => Math.max(max, Number(v.id.replace(/^v/, "")) || 0), 0) + 1;
  const version: Version = {
    id: `v${n}`,
    file: input.file,
    duration: input.duration ?? null,
    fps: input.fps ?? null,
    addedAt: now.toISOString(),
    note: input.note ?? "",
  };
  video.versions.push(version);
  return { video, version };
}

export function latestVersion(video: Video): Version | undefined {
  return video.versions[video.versions.length - 1];
}

export interface AddVariantInput {
  stage: LaneStage;
  /** Lane id. Defaults to the stage name, e.g. "music". */
  lane?: string;
  name: string;
  file: string;
  meta?: Record<string, string | number>;
  cues?: { name: string; t: number }[];
}

const LANE_NAMES: Record<LaneStage, string> = { voice: "Voiceover", music: "Music", sfx: "Sound effects" };

export function addVariant(p: Project, input: AddVariantInput): { lane: Lane; variant: Variant } {
  const laneId = slugify(input.lane ?? input.stage);
  let lane = p.lanes.find((l) => l.id === laneId);
  if (lane && lane.stage !== input.stage) throw new InvalidError(`Lane "${laneId}" belongs to ${lane.stage}, not ${input.stage}`);
  if (!lane) {
    lane = { id: laneId, stage: input.stage, name: input.lane ?? LANE_NAMES[input.stage], variants: [] };
    p.lanes.push(lane);
  }
  const cues: Cue[] = [];
  for (const c of input.cues ?? []) {
    cues.push({ id: uniqueId(slugify(c.name), cues.map((x) => x.id)), name: c.name, t: c.t });
  }
  const variant: Variant = {
    id: uniqueId(slugify(input.name), lane.variants.map((v) => v.id)),
    name: input.name,
    file: input.file,
    meta: input.meta ?? {},
    cues,
  };
  lane.variants.push(variant);
  return { lane, variant };
}

export function findVideo(p: Project, id: string): Video {
  const v = p.videos.find((x) => x.id === id);
  if (!v) throw new NotFoundError("video", id);
  return v;
}
