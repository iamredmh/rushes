import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { LaneStage, Project, Script } from "../core/schema.js";
import type { Store } from "../core/store.js";
import { fromManifestPath } from "../core/paths.js";
import { GRAB_PATH, SCREENSHOT_PATH, registeredMedia } from "./files.js";

export type AssetKind = "screenshot" | "cut" | "take" | "music" | "sfx" | "voice";

export interface Asset {
  kind: AssetKind;
  path: string;
  abs: string;
  name: string;
  size: number | null;
  modified: string | null;
  missing: boolean;
  video?: string;
  version?: string;
  frame?: number;
  t?: number;
  section?: string;
  lane?: string;
  variant?: string;
}

/**
 * "hero-60s_v3_00m12.10s_f726.png": the time is frame/fps, rounded to hundredths before
 * splitting into minutes and seconds -- the same rule fmt() uses, so 59.999s carries into the
 * next minute rather than printing 00m60.00s.
 */
export function screenshotName(video: string, version: string, frame: number, fps: number): string {
  const t = frame / fps;
  const cs = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(cs / 6000);
  const s = ((cs - m * 6000) / 100).toFixed(2).padStart(5, "0");
  const mm = String(m).padStart(2, "0");
  return `${video}_${version}_${mm}m${s}s_f${frame}.png`;
}

/** The fps to use for a grab or screenshot: the version's own, falling back to the project's. */
export function fpsFor(project: Project, video: string, version: string): number {
  const v = project.videos.find((x) => x.id === video)?.versions.find((x) => x.id === version);
  return v?.fps ?? project.fps;
}

// Parses a name screenshotName() itself produced.
const NEW_NAME = /^([a-z0-9][a-z0-9-]*)_(v\d+)_(\d{2})m(\d{2}\.\d{2})s_f(\d+)\.png$/;
// Parses a Plan 1-2 grab name: {video}_{version}_f{frame}.png.
const OLD_NAME = /^([a-z0-9][a-z0-9-]*)_(v\d+)_f(\d+)\.png$/;

async function statInfo(abs: string): Promise<{ size: number | null; modified: string | null; mtimeMs: number; missing: boolean }> {
  try {
    const info = await stat(abs);
    return { size: info.size, modified: info.mtime.toISOString(), mtimeMs: info.mtimeMs, missing: false };
  } catch {
    return { size: null, modified: null, mtimeMs: 0, missing: true };
  }
}

/** The two screenshot directories, as (directory, manifest prefix, safe-name regex) triples. */
const SCREENSHOT_DIRS = [
  ["screenshots", "screenshots/", SCREENSHOT_PATH],
  [".rushes/grabs", ".rushes/grabs/", GRAB_PATH],
] as const;

/** Names (not full paths) of every *.png directly inside `dir`, never recursing. Empty when the directory doesn't exist. */
async function pngNames(store: Store, dir: string): Promise<string[]> {
  try {
    return (await readdir(join(store.root, dir))).filter((n) => n.toLowerCase().endsWith(".png"));
  } catch {
    return [];
  }
}

/**
 * Every *.png directly inside one screenshots directory, skipping anything whose name `safe`
 * wouldn't let /media serve. Stats every candidate in parallel; the returned order matches the
 * order `names` came in, so the caller's own sort (by modified time) sees a stable input. A name
 * that parses as video_version_time_frame (or the older video_version_frame) carries video,
 * version, frame and t; anything else is still listed, just without those fields.
 */
async function scanScreenshotDir(
  store: Store,
  names: string[],
  manifestPrefix: string,
  safe: RegExp,
  project: Project,
): Promise<{ asset: Asset; mtimeMs: number }[]> {
  const candidates = names.map((name) => ({ name, path: `${manifestPrefix}${name}` })).filter(({ path }) => safe.test(path));
  const results = await Promise.all(
    candidates.map(async ({ name, path }) => {
      const abs = fromManifestPath(store.root, path);
      const info = await statInfo(abs);
      if (info.missing) return null; // vanished between the directory read and the stat
      const asset: Asset = { kind: "screenshot", path, abs, name, size: info.size, modified: info.modified, missing: false };
      const newMatch = NEW_NAME.exec(name);
      const oldMatch = newMatch ? null : OLD_NAME.exec(name);
      if (newMatch) {
        asset.video = newMatch[1];
        asset.version = newMatch[2];
        asset.frame = Number(newMatch[5]);
        asset.t = asset.frame / fpsFor(project, asset.video, asset.version);
      } else if (oldMatch) {
        asset.video = oldMatch[1];
        asset.version = oldMatch[2];
        asset.frame = Number(oldMatch[3]);
        asset.t = asset.frame / fpsFor(project, asset.video, asset.version);
      }
      return { asset, mtimeMs: info.mtimeMs };
    }),
  );
  return results.filter((x): x is { asset: Asset; mtimeMs: number } => x !== null);
}

async function fileAsset(
  store: Store,
  kind: AssetKind,
  path: string,
  extra: Partial<Pick<Asset, "video" | "version" | "section" | "lane" | "variant">>,
): Promise<Asset> {
  const abs = fromManifestPath(store.root, path);
  const info = await statInfo(abs);
  return { kind, path, abs, name: basename(path), size: info.size, modified: info.modified, missing: info.missing, ...extra };
}

function variantEntries(project: Project, stage: LaneStage): { lane: string; variant: string; file: string }[] {
  return project.lanes
    .filter((lane) => lane.stage === stage)
    .flatMap((lane) => lane.variants.map((variant) => ({ lane: lane.id, variant: variant.id, file: variant.file })));
}

/**
 * Every asset in the project: screenshots (newest modified first), then cuts (by video in
 * project order, newest version first), then takes, voice, music and sfx, each in manifest
 * order. Callers never need to sort this themselves. Every file this returns has been `stat`ed,
 * in parallel within each group, so a large project doesn't pay for it one file at a time.
 */
export async function listAssets(store: Store, project: Project, script: Script): Promise<Asset[]> {
  const cutEntries = project.videos.flatMap((video) =>
    [...video.versions].reverse().map((version) => ({ video: video.id, version: version.id, file: version.file })),
  );
  const takeEntries = script.sections.flatMap((section) => section.takes.map((take) => ({ section: section.id, file: take.file })));

  const [[freshNames, oldNames], cuts, takes, voice, music, sfx] = await Promise.all([
    Promise.all([pngNames(store, SCREENSHOT_DIRS[0][0]), pngNames(store, SCREENSHOT_DIRS[1][0])]),
    Promise.all(cutEntries.map((e) => fileAsset(store, "cut", e.file, { video: e.video, version: e.version }))),
    Promise.all(takeEntries.map((e) => fileAsset(store, "take", e.file, { section: e.section }))),
    Promise.all(variantEntries(project, "voice").map((e) => fileAsset(store, "voice", e.file, { lane: e.lane, variant: e.variant }))),
    Promise.all(variantEntries(project, "music").map((e) => fileAsset(store, "music", e.file, { lane: e.lane, variant: e.variant }))),
    Promise.all(variantEntries(project, "sfx").map((e) => fileAsset(store, "sfx", e.file, { lane: e.lane, variant: e.variant }))),
  ]);
  const [fresh, old] = await Promise.all([
    scanScreenshotDir(store, freshNames, SCREENSHOT_DIRS[0][1], SCREENSHOT_DIRS[0][2], project),
    scanScreenshotDir(store, oldNames, SCREENSHOT_DIRS[1][1], SCREENSHOT_DIRS[1][2], project),
  ]);
  const screenshots = [...fresh, ...old].sort((a, b) => b.mtimeMs - a.mtimeMs).map((x) => x.asset);

  return [...screenshots, ...cuts, ...takes, ...voice, ...music, ...sfx];
}

/**
 * Every path `/api/assets` would list, without stat'ing any of them: registered media (cuts,
 * takes, variants -- present whether or not the file is actually there) plus every *.png
 * directly inside screenshots/ and .rushes/grabs/ whose name the matching safe-name regex would
 * let /media serve. POST /api/reveal uses this to check a path cheaply, stat'ing only the one
 * file it actually needs instead of every asset in the project.
 */
export async function candidatePaths(store: Store, project: Project, script: Script): Promise<Set<string>> {
  const paths = registeredMedia(project, script);
  const nameLists = await Promise.all(SCREENSHOT_DIRS.map(([dir]) => pngNames(store, dir)));
  for (let i = 0; i < SCREENSHOT_DIRS.length; i++) {
    const [, manifestPrefix, safe] = SCREENSHOT_DIRS[i];
    for (const name of nameLists[i]) {
      const path = `${manifestPrefix}${name}`;
      if (safe.test(path)) paths.add(path);
    }
  }
  return paths;
}
