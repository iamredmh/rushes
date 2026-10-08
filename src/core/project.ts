import { basename } from "node:path";
import type { Cue, FileEntry, FileKind, Format, Lane, LaneStage, Project, Shot, Variant, Version, Video } from "./schema.js";
import { newProjectId, slugify, uniqueId } from "./ids.js";
import { InvalidError, NotFoundError, RushesError } from "./errors.js";
import { MAX_FORMATS, durationWarning, ratioId, sameShape, settleLabel, versionFormats } from "./formats.js";
import type { Store } from "./store.js";

/** Sets `p.id` when missing. Returns whether it changed anything. */
export function ensureProjectId(p: Project): boolean {
  if (p.id) return false;
  p.id = newProjectId();
  return true;
}

// One in-flight (or settled) promise per store, so the server's own startup ensure and the
// app's lazy one (a request that lands before startup's own ensure completes) always converge
// on the same call: whichever runs first registers the promise here, synchronously, before any
// `await` yields control, so a second caller for the same store only ever awaits it, never
// triggers a second store.update (which would otherwise bump project.json's rev a second time
// even though ensureProjectId itself is a no-op once the id is already set).
const ensuring = new WeakMap<Store, Promise<string>>();

/** The project's id, generated and persisted the first time this is called for a given store. */
export function ensureProjectIdOnce(store: Store): Promise<string> {
  let p = ensuring.get(store);
  if (!p) {
    p = (async () => {
      const project = await store.read("project");
      if (project.id) return project.id;
      const { data } = await store.update("project", ensureProjectId);
      return data.id!;
    })();
    ensuring.set(store, p);
  }
  return p;
}

export interface AddVersionInput {
  /** Video id or display name. A new video is created when no id matches. */
  video: string;
  /** Manifest path (already passed through toManifestPath). */
  file: string;
  note?: string;
  duration?: number | null;
  fps?: number | null;
  /** §21.3: the primary render's picture size as shown, when known. */
  width?: number | null;
  height?: number | null;
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
  const duration = input.duration ?? null;
  // Inherited shots are a copy of the previous version's, but one that starts at or past a
  // shorter cut's duration can't belong to it: drop it rather than carry a shot nothing can
  // ever reach (M4). Left alone when the duration isn't known yet.
  const shots = prev ? (duration === null ? prev.shots : prev.shots.filter((s) => s.start < duration)) : [];
  const version: Version = {
    id: `v${n}`,
    file: input.file,
    duration,
    fps: input.fps ?? null,
    addedAt: now.toISOString(),
    note: input.note ?? "",
    shots: shots.map((s) => ({ ...s })),
    proxy: null,
    width: input.width ?? null,
    height: input.height ?? null,
    formats: [],
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
  /** Lane id. Defaults to the round name, slugged, or the stage name, e.g. "music". Wins over `round`. */
  lane?: string;
  /**
   * Round name for voice reads, e.g. "Round 2 · Gerald, tone". Reads in one round are compared
   * side by side; a new direction gets a new round. With no `lane`, the lane id is this name
   * slugged, and a new lane is created on first use, named for it.
   */
  round?: string;
  name: string;
  file: string;
  meta?: Record<string, string | number>;
  /** The one-line description the lane card shows. Stored as `meta.description`; wins over a `description` inside `meta`. */
  description?: string;
  cues?: { name: string; t: number }[];
}

const LANE_NAMES: Record<LaneStage, string> = { voice: "Voiceover", music: "Music", sfx: "Sound effects" };

export function addVariant(p: Project, input: AddVariantInput): { lane: Lane; variant: Variant } {
  // Lane ids are capped at 64 by the schema; a slug can outgrow its source (NFKD splits ligatures).
  const laneId = slugify(input.lane ?? input.round ?? input.stage).slice(0, 64).replace(/-+$/, "");
  let lane = p.lanes.find((l) => l.id === laneId);
  if (lane && lane.stage !== input.stage) throw new InvalidError(`Lane "${laneId}" belongs to ${lane.stage}, not ${input.stage}`);
  if (!lane) {
    lane = { id: laneId, stage: input.stage, name: input.round ?? input.lane ?? LANE_NAMES[input.stage], variants: [] };
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
    meta: input.description === undefined ? { ...input.meta } : { ...input.meta, description: input.description },
    cues,
  };
  lane.variants.push(variant);
  return { lane, variant };
}

export interface AddFileInput {
  kind: FileKind;
  /** Manifest path (already passed through toManifestPath). */
  file: string;
  /** Shown in the library. Defaults to the file's base name. */
  name?: string;
  note?: string;
  /** Video id or name this file belongs to, e.g. a delivery or export for a specific film. */
  video?: string;
}

const FILE_NAME_MAX = 120;
// Leaves room for uniqueId's "-2", "-3" ... suffix and the odd longer one, well inside the
// schema's 64-character id cap.
const FILE_SLUG_MAX = 58;

/** `base`, cut to at most `max` characters, preferring to cut at a `-` so the id still reads as
 *  whole words rather than stopping mid-word. */
function trimSlugBase(base: string, max: number): string {
  if (base.length <= max) return base;
  const cut = base.slice(0, max);
  const dash = cut.lastIndexOf("-");
  return dash > max / 2 ? cut.slice(0, dash) : cut;
}

/** Registers a project file (a doc, image, caption, export, delivery or edit file) in the library. */
export function addFile(p: Project, input: AddFileInput, now = new Date()): FileEntry {
  const given = input.name?.trim();
  let name: string;
  if (given) {
    if (given.length > FILE_NAME_MAX) throw new InvalidError("Name is over 120 characters");
    name = given;
  } else {
    const base = basename(input.file);
    name = base.length > FILE_NAME_MAX ? `${base.slice(0, FILE_NAME_MAX - 1)}…` : base;
  }
  const video = input.video ? resolveVideo(p, input.video).id : null;
  const entry: FileEntry = {
    id: uniqueId(trimSlugBase(slugify(name), FILE_SLUG_MAX), p.files.map((f) => f.id)),
    kind: input.kind,
    file: input.file,
    name,
    note: input.note ?? "",
    video,
    addedAt: now.toISOString(),
  };
  p.files.push(entry);
  return entry;
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

/** The cut `videoRef`/`versionId` names, defaulting to the newest cut of the only or newest film (§21.4, R16). */
export function resolveCut(p: Project, videoRef?: string, versionId?: string): { video: Video; version: Version } {
  let video: Video | undefined;
  if (videoRef !== undefined) video = resolveVideo(p, videoRef);
  else {
    let newest: string | null = null;
    for (const v of p.videos) {
      const last = latestVersion(v);
      if (last && (newest === null || last.addedAt >= newest)) {
        newest = last.addedAt;
        video = v;
      }
    }
  }
  if (!video) throw new RushesError("There's no cut to add a format to yet. Register one with rushes_add_version first.", 404, "no_cut");
  return { video, version: resolveVersion(video, versionId) };
}

export interface AddFormatInput {
  /** Video id or name. Defaults to the newest cut's film (R16). */
  video?: string;
  /** Defaults to that film's newest version. */
  version?: string;
  /** Manifest path (already passed through toManifestPath). */
  file: string;
  /** The render's picture size as shown (probeVideo applies rotation and pixel shape). */
  width: number;
  height: number;
  duration: number | null;
  fps: number | null;
  /** §21.4: only a hint, for a ratio that isn't a standard one (R10). */
  label?: string;
  /** The primary's own size, read by the caller when the version has none yet (a cut from before formats). */
  primarySize?: { width: number; height: number } | null;
}

export interface AddFormatResult { video: Video; version: Version; format: Format; warning: string | null; labelNote: string | null }

/** A size the probe or the caller gave that isn't a picture size is a refusal, not a crash. */
function checkedLabel(width: number, height: number, hint?: string): { label: string; note: string | null } {
  try {
    return settleLabel(width, height, hint);
  } catch (e) {
    if (e instanceof RangeError) throw new RushesError(`${width}×${height} isn't a picture size.`, 400, "bad_size", { width, height });
    throw e;
  }
}

/**
 * §21.3: registers another shape of a cut. Refuses a ratio the cut already has, and a ninth shape.
 * Atomic: every check runs on local values, and the version is written only once all of them pass.
 */
export function addFormat(p: Project, input: AddFormatInput, now = new Date()): AddFormatResult {
  const { video, version } = resolveCut(p, input.video, input.version);
  let primary: { width: number; height: number } | null = version.width !== null && version.height !== null ? { width: version.width, height: version.height } : null;
  if (!primary) {
    if (!input.primarySize) {
      throw new RushesError(
        `Rushes can't read ${version.id}'s own picture size, so it can't tell a new shape from it. Check that the cut's file is there and that ffprobe is installed.`,
        422, "no_primary_size", { version: version.id },
      );
    }
    primary = { width: input.primarySize.width, height: input.primarySize.height };
    checkedLabel(primary.width, primary.height);
  }
  const { label, note } = checkedLabel(input.width, input.height, input.label);
  const id = ratioId(label);
  const shapes = versionFormats({ ...version, width: primary.width, height: primary.height });
  // The same id, or a ratio within 1% under another label (final review M1): either way, one shape.
  const taken = shapes.find((f) => f.id === id) ?? shapes.find((f) => sameShape(f, input));
  if (taken) {
    throw new RushesError(`${version.id} already has ${taken.label}. Register a re-render as a new version.`, 409, "same_ratio", { version: version.id, id: taken.id, label: taken.label, file: taken.file });
  }
  if (shapes.length >= MAX_FORMATS) {
    throw new RushesError(`${version.id} already has ${MAX_FORMATS} formats, the most one cut can have.`, 400, "too_many_formats", { version: version.id });
  }
  const format: Format = { id, label, file: input.file, width: input.width, height: input.height, duration: input.duration, fps: input.fps, addedAt: now.toISOString() };
  // Every check has passed: now, and only now, the version changes.
  version.width = primary.width;
  version.height = primary.height;
  version.formats.push(format);
  return { video, version, format, warning: durationWarning(label, input.duration, version.duration), labelNote: note };
}

/** The last shot whose start is at or before `t`, or null when `t` is before the first shot. */
export function shotAt(shots: Shot[], t: number): { n: number; name: string } | null {
  let found: Shot | null = null;
  for (const s of shots) {
    if (s.start <= t && (!found || s.start > found.start)) found = s;
  }
  return found ? { n: found.n, name: found.name } : null;
}
