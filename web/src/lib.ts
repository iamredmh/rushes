// Pure helpers for the dashboard. No DOM, so they're unit-tested in Node.
import type { Asset, AssetKind, Cue, Lane, LaneStage, LoudnessResult, Mark, Note, Section, Shot, Stage, TabState, Take, Video, Version } from "./types.js";

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
export const BUILT: Record<Stage, boolean> = { script: true, picture: true, voice: true, music: true, sfx: true, mix: true };

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
 * A Voiceover/Music/Sound effects row's secondary line: the lane's own name, then each of the
 * variant's meta entries, joined with " · ". A numeric entry gets its key as a unit suffix
 * (`{bpm: 120}` -> "120 BPM"); a string entry is already self-explanatory and shown as-is
 * (`{key: "A minor"}` -> "A minor"). Null when there's nothing to show.
 */
export function metaLine(laneName?: string, meta?: Record<string, string | number>): string | null {
  const parts: string[] = [];
  if (laneName) parts.push(laneName);
  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      parts.push(typeof value === "number" ? `${value} ${key.toUpperCase()}` : String(value));
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
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

/** Extensions a Cut/Delivery grid tile will try to show a poster frame for (I5/I6); anything
 *  else gets a plain file tile instead of a black box with a video element that can't play it. */
export const VIDEO_EXT: ReadonlySet<string> = new Set(["mp4", "mov", "m4v", "webm", "mkv"]);

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
  /** Whether this folder offers the grid/list toggle at all (I5). Every other folder's items
   *  (Voiceover, Music, Sound effects, Scripts & docs, Captions, Exports, Edit files) render
   *  `<img>`/`<video>`-based tiles that only make sense for the four kinds listed here, so
   *  they're always list, with no toggle shown. */
  gridToggle: boolean;
}

/** §16.1's folders, in their fixed sidebar order. */
export const FOLDERS: FolderDef[] = [
  { id: "screenshot", title: "Screenshots", kinds: ["screenshot"], view: "grid", filmFilter: true, gridToggle: true },
  { id: "cut", title: "Cuts", kinds: ["cut"], view: "grid", filmFilter: true, gridToggle: true },
  { id: "voiceover", title: "Voiceover", kinds: ["take", "voice"], view: "list", filmFilter: false, gridToggle: false },
  { id: "music", title: "Music", kinds: ["music"], view: "list", filmFilter: false, gridToggle: false },
  { id: "sfx", title: "Sound effects", kinds: ["sfx"], view: "list", filmFilter: false, gridToggle: false },
  { id: "doc", title: "Scripts & docs", kinds: ["doc"], view: "list", filmFilter: false, gridToggle: false },
  { id: "image", title: "Images", kinds: ["image"], view: "grid", filmFilter: false, gridToggle: true },
  { id: "caption", title: "Captions", kinds: ["caption"], view: "list", filmFilter: false, gridToggle: false },
  { id: "export", title: "Exports", kinds: ["export"], view: "list", filmFilter: false, gridToggle: false },
  { id: "delivery", title: "Delivery", kinds: ["delivery"], view: "grid", filmFilter: true, gridToggle: true },
  { id: "edit", title: "Edit files", kinds: ["edit"], view: "list", filmFilter: false, gridToggle: false },
];

/** Folders whose list view offers a read-only preview on the right (§16.1). */
export const PREVIEW_FOLDER_IDS: ReadonlySet<FolderId> = new Set(["doc", "caption", "export", "edit"]);
/** Extensions the preview panel knows how to show (§16.1 / the brief). */
export const PREVIEWABLE_EXT: ReadonlySet<string> = new Set(["md", "txt", "srt", "vtt"]);

// Reads the extension from path, not name (I2): a registered file's display name (e.g. "Creative
// brief") carries no extension at all once I2 moves it to `label`, and even before that a caller
// could give a registered file a name with a different, misleading extension.
export function isPreviewable(asset: Pick<Asset, "path">): boolean {
  return PREVIEWABLE_EXT.has(extOf(asset.path));
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
 * Groups every item under its "Film · vN" heading (§16.1) -- every item with that heading,
 * never just a run of adjacent ones, so two screenshots of the same film and version taken
 * apart in time still land in one group rather than fragmenting into two. `items` must already
 * be sorted the way the caller wants (Newest or Oldest first, as `folderItems` leaves them):
 * groups come out ordered by each one's first item in that order -- which is exactly the
 * group's newest item under a Newest sort, or its oldest under Oldest -- and the items inside
 * each group keep their relative order from the input, so they stay sorted too.
 */
export function groupByFilm(items: Asset[], videos: Video[] = []): FilmGroup[] {
  const byHeading = new Map<string, FilmGroup>();
  for (const a of items) {
    const video = videos.find((v) => v.id === a.video);
    const heading = video && a.version ? `${video.name} · ${a.version}` : null;
    const key = heading ?? "\u0000";
    let group = byHeading.get(key);
    if (!group) {
      group = { heading, items: [] };
      byHeading.set(key, group);
    }
    group.items.push(a);
  }
  return [...byHeading.values()];
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

// ---- audio tabs (§17) ----

export type AudioStageId = "voice" | "music" | "sfx" | "mix";
export type Scope = "point" | "range" | "whole";
export type MarkKind = Mark["kind"];

/**
 * Is a note in the making on an audio tab? A range (even just an In point), marks ticked (with or
 * without a range) or typed text. One definition, for both the film hold and New take's refusal:
 * nothing pending is ever dropped.
 */
export function notePending(p: { range: { in: number | null }; marks: readonly unknown[]; hasText: boolean }): boolean {
  return p.range.in !== null || p.marks.length > 0 || p.hasText;
}

/** Quick-start chips per audio tab (§17.1). They only put a prefix in the note box. */
export const AUDIO_CHIPS: Record<AudioStageId, string[]> = {
  voice: ["Level", "Pace", "Pronunciation", "Breath"],
  music: ["Tempo", "Key", "Energy", "Ending"],
  sfx: ["Timing", "Level", "Swap sound", "Remove"],
  mix: ["Level", "Balance", "Loudness"],
};

/** Louder/Quieter amounts on offer, and the default (§17.1). */
export const MARK_DB: readonly number[] = [1, 2, 3, 6, 9];
export const DEFAULT_MARK_DB = 3;
const MARK_ORDER: MarkKind[] = ["rise", "fall", "louder", "quieter"];
const OPPOSITE: Record<MarkKind, MarkKind> = { rise: "fall", fall: "rise", louder: "quieter", quieter: "louder" };
const takesDb = (k: MarkKind) => k === "louder" || k === "quieter";

/**
 * A web copy of src/core/schema.ts's markLabel (the web bundle imports types only from src/; a
 * unit test asserts the two agree): "Rise" | "Fall" | "Louder 3 dB" | "Quieter 3 dB".
 */
export function markLabel(m: Mark): string {
  const label = m.kind === "rise" ? "Rise" : m.kind === "fall" ? "Fall" : m.kind === "louder" ? "Louder" : "Quieter";
  return m.db === undefined ? label : `${label} ${m.db} dB`;
}

/** A note's marks as one line, "Fall · Quieter 3 dB", or null when it has none. */
export function marksLabel(marks: Mark[] | undefined): string | null {
  return marks && marks.length > 0 ? marks.map(markLabel).join(" · ") : null;
}

/**
 * Turn a mark on or off. Rise and Fall exclude each other, and so do Louder and Quieter; one of
 * each pair can be combined (Fall + Quieter 3 dB). Louder/Quieter carry `db`. Kept in a fixed order.
 */
export function toggleMark(marks: Mark[], kind: MarkKind, db = DEFAULT_MARK_DB): Mark[] {
  const on = marks.some((m) => m.kind === kind);
  const out = marks.filter((m) => m.kind !== kind && m.kind !== OPPOSITE[kind]);
  if (!on) out.push(takesDb(kind) ? { kind, db } : { kind });
  return out.sort((a, b) => MARK_ORDER.indexOf(a.kind) - MARK_ORDER.indexOf(b.kind));
}

/** Change the dB amount on an active Louder/Quieter mark. */
export function setMarkDb(marks: Mark[], kind: MarkKind, db: number): Mark[] {
  return marks.map((m) => (m.kind === kind && takesDb(kind) ? { kind, db } : m));
}

/** A variant card's second line: its description, else BPM · key; on SFX, the cue count too. */
export function variantMeta(meta: Record<string, string | number> | undefined, cues = 0): string | null {
  const parts: string[] = [];
  const description = meta?.description;
  if (description !== undefined && String(description).trim()) parts.push(String(description));
  else {
    if (meta?.bpm !== undefined) parts.push(`${meta.bpm} BPM`);
    if (meta?.key !== undefined) parts.push(String(meta.key));
  }
  if (cues > 0) parts.push(`${cues} cue${cues === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** One lane on Music or Sound effects: a variant of one of the stage's lanes (§17.3, §17.4). */
export interface VariantRow {
  /** `<lane id>/<variant id>`: unique, and the engine clip id. */
  key: string;
  lane: string;
  laneName: string;
  variant: string;
  name: string;
  meta: string | null;
  file: string;
  cues: Cue[];
}

/** Every variant of every lane on `stage`, in manifest order. */
export function variantRows(lanes: Lane[], stage: "voice" | "music" | "sfx"): VariantRow[] {
  const rows: VariantRow[] = [];
  for (const l of lanes) {
    if (l.stage !== stage) continue;
    for (const v of l.variants) {
      rows.push({
        key: `${l.id}/${v.id}`, lane: l.id, laneName: l.name, variant: v.id, name: v.name,
        meta: variantMeta(v.meta, stage === "sfx" ? v.cues.length : 0), file: v.file, cues: v.cues,
      });
    }
  }
  return rows;
}

/** One entry in a note's On menu: `on` is what's saved, `t` a cue's own time. */
export interface OnOption {
  value: string;
  label: string;
  on: string | null;
  /** A cue's time: a point note on a cue is saved at it (§17.4). */
  t?: number;
  /** The lane row this option belongs to, if any. */
  row?: string;
}

/**
 * The `on` a note on a variant saves: `"<lane id>/<variant id>"` (the row's key). Variant ids are
 * only unique within their lane, and lane ids are unique project-wide, so qualifying by lane keeps
 * a music bed and an SFX pass both called "Option A" apart. Both ids are slugs (`[a-z0-9-]`), so the
 * `/` can never be part of either, nor clash with `"vo"`, a take (`"<section>:<take>"`) or a section id.
 */
export const variantOn = (r: Pick<VariantRow, "key">): string => r.key;
/** The `on` a note on a cue saves: `"<lane id>/<variant id>:<cue id>"` (cue ids are only unique within a pass). */
export const cueOn = (r: Pick<VariantRow, "key">, cueId: string): string => `${r.key}:${cueId}`;

/** How wide each cue's label may be, as a fraction of the lane, in the order given: the gap to its
 *  nearest neighbour, so labels centred on their cues never overlap. A cue with no neighbour gets 0.4. */
export function cueRoom(cues: { t: number }[], length: number): number[] {
  const ts = cues.map((c) => c.t);
  return ts.map((t, i) => {
    const gaps = ts.filter((_, j) => j !== i).map((u) => Math.abs(u - t));
    return length > 0 && gaps.length ? Math.min(0.4, Math.min(...gaps) / length) : 0.4;
  });
}

/** The On menu for variant rows: each variant, then (with `cues`) each cue as `Cue · Swipe`, saved as
 *  `on: "<lane id>/<pass id>:<cue id>"`. A cue name two passes share gets the pass's name too. */
export function variantOnOptions(rows: VariantRow[], nameOf: (r: VariantRow) => string, cues = false): OnOption[] {
  const out: OnOption[] = rows.map((r) => ({ value: `v:${r.key}`, label: nameOf(r), on: variantOn(r), row: r.key }));
  if (!cues) return out;
  const seen = new Set(out.map((o) => o.label));
  for (const r of rows) {
    for (const c of r.cues) {
      let label = `Cue · ${c.name}`;
      if (seen.has(label)) label = `${label} · ${nameOf(r)}`;
      seen.add(label);
      out.push({ value: `c:${r.key}:${c.id}`, label, on: cueOn(r, c.id), t: c.t, row: r.key });
    }
  }
  return out;
}

/**
 * The exact lane-qualified variant or cue an `on` names, or null: `"<lane>/<variant>"` or
 * `"<lane>/<variant>:<cue>"`. Never matches a bare (legacy) id, which has no `/`.
 */
export function qualifiedTarget(rows: VariantRow[], on: string | null): { row: VariantRow; cue: string | null } | null {
  if (on === null || !on.includes("/")) return null;
  const variant = rows.find((r) => variantOn(r) === on);
  if (variant) return { row: variant, cue: null };
  const i = on.indexOf(":", on.indexOf("/"));
  if (i === -1) return null;
  const key = on.slice(0, i);
  const cue = on.slice(i + 1);
  const pass = rows.find((r) => r.key === key && r.cues.some((c) => c.id === cue));
  return pass ? { row: pass, cue } : null;
}

/**
 * The legacy forms, from before `on` was lane-qualified: a bare variant id (the first row with it,
 * in the order given), a bare `"<pass id>:<cue id>"`, or a bare cue id (the first pass holding it).
 * Kept so older notes draw exactly where they always have.
 */
function legacyVariantTarget(rows: VariantRow[], on: string): { row: VariantRow; cue: string | null } | null {
  const variant = rows.find((r) => r.variant === on);
  if (variant) return { row: variant, cue: null };
  const i = on.indexOf(":");
  if (i > 0) {
    const v = on.slice(0, i);
    const cue = on.slice(i + 1);
    const pass = rows.find((r) => r.variant === v && r.cues.some((c) => c.id === cue));
    if (pass) return { row: pass, cue };
  }
  const pass = rows.find((r) => r.cues.some((c) => c.id === on));
  return pass ? { row: pass, cue: on } : null;
}

/**
 * What a note is `on` among variant rows: the exact lane-qualified variant (`"sfx/pass-b"`) or cue
 * (`"sfx/pass-b:swipe"`) first, then the legacy bare forms (`"pass-b"`, `"pass-b:swipe"`, `"swipe"`).
 */
export function variantNoteTarget(rows: VariantRow[], on: string | null): { row: string; cue: string | null } | null {
  if (on === null) return null;
  const t = qualifiedTarget(rows, on) ?? legacyVariantTarget(rows, on);
  return t ? { row: t.row.key, cue: t.cue } : null;
}

/** The row a note is drawn on (see variantNoteTarget). */
export function variantNoteRow(rows: VariantRow[], on: string | null): string | null {
  return variantNoteTarget(rows, on)?.row ?? null;
}

/** The On menu's label for what a note is on, e.g. `Cue · Swipe · Pass B`, or null. */
export function variantOnLabel(rows: VariantRow[], options: OnOption[], on: string | null): string | null {
  const target = variantNoteTarget(rows, on);
  if (!target) return null;
  const value = target.cue === null ? `v:${target.row}` : `c:${target.row}:${target.cue}`;
  return options.find((o) => o.value === value)?.label ?? null;
}

/**
 * Which clip each engine lane plays: the selected row's clip in its lane, else the picked one,
 * else the lane's first in manifest order (`order`, else array order). Audition and Use can differ (§17.3).
 */
export function laneSelection(
  rows: { key: string; audition?: { lane: string; clip: string }; picked?: boolean; order?: number }[],
  selected: string | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  const sel = rows.find((r) => r.key === selected)?.audition;
  // "First" means manifest order (`order`), never display order, so Blind's shuffle can't change what plays.
  const ordered = rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.order ?? a.i) - (b.r.order ?? b.i)).map((x) => x.r);
  for (const r of ordered) {
    const a = r.audition;
    if (!a || out[a.lane] !== undefined) continue;
    if (sel && sel.lane === a.lane) out[a.lane] = sel.clip;
    else out[a.lane] = (rows.find((x) => x.picked && x.audition?.lane === a.lane) ?? r).audition!.clip;
  }
  return out;
}

/** A stable shuffle of `keys` for Blind: the same seed always gives the same order. */
export function blindOrder(keys: string[], seed: number): string[] {
  const hash = (k: string) => {
    let h = (2166136261 ^ seed) >>> 0;
    for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619) >>> 0;
    // One more avalanche round so keys differing only at the end still spread out.
    h ^= h >>> 15;
    h = Math.imul(h, 2246822507) >>> 0;
    return (h ^ (h >>> 13)) >>> 0;
  };
  return [...keys].sort((a, b) => hash(a) - hash(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Test-only switches read from the page URL. `streamOver` only counts alongside `test`. */
export function testFlags(search: string): { test: boolean; streamOver: boolean } {
  const q = new URLSearchParams(search);
  const test = q.get("test") === "1";
  return { test, streamOver: test && q.get("streamOver") === "1" };
}

// ---- Voiceover (§17.5) ----

/** A web copy of src/core/script.ts's isTakeStale (the web bundle imports types only from src/; a
 *  unit test asserts the two agree): a take is stale once its section's line no longer matches the
 *  text it was read from. */
export function isTakeStale(take: Pick<Take, "forText">, s: Pick<Section, "current">): boolean {
  return take.forText.trim() !== s.current.trim();
}

/** "S2": a section's name on every tab. */
export function sectionLabel(id: string): string {
  return id.toUpperCase();
}

/** "S2 · Take 1": a take is named by its place in its section, as Assets names it. */
export function takeLabel(s: { id: string; takes: { id: string }[] }, takeId: string): string {
  return `${sectionLabel(s.id)} · Take ${s.takes.findIndex((t) => t.id === takeId) + 1}`;
}

/** The take a section's read uses: its pick, else its newest; null with no takes. The same rule as the mix. */
export function readTake<T extends { id: string }>(s: { id: string; takes: T[] }, picks: Record<string, string>): T | null {
  if (s.takes.length === 0) return null;
  return s.takes.find((t) => t.id === picks[s.id]) ?? s.takes[s.takes.length - 1];
}

/** The section whose span [start, end) holds `t`, or null in a gap. */
export function sectionAt(sections: Pick<Section, "id" | "start" | "end">[], t: number): string | null {
  return sections.find((s) => t >= s.start && t < s.end)?.id ?? null;
}

/**
 * The whole-read voice variant that replaces the assembled read, as in the mix: the first voice
 * lane, in manifest order, whose pick names one of its variants. Never just the only or first one.
 */
export function pickedVoiceRow(rows: VariantRow[], lanePicks: Record<string, string>): VariantRow | null {
  return rows.find((r) => lanePicks[r.lane] === r.variant) ?? null;
}

// The Voiceover tab's names. Row keys, engine lanes and On values each keep to their own namespace.
/** The assembled read: its row key, and the `on` a note on it saves. */
export const READ_ROW = "vo";
/** The engine lane holding one section's candidates: every take of it, at the section's start. */
export const sectionLane = (sectionId: string): string => `sec:${sectionId}`;
/** The engine lane holding one voice lane's variants. */
export const voiceLane = (laneId: string): string => `var:${laneId}`;
/** A take's engine clip id, and the `on` a note on it saves: "<section>:<take>", as assembleRead. */
export const takeClipId = (sectionId: string, takeId: string): string => `${sectionId}:${takeId}`;
/** A take sub-lane's row key. */
export const takeRowKey = (sectionId: string, takeId: string): string => `take:${takeClipId(sectionId, takeId)}`;

/** What an audio tab hears: per engine lane, the one clip that plays (null: all of them), and the lane's gain. */
export interface Listening {
  select: Record<string, string | null>;
  gains: Record<string, number>;
}

export interface VoiceModel {
  sections: Pick<Section, "id" | "start" | "end" | "takes">[];
  /** picks.sections */
  picks: Record<string, string>;
  /** The voice lanes' variants, in manifest order (variantRows(lanes, "voice")). */
  variants: VariantRow[];
  /** picks.lanes */
  lanePicks: Record<string, string>;
}

function takeByRow(sections: VoiceModel["sections"], key: string | null): { section: string; take: string } | null {
  if (key === null) return null;
  for (const s of sections) for (const t of s.takes) if (takeRowKey(s.id, t.id) === key) return { section: s.id, take: t.id };
  return null;
}

/**
 * What the Voiceover tab plays, given the selected row (§17.5).
 *
 * Each section is an engine lane (`sec:<id>`) holding every take of it at the section's start; its
 * selection is the one take heard. Each voice lane (`var:<id>`) holds its variants. One source
 * sounds at a time, switched by lane gains: the read (every section lane at 1) or one voice variant.
 * - Nothing selected: the read with the picks, or the picked voice variant instead (the mix rule).
 * - The read selected: the read with the picks.
 * - A take selected: the read, with that take in its section's place.
 * - A voice variant selected: that variant.
 * All of it is gains on one clock, so switching never moves the playhead.
 */
export function voiceListening(m: VoiceModel, selected: string | null): Listening {
  const variant = m.variants.find((r) => r.key === selected) ?? null;
  const take = variant ? null : takeByRow(m.sections, selected);
  const source = variant ?? (selected === READ_ROW || take ? null : pickedVoiceRow(m.variants, m.lanePicks));
  const select: Record<string, string | null> = {};
  const gains: Record<string, number> = {};
  for (const s of m.sections) {
    const picked = readTake(s, m.picks);
    if (!picked) continue;
    const heard = take && take.section === s.id ? take.take : picked.id;
    select[sectionLane(s.id)] = takeClipId(s.id, heard);
    gains[sectionLane(s.id)] = source ? 0 : 1;
  }
  for (const r of m.variants) {
    const lane = voiceLane(r.lane);
    if (lane in select) continue;
    const inLane = m.variants.filter((x) => x.lane === r.lane);
    const live = source?.lane === r.lane;
    const heard = live ? source! : (inLane.find((x) => m.lanePicks[x.lane] === x.variant) ?? inLane[0]);
    select[lane] = heard.key;
    gains[lane] = live ? 1 : 0;
  }
  return { select, gains };
}

export type VoiceTarget =
  | { kind: "read" }
  | { kind: "section"; section: string }
  | { kind: "take"; section: string; take: string }
  | { kind: "variant"; row: string };

/**
 * What a Voiceover note is on, in this order: a lane-qualified voice variant (`"<lane>/<variant>"`),
 * "vo" (the read), "<section>:<take>" a take, a section id that section, else (legacy) a bare voice
 * variant id. A note with no `on` is about the read.
 */
export function voiceNoteTarget(sections: VoiceModel["sections"], variants: VariantRow[], on: string | null): VoiceTarget | null {
  const qualified = qualifiedTarget(variants, on);
  if (qualified && qualified.cue === null) return { kind: "variant", row: qualified.row.key };
  if (on === null || on === READ_ROW) return { kind: "read" };
  for (const s of sections) for (const t of s.takes) if (takeClipId(s.id, t.id) === on) return { kind: "take", section: s.id, take: t.id };
  if (sections.some((s) => s.id === on)) return { kind: "section", section: on };
  const v = variants.find((r) => r.variant === on);
  return v ? { kind: "variant", row: v.key } : null;
}

/**
 * The rows a Voiceover note is drawn on: the read, for a note on the read, on a section or a take
 * (at its own time, even outside that section's span — a stray note, from an agent say, must never
 * appear only in the list); and a take note's own sub-lane while its section is shown.
 */
export function voiceNoteRows(m: Pick<VoiceModel, "sections" | "variants">, note: Pick<Note, "on" | "t">, shown: string | null): string[] {
  const target = voiceNoteTarget(m.sections, m.variants, note.on);
  if (!target || note.t === null) return [];
  if (target.kind === "read") return [READ_ROW];
  if (target.kind === "variant") return [target.row];
  const s = m.sections.find((x) => x.id === target.section)!;
  const rows = [READ_ROW];
  if (target.kind === "take" && shown === s.id) rows.push(takeRowKey(s.id, target.take));
  return rows;
}

/**
 * The On menu on Voiceover: the read, each section (S1 …), the shown section's takes and each voice
 * variant. Values: "r", "s:<section>", "t:<section>:<take>", "v:<lane>/<variant>".
 */
export function voiceOnOptions(m: Pick<VoiceModel, "sections" | "variants">, shown: string | null): OnOption[] {
  const out: OnOption[] = [{ value: "r", label: "Assembled read", on: READ_ROW, row: READ_ROW }];
  for (const s of m.sections) out.push({ value: `s:${s.id}`, label: sectionLabel(s.id), on: s.id, row: READ_ROW });
  const sec = m.sections.find((s) => s.id === shown);
  for (const t of sec?.takes ?? []) {
    out.push({ value: `t:${takeClipId(sec!.id, t.id)}`, label: takeLabel(sec!, t.id), on: takeClipId(sec!.id, t.id), row: takeRowKey(sec!.id, t.id) });
  }
  for (const r of m.variants) out.push({ value: `v:${r.key}`, label: r.name, on: variantOn(r), row: r.key });
  return out;
}

/** What a listed Voiceover note is on: "Assembled read", "S2", "S2 · Take 1" or the variant's name. */
export function voiceOnLabel(m: Pick<VoiceModel, "sections" | "variants">, on: string | null): string | null {
  const target = voiceNoteTarget(m.sections, m.variants, on);
  if (!target) return null;
  if (target.kind === "read") return "Assembled read";
  if (target.kind === "section") return sectionLabel(target.section);
  if (target.kind === "take") return takeLabel(m.sections.find((s) => s.id === target.section)!, target.take);
  return m.variants.find((r) => r.key === target.row)?.name ?? null;
}

// ---- Mix (§17.6) ----

/** The Mix tab's three lanes: their row keys and engine lanes. "vo" is also the `on` of a note on the VO lane. */
export type MixLane = "vo" | "music" | "sfx";
export const MIX_LANES: readonly MixLane[] = ["vo", "music", "sfx"];
/** Each Mix lane's name in `POST /api/mix/loudness`. */
export const MIX_STAGE: Record<MixLane, LaneStage> = { vo: "voice", music: "music", sfx: "sfx" };
/** The On value of a note on the whole mix, saved with `on: null`. */
export const WHOLE_MIX = "mix";

export interface MixModel {
  /** Every music and sfx variant, in manifest order. */
  variants: { music: VariantRow[]; sfx: VariantRow[] };
  /** What each lane plays: the VO lane has something, and the picked variants whose files are on disk. */
  heard: { vo: boolean; music: VariantRow[]; sfx: VariantRow[] };
}

/** The lanes a loudness reading covers: those with something to play that are heard (solo wins over mute). */
export function loudnessLanes(heard: Record<MixLane, boolean>, gains: Record<string, number>): LaneStage[] {
  return MIX_LANES.filter((l) => heard[l] && (gains[l] ?? 1) > 0).map((l) => MIX_STAGE[l]);
}

/** The Music or Sound effects row a Mix note's `on` names: lane-qualified first, then (legacy) a bare variant id. */
function mixNoteVariant(m: MixModel, on: string): { lane: "music" | "sfx"; row: VariantRow } | null {
  for (const lane of ["music", "sfx"] as const) {
    const q = qualifiedTarget(m.variants[lane], on);
    if (q) return { lane, row: q.row };
  }
  if (on.includes("/")) return null;
  // Legacy: a bare variant id, a variant being heard first, then any variant of either stage.
  for (const lane of ["music", "sfx"] as const) {
    const row = m.heard[lane].find((r) => r.variant === on);
    if (row) return { lane, row };
  }
  for (const lane of ["music", "sfx"] as const) {
    const row = m.variants[lane].find((r) => r.variant === on);
    if (row) return { lane, row };
  }
  return null;
}

/**
 * What a Mix note is on: null is the whole mix; a lane-qualified variant (`"<lane>/<variant>"`) the
 * Music or Sound effects lane it belongs to; "vo" the VO lane; then (legacy) a bare variant id, a
 * variant being heard first, then any variant of either stage. Null if unknown.
 */
export function mixNoteTarget(m: MixModel, on: string | null): MixLane | typeof WHOLE_MIX | null {
  if (on === null) return WHOLE_MIX;
  const qualified = on.includes("/") ? mixNoteVariant(m, on) : null;
  if (qualified) return qualified.lane;
  if (on === READ_ROW) return "vo";
  return mixNoteVariant(m, on)?.lane ?? null;
}

/** The lanes a Mix note is drawn on: its lane; a note on the whole mix (or on something gone) on every lane. */
export function mixNoteRows(m: MixModel, on: string | null): MixLane[] {
  const target = mixNoteTarget(m, on);
  return target === null || target === WHOLE_MIX ? [...MIX_LANES] : [target];
}

const MIX_NAMES: Record<MixLane, string> = { vo: "Voiceover", music: "Music", sfx: "Sound effects" };

/** What a listed Mix note is on: "Whole mix", "Voiceover", "Music · B · Warm keys", or null. */
export function mixOnLabel(m: MixModel, on: string | null): string | null {
  const target = mixNoteTarget(m, on);
  if (target === null) return null;
  if (target === WHOLE_MIX) return "Whole mix";
  if (target === "vo") return MIX_NAMES.vo;
  return `${MIX_NAMES[target]} · ${mixNoteVariant(m, on!)!.row.name}`;
}

/**
 * The On menu on Mix: the whole mix, then each lane that has something to play. Values: "mix", "vo",
 * "<stage>:<lane id>/<variant>"; a variant's note saves `on: "<lane id>/<variant>"`.
 */
export function mixOnOptions(m: MixModel): OnOption[] {
  const out: OnOption[] = [{ value: WHOLE_MIX, label: "Whole mix", on: null }];
  if (m.heard.vo) out.push({ value: "vo", label: MIX_NAMES.vo, on: READ_ROW, row: "vo" });
  for (const lane of ["music", "sfx"] as const) {
    for (const r of m.heard[lane]) out.push({ value: `${lane}:${r.key}`, label: `${MIX_NAMES[lane]} · ${r.name}`, on: variantOn(r), row: lane });
  }
  return out;
}

/** A level for the loudness readout: one decimal by default, a real minus sign, "+" above zero, never "−0.0". */
export function levelText(n: number, digits = 1): string {
  const fixed = Math.abs(n).toFixed(digits);
  if (Number(fixed) === 0) return fixed;
  return `${n < 0 ? "\u2212" : "+"}${fixed}`;
}

/** Where the loudness readout is (§17.6). `waiting`: the first reading isn't back yet. */
export type LoudnessState =
  | { kind: "empty" }
  | { kind: "waiting" }
  | { kind: "result"; result: LoudnessResult }
  | { kind: "timeout" }
  | { kind: "error" };

export interface ReadoutCell {
  id: "integrated" | "truePeak" | "musicUnderVo";
  value: string;
  label: string;
  /** Why there's no number, or null when there is one. */
  tip: string | null;
}

const DASH = "\u2014";
const NO_FFMPEG = "Install ffmpeg for loudness";

/**
 * The three readout values: LUFS integrated, dBTP true peak and music under VO. A value that can't
 * be shown is `—` with a tooltip saying why.
 */
export function loudnessReadout(s: LoudnessState): ReadoutCell[] {
  const cells = (v: [string, string | null], p: [string, string | null], u: [string, string | null]): ReadoutCell[] => [
    { id: "integrated", label: "LUFS integrated", value: v[0], tip: v[1] },
    { id: "truePeak", label: "dBTP true peak", value: p[0], tip: p[1] },
    { id: "musicUnderVo", label: "Music under VO", value: u[0], tip: u[1] },
  ];
  const all = (tip: string | null) => cells([DASH, tip], [DASH, tip], [DASH, tip]);
  if (s.kind === "empty") return all("Nothing to measure");
  if (s.kind === "waiting") return all(null);
  // Neither is cached by the server, so a click on the readout measures again.
  if (s.kind === "timeout") return all("Measuring took too long · click to retry");
  if (s.kind === "error") return all("Couldn't measure loudness · click to retry");
  const r = s.result;
  if (!r.available) return all(NO_FFMPEG);
  const level = (n: number | null): [string, string | null] =>
    r.silent ? ["\u2212\u221e", "The mix is silent"] : n === null ? [DASH, "Couldn't measure loudness"] : [levelText(n), null];
  const under: [string, string | null] = r.silent
    ? ["−∞", "The mix is silent"]
    : r.musicUnderVo === null ? [DASH, "Needs Voiceover and Music both playing"] : [`${levelText(r.musicUnderVo, 0)} dB`, null];
  return cells(level(r.integrated), level(r.truePeak), under);
}
