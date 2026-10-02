import type { Cue, Lane, LaneStage, Project, Shot, Variant, Version, Video } from "./schema.js";
import { newProjectId, slugify, uniqueId } from "./ids.js";
import { InvalidError, NotFoundError } from "./errors.js";

/** Sets `p.id` when missing. Returns whether it changed anything. */
export function ensureProjectId(p: Project): boolean {
  if (p.id) return false;
  p.id = newProjectId();
  return true;
}

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
    video = { id: uniqueId(vid, p.videos.map((v) => v.id)), name: input.video, versions: [], lockedVersion: null };
    p.videos.push(video);
  }
  const n = video.versions.reduce((max, v) => Math.max(max, Number(v.id.replace(/^v/, "")) || 0), 0) + 1;
  const prev = latestVersion(video);
  const version: Version = {
    id: `v${n}`,
    file: input.file,
    duration: input.duration ?? null,
    fps: input.fps ?? null,
    addedAt: now.toISOString(),
    note: input.note ?? "",
    shots: prev ? prev.shots.map((s) => ({ ...s })) : [],
  };
  video.versions.push(version);
  return { video, version };
}

export function latestVersion(video: Video): Version | undefined {
  return video.versions[video.versions.length - 1];
}

/** The named version, or the newest when `versionId` is undefined. */
function resolveVersion(video: Video, versionId: string | undefined): Version {
  if (versionId === undefined) {
    const v = latestVersion(video);
    if (!v) throw new NotFoundError("version", "(none)");
    return v;
  }
  const v = video.versions.find((x) => x.id === versionId);
  if (!v) throw new NotFoundError("version", versionId);
  return v;
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

/**
 * Finds a video by id, slug or name, so routes, MCP tools and the CLI all accept either
 * "Hero 60s" or "hero-60s". Tried in order: exact id, then `slugify(ref)`, then a
 * case-insensitive exact name match.
 */
export function resolveVideo(p: Project, ref: string): Video {
  const byId = p.videos.find((v) => v.id === ref);
  if (byId) return byId;
  const slug = slugify(ref);
  const bySlug = p.videos.find((v) => v.id === slug);
  if (bySlug) return bySlug;
  const lower = ref.toLowerCase();
  const byName = p.videos.find((v) => v.name.toLowerCase() === lower);
  if (byName) return byName;
  throw new NotFoundError("video", ref);
}

export interface ShotInput {
  name: string;
  start: number;
  tag?: string;
}

/** Replaces a version's shot list: sorted by start, renumbered from 1. */
export function setShots(p: Project, videoId: string, versionId: string | undefined, shots: ShotInput[]): Version {
  const video = resolveVideo(p, videoId);
  const version = resolveVersion(video, versionId);
  if (shots.length > 200) throw new InvalidError("A shot list holds at most 200 shots");
  const sorted = [...shots].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start === sorted[i - 1].start) throw new InvalidError(`Two shots start at ${sorted[i].start.toFixed(2)} s`);
  }
  if (version.duration !== null) {
    const late = sorted.find((s) => s.start >= version.duration!);
    if (late) throw new InvalidError(`Shot starts at ${late.start.toFixed(2)} s, at or after the cut's duration`);
  }
  version.shots = sorted.map((s, i) => ({ n: i + 1, name: s.name, start: s.start, tag: s.tag ?? "" }));
  return version;
}

/** Locks a video's picture at a version, or unlocks it when `versionId` is null. */
export function lockPicture(p: Project, videoId: string, versionId: string | null): Video {
  const video = resolveVideo(p, videoId);
  if (versionId !== null && !video.versions.some((v) => v.id === versionId)) throw new NotFoundError("version", versionId);
  video.lockedVersion = versionId;
  return video;
}

/** The last shot whose start is at or before `t`, or null when `t` is before the first shot. */
export function shotAt(shots: Shot[], t: number): { n: number; name: string } | null {
  let found: Shot | null = null;
  for (const s of shots) {
    if (s.start <= t && (!found || s.start > found.start)) found = s;
  }
  return found ? { n: found.n, name: found.name } : null;
}
