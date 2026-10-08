import { readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { FileEntry, FileKind, LaneStage, Project, Script } from "../core/schema.js";
import type { Store } from "../core/store.js";
import { fromManifestPath } from "../core/paths.js";
import { GRAB_PATH, SCREENSHOT_PATH, registeredMedia } from "./files.js";
import { PROXY_PATH } from "./proxy.js";
import { chipOrder, labelOfId, versionFormats } from "../core/formats.js";

export type AssetKind = "screenshot" | "cut" | "proxy" | "take" | "music" | "sfx" | "voice" | FileKind;

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
  note?: string;
  /** The human display name for a take or variant (its own name, or "Take N") -- `name` stays
   *  the file's basename, since Download/Save-as need that for the real file; this is what the
   *  dashboard shows instead when it's present. */
  label?: string;
  /** The lane's own name (distinct from `lane`, its id), for a voice/music/sfx row's secondary
   *  text. */
  laneName?: string;
  /** A voice/music/sfx variant's own meta (e.g. {bpm: 120, key: "A minor"}), for the same
   *  secondary text. Only present when the variant actually has any. */
  meta?: Record<string, string | number>;
  /** A proxy's picture size (§19.5), from its record. */
  width?: number;
  height?: number;
  /** §21: a cut's format row (its id), and the ratio label on a cut with formats. */
  format?: string;
  formatLabel?: string;
}

/**
 * "hero-60s_v3_00m12.10s_f726.png": the time is frame/fps, rounded to hundredths before
 * splitting into minutes and seconds -- the same rule fmt() uses, so 59.999s carries into the
 * next minute rather than printing 00m60.00s.
 */
export function screenshotName(video: string, version: string, frame: number, fps: number, format: string | null = null): string {
  const t = frame / fps;
  const cs = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(cs / 6000);
  const s = ((cs - m * 6000) / 100).toFixed(2).padStart(5, "0");
  const mm = String(m).padStart(2, "0");
  // §21.5: a grab of a cut with formats carries the ratio it shows ("hero_v1_9x16_00m01.00s_f30.png").
  return `${video}_${version}${format ? `_${format}` : ""}_${mm}m${s}s_f${frame}.png`;
}

/** The fps to use for a grab or screenshot: the version's own, falling back to the project's. */
export function fpsFor(project: Project, video: string, version: string): number {
  const v = project.videos.find((x) => x.id === video)?.versions.find((x) => x.id === version);
  return v?.fps ?? project.fps;
}

// Parses a name screenshotName() itself produced, with or without a format's ratio (§21.5).
const NEW_NAME = /^([a-z0-9][a-z0-9-]*)_(v\d+)(?:_(\d+(?:\.\d+)?x\d+(?:\.\d+)?))?_(\d{2})m(\d{2}\.\d{2})s_f(\d+)\.png$/;
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
        asset.frame = Number(newMatch[6]);
        asset.t = asset.frame / fpsFor(project, asset.video, asset.version);
        if (newMatch[3]) {
          asset.format = newMatch[3];
          asset.formatLabel = labelOfId(newMatch[3]);
        }
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
  extra: Partial<Pick<Asset, "video" | "version" | "section" | "lane" | "variant" | "note" | "label" | "laneName" | "meta" | "width" | "height" | "format" | "formatLabel">>,
): Promise<Asset> {
  const abs = fromManifestPath(store.root, path);
  const info = await statInfo(abs);
  return { kind, path, abs, name: basename(path), size: info.size, modified: info.modified, missing: info.missing, ...extra };
}

async function registeredFileAsset(store: Store, f: FileEntry): Promise<Asset> {
  const abs = fromManifestPath(store.root, f.file);
  const info = await statInfo(abs);
  // `name` stays the file's own basename -- Download, Save-as and the dashboard's extension
  // checks (isPreviewable, Open) all read it, the same as a take or variant already does -- and
  // `f.name` (the display name the agent or CLI gave it) goes in `label` instead (I2).
  const asset: Asset = {
    kind: f.kind, path: f.file, abs, name: basename(f.file), label: f.name, size: info.size, modified: info.modified, missing: info.missing, note: f.note,
  };
  if (f.video) asset.video = f.video;
  return asset;
}

/** §16.2's new kinds, in the order the library shows them. */
const LIBRARY_KINDS: FileKind[] = ["doc", "image", "caption", "export", "delivery", "edit"];

const DOC_EXT = new Set(["md", "txt", "pdf"]);
const CAPTION_EXT = new Set(["srt", "vtt"]);

/**
 * Names (not full paths) of every regular file directly inside `dir`, optionally filtered to
 * `exts` (lower-case, no dot). Never recurses, never follows a symlink, and skips hidden names,
 * the same cheap, one-level readdir the screenshot scan already does. Empty when `dir` doesn't
 * exist. Sorted by name, so auto-discovered files always list in a stable order.
 */
async function dirFileNames(store: Store, dir: string, exts?: ReadonlySet<string>): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(store.root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const d of entries) {
    if (d.isSymbolicLink() || d.isDirectory() || !d.isFile()) continue;
    if (d.name.startsWith(".")) continue;
    if (exts && !exts.has(extname(d.name).toLowerCase().slice(1))) continue;
    names.push(d.name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * §16.2's auto-discovered paths: every *.md/.txt/.pdf directly in the project root (`doc`), every
 * *.srt/.vtt directly in the root (`caption`), and every file directly in `exports/` (`export`).
 * Hidden files, anything inside `.rushes/`, and anything in a deeper sub-folder never appear,
 * because this only ever reads one directory level.
 */
async function discoveredLibraryPaths(store: Store): Promise<{ doc: string[]; caption: string[]; export: string[] }> {
  // One readdir of the project root serves both doc and caption (§16.2's two root extension
  // sets), rather than reading the same directory twice over just to apply a different filter.
  const [rootNames, exportNames] = await Promise.all([dirFileNames(store, "."), dirFileNames(store, "exports")]);
  const extOf = (n: string) => extname(n).toLowerCase().slice(1);
  const doc = rootNames.filter((n) => DOC_EXT.has(extOf(n)));
  const caption = rootNames.filter((n) => CAPTION_EXT.has(extOf(n)));
  return { doc, caption, export: exportNames.map((n) => `exports/${n}`) };
}

/**
 * The library assets (doc, image, caption, export, delivery, edit), one kind at a time in
 * LIBRARY_KINDS order. Within a kind, registered files come first in manifest order, then
 * auto-discovered files sorted by name; a path that's both registered and auto-discovered is
 * listed once, with the registered metadata (§16.2).
 */
async function libraryAssets(store: Store, project: Project): Promise<Asset[]> {
  const discovered = await discoveredLibraryPaths(store);
  const autoByKind: Partial<Record<FileKind, string[]>> = { doc: discovered.doc, caption: discovered.caption, export: discovered.export };
  const out: Asset[] = [];
  for (const kind of LIBRARY_KINDS) {
    const registered = project.files.filter((f) => f.kind === kind);
    out.push(...(await Promise.all(registered.map((f) => registeredFileAsset(store, f)))));
    const registeredPaths = new Set(registered.map((f) => f.file));
    const auto = (autoByKind[kind] ?? []).filter((path) => !registeredPaths.has(path));
    out.push(...(await Promise.all(auto.map((path) => fileAsset(store, kind, path, {})))));
  }
  return out;
}

function variantEntries(
  project: Project,
  stage: LaneStage,
): { lane: string; laneName: string; variant: string; label: string; meta: Record<string, string | number> | undefined; file: string }[] {
  return project.lanes
    .filter((lane) => lane.stage === stage)
    .flatMap((lane) =>
      lane.variants.map((variant) => ({
        lane: lane.id,
        laneName: lane.name,
        variant: variant.id,
        label: variant.name,
        meta: Object.keys(variant.meta).length > 0 ? variant.meta : undefined,
        file: variant.file,
      })),
    );
}

/**
 * Every asset in the project: screenshots (newest modified first), then cuts (by video in
 * project order, newest version first), then proxies (§19.5, the same order, only for a cut that
 * has one recorded), then takes, voice, music and sfx, each in manifest
 * order. Callers never need to sort this themselves. Every file this returns has been `stat`ed,
 * in parallel within each group, so a large project doesn't pay for it one file at a time.
 */
export async function listAssets(store: Store, project: Project, script: Script): Promise<Asset[]> {
  // §21.5: each cut, then its formats as sub-rows in chip order, each with the ratio it is.
  type CutEntry = { video: string; version: string; file: string; formatLabel?: string; format?: string; width?: number; height?: number };
  const cutEntries: CutEntry[] = project.videos.flatMap((video) =>
    [...video.versions].reverse().flatMap((version): CutEntry[] => {
      const views = versionFormats(version);
      const primary = views.find((f) => f.primary);
      const own: CutEntry = { video: video.id, version: version.id, file: version.file, ...(version.formats.length > 0 && primary ? { formatLabel: primary.label } : {}) };
      const subs = chipOrder(version.formats).map((f) => ({ video: video.id, version: version.id, file: f.file, format: f.id, formatLabel: labelOfId(f.id), width: f.width, height: f.height }));
      return [own, ...subs];
    }),
  );
  const proxyEntries = project.videos.flatMap((video) =>
    // Only a file this server would have written into proxies/: a hand-edited record pointing
    // anywhere else (the original, say) is never offered for deletion as a proxy.
    [...video.versions].reverse().flatMap((version) =>
      version.proxy && PROXY_PATH.test(version.proxy.file) ? [{ video: video.id, version: version.id, proxy: version.proxy }] : [],
    ),
  );
  // A take has no name of its own in script.json (just an id and the text it was read against),
  // so its label is its ordinal within the section -- "Take 1", "Take 2" -- rather than the file
  // name Download/Save-as still need under `name`.
  const takeEntries = script.sections.flatMap((section) =>
    section.takes.map((take, i) => ({ section: section.id, file: take.file, label: `Take ${i + 1}` })),
  );

  const [[freshNames, oldNames], cuts, proxies, takes, voice, music, sfx] = await Promise.all([
    Promise.all([pngNames(store, SCREENSHOT_DIRS[0][0]), pngNames(store, SCREENSHOT_DIRS[1][0])]),
    Promise.all(cutEntries.map((e) => fileAsset(store, "cut", e.file, { video: e.video, version: e.version, format: e.format, formatLabel: e.formatLabel, width: e.width, height: e.height }))),
    Promise.all(proxyEntries.map((e) => fileAsset(store, "proxy", e.proxy.file, { video: e.video, version: e.version, width: e.proxy.width, height: e.proxy.height }))),
    Promise.all(takeEntries.map((e) => fileAsset(store, "take", e.file, { section: e.section, label: e.label }))),
    Promise.all(variantEntries(project, "voice").map((e) => fileAsset(store, "voice", e.file, { lane: e.lane, laneName: e.laneName, variant: e.variant, label: e.label, meta: e.meta }))),
    Promise.all(variantEntries(project, "music").map((e) => fileAsset(store, "music", e.file, { lane: e.lane, laneName: e.laneName, variant: e.variant, label: e.label, meta: e.meta }))),
    Promise.all(variantEntries(project, "sfx").map((e) => fileAsset(store, "sfx", e.file, { lane: e.lane, laneName: e.laneName, variant: e.variant, label: e.label, meta: e.meta }))),
  ]);
  const [fresh, old] = await Promise.all([
    scanScreenshotDir(store, freshNames, SCREENSHOT_DIRS[0][1], SCREENSHOT_DIRS[0][2], project),
    scanScreenshotDir(store, oldNames, SCREENSHOT_DIRS[1][1], SCREENSHOT_DIRS[1][2], project),
  ]);
  const screenshots = [...fresh, ...old].sort((a, b) => b.mtimeMs - a.mtimeMs).map((x) => x.asset);
  const library = await libraryAssets(store, project);

  return [...screenshots, ...cuts, ...proxies, ...takes, ...voice, ...music, ...sfx, ...library];
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
  const discovered = await discoveredLibraryPaths(store);
  for (const path of [...discovered.doc, ...discovered.caption, ...discovered.export]) paths.add(path);
  return paths;
}
