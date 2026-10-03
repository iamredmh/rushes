// Pure helpers for the dashboard. No DOM, so they're unit-tested in Node.
import type { Asset, AssetKind, Note, Section, Shot, Stage, TabState, Video, Version } from "./types.js";

/** 72.4 -> "1:12.40" (minutes, seconds, hundredths). */
export function fmt(t: number): string {
  // Round to hundredths first, so 59.999 becomes 1:00.00 rather than 0:60.00.
  const cs = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(cs / 6000);
  const s = ((cs - m * 6000) / 100).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}

/** The frame showing at time t. */
export function frameAt(t: number, fps: number): number {
  return Math.round(t * fps);
}

/** t moved to the start of its frame, to the microsecond. */
export function snap(t: number, fps: number): number {
  return Math.round((frameAt(t, fps) / fps) * 1e6) / 1e6;
}

/** Time of the frame `n` steps from the one at t, clamped to [0, duration]. */
export function stepFrame(t: number, fps: number, n: number, duration: number): number {
  const frame = frameAt(t, fps) + n;
  return Math.min(Math.max(0, frame / fps), duration || Infinity);
}

/** Where a note sits in the version being watched, and where it came from if it was left on another one. */
export function placeNote(note: Note, version: string | null): { t: number | null; tOut: number | null; from: string | null } {
  if (note.t === null) return { t: null, tOut: null, from: null };
  if (!note.version || note.version === version) return { t: note.t, tOut: note.tOut, from: null };
  const from = `${note.version} at ${fmt(note.t)}`;
  if (note.fixT !== null && note.fixVersion === version) {
    const len = note.tOut !== null ? note.tOut - note.t : null;
    return { t: note.fixT, tOut: len !== null ? note.fixT + len : null, from };
  }
  return { t: note.t, tOut: note.tOut, from };
}

/** "1:12.40", "0:31.05–0:33.10" or "Whole". */
export function noteTime(t: number | null, tOut: number | null): string {
  if (t === null) return "Whole";
  return tOut !== null ? `${fmt(t)}–${fmt(tOut)}` : fmt(t);
}

export type FitState = "ok" | "tight" | "over";

/** Words, reading time and whether a line fits its slot. Matches the server's fit(). */
export function fit(text: string, slotSeconds: number, wordsPerSecond: number): { words: number; seconds: number; ratio: number; state: FitState } {
  const words = (text.trim().match(/\S+/g) ?? []).length;
  const seconds = words / wordsPerSecond;
  const ratio = slotSeconds > 0 ? seconds / slotSeconds : Infinity;
  return { words, seconds, ratio, state: ratio > 1 ? "over" : ratio > 0.8 ? "tight" : "ok" };
}

export function isChanged(s: Section): boolean {
  return s.proposed !== null && s.proposed.trim() !== s.current.trim();
}

export function latest(video: Video | undefined): Version | undefined {
  return video?.versions[video.versions.length - 1];
}

/** The version a film opens on: its locked version if it has one and the version still exists, otherwise the newest. */
export function defaultVersion(video: Video | undefined): Version | undefined {
  if (video?.lockedVersion) {
    const locked = video.versions.find((v) => v.id === video.lockedVersion);
    if (locked) return locked;
  }
  return latest(video);
}

/** The id of the film one step before/after `currentId` in `videos`, or null at either end or if not found. */
export function neighbourVideo(videos: Video[], currentId: string | null, dir: -1 | 1): string | null {
  const i = videos.findIndex((v) => v.id === currentId);
  if (i === -1) return null;
  const j = i + dir;
  return j >= 0 && j < videos.length ? videos[j].id : null;
}

/** Is this stage built in this release of the dashboard? Later releases add the audio tabs. */
export const BUILT: Record<Stage, boolean> = { script: true, picture: true, voice: false, music: false, sfx: false, mix: false };

export const STAGE_NAMES: Record<Stage, string> = {
  script: "Script",
  picture: "Picture",
  voice: "Voiceover",
  music: "Music",
  sfx: "Sound effects",
  mix: "Mix",
};

/** One line saying what unlocks a tab. */
export const UNLOCK_HINT: Record<Stage, string> = {
  script: "It unlocks when your agent adds a script with rushes_set_script.",
  picture: "It unlocks when your agent adds a cut with rushes_add_version.",
  voice: "It unlocks when your agent adds a VO take with rushes_add_take.",
  music: "It unlocks when your agent adds a music bed with rushes_add_variant.",
  sfx: "It unlocks when your agent adds an SFX pass with rushes_add_variant.",
  mix: "It unlocks once there's a cut and at least one audio stage.",
};

/** Which tab to show first: the first unlocked one in workflow order, preferring Picture when it's there. */
export function firstTab(tabs: TabState[]): Stage {
  if (tabs.find((t) => t.stage === "picture")?.unlocked) return "picture";
  return tabs.find((t) => t.unlocked)?.stage ?? "picture";
}

/**
 * The last shot whose start is at or before `t`, or null when `t` is before the first shot.
 * Mirrors src/core/project.ts's shotAt exactly: copied rather than imported, because the web
 * bundle imports types only from src/.
 */
export function shotAt(shots: Shot[], t: number): { n: number; name: string } | null {
  let found: Shot | null = null;
  for (const s of shots) {
    if (s.start <= t && (!found || s.start > found.start)) found = s;
  }
  return found ? { n: found.n, name: found.name } : null;
}

/** "2" -> "02"; widens to 3 digits once n reaches 100. */
export function shotLabel(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The first frame at or after a shot's start, so clicking its card seeks somewhere that
 * snaps forward into the shot rather than a frame early (a shot starting between frames,
 * e.g. 1.71s at 30fps, would otherwise snap back to the frame before it). The epsilon
 * stops an exact frame boundary being pushed a frame later by floating-point error.
 */
export function shotSeek(start: number, fps: number): number {
  return Math.ceil(start * fps - 1e-9) / fps;
}

/** "1536 -> 2 KB", "1587200 -> 1.5 MB". Whole numbers up to KB; one decimal from MB up. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * §16.3: the only extensions Open will act on, lower-case and without the dot. A web-side copy of
 * src/server/reveal.ts's OPEN_SAFE_EXT (deliberately duplicated rather than imported, since the
 * web bundle never pulls in server code) -- a unit test asserts the two stay equal. svg is
 * deliberately excluded: on macOS an SVG often opens in a browser and can carry script.
 */
export const OPEN_SAFE_EXT: ReadonlySet<string> = new Set([
  "md", "txt", "pdf", "srt", "vtt",
  "png", "jpg", "jpeg", "gif", "webp",
  "mp4", "mov", "m4v", "webm", "mkv",
  "wav", "mp3", "m4a", "aac", "flac", "ogg",
  "prproj", "drp",
]);

/** The lower-case extension of a file name, without the dot ("a.MP4" -> "mp4"; "noext" -> ""). */
export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

export type FolderId = "screenshot" | "cut" | "voiceover" | "music" | "sfx" | "doc" | "image" | "caption" | "export" | "delivery" | "edit";

export interface FolderDef {
  id: FolderId;
  title: string;
  kinds: AssetKind[];
  /** The view a folder opens in before anything's been remembered in localStorage for it. */
  view: "grid" | "list";
  /** Whether the "All films / one film" filter applies to this folder (§16.1). */
  filmFilter: boolean;
}

/** §16.1's folders, in their fixed sidebar order. */
export const FOLDERS: FolderDef[] = [
  { id: "screenshot", title: "Screenshots", kinds: ["screenshot"], view: "grid", filmFilter: true },
  { id: "cut", title: "Cuts", kinds: ["cut"], view: "grid", filmFilter: true },
  { id: "voiceover", title: "Voiceover", kinds: ["take", "voice"], view: "list", filmFilter: false },
  { id: "music", title: "Music", kinds: ["music"], view: "list", filmFilter: false },
  { id: "sfx", title: "Sound effects", kinds: ["sfx"], view: "list", filmFilter: false },
  { id: "doc", title: "Scripts & docs", kinds: ["doc"], view: "list", filmFilter: false },
  { id: "image", title: "Images", kinds: ["image"], view: "grid", filmFilter: false },
  { id: "caption", title: "Captions", kinds: ["caption"], view: "list", filmFilter: false },
  { id: "export", title: "Exports", kinds: ["export"], view: "list", filmFilter: false },
  { id: "delivery", title: "Delivery", kinds: ["delivery"], view: "grid", filmFilter: true },
  { id: "edit", title: "Edit files", kinds: ["edit"], view: "list", filmFilter: false },
];

/** Folders whose list view offers a read-only preview on the right (§16.1). */
export const PREVIEW_FOLDER_IDS: ReadonlySet<FolderId> = new Set(["doc", "caption", "export", "edit"]);
/** Extensions the preview panel knows how to show (§16.1 / the brief). */
export const PREVIEWABLE_EXT: ReadonlySet<string> = new Set(["md", "txt", "srt", "vtt"]);

export function isPreviewable(asset: Pick<Asset, "name">): boolean {
  return PREVIEWABLE_EXT.has(extOf(asset.name));
}

export interface FolderItemsOptions {
  /** Matched, case-insensitively, against the name, the path, the file's own note, the film's
   *  name and (for a cut) its version note. */
  query?: string;
  sort?: "newest" | "oldest" | "name";
  /** A video id to narrow to, or null/undefined for every film. Only meaningful on a folder
   *  with filmFilter set, but harmless to pass anywhere. */
  film?: string | null;
  /** Needed to resolve a film's name and a cut's version note for both search and sorting. */
  videos?: Video[];
}

/** `assets` narrowed to one folder's kinds, then filtered by film and search, then sorted. */
export function folderItems(assets: Asset[], folder: Pick<FolderDef, "kinds">, opts: FolderItemsOptions = {}): Asset[] {
  const { query = "", sort = "newest", film, videos = [] } = opts;
  let items = assets.filter((a) => folder.kinds.includes(a.kind));
  if (film) items = items.filter((a) => a.video === film);
  const q = query.trim().toLowerCase();
  if (q) {
    items = items.filter((a) => {
      const video = videos.find((v) => v.id === a.video);
      const version = video?.versions.find((v) => v.id === a.version);
      const haystack = [a.name, a.path, a.note, version?.note, video?.name].filter((s): s is string => !!s);
      return haystack.some((s) => s.toLowerCase().includes(q));
    });
  }
  const modifiedMs = (a: Asset) => (a.modified ? new Date(a.modified).getTime() : 0);
  const sorted = [...items];
  if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === "oldest") sorted.sort((a, b) => modifiedMs(a) - modifiedMs(b));
  else sorted.sort((a, b) => modifiedMs(b) - modifiedMs(a)); // "newest", the default
  return sorted;
}

export interface FilmGroup {
  /** "Film · vN", or null for items with no film/version (e.g. an un-parsed screenshot name). */
  heading: string | null;
  items: Asset[];
}

/**
 * Groups already-ordered items under "Film · vN" headings (§16.1), without reordering them --
 * a run of consecutive items sharing the same film and version becomes one group, so calling
 * this on output already sorted Newest/Oldest keeps that order intact.
 */
export function groupByFilm(items: Asset[], videos: Video[] = []): FilmGroup[] {
  const groups: FilmGroup[] = [];
  for (const a of items) {
    const video = videos.find((v) => v.id === a.video);
    const heading = video && a.version ? `${video.name} · ${a.version}` : null;
    const last = groups[groups.length - 1];
    if (last && last.heading === heading) last.items.push(a);
    else groups.push({ heading, items: [a] });
  }
  return groups;
}

/** Normalised box from two pointer positions inside an element of size w × h. */
export function boxFrom(x0: number, y0: number, x1: number, y1: number, w: number, h: number) {
  // Four decimals is finer than a pixel on any screen, and keeps notes.json readable.
  const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
  const ax = clamp(Math.min(x0, x1) / w);
  const ay = clamp(Math.min(y0, y1) / h);
  const bx = clamp(Math.max(x0, x1) / w);
  const by = clamp(Math.max(y0, y1) / h);
  return { x: ax, y: ay, w: Math.round((bx - ax) * 10000) / 10000, h: Math.round((by - ay) * 10000) / 10000 };
}
