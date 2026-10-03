import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { LaneStage, Project, Script } from "../core/schema.js";
import type { Store } from "../core/store.js";
import { fromManifestPath } from "../core/paths.js";
import { GRAB_PATH, SCREENSHOT_PATH } from "./files.js";

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

/**
 * Every *.png directly inside one screenshots directory (never recursing), skipping anything
 * that isn't a .png and anything whose name `safe` wouldn't let /media serve. A name that
 * parses as video_version_time_frame (or the older video_version_frame) carries video, version,
 * frame and t; anything else is still listed, just without those fields.
 */
async function scanScreenshotDir(
  store: Store,
  dir: string,
  manifestPrefix: string,
  safe: RegExp,
  project: Project,
): Promise<{ asset: Asset; mtimeMs: number }[]> {
  let names: string[];
  try {
    names = await readdir(join(store.root, dir));
  } catch {
    return [];
  }
  const out: { asset: Asset; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".png")) continue;
    const path = `${manifestPrefix}${name}`;
    if (!safe.test(path)) continue;
    const abs = fromManifestPath(store.root, path);
    const info = await statInfo(abs);
    if (info.missing) continue; // vanished between the directory read and the stat
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
    out.push({ asset, mtimeMs: info.mtimeMs });
  }
  return out;
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

async function variantAssets(store: Store, project: Project, stage: LaneStage): Promise<Asset[]> {
  const out: Asset[] = [];
  for (const lane of project.lanes) {
    if (lane.stage !== stage) continue;
    for (const variant of lane.variants) {
      out.push(await fileAsset(store, stage, variant.file, { lane: lane.id, variant: variant.id }));
    }
  }
  return out;
}

/**
 * Every asset in the project: screenshots (newest modified first), then cuts (by video in
 * project order, newest version first), then takes, voice, music and sfx, each in manifest
 * order. Callers never need to sort this themselves.
 */
export async function listAssets(store: Store, project: Project, script: Script): Promise<Asset[]> {
  const [fresh, old] = await Promise.all([
    scanScreenshotDir(store, "screenshots", "screenshots/", SCREENSHOT_PATH, project),
    scanScreenshotDir(store, ".rushes/grabs", ".rushes/grabs/", GRAB_PATH, project),
  ]);
  const screenshots = [...fresh, ...old].sort((a, b) => b.mtimeMs - a.mtimeMs).map((x) => x.asset);

  const cuts: Asset[] = [];
  for (const video of project.videos) {
    for (const version of [...video.versions].reverse()) {
      cuts.push(await fileAsset(store, "cut", version.file, { video: video.id, version: version.id }));
    }
  }

  const takes: Asset[] = [];
  for (const section of script.sections) {
    for (const take of section.takes) {
      takes.push(await fileAsset(store, "take", take.file, { section: section.id }));
    }
  }

  const voice = await variantAssets(store, project, "voice");
  const music = await variantAssets(store, project, "music");
  const sfx = await variantAssets(store, project, "sfx");

  return [...screenshots, ...cuts, ...takes, ...voice, ...music, ...sfx];
}
