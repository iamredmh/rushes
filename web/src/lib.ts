// Pure helpers for the dashboard. No DOM, so they're unit-tested in Node.
import { DEFAULT_PROXY_PRESET, PRESETS, PROXY_AUDIO_KBPS, PROXY_PRESETS as PROXY_PRESET_ORDER, ladderOrder, missingPresets, type ProxyPreset } from "../../src/core/proxyPresets.js";
import type { Proxies } from "../../src/core/schema.js";
import type { Asset, AssetKind, BriefSectionView, BriefView, Cue, FilmPlan, FoundCounts, FoundItem, FoundKind, FoundSummary, InUse, Lane, LaneStage, LogLine, LoudnessResult, Mark, Note, Picks, Project, ProxyEvent, ProxyJob, Section, Shot, Stage, State, StoryboardView, TabState, Variant, Video, Version } from "./types.js";
export type { FoundItem } from "./types.js";

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

/**
 * Where a note sits in the version being watched, and where it came from if it was left on another one. A note on a take
 * (Voice, Music, Effects) is timed on the take itself, which does not move with the cut: it sits where it was saved.
 */
export function placeNote(note: Note, version: string | null): { t: number | null; tOut: number | null; from: string | null } {
  if (note.t === null) return { t: null, tOut: null, from: null };
  const onTake = note.stage === "voice" || note.stage === "music" || note.stage === "sfx";
  if (onTake || !note.version || note.version === version) return { t: note.t, tOut: note.tOut, from: null };
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

/** §26: a film is in play unless it has been shelved. */
export const inPlay = (video: Pick<Video, "shelved">): boolean => !video.shelved;

/**
 * The id of the film one step before/after `currentId` among the films in play (§26: [ and ] skip shelved films), or null
 * at either end or if not found. From a shelved film (opened from the Shelved list) it is the nearest film in play on that side.
 */
export function neighbourVideo(videos: Video[], currentId: string | null, dir: -1 | 1): string | null {
  const i = videos.findIndex((v) => v.id === currentId);
  if (i === -1) return null;
  for (let j = i + dir; j >= 0 && j < videos.length; j += dir) if (inPlay(videos[j])) return videos[j].id;
  return null;
}

/** §26: where you land when the film you are on is shelved: the next film in play to its right, else the one to its left. */
export function filmAfterShelving(videos: Video[], id: string): string | null {
  const i = videos.findIndex((v) => v.id === id);
  if (i === -1) return null;
  const others = videos.map((v, j) => ({ v, j })).filter(({ v, j }) => j !== i && inPlay(v));
  return (others.find(({ j }) => j > i) ?? others[others.length - 1])?.v.id ?? null;
}

/** Is this stage built in this release of the dashboard? Later releases add the audio tabs. */
export const BUILT: Record<Stage, boolean> = { script: true, picture: true, voice: true, music: true, sfx: true, mix: true, visuals: true };

export const STAGE_NAMES: Record<Stage, string> = {
  script: "Script",
  picture: "Picture",
  voice: "Voiceover",
  music: "Music",
  sfx: "Sound effects",
  mix: "Mix",
  visuals: "Visuals",
};

/** §19.1: a locked tab's copy -- what it's for, what unlocks it, and the noun its tooltip asks for. */
export const LOCKED_TAB: Record<Stage | "assets", { what: string; unlocks: string; ask: string }> = {
  script: {
    what: "Read the VO line by line and suggest your own wording.",
    unlocks: "Your agent adds the script.",
    ask: "the script",
  },
  picture: {
    what: "Watch each cut, leave timecoded notes and lock the picture.",
    unlocks: "Your agent adds a cut.",
    ask: "a cut",
  },
  voice: {
    what: "Compare whole reads in rounds and pick one.",
    unlocks: "Your agent adds voice reads.",
    ask: "voice reads",
  },
  music: {
    what: "Compare music beds against the picture and pick one.",
    unlocks: "Your agent adds music beds.",
    ask: "music beds",
  },
  sfx: {
    what: "Compare SFX passes, cue by cue.",
    unlocks: "Your agent adds an SFX pass.",
    ask: "an SFX pass",
  },
  mix: {
    what: "Balance voice, music and effects and check loudness.",
    unlocks: "Unlocks with a cut and any audio.",
    ask: "a cut and some audio",
  },
  visuals: {
    what: "Mark up stills and carousels, region by region.",
    unlocks: "Your agent registers a still or a carousel.",
    ask: "a still or a carousel",
  },
  assets: {
    what: "Every file in the project in one place.",
    unlocks: "Unlocks with the first cut, take, track or screenshot.",
    ask: "files",
  },
};

/** `{for "{f}"}`/`{of "{f}"}`: ` <word> "<film>"` once a film is known, else nothing. */
const filmClause = (word: string, filmName: string | null): string => (filmName ? ` ${word} "${filmName}"` : "");

/** §19.1's "Copy prompt for your agent" templates, one per locked tab, verbatim. */
const PROMPT_TEMPLATE: Record<Stage | "assets", (p: string, f: string | null) => string> = {
  script: (p, f) =>
    `In Rushes project "${p}", add the voiceover script${filmClause("for", f)} with rushes_set_script, one section per line with start and end times.`,
  picture: (p, f) => `In Rushes project "${p}", add the latest cut${filmClause("of", f)} with rushes_add_version.`,
  voice: (p, f) =>
    `In Rushes project "${p}", record two or three voice reads${filmClause("for", f)} and add each with rushes_add_variant (stage "voice", round "Round 1 · Voices") with a one-line description.`,
  music: (p, f) =>
    `In Rushes project "${p}", make two or three music beds${filmClause("for", f)} and add each with rushes_add_variant (stage "music") with a one-line description.`,
  sfx: (p, f) =>
    `In Rushes project "${p}", make a sound-effects pass${filmClause("for", f)} and add it with rushes_add_variant (stage "sfx") with its cues.`,
  mix: (p, f) =>
    `In Rushes project "${p}", add a cut and at least one voice read, music bed or SFX pass${filmClause("for", f)}.`,
  visuals: (p) =>
    `In Rushes project "${p}", register my stills and carousels with rushes_add_visual: one visual per post (a still, or a carousel), with each page's picture in every aspect ratio it comes in. Then tell me, and I'll mark them up in the Visuals tab.`,
  assets: (p, f) => `In Rushes project "${p}", add the first cut${filmClause("of", f)} with rushes_add_version.`,
};

/** The ready-to-paste request a locked tab's "Copy prompt for your agent" button copies (§19.1). */
export function agentPrompt(stage: Stage | "assets", projectName: string, filmName: string | null): string {
  return PROMPT_TEMPLATE[stage](projectName, filmName);
}

/** §24: Brief, Script and Storyboard share the Plan workspace. Brief and Storyboard are dashboard pages over files, not review stages. */
export type PlanPage = "brief" | "script" | "storyboard";
export const PLAN_PAGES: readonly PlanPage[] = ["brief", "script", "storyboard"];
export const isPlanPage = (view: string | null): view is PlanPage => view === "brief" || view === "script" || view === "storyboard";

/** How far one planning step has got, for the ticks on the Plan switch. */
export type Progress = "none" | "part" | "ok";

/** The brief is `ok` once approved; the script and the storyboard are `ok` when every part is, `part` when some are. */
export function planProgress(
  brief: Pick<BriefView, "exists" | "status">,
  sections: Pick<Section, "status">[],
  storyboard: Pick<StoryboardView, "total" | "approved">,
): { brief: Progress; script: Progress; storyboard: Progress } {
  const approved = sections.filter((s) => s.status === "approved").length;
  return {
    brief: brief.exists && brief.status === "approved" ? "ok" : "none",
    script: sections.length > 0 && approved === sections.length ? "ok" : approved > 0 ? "part" : "none",
    storyboard: storyboard.total > 0 && storyboard.approved === storyboard.total ? "ok" : storyboard.approved > 0 ? "part" : "none",
  };
}

/** The locked Brief page's copy (§19.1): what it's for, what unlocks it, and the noun its tooltip asks for. */
export const LOCKED_BRIEF = {
  what: "Write down what this film is for before anything is built, and approve it.",
  unlocks: "Your agent starts a brief for this film.",
  ask: "a brief",
};

/** The locked Storyboard page's copy. */
export const LOCKED_STORYBOARD = {
  what: "See each shot as a still, rewrite what happens, and approve it before anything is built.",
  unlocks: "Your agent sketches the shots once the script is approved.",
  ask: "a storyboard",
};

/** §31.3: where a film's own plan files are. The first film's (and a project's with no film yet) are the root ones. */
export interface PlanPaths {
  brief: string;
  storyboard: string;
}
export const ROOT_PLAN: PlanPaths = { brief: "brief.md", storyboard: "storyboard.md" };

/** The locked Brief page's "Copy prompt for your agent". */
export function briefPrompt(projectName: string, filmName: string | null, paths: PlanPaths = ROOT_PLAN): string {
  return `In Rushes project "${projectName}", start a brief${filmClause("for", filmName)}: ask me up to three questions, each with a recommended answer, then write ${paths.brief} (see "Starting a film" in AGENTS.md).`;
}

/** The locked Storyboard page's "Copy prompt for your agent". */
export function storyboardPrompt(projectName: string, filmName: string | null, paths: PlanPaths = ROOT_PLAN): string {
  return `In Rushes project "${projectName}", sketch the shots${filmClause("for", filmName)} from the approved script: write ${paths.storyboard} with one "## Shot 01 · Name" section per shot (Tag, Length, Still and Status: draft lines, then what happens), make a still for each, and save them under storyboard/ (see "Starting a film" in AGENTS.md).`;
}

/** What the Plan workspace's "Ready to build" copies once the plan is approved. */
export function readyPrompt(projectName: string, filmName: string | null, paths: PlanPaths = ROOT_PLAN): string {
  return `The plan is approved in Rushes project "${projectName}"${filmClause("for", filmName)}. Build the film from ${paths.brief} and ${paths.storyboard}, name each scene after its planned shot, and register the cut with rushes_add_version.`;
}

/** What Send says from the Brief page. Nothing is recorded: the file itself is the record. */
export function briefSendPrompt(projectName: string, filmName: string | null, brief: { status: BriefView["status"]; sections: Pick<BriefSectionView, "heading" | "changed">[] }, paths: PlanPaths = ROOT_PLAN): string {
  const approved = brief.status === "approved";
  const edited = brief.sections.filter((s) => s.changed).map((s) => s.heading);
  const parts = [`In Rushes project "${projectName}"${filmClause("for", filmName)}, the brief is ${approved ? "approved" : "still a draft"}.`];
  if (edited.length) parts.push(`I changed ${edited.length === 1 ? "this section" : "these sections"} in ${paths.brief}: ${edited.join(", ")}. Read the file again before you go on, and keep my wording.`);
  parts.push(approved ? "Next: write the script with rushes_set_script." : "Don't build anything until I approve it.");
  return parts.join(" ");
}

/** How many items Send sends, from any tab: every tab's open notes on films in play and
 *  changed script lines (each tab's `todo`), plus the brief's and the storyboard's changed rows. */
export function openToSend(tabs: Pick<TabState, "todo">[], brief: Pick<BriefView, "changed">, board: Pick<StoryboardView, "changed">): number {
  return tabs.reduce((n, t) => n + t.todo, 0) + brief.changed + board.changed;
}

/** What Send says from the Storyboard page: how many shots are approved, and which ones I changed. */
export function storySendPrompt(projectName: string, filmName: string | null, board: Pick<StoryboardView, "approved" | "total"> & { shots: { n: number; name: string; changed: boolean }[] }, paths: PlanPaths = ROOT_PLAN): string {
  const edited = board.shots.filter((s) => s.changed).map((s) => `Shot ${String(s.n).padStart(2, "0")} · ${s.name}`);
  const parts = [`In Rushes project "${projectName}"${filmClause("for", filmName)}, ${board.approved} of ${board.total} shots in ${paths.storyboard} are approved.`];
  if (edited.length) parts.push(`I changed ${edited.length === 1 ? "this shot" : "these shots"}: ${edited.join(", ")}. Read ${paths.storyboard} again before you go on, keep my wording, and update the still${edited.length === 1 ? "" : "s"} if what happens has changed.`);
  parts.push(board.approved === board.total && board.total > 0 ? "Next: build the film." : "Don't build anything until I approve them all.");
  return parts.join(" ");
}

/** The film's length in seconds as the brief states it ("Length: 30 seconds" in its Length section), or null when it does not. */
export function briefTargetSeconds(brief: Pick<BriefView, "sections">): number | null {
  const section = brief.sections.find((s) => /^length/i.test(s.heading));
  const m = section ? /Length:\s*(\d+(?:\.\d+)?)/i.exec(section.yours) : null;
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The tab to open first: Picture when there is a cut, else the brief when there is one, else the first unlocked tab. */
export function firstView(tabs: TabState[], brief: Pick<BriefView, "exists">): Stage | "brief" {
  if (tabs.find((t) => t.stage === "picture")?.unlocked) return "picture";
  if (brief.exists) return "brief";
  return firstTab(tabs);
}

/** Which planning page Key 1 opens: the one last used if it has something in it, else the first that does. */
export function planTarget(last: PlanPage, open: Record<PlanPage, boolean>): PlanPage {
  if (open[last]) return last;
  return PLAN_PAGES.find((p) => open[p]) ?? last;
}

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

export type FolderId = "screenshot" | "cut" | "proxy" | "voiceover" | "music" | "sfx" | "doc" | "image" | "caption" | "export" | "delivery" | "edit" | "visual";

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
  // §19.5: listed only once a proxy exists, like every folder but Exports.
  { id: "proxy", title: "Proxies", kinds: ["proxy"], view: "list", filmFilter: true, gridToggle: false },
  { id: "voiceover", title: "Voiceover", kinds: ["take", "voice"], view: "list", filmFilter: false, gridToggle: false },
  { id: "music", title: "Music", kinds: ["music"], view: "list", filmFilter: false, gridToggle: false },
  { id: "sfx", title: "Sound effects", kinds: ["sfx"], view: "list", filmFilter: false, gridToggle: false },
  { id: "doc", title: "Scripts & docs", kinds: ["doc"], view: "list", filmFilter: false, gridToggle: false },
  { id: "image", title: "Images", kinds: ["image"], view: "grid", filmFilter: false, gridToggle: true },
  { id: "caption", title: "Captions", kinds: ["caption"], view: "list", filmFilter: false, gridToggle: false },
  { id: "export", title: "Exports", kinds: ["export"], view: "list", filmFilter: false, gridToggle: false },
  { id: "delivery", title: "Delivery", kinds: ["delivery"], view: "grid", filmFilter: true, gridToggle: true },
  { id: "edit", title: "Edit files", kinds: ["edit"], view: "list", filmFilter: false, gridToggle: false },
  // §31.2.3: the visuals' pictures, the project's own: listed on every film, marked Shared.
  { id: "visual", title: "Visuals", kinds: ["visual"], view: "grid", filmFilter: false, gridToggle: true },
];

/**
 * §31.5: whether a folder offers the Film filter. With several films every folder does (and opens on the film in the
 * top bar); with one, only the folders that always did, so a one-film project's Assets look as they did (§31.7).
 */
export const filmFilterOn = (folder: Pick<FolderDef, "filmFilter">, filmCount: number): boolean => folder.filmFilter || filmCount > 1;

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
  /** A video id to narrow to, or null/undefined for every film (§31.5: assetOnFilm). Only meaningful on a folder
   *  with filmFilter set, but harmless to pass anywhere. */
  film?: string | null;
  /** Needed to resolve a film's name and a cut's version note for both search and sorting. */
  videos?: Video[];
}

/** `assets` narrowed to one folder's kinds, then filtered by film and search, then sorted. */
export function folderItems(assets: Asset[], folder: Pick<FolderDef, "kinds">, opts: FolderItemsOptions = {}): Asset[] {
  const { query = "", sort = "newest", film, videos = [] } = opts;
  let items = assets.filter((a) => folder.kinds.includes(a.kind));
  if (film) items = items.filter((a) => assetOnFilm(a, film, videos));
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
  return folder.kinds.includes("cut") ? withFormatRows(sorted) : sorted;
}

/** §21.5: each cut's format rows straight after it, in chip order; a row whose cut was filtered out stays where it fell. */
export function withFormatRows(items: Asset[]): Asset[] {
  const isSub = (a: Asset) => a.kind === "cut" && a.format !== undefined;
  const subs = items.filter(isSub);
  const placed = new Set<Asset>();
  const out: Asset[] = [];
  for (const a of items) {
    if (isSub(a)) {
      // A row whose cut isn't in the list (a search or film filter left it out) stays where it fell.
      if (!items.some((c) => c.kind === "cut" && !isSub(c) && c.video === a.video && c.version === a.version)) {
        out.push(a);
        placed.add(a);
      }
      continue;
    }
    out.push(a);
    if (a.kind !== "cut") continue;
    const mine = subs.filter((s) => s.video === a.video && s.version === a.version && !placed.has(s));
    for (const s of orderChips(mine.map((s) => ({ id: s.format!, width: s.width ?? 1, height: s.height ?? 1, s }))).map((x) => x.s)) {
      out.push(s);
      placed.add(s);
    }
  }
  return out;
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

/**
 * Where a videoW × videoH picture actually sits inside a boxW × boxH element under
 * `object-fit: contain`: scaled to fit whole, centred, letterboxed or pillarboxed on the spare
 * axis. Notes' boxes are measured against this, never the element itself, which is only the
 * picture when the two shapes happen to match. Without a picture size yet, it's the whole box.
 */
export function contentRect(videoW: number, videoH: number, boxW: number, boxH: number) {
  if (!(videoW > 0 && videoH > 0 && boxW > 0 && boxH > 0)) return { x: 0, y: 0, w: Math.max(0, boxW), h: Math.max(0, boxH) };
  const scale = Math.min(boxW / videoW, boxH / videoH);
  const w = videoW * scale;
  const h = videoH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
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

export type Scope = "point" | "range" | "whole";
export type MarkKind = Mark["kind"];

const SCOPE_LABELS: Record<Scope, string> = { point: "Point", range: "Range", whole: "Whole" };
const ALL_SCOPES: Scope[] = ["point", "range", "whole"];

/** The scope segments a tab offers, in the order given (Music/SFX/Mix: all three). */
export function scopeOptions(allowed: Scope[] | undefined): { value: Scope; label: string }[] {
  return (allowed ?? ALL_SCOPES).filter((s) => s in SCOPE_LABELS).map((s) => ({ value: s, label: SCOPE_LABELS[s] }));
}

/**
 * Is a note in the making on an audio tab? A range (even just an In point), marks ticked (with or
 * without a range) or typed text. One definition, for both the film hold and New take's refusal:
 * nothing pending is ever dropped.
 */
export function notePending(p: { range: { in: number | null }; marks: readonly unknown[]; hasText: boolean }): boolean {
  return p.range.in !== null || p.marks.length > 0 || p.hasText;
}


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

/**
 * A take's details, for its name's tooltip and its details line on a sound's tab (round 1: nothing is drawn over a
 * waveform): its description, then BPM, key and loudness (`lufs`, a number, or `loudness` in words) when known, and an
 * effects pass's cue count. Unlike variantMeta, BPM and key are listed beside a description, not in place of one.
 */
export function takeDetails(meta: Record<string, string | number> | undefined, cues = 0): string[] {
  const given = (v: string | number | undefined) => (v !== undefined && String(v).trim() ? String(v).trim() : null);
  const parts: string[] = [];
  const description = given(meta?.description);
  if (description) parts.push(description);
  const bpm = given(meta?.bpm);
  if (bpm) parts.push(`${bpm} BPM`);
  const key = given(meta?.key);
  if (key) parts.push(key);
  if (typeof meta?.lufs === "number" && Number.isFinite(meta.lufs)) parts.push(`${String(meta.lufs).replace("-", "−")} LUFS`);
  else {
    const loudness = given(meta?.lufs ?? meta?.loudness);
    if (loudness) parts.push(loudness);
  }
  if (cues > 0) parts.push(`${cues} cue${cues === 1 ? "" : "s"}`);
  return parts;
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
  /** The films it is on (see variantFilms). */
  films: string[];
}

/** Every variant of every lane on `stage`, in manifest order. */
export function variantRows(lanes: Lane[], stage: "voice" | "music" | "sfx"): VariantRow[] {
  const rows: VariantRow[] = [];
  for (const l of lanes) {
    if (l.stage !== stage) continue;
    for (const v of l.variants) {
      rows.push({
        key: `${l.id}/${v.id}`, lane: l.id, laneName: l.name, variant: v.id, name: v.name,
        meta: variantMeta(v.meta, stage === "sfx" ? v.cues.length : 0), file: v.file, cues: v.cues, films: variantFilms(v),
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
  /** The full name, shown as the On menu's tooltip when the label alone is ambiguous ("Round 2 · Gerald, tone · more sombre"). */
  full?: string;
  /** The menu group this option sits in: its round, on Voiceover. Other tabs leave it out. */
  group?: string;
  /** What keeps two groups apart when their labels match (a round's lane id). Defaults to `group`. */
  groupId?: string;
}

/** The On menu's options as runs of consecutive options sharing a group; ungrouped runs render as plain options. */
export function onOptionGroups(options: OnOption[]): { group: string | undefined; options: OnOption[] }[] {
  const out: { group: string | undefined; options: OnOption[] }[] = [];
  for (const o of options) {
    const last = out[out.length - 1];
    if (last && (last.options[0].groupId ?? last.group) === (o.groupId ?? o.group)) last.options.push(o);
    else out.push({ group: o.group, options: [o] });
  }
  return out;
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

type FocusTarget = { matches?(selector: string): boolean; closest?(selector: string): FocusTarget | null };

// Buttons that got focus from the keyboard (Tab), as opposed to a click.
const keyboardFocused = new WeakSet<object>();
let watching = false;

/**
 * Remember, as focus lands, whether a button was reached by keyboard: `:focus-visible` read then.
 * It can't be read when Space is pressed, since any key press makes the focused element match it.
 * A pointer press on a button forgets it, so a click on a button Tab had reached plays again too.
 * Installed once, by the page's entry point.
 */
export function watchFocusOrigin(doc: Pick<Document, "addEventListener">): void {
  if (watching) return;
  watching = true;
  doc.addEventListener("focusin", (e) => noteFocus(e.target), true);
  doc.addEventListener("pointerdown", (e) => {
    const button = (e.target as FocusTarget | null)?.closest?.("button");
    if (button) keyboardFocused.delete(button);
  }, true);
}

/** Record whether `target` matches `:focus-visible` as it takes focus. Exported for tests. */
export function noteFocus(target: EventTarget | null): void {
  const el = target as FocusTarget | null;
  if (!el || typeof el.matches !== "function") return;
  if (el.matches(":focus-visible")) keyboardFocused.add(el);
  else keyboardFocused.delete(el);
}

/**
 * Whether Space belongs to the focused element rather than the transport (§19.8): a button reached
 * by keyboard (Tab to Measure again, say) is pressed by Space, not played over. A button that only
 * has focus because it was clicked (a tab, M, S, Blind, a scope chip) doesn't keep Space: it plays,
 * as before. A button inside the player itself, a lane's name or a shot (marked `data-player`),
 * only selects or seeks, so Space plays there either way.
 */
export function spacePressesButton(target: EventTarget | null): boolean {
  const el = target as FocusTarget | null;
  if (!el || typeof el.closest !== "function") return false;
  const button = el.closest("button");
  return !!button && keyboardFocused.has(button) && !el.closest("[data-player]");
}

/** Test-only switches read from the page URL. `streamOver` only counts alongside `test`. */
export function testFlags(search: string): { test: boolean; streamOver: boolean } {
  const q = new URLSearchParams(search);
  const test = q.get("test") === "1";
  return { test, streamOver: test && q.get("streamOver") === "1" };
}

// ---- Voiceover (§18) ----

/** "S2": a section's name on every tab, and how an old Voiceover note on a section is listed. */
export function sectionLabel(id: string): string {
  return id.toUpperCase();
}

/** The `on` an old note on the assembled read saved; also Mix's VO row key. */
export const READ_ROW = "vo";
/** A Voiceover round (§18.2): one `voice` lane, named for the round, with its own pick. */
export interface VoiceRound {
  /** The lane id. */
  id: string;
  /** The lane's name, e.g. "Round 2 · Gerald, tone". */
  name: string;
  /** Its reads, in manifest order. */
  reads: VariantRow[];
  /** The picked read's variant id, or null (no pick, or a pick naming a read that's gone). */
  pick: string | null;
  /** The newest round. */
  current: boolean;
}

/** The voice lanes that have reads, as rounds in creation (manifest) order; the last is current. */
export function voiceRounds(lanes: Lane[], picks: Record<string, string>): VoiceRound[] {
  const voice = lanes.filter((l) => l.stage === "voice" && l.variants.length > 0);
  return voice.map((l, i) => {
    const reads = variantRows([l], "voice");
    const pick = reads.some((r) => r.variant === picks[l.id]) ? picks[l.id] : null;
    return { id: l.id, name: l.name, reads, pick, current: i === voice.length - 1 };
  });
}

const pickedRead = (r: VoiceRound): VariantRow | null => r.reads.find((x) => x.variant === r.pick) ?? null;

/** §27.6: whether a read, bed or pass is the one in use for its sound, as the server worked it out. */
export function takeInUse(use: InUse | undefined, stage: LaneStage, r: Pick<VariantRow, "lane" | "variant">): boolean {
  const u = use?.[stage];
  return u !== undefined && u.lane === r.lane && u.variant === r.variant;
}

/**
 * The VO the mix hears. With the take in use given (§27.6: the server's answer, in every state it
 * sends), that read, from whichever round, or null. Without it, the rule from before: the newest
 * round's pick, walking back past rounds with none (§18.4).
 */
export function heardVoice(rounds: VoiceRound[], use?: InUse): VariantRow | null {
  if (use !== undefined) return rounds.flatMap((r) => r.reads).find((r) => takeInUse(use, "voice", r)) ?? null;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const read = pickedRead(rounds[i]);
    if (read) return read;
  }
  return null;
}

/** What Voiceover's notes resolve against: the rounds, and the script's sections and their takes (for older notes). */
export interface VoiceNotes {
  rounds: VoiceRound[];
  sections?: { id: string; takes: { id: string }[] }[];
}

const hasSection = (m: VoiceNotes, id: string): boolean => !!m.sections?.some((s) => s.id === id);

/**
 * The read a Voiceover note is on: `"<lane>/<variant>"`, else (legacy) a bare variant id. Never the
 * forms that came before rounds — "vo", a section id or "<section>:<take>" — which name no read.
 */
function voiceTarget(m: VoiceNotes, on: string | null): { round: VoiceRound; read: VariantRow } | null {
  if (on === null) return null;
  for (const round of m.rounds) {
    const read = round.reads.find((r) => r.key === on);
    if (read) return { round, read };
  }
  if (on.includes("/") || on.includes(":") || on === READ_ROW || hasSection(m, on)) return null;
  for (const round of m.rounds) {
    const read = round.reads.find((r) => r.variant === on);
    if (read) return { round, read };
  }
  return null;
}

/**
 * The lane a Voiceover note is drawn on: its read's row (the read's key), or null. Older notes on the
 * assembled read, a section or a take name no read, so they're listed and never drawn. Whole notes
 * aren't drawn either; AudioStage skips them.
 */
export function voiceNoteRows(m: VoiceNotes, note: Pick<Note, "on">): string | null {
  return voiceTarget(m, note.on)?.read.key ?? null;
}

/**
 * What a listed Voiceover note is on: a read in the current round by its name, a read in an older
 * round as "<round> · <read>"; older notes as "Assembled read" (also with no `on`), "S2" or
 * "S2 · Take 1" (the take's place in its section, and only while it exists); else null. Older forms
 * get the same words as export and the CLI (`onLabel` in src/core/notes.ts).
 */
export function voiceOnLabel(m: VoiceNotes, on: string | null, nameOf: (r: VariantRow) => string = (r) => r.name): string | null {
  const target = voiceTarget(m, on);
  if (target) return target.round.current ? nameOf(target.read) : `${target.round.name} · ${nameOf(target.read)}`;
  if (on === null || on === READ_ROW) return "Assembled read";
  if (hasSection(m, on)) return sectionLabel(on);
  for (const s of m.sections ?? []) {
    const i = s.takes.findIndex((t) => `${s.id}:${t.id}` === on);
    if (i !== -1) return `${sectionLabel(s.id)} · Take ${i + 1}`;
  }
  return null;
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

// §19.6: a Mix lane's level slider, mirroring src/core/schema.ts's LEVEL_MIN/MAX/STEP exactly (not
// imported -- the web bundle imports types only from src/).
export const LEVEL_MIN = -24;
export const LEVEL_MAX = 12;
export const LEVEL_STEP = 0.5;

/** A level, clamped to the slider's range and snapped to its 0.5 dB step (§19.6) -- a guard before a
 *  value reaches the server, never a substitute for the server's own check. */
export function clampLevel(db: number): number {
  const stepped = Math.round(db / LEVEL_STEP) * LEVEL_STEP;
  return Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, stepped));
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

// ---- Proxies (§19.5, §36) ----

/**
 * The Create proxy tooltip's size: duration × the preset's average video bitrate plus 256 kbps audio, rounded to 10 MB,
 * and never under 10.
 */
export function proxyEstimateMb(seconds: number, preset: ProxyPreset = DEFAULT_PROXY_PRESET): number {
  const kbps = PRESETS[preset].avgKbps + PROXY_AUDIO_KBPS;
  const mb = ((Number.isFinite(seconds) ? seconds : 0) * kbps) / 8 / 1000;
  return Math.max(10, Math.round(mb / 10) * 10);
}

/** The Create proxy button's tooltip (§19.5, §36), for one quality or several (§37.4). */
export function proxyTip(seconds: number, preset: ProxyPreset | readonly ProxyPreset[] = DEFAULT_PROXY_PRESET): string {
  const list = typeof preset === "string" ? [preset] : preset.length ? preset : [DEFAULT_PROXY_PRESET];
  const mb = list.reduce((n, p) => n + proxyEstimateMb(seconds, p), 0);
  const names = list.map((p) => PRESETS[p].label);
  const what = names.length === 1 ? `a lightweight ${names[0]} copy` : `lightweight ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} copies`;
  return `Makes ${what} on your drive so this cut previews smoothly. About ${mb} MB. Your original isn't changed.`;
}

/** §36.7: where the toolbar's Proxies on/off is kept for this browser, per project. */
export const proxiesKey = (project: string): string => `rushes:proxies:${project}`;

/** §37.5: what the player is playing with Proxies on: a quality, or the original (none ready, or picked). */
export interface Playing {
  /** The quality playing, or null for the original. */
  preset: ProxyPreset | null;
  /** The player stepped down after stalls (and nothing was picked by hand since). */
  stepped: boolean;
  /** Picked by hand from the quality menu. */
  picked: boolean;
}

/** §36.7, §37.5: the toolbar button's tooltip, naming what's playing. */
export function proxiesTip(on: boolean, playing?: Playing | ProxyPreset | null): string {
  if (!on) return "Proxies off · playing originals";
  const p: Playing | null = typeof playing === "string" ? { preset: playing, stepped: false, picked: false } : playing ?? null;
  if (!p || p.preset === null) return p?.picked ? "Proxies on · playing the original" : "Proxies on · no proxy for this cut, playing the original";
  return `Proxies on · playing ${PRESETS[p.preset].label}${p.stepped ? " (stepped down)" : ""}`;
}

/** §37.5: the quality label on the picture: "1080p Low", "720p Low · stepped down", "Original". */
export function playingLabel(p: Playing): string {
  if (p.preset === null) return "Original";
  return `${PRESETS[p.preset].label}${p.stepped ? " · stepped down" : ""}`;
}

/**
 * §37.5: the ladder's state for the cut on screen. `cap` is the best quality it may play after stepping down (null:
 * the top); `pick` a choice from the quality menu ("original", or a quality), which holds until the cut changes.
 */
export interface LadderState {
  cap: ProxyPreset | null;
  pick: ProxyPreset | "original" | null;
  /** performance.now() of the last step down, for the 10 s spacing. */
  steppedAt: number | null;
}
export const LADDER_TOP: LadderState = { cap: null, pick: null, steppedAt: null };

/** §37.5: at most one step down every this many ms. */
export const STEP_SPACING_MS = 10_000;

/**
 * §37.5: what plays. Off: the original. On: a hand pick if it is still ready; otherwise the best ready rung at or
 * under the cap. `ready` is the cut's ready ticked qualities, best first (readyRungs). None ready: the original.
 */
export function choosePlaying(on: boolean, ready: readonly ProxyPreset[], ladder: LadderState): Playing {
  if (!on) return { preset: null, stepped: false, picked: false };
  if (ladder.pick === "original") return { preset: null, stepped: false, picked: true };
  if (ladder.pick && ready.includes(ladder.pick)) return { preset: ladder.pick, stepped: false, picked: true };
  if (ready.length === 0) return { preset: null, stepped: false, picked: false };
  const capAt = ladder.cap ? PROXY_PRESET_ORDER.indexOf(ladder.cap) : -1;
  const allowed = capAt < 0 ? ready : ready.filter((p) => PROXY_PRESET_ORDER.indexOf(p) >= capAt);
  const preset = allowed[0] ?? ready[ready.length - 1];
  return { preset, stepped: ladder.cap !== null && preset !== ready[0], picked: false };
}

/**
 * §37.5: after a stall, whether to step down, and to what. Only while a quality plays (not a hand pick, not the
 * original), only when the player stalls repeatedly (stallsSayHint), only to the next ready rung below, and at most
 * once every STEP_SPACING_MS. Returns the new state, or null to stay. It never steps up.
 */
export function stepDown(
  ladder: LadderState,
  playing: Playing,
  ready: readonly ProxyPreset[],
  stalls: readonly { at: number; ms: number }[],
  now: number,
): LadderState | null {
  if (playing.preset === null || playing.picked) return null;
  if (!stallsSayHint(stalls, now)) return null;
  if (ladder.steppedAt !== null && now - ladder.steppedAt < STEP_SPACING_MS) return null;
  const at = ready.indexOf(playing.preset);
  const next = at >= 0 ? ready[at + 1] : undefined;
  if (!next) return null;
  return { cap: next, pick: null, steppedAt: now };
}

/** "About 5.8 Mbps from here": a measured speed, to one decimal under 10 and whole above. */
export function speedText(mbps: number): string {
  return `About ${mbps < 10 ? mbps.toFixed(1) : Math.round(mbps)} Mbps from here`;
}

/** §36.7: the stall hint's rule: 2 or more waits of 1 s or longer within the last 30 s. */
export const STALL_MIN_MS = 1000;
export const STALL_WINDOW_MS = 30_000;
export const STALLS_TO_HINT = 2;
export function stallsSayHint(stalls: readonly { at: number; ms: number }[], now: number): boolean {
  return stalls.filter((s) => s.ms >= STALL_MIN_MS && now - s.at <= STALL_WINDOW_MS).length >= STALLS_TO_HINT;
}

/** A job still to finish: waiting its turn, or being made. */
export const proxyActive = (state: ProxyJob["state"] | undefined): boolean => state === "queued" || state === "running";

/** The offer's reason when the browser itself refused the file, whatever the server thought of it. */
export const PLAYBACK_ERROR_REASON = "The browser couldn't play this file";

/** One proxy job as this tab last heard of it, and when (`performance.now()`), so older news never overwrites newer. */
export interface ProxyProgress extends ProxyEvent {
  at: number;
}
/** What this tab knows of every proxy job, one per cut and quality, keyed by proxyKey(). */
export type ProxyJobs = Readonly<Record<string, ProxyProgress>>;

/** §37.4: one job per cut and quality. */
export const proxyKey = (video: string, version: string, preset: ProxyPreset): string => `${video}/${version}/${preset}`;

/** §37.4: every job this tab knows of for one cut, whatever the quality, best quality first. */
export function cutJobs(jobs: ProxyJobs, video: string, version: string): ProxyProgress[] {
  return PROXY_PRESET_ORDER.flatMap((p) => (jobs[proxyKey(video, version, p)] ? [jobs[proxyKey(video, version, p)]] : []));
}

/** §37.4: the qualities of a cut being made right now (queued or running). */
export function makingPresets(jobs: ProxyJobs, video: string, version: string): Set<ProxyPreset> {
  return new Set(cutJobs(jobs, video, version).filter((j) => proxyActive(j.state)).map((j) => j.preset));
}

/** §37.5: the ticked qualities a cut is missing that aren't being made yet: what its Make buttons would make. */
export function toMake(proxies: Proxies | null | undefined, ticked: readonly ProxyPreset[], making: ReadonlySet<ProxyPreset>): ProxyPreset[] {
  return missingPresets(proxies, ticked).filter((p) => !making.has(p));
}

/** A route's ProxyJob in the SSE event's shape. */
export function proxyProgress(job: ProxyJob, at: number): ProxyProgress {
  const p: ProxyProgress = { job: job.id, video: job.video, version: job.version, preset: job.preset, pct: job.pct, state: job.state, at };
  if (job.reason !== undefined) p.reason = job.reason;
  return p;
}

/**
 * Folds one report of a job (an SSE event, a route's reply, or a job the state lists) into what
 * this tab knows. A job never moves backwards: once it's finished it stays finished, and its % never
 * drops. A different job for the same cut replaces the old one unless it's older news. Returns the
 * same object when nothing changes, so a state update can bail out.
 */
export function mergeProxyJob(jobs: ProxyJobs, e: ProxyProgress): ProxyJobs {
  const key = proxyKey(e.video, e.version, e.preset);
  const old = jobs[key];
  if (old && old.job === e.job) {
    if (!proxyActive(old.state)) return jobs;
    // Queued news while queued (its preset may have changed) and anything past the queue land; a running job's % never drops.
    if (old.state === "running" && e.state === "queued") return jobs;
    if (old.state === "running" && e.state === "running" && e.pct <= old.pct) return jobs;
    if (old.state === "queued" && e.state === "queued" && e.preset === old.preset) return jobs;
  } else if (old && old.at > e.at) {
    return jobs;
  }
  return { ...jobs, [key]: e };
}

/**
 * After a state fetch that started at `since`: drops what that state shows is over, then seeds the
 * jobs it lists as running (a tab opened mid-job shows progress before the next tick). Dropped are a
 * running job the state no longer lists (its end was missed, e.g. while the event stream
 * reconnected) and a finished job whose proxy has since gone (deleted). Only news older than the
 * fetch is ever dropped.
 */
export function settleProxyJobs(
  jobs: ProxyJobs,
  running: readonly ProxyJob[],
  since: number,
  hasProxy: (video: string, version: string, preset: ProxyPreset) => boolean,
): ProxyJobs {
  const listed = new Set(running.map((j) => j.id));
  let next: Record<string, ProxyProgress> | null = null;
  for (const [key, p] of Object.entries(jobs)) {
    if (p.at >= since) continue;
    const over = (proxyActive(p.state) && !listed.has(p.job)) || (p.state === "done" && !hasProxy(p.video, p.version, p.preset));
    if (!over) continue;
    next ??= { ...jobs };
    delete next[key];
  }
  let out: ProxyJobs = next ?? jobs;
  for (const j of running) out = mergeProxyJob(out, proxyProgress(j, since));
  return out;
}

/** §37.5: Make proxies for all films' count: every ticked quality each film's latest cut is missing and isn't being made. */
export function latestMissing(project: Pick<Project, "videos">, presets: readonly ProxyPreset[], jobs: ProxyJobs): number {
  let n = 0;
  for (const video of project.videos) {
    if (video.shelved) continue;
    const v = video.versions[video.versions.length - 1];
    if (v) n += toMake(v.proxies, presets, makingPresets(jobs, video.id, v.id)).length;
  }
  return n;
}

/** §37.5: Make proxies for this cut's count: every ticked quality the cut on screen is missing and isn't being made. */
export function cutMissing(project: Pick<Project, "videos">, cut: { video: string; version: string } | null, presets: readonly ProxyPreset[], jobs: ProxyJobs): ProxyPreset[] {
  const v = cut && project.videos.find((x) => x.id === cut.video)?.versions.find((x) => x.id === cut.version);
  return v ? toMake(v.proxies, presets, makingPresets(jobs, cut.video, cut.version)) : [];
}

/** §37.5: unticking a quality is refused when it is the last one ticked. Returns the new list, or null. */
export function toggledPresets(ticked: readonly ProxyPreset[], id: ProxyPreset): ProxyPreset[] | null {
  const next = ticked.includes(id) ? ticked.filter((p) => p !== id) : ladderOrder([...ticked, id]);
  return next.length === 0 ? null : next;
}

export type ProxyPhase = "none" | "offer" | "working" | "done" | "missing" | "stall";

/**
 * Which row the bar under the player shows (§19.5). Nothing without ffmpeg. "working" while a job
 * runs (or is being started, or has finished but its record hasn't arrived yet). "done" only for
 * a proxy this view watched being made; an existing proxy otherwise just brings the switch. The
 * offer needs a reason: the server's, or a playback error, and no proxy yet.
 */
export function proxyPhase(p: {
  ffmpeg: boolean;
  need: string | null | undefined;
  broken: boolean;
  hasProxy: boolean;
  job: ProxyProgress | undefined;
  starting: boolean;
  watched: boolean;
  /** §36.7: the toolbar's Proxies is on in this browser. */
  proxiesOn?: boolean;
  /** §36.7: proxies are off and the player keeps stalling (not yet dismissed for this cut). */
  stalling?: boolean;
}): ProxyPhase {
  if (!p.ffmpeg) return "none";
  if (p.starting || proxyActive(p.job?.state) || (p.job?.state === "done" && !p.hasProxy)) return "working";
  if (p.hasProxy && p.watched && p.job?.state === "done") return "done";
  // §36.7: proxies on, and this cut has none to play.
  if (!p.hasProxy && p.proxiesOn) return "missing";
  if (p.stalling && !p.proxiesOn) return "stall";
  if (p.hasProxy) return "none";
  return p.need || p.broken ? "offer" : "none";
}

/** The offer's reason: the server's when it has one, else the browser's own refusal. Null when there's no reason to offer. */
export function proxyReason(need: string | null | undefined, broken: boolean): string | null {
  return need || (broken ? PLAYBACK_ERROR_REASON : null);
}

/** "1.2 MB · 1920×1080 · from v3": a Proxies row's second line. */
export function proxyMeta(asset: Pick<Asset, "size" | "width" | "height" | "version">): string {
  const parts = [formatBytes(asset.size ?? 0)];
  if (asset.width && asset.height) parts.push(`${asset.width}×${asset.height}`);
  if (asset.version) parts.push(`from ${asset.version}`);
  return parts.join(" · ");
}

/** The copy keys to name in a hint: ⌘C on Apple platforms, Ctrl+C everywhere else. `platform` is `navigator.platform`. */
export function copyShortcut(platform: string): string {
  return /Mac|iPhone|iPad|iPod/.test(platform) ? "⌘C" : "Ctrl+C";
}

// ---- §20.5: Assets › Found ----

/** The kinds a found file can be, in the order the filter bar and the kind menu list them. */
export const FOUND_KIND_ORDER: readonly FoundKind[] = ["voice", "music", "sfx", "other", "cut"];
export const FOUND_KIND_LABEL: Record<FoundKind, string> = {
  voice: "Voiceover",
  music: "Music",
  sfx: "Sound effects",
  other: "Other audio",
  cut: "Cut",
};

/** How many files a scan left, all kinds together. */
export function foundTotal(counts: FoundCounts | undefined): number {
  return counts ? counts.voice + counts.music + counts.sfx + counts.cut + counts.other : 0;
}

/** §20.5: a locked tab's line when files of its kind were found: "14 music files found in this project", or
 *  null when none were (and for every tab that takes no files of its own). The count is the live one. */
const LOCKED_FOUND: Partial<Record<Stage | "assets", { kind: FoundKind; one: string; many: string }>> = {
  voice: { kind: "voice", one: "voiceover file", many: "voiceover files" },
  music: { kind: "music", one: "music file", many: "music files" },
  sfx: { kind: "sfx", one: "sound effect file", many: "sound effect files" },
};
export function lockedFound(tab: Stage | "assets", counts: FoundCounts | undefined): { kind: FoundKind; text: string; review: string } | null {
  const spec = LOCKED_FOUND[tab];
  const n = spec && counts ? counts[spec.kind] : 0;
  if (!spec || !(n > 0)) return null;
  return { kind: spec.kind, text: `${n} ${n === 1 ? spec.one : spec.many} found in this project`, review: `Review ${spec.many} in Found` };
}

/** The header chip's text (§20.5): "3 brought in · 118 more found", with whichever half is empty left
 *  out, or null when there is nothing to say. */
export function foundChip(found: Pick<FoundSummary, "broughtIn" | "counts"> | null | undefined): string | null {
  if (!found) return null;
  const n = found.broughtIn.length;
  const m = foundTotal(found.counts);
  if (n > 0 && m > 0) return `${n} brought in · ${m} more found`;
  if (n > 0) return `${n} brought in`;
  if (m > 0) return `${m} found`;
  return null;
}

/** Changes whenever the files found or brought in change, not only their number: the chip stays hidden until it does. The server's `digest` names the files; without one (an older server), the counts stand in. */
export function foundSignature(found: { broughtIn: string[]; counts: FoundCounts; digest?: string } | null | undefined): string {
  if (!found) return "";
  if (found.digest) return `d:${found.digest}`;
  return `${found.broughtIn.length}:${FOUND_KIND_ORDER.map((k) => found.counts[k]).join(",")}`;
}

const sameItem = (a: FoundItem, b: FoundItem): boolean =>
  a.path === b.path && a.kind === b.kind && a.folder === b.folder && a.size === b.size && a.modified === b.modified && a.duration === b.duration &&
  a.score === b.score && a.suggested === b.suggested && a.reasons.length === b.reasons.length && a.reasons.every((r, i) => r === b.reasons[i]);

/**
 * A fresh read of the list, keeping the old objects for files that have not changed, so a row
 * whose file is the same can tell it need not draw again. Returns `prev` itself when nothing
 * differs at all (same files, same order), so the whole list can be left alone.
 */
export function reuseItems(prev: FoundItem[], next: FoundItem[]): FoundItem[] {
  const before = new Map(prev.map((f) => [f.path, f]));
  const merged = next.map((f) => {
    const old = before.get(f.path);
    return old && sameItem(old, f) ? old : f;
  });
  return merged.length === prev.length && merged.every((f, i) => f === prev[i]) ? prev : merged;
}

/** "vo_jules" -> "Vo Jules", "hyperframes/out" -> "Hyperframes / Out", "" -> "Project folder". */
export function humanFolder(folder: string): string {
  if (!folder) return "Project folder";
  return folder
    .split("/")
    .map((level) =>
      level
        .replace(/([a-z\d])([A-Z])/g, "$1 $2")
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" "),
    )
    .filter(Boolean)
    .join(" / ");
}

export interface FoundGroup<T> {
  /** Stable across renders (a folder path), for keys and for remembering a collapse. Cuts share one key that no folder can have. */
  key: string;
  title: string;
  /** The real folder ("" for the project folder); null for Other cuts. */
  folder: string | null;
  files: T[];
}

export const CUTS_GROUP_KEY = "\0cuts";

/** §20.5: by folder, in the order each folder first appears (the list arrives best score first), with every cut in one "Other cuts" group last. */
export function groupFound<T extends { folder: string; kind: FoundKind }>(files: T[]): FoundGroup<T>[] {
  const byFolder = new Map<string, FoundGroup<T>>();
  const cuts: T[] = [];
  for (const f of files) {
    if (f.kind === "cut") {
      cuts.push(f);
      continue;
    }
    let g = byFolder.get(f.folder);
    if (!g) byFolder.set(f.folder, (g = { key: f.folder, title: humanFolder(f.folder), folder: f.folder, files: [] }));
    g.files.push(f);
  }
  const groups = [...byFolder.values()];
  if (cuts.length) groups.push({ key: CUTS_GROUP_KEY, title: "Other cuts", folder: null, files: cuts });
  return groups;
}

/** The search box and the kind filter, applied together. The search is a case-insensitive match on the whole path. */
export function filterFound<T extends { path: string; kind: FoundKind }>(files: T[], kind: FoundKind | "all", query: string): T[] {
  const q = query.trim().toLowerCase();
  return files.filter((f) => (kind === "all" || f.kind === kind) && (!q || f.path.toLowerCase().includes(q)));
}

/** The kinds present, with how many of each, in the filter bar's order. */
export function foundKinds<T extends { kind: FoundKind }>(files: T[]): [FoundKind, number][] {
  return FOUND_KIND_ORDER.map((k): [FoundKind, number] => [k, files.filter((f) => f.kind === k).length]).filter(([, n]) => n > 0);
}

/** 68.6 -> "1:08.6"; "—" when the length isn't known (no ffprobe, or not probed yet). */
export function foundDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const tenths = Math.round(seconds * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/** A refusal in a sentence: "That file has gone" -> "that file has gone". */
const reasonText = (reason: string): string => reason.replace(/\.$/, "").replace(/^(\p{Lu})(?=\p{Ll})/u, (c) => c.toLowerCase());

/** The toast after Bring in: what came in, and, when something didn't, how many and why. */
export function bringInMessage(added: number, failed: { path: string; reason: string }[]): string {
  const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
  if (failed.length === 0) return `Brought in ${files(added)}`;
  const why = [...new Set(failed.map((f) => reasonText(f.reason)))].join("; ");
  const head = added > 0 ? `Brought in ${files(added)}.` : "Nothing was brought in.";
  return `${head} ${failed.length} couldn't be added: ${why}.`;
}

/** One row of the "Brought in with this cut" card. */
export interface BroughtInRow {
  path: string;
  name: string;
  /** What it became, or null when the project doesn't list it (it moved, or was removed). */
  kind: FoundKind | "doc" | null;
  label: string;
  /** The reasons Rushes gave when it came in (a variant's description). */
  reasons: string;
  /** Audio, so it has a play button. */
  playable: boolean;
}

/** §20.5: the files brought in this session, each described from where it was registered. */
export function broughtInRows(project: Pick<Project, "videos" | "lanes" | "files">, paths: string[]): BroughtInRow[] {
  return paths.map((path) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    for (const lane of project.lanes) {
      const variant = lane.variants.find((v) => v.file === path);
      if (!variant) continue;
      const description = variant.meta.description;
      return {
        path,
        name,
        kind: lane.stage,
        label: lane.stage === "voice" && lane.name !== FOUND_KIND_LABEL.voice ? `Voiceover · ${lane.name}` : FOUND_KIND_LABEL[lane.stage],
        reasons: typeof description === "string" ? description : "",
        playable: true,
      };
    }
    for (const video of project.videos) {
      const version = video.versions.find((v) => v.file === path);
      if (version) return { path, name, kind: "cut" as const, label: `Cut · ${video.name} ${version.id}`, reasons: "", playable: false };
    }
    if (project.files.some((f) => f.file === path)) return { path, name, kind: "doc" as const, label: "Doc", reasons: "", playable: false };
    return { path, name, kind: null, label: "", reasons: "", playable: false };
  });
}

/** What a Found row shows: when none of it changed, the row needn't draw again (there can be 2,000). */
export interface FoundRowShown {
  item: FoundItem;
  kind: FoundKind;
  ticked: boolean;
  playing: boolean;
  failure: string | undefined;
}

export function foundRowChanged(a: FoundRowShown, b: FoundRowShown): boolean {
  return a.item !== b.item || a.kind !== b.kind || a.ticked !== b.ticked || a.playing !== b.playing || a.failure !== b.failure;
}

// ---- §21 formats ----
export { CHIP_ORDER, chipOrder, durationWarning, labelOfId, noteShowsOn, ratioLabel, versionFormats, type FormatView } from "../../src/core/formats.js";
import { chipOrder as orderChips, durationWarning as lengthWarning, type FormatView as View } from "../../src/core/formats.js";

/** One chip of the format toggle (§21.5). */
export interface FormatChip {
  id: string;
  label: string;
  width: number;
  height: number;
  /** Part of this cut and selectable (false: the one-format chip, or a format only the previous cut had). */
  enabled: boolean;
  selected: boolean;
  /** Open notes you'd see on this format; 0 shows none. */
  count: number;
  /** "File not found", or the length warning; null for none. */
  warn: string | null;
  /** Why it's greyed: the only format, or not in this cut; null when it's selectable. */
  reason: "single" | "absent" | null;
}

/** The version before `versionId`, for §21.5's "Not in v2". */
export function previousVersion(video: Video, versionId: string): Version | undefined {
  const i = video.versions.findIndex((v) => v.id === versionId);
  return i > 0 ? video.versions[i - 1] : undefined;
}

/** The format on screen: the film's remembered choice when this cut has it, else the primary; null for one format. */
export function currentFormat(views: View[], remembered: string | undefined): string | null {
  if (views.length < 2) return null;
  if (remembered && views.some((v) => v.id === remembered)) return remembered;
  return (views.find((v) => v.primary) ?? views[0]).id;
}

/** §21.5: the toggle's chips, in the fixed order, with this cut's formats and any the previous cut had that this one lacks. */
export function formatChips(o: { views: View[]; previous: View[]; current: string | null; versionDuration: number | null; notes: Note[]; missing: ReadonlySet<string> }): FormatChip[] {
  if (o.views.length === 0) return [];
  const single = o.views.length === 1;
  const here = new Set(o.views.map((v) => v.id));
  const all = orderChips([...o.views.map((v) => ({ ...v, absent: false })), ...o.previous.filter((p) => !here.has(p.id)).map((v) => ({ ...v, absent: true }))]);
  return all.map((v) => {
    const enabled = !v.absent && !single;
    const count = enabled ? o.notes.filter((n) => n.status === "todo" && (n.format === null || n.format === v.id)).length : 0;
    const warn = v.absent || v.primary ? null : o.missing.has(v.file) ? "File not found" : lengthWarning(v.label, v.duration, o.versionDuration);
    return {
      id: v.id, label: v.label, width: v.width, height: v.height, enabled,
      selected: !v.absent && (single || v.id === o.current), count, warn,
      reason: v.absent ? "absent" : single ? "single" : null,
    };
  });
}

/** R1: the next or previous selectable format, stopping at the ends. */
export function neighbourFormat(chips: FormatChip[], current: string | null, dir: -1 | 1): string | null {
  const list = chips.filter((c) => c.enabled);
  const i = list.findIndex((c) => c.id === current);
  if (i === -1) return null;
  return list[i + dir]?.id ?? null;
}

/** The chip's accessible name: "9:16, 2 open notes", "4:5, not in v2", "1:1, 1 open note, File not found". */
export function chipLabel(c: FormatChip, versionId: string): string {
  const parts = [c.label];
  if (c.reason === "absent") parts.push(`not in ${versionId}`);
  if (c.reason === "single") parts.push("the only format");
  if (c.count > 0) parts.push(`${c.count} open note${c.count === 1 ? "" : "s"}`);
  if (c.warn) parts.push(c.warn);
  return parts.join(", ");
}

/** The shape glyph's size: the ratio inside a `size` px square. */
export function shapeBox(width: number, height: number, size = 14): { width: number; height: number } {
  const k = size / Math.max(width, height);
  return { width: Math.max(4, Math.round(width * k)), height: Math.max(4, Math.round(height * k)) };
}

/** Explicit grid tracks for a segmented control of `n` (§21.8: Safari). */
export const fmtColumns = (n: number): string => `repeat(${n}, minmax(0, 1fr))`;

/** The one-format popover's ready-made request (§21.5), in the locked tabs' manner (§19.1). */
export function formatPrompt(projectName: string, filmName: string, versionId: string): string {
  return `In Rushes project "${projectName}", register the other shapes of "${filmName}" ${versionId} (the same cut rendered at other aspect ratios, such as 9:16, 1:1 and 4:5) with rushes_add_format, one call per file.`;
}

/** §21.5: the frame takes its new shape over 160 ms. */
export const RESHAPE_MS = 160;

/** The frame's reshape keyframes, or null under reduced motion or when the size doesn't change. */
export function reshapeKeyframes(from: { width: number; height: number }, to: { width: number; height: number }, reduced: boolean): { width: string; height: string }[] | null {
  if (reduced) return null;
  if (Math.abs(from.width - to.width) < 1 && Math.abs(from.height - to.height) < 1) return null;
  return [{ width: `${from.width}px`, height: `${from.height}px` }, { width: `${to.width}px`, height: `${to.height}px` }];
}

// ---- §21 notes per format ----
import { labelOfId as labelFor, noteShowsOn as showsOn } from "../../src/core/formats.js";

/** §21.2 (5): the notes that show on the format on screen (every note on a one-format cut). */
export const visibleNotes = (notes: Note[], current: string | null): Note[] => notes.filter((n) => showsOn(n, current));
/** §21.5: the rest, for the "Other formats (N)" row. */
export const otherFormatNotes = (notes: Note[], current: string | null): Note[] => (current === null ? [] : notes.filter((n) => !showsOn(n, current)));

/** R7: a box belongs to the format it was drawn on; an older note's to the primary. */
export function boxShowsOn(note: Pick<Note, "box" | "format">, current: string | null, primaryId: string | null): boolean {
  if (!note.box) return false;
  if (current === null) return true;
  return note.format !== null ? note.format === current : current === primaryId;
}

/** §21.2 (6): why a boxed note can't be widened to every format. */
export const BOX_REASON = "A drawn box belongs to one frame, so this note stays on this format.";

/** The composer's hint line (mockup; R15: only with two or more formats). */
export function scopeHint(label: string, scope: "this" | "all", hasBox: boolean): string {
  if (hasBox) return `A drawn box fixes this note to ${label}.`;
  return scope === "this" ? `Shows only while you're viewing ${label}.` : "Shows on every format.";
}

/** R4: a listed note's tag: its format, "All" on a cut with two or more formats, else none. */
export function noteFormatTag(note: Pick<Note, "format">, many: boolean): string | null {
  if (note.format !== null) return labelFor(note.format);
  return many ? "All" : null;
}

export type OtherFormatAction = { kind: "show"; id: string; label: string } | { kind: "restore" } | null;

/** R17: what a read-only note in the Other formats row offers. */
export function otherFormatAction(note: Pick<Note, "format" | "box">, viewsHere: View[], ownViews: View[]): OtherFormatAction {
  if (note.format === null) return null;
  const here = viewsHere.find((f) => f.id === note.format);
  if (here) return { kind: "show", id: here.id, label: here.label };
  if (!note.box && !ownViews.some((f) => f.id === note.format)) return { kind: "restore" };
  return null;
}

/** A web copy of src/core/schema.ts's picksForVideo: the picks and levels one film plays, its own entry or nothing picked. */
export function filmPicks(picks: Picks, videoId: string | null | undefined): Picks {
  if (!videoId) return picks;
  const own = picks.videos?.[videoId];
  return { ...picks, lanes: { ...(own?.lanes ?? {}) }, levels: { ...(own?.levels ?? {}) }, use: { ...(own?.use ?? {}) }, balanced: own?.balanced, sections: {}, videos: {} };
}

/**
 * §29: whether a film's levels are still the last balance's own (or none are set): the Balance button shows pressed,
 * and the server balances again by itself when the take in use changes. Mirrors app.ts's `balanceOwned`.
 */
export function balanceOwned(film: Pick<Picks, "levels" | "balanced">): boolean {
  const stages = ["voice", "music", "sfx"] as const;
  const b = film.balanced;
  return b ? stages.every((k) => (film.levels[k] ?? 0) === (b.levels[k] ?? 0)) : stages.every((k) => (film.levels[k] ?? 0) === 0);
}

/**
 * §30: the films a Change Log line is about. Its own film when it has one; for a line written before lines carried one,
 * the films of the notes it names (a reply line's `notes:<ids>`) or of the take it is about (`<lane>/<variant>`).
 * Empty: the line is about the whole project (the script, the brief, a file), or its film can't be told.
 */
export function lineFilms(line: Pick<LogLine, "video" | "ref">, project: Pick<Project, "lanes">, notes: readonly Pick<Note, "id" | "video">[]): string[] {
  if (line.video) return [line.video];
  const ref = line.ref ?? "";
  if (ref.startsWith("notes:")) {
    const ids = new Set(ref.slice("notes:".length).split(","));
    return [...new Set(notes.filter((n) => ids.has(n.id) && n.video).map((n) => n.video!))];
  }
  const slash = ref.indexOf("/");
  if (slash > 0) {
    const variant = project.lanes.find((l) => l.id === ref.slice(0, slash))?.variants.find((v) => v.id === ref.slice(slash + 1));
    if (variant) return variantFilms(variant);
  }
  return [];
}

/** §30: whether Activity on `film` shows a line: its own and the project's. With one film (or none) every line. */
export function onFilm(line: Pick<LogLine, "video" | "ref">, film: string | null, project: Pick<Project, "lanes" | "videos">, notes: readonly Pick<Note, "id" | "video">[]): boolean {
  if (!film || project.videos.length < 2) return true;
  const films = lineFilms(line, project, notes);
  return films.length === 0 || films.includes(film);
}

/**
 * §31.5: whether an asset shows on `film` in Assets: a visual's picture on every film (shared), a read, bed or pass on
 * each film it is on, anything else on its own film, and anything that names no film on the first film (§31.2.4).
 */
export function assetOnFilm(a: Pick<Asset, "video" | "videos" | "shared">, film: string, videos: readonly Pick<Video, "id">[]): boolean {
  if (a.shared) return true;
  if (a.videos?.length) return a.videos.includes(film);
  if (a.video) return a.video === film;
  return videos.length === 0 || videos[0].id === film;
}

/**
 * A web copy of src/core/films.ts's noteOnFilm (§31.5): a note on a visual shows on every film; any other on its own
 * film, and one that names none on the first film. With no film, every note.
 */
export function noteOnFilm(note: Pick<Note, "stage" | "video">, film: string | null | undefined, videos: readonly Pick<Video, "id">[]): boolean {
  if (!film || note.stage === "visuals") return true;
  if (note.video) return note.video === film;
  return videos.length === 0 || videos[0].id === film;
}

/**
 * §31.5: the state as one film's desk sees it: that film's script, brief, storyboard and plan state, its tabs (counts,
 * dots, unlocking) and its Activity head, and only its notes (and the shared visuals'). With no film (a project with
 * no film yet), the state as it is. A server older than §31 has no `films`: the state as it is too.
 */
export function scopeState(state: State, film: string | null | undefined): State {
  const plan: FilmPlan | undefined = film ? state.films?.[film] : undefined;
  if (!film || !plan) return state;
  const videos = state.project.videos;
  return {
    ...state,
    script: plan.script,
    brief: plan.brief,
    storyboard: plan.storyboard,
    build: plan.build,
    tabs: plan.tabs,
    log: plan.log,
    notes: { ...state.notes, notes: state.notes.notes.filter((n) => noteOnFilm(n, film, videos)) },
  };
}

/** §31.5: the film a URL's query names (`?film=<id>`), or null. */
export function filmFromSearch(search: string): string | null {
  const f = new URLSearchParams(search).get("film");
  return f && f.length <= 64 ? f : null;
}

/** §31.5: a URL's query with `film` set to `id`, every other parameter kept as it was. */
export function withFilm(search: string, id: string): string {
  const q = new URLSearchParams(search);
  q.set("film", id);
  return `?${q.toString()}`;
}

/** A web copy of src/core/schema.ts's variantFilms: a variant's `videos`, or an older project's one `video`. */
export function variantFilms(v: Pick<Variant, "videos" | "video">): string[] {
  return v.videos ?? (v.video === undefined ? [] : [v.video]);
}

/** The lanes one film lists, as the server's lanesForVideo: each keeps only the reads, beds and
 *  passes on that film (§31.2.4: one on no film is the first film's), and a lane left with none is dropped. */
export function filmLanes(lanes: Lane[], videoId: string | null | undefined, videos: readonly Pick<Video, "id">[]): Lane[] {
  if (!videoId) return lanes;
  return lanes
    .map((l) => ({
      ...l,
      variants: l.variants.filter((v) => {
        const films = variantFilms(v);
        return films.length === 0 ? videos.length === 0 || videos[0].id === videoId : films.includes(videoId);
      }),
    }))
    .filter((l) => l.variants.length > 0);
}

/** The reads, beds and passes not on this film (on other films), in a project with more than one
 *  film: the tab keeps them folded under "Not on this film", to put one on it. */
export function otherLanes(lanes: Lane[], videoId: string, videos: readonly Pick<Video, "id">[]): Lane[] {
  if (videos.length <= 1) return [];
  const here = new Set(filmLanes(lanes, videoId, videos).flatMap((l) => l.variants.map((v) => `${l.id}/${v.id}`)));
  return lanes
    .map((l) => ({ ...l, variants: l.variants.filter((v) => !here.has(`${l.id}/${v.id}`)) }))
    .filter((l) => l.variants.length > 0);
}

/** One film's notes on an audio tab: those made on it (§31.5: one that names no film is the first film's). */
export function filmNotes(notes: Note[], stage: Stage, videoId: string | null | undefined, videos: readonly Pick<Video, "id">[] = []): Note[] {
  return notes.filter((n) => n.stage === stage && noteOnFilm(n, videoId, videos));
}
