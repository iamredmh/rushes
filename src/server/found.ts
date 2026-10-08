import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import {
  AUDIO_EXT,
  DEFAULT_LIMITS,
  SKIPPED_FOLDERS,
  VIDEO_EXT,
  commonWordsOf,
  kindOf,
  pickCurrentSet,
  scanFolder,
  scoreCandidate,
  wordsOf,
  type Anchor,
  type FoundFile,
  type ScanLimits,
  type Scored,
} from "../core/found.js";
import { InvalidError, RevConflictError, RushesError } from "../core/errors.js";
import { slugify } from "../core/ids.js";
import { probe as ffprobe } from "../core/media.js";
import { fromManifestPath, toManifestPath } from "../core/paths.js";
import { addFile, addVariant, addVersion, resolveVideo } from "../core/project.js";
import type { Project, Script, Version, Video } from "../core/schema.js";
import type { ChangeEvent, Store } from "../core/store.js";
import { logBookFor } from "./logbook.js";
import { broughtInEvent, cutName } from "../core/logEvents.js";

// §20: finding the project's other files. One scanner per server. The walk (Task 1's scanFolder)
// runs in the background; GET /api/state and GET /api/found only ever read what the last walk
// left in memory, and never wait on a walk or a probe. Durations come from background probes,
// two at a time, cached by path, size and mtime. Only the dismissed paths are written to disk
// (.rushes/found.json); everything else lives in memory for the server's lifetime.

export interface FoundCounts {
  voice: number;
  music: number;
  sfx: number;
  cut: number;
  other: number;
}

export interface FoundSummary {
  /** A walk of the folder is running (the first pass, or its background continuation). */
  scanning: boolean;
  /** When the last walk finished (ISO), or null before the first. */
  scannedAt: string | null;
  /** False when the last walk stopped at a limit (or none has finished yet). */
  complete: boolean;
  /** Candidates by kind: found, not registered, not dismissed. */
  counts: FoundCounts;
  /** Paths brought in during this server session (Task 3 fills this). */
  broughtIn: string[];
  /** Identifies exactly which files are found and brought in (not just how many): it changes when one is swapped for another. The dashboard's chip uses it to know whether you have seen what is there now. */
  digest: string;
}

export interface FoundEntry extends FoundFile {
  /** §20.4's score against the anchor cut; null for a cut, or when there's no anchor. */
  score: number | null;
  reasons: string[];
  /** Picked by `pickCurrentSet` as the current set's file for its kind. */
  suggested: boolean;
}

/** A file's duration in seconds, or null when unknown. Stops early (answering anything) when `signal` aborts. */
export type FoundProbe = (abs: string, signal?: AbortSignal) => Promise<number | null>;

export interface FoundScannerOptions {
  store: Store;
  probe: FoundProbe;
  /** Tells every open tab to read the state again (the SSE `change` event). */
  announce: () => void;
  limits?: Partial<ScanLimits>;
  /** The time budget of the background continuation when the first pass ran out of time. Defaults to 30 s. */
  continueBudgetMs?: number;
  /** How long adopting the current set waits for the walk and the probes before it scores anyway. Defaults to 15 s. */
  adoptWaitMs?: number;
}

/** What a found file is brought in as: a variant in a lane, a cut, or a library doc. */
export type BringInKind = "voice" | "music" | "sfx" | "cut" | "doc";

export interface BringInItem {
  /** A manifest path (relative to the project) or an absolute path inside the project. */
  path: string;
  /** Defaults to the kind the file's name suggests; a file that suggests none needs one. */
  kind?: BringInKind;
  /** Voice only: the round (lane) it joins. Defaults to its folder's name, humanised. */
  round?: string;
}

export interface BringInAdded {
  /** The manifest path registered, in its spelling on disk. */
  path: string;
  kind: string;
  lane?: string;
  variant?: string;
  video?: string;
  version?: string;
}

/** What §20.7 tells an agent about a file brought in this session: where it went and why. */
export interface BroughtInEntry extends BringInAdded {
  /** The reasons it was chosen, in plain words (empty for a file brought in with no scoring). */
  reasons: string[];
  /** Who brought it in: the scoring's current set, an agent's `include`, or somebody by hand. */
  origin: BringInOrigin;
}

export type BringInOrigin = "auto" | "include" | "hand";

/** Why an item was refused, as a stable name: a key of BRING_IN_REASONS, or "other" for a message that comes from elsewhere (a clash, a registration error). Callers match on this, never on the words. */
export type BringInCode = keyof typeof BRING_IN_REASONS | "other";

export interface BringInFailure {
  path: string;
  /** In words for the user. */
  reason: string;
  code: BringInCode;
}

export interface BringInResult {
  added: BringInAdded[];
  /** Each refused item, with its path as given, why, and the code for why. */
  failed: BringInFailure[];
}

/** The audio kinds, which an include can settle. */
const AUDIO_KINDS: ReadonlySet<string> = new Set(["voice", "music", "sfx"]);
/** The most cuts' settled kinds found.json keeps (the newest). */
const MAX_SETTLED = 200;

/** The most items one bring-in request takes (§20.6's route, and bringIn itself). */
export const BRING_IN_MAX = 60;
/** §20.5: at most this many of one kind per request. */
export const BRING_IN_PER_KIND = 12;
/** The default for `adoptWaitMs`: how long adoption waits for the lengths it needs. */
export const ADOPT_WAIT_MS = 15_000;
/** The longest settled() waits by default, so it can never hang. */
export const SETTLED_MAX_MS = 30_000;

/** Why an item wasn't brought in. The first four are §20.5's own lines. */
export const BRING_IN_REASONS = {
  outside: "That file isn't in the project folder",
  gone: "That file has gone",
  already: "Already in the project.",
  cap: "Up to 12 at a time, so the tabs stay quick.",
  link: "That file is a link. Bring in the file it points to",
  folder: "That's a folder, not a file",
  hiddenFile: "That's a hidden file",
  skippedFolder: "Rushes leaves that folder alone",
  chooseKind: "Choose a kind for this file",
  notAudio: "That isn't an audio file",
  notVideo: "That isn't a video file",
  notDoc: "That isn't a script or document (md, txt or pdf)",
  unknownType: "That isn't an audio, video or document file",
} as const;

const R = BRING_IN_REASONS;

/** A refusal with its code: the key whose words these are, else "other". */
function refusal(path: string, reason: string): BringInFailure {
  const code = (Object.keys(BRING_IN_REASONS) as (keyof typeof BRING_IN_REASONS)[]).find((k) => BRING_IN_REASONS[k] === reason);
  return { path, reason, code: code ?? "other" };
}
/** §20.2: scripts and documents, brought in as library docs. */
const DOC_EXT: ReadonlySet<string> = new Set([".md", ".txt", ".pdf"]);
/** A variant's or film's id comes from its name; this keeps it, plus uniqueId's suffix, inside the 64-character id limit. */
const NAME_SLUG_MAX = 58;
const ROUND_MAX = 64;
/** The default lanes' ids, which a voice round never takes. */
const STAGE_LANES: Record<"voice" | "music" | "sfx", string> = { voice: "voice", music: "music", sfx: "sfx" };
const STAGE_WORDS: Record<"voice" | "music" | "sfx", string> = { voice: "voiceover", music: "music", sfx: "sound effects" };

/** At most `max` characters (code points), trimmed. */
function cut(text: string, max: number): string {
  return [...text].slice(0, max).join("").trim();
}

/**
 * A folder's name as a voice round: its last segment split on spaces, `_`, `-`, `.` and camel
 * case, each word capitalised. "vo_jules" and "voJules" both become "Vo Jules". Undefined for the
 * project folder itself, or a name with no words.
 */
export function roundName(folder: string): string | undefined {
  const last = folder.split("/").filter((p) => p !== "").pop();
  if (!last) return undefined;
  const words = last
    .normalize("NFC")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[\s_.-]+/u)
    .filter((w) => w !== "")
    .map((w) => {
      const [first, ...rest] = [...w];
      return first.toUpperCase() + rest.join("");
    });
  const name = cut(words.join(" "), ROUND_MAX);
  return name === "" ? undefined : name;
}

/** The lane id addVariant gives a round or lane name. */
function laneIdOf(name: string): string {
  return slugify(name).slice(0, 64).replace(/-+$/, "");
}

/** A manifest path's folder ("" at the top of the project). */
function folderOf(file: string): string {
  const slash = file.lastIndexOf("/");
  return slash < 0 ? "" : file.slice(0, slash);
}

/**
 * The round a voice file from `folder` joins (§20.5: each voiceover folder is its own round).
 * Its folder's name, humanised, unless a round of that name holds another folder's files; then
 * the parent folder's name is added ("Vo · B"), then a number ("Vo 2"). A folder named like
 * the music or sfx lane, or with no name, joins the default voiceover lane (undefined).
 */
function voiceRound(p: Project, folder: string): string | undefined {
  const base = roundName(folder);
  if (base === undefined) return undefined;
  const reserved = new Set([STAGE_LANES.music, STAGE_LANES.sfx]);
  if (reserved.has(laneIdOf(base))) return undefined;
  const parentFolder = folderOf(folder);
  const parent = parentFolder === "" ? undefined : roundName(parentFolder);
  const options = [base];
  if (parent !== undefined) options.push(cut(`${base} · ${parent}`, ROUND_MAX));
  for (let n = 2; n <= 99; n++) options.push(`${cut(base, ROUND_MAX - 3)} ${n}`);
  for (const name of options) {
    const id = laneIdOf(name);
    if (reserved.has(id)) continue;
    const lane = p.lanes.find((l) => l.id === id);
    if (!lane) return name;
    if (lane.stage !== "voice") continue;
    // An empty round of that name, or one already holding this folder's files, is this folder's.
    if (lane.variants.length === 0 || lane.variants.some((v) => folderOf(v.file) === folder)) return name;
  }
  return undefined;
}

/** Why a variant of `stage` can't go into the lane `round` (or the stage's own lane) names, or null when it can. */
function laneClash(p: Project, stage: "voice" | "music" | "sfx", round: string | undefined): string | null {
  if (round !== undefined) {
    const id = laneIdOf(round);
    const lane = p.lanes.find((l) => l.id === id);
    if (lane && lane.stage !== stage) return `“${round}” is already the ${STAGE_WORDS[lane.stage]} lane. Choose another round name`;
    if (!lane && (id === STAGE_LANES.music || id === STAGE_LANES.sfx)) {
      return `“${round}” is kept for the ${STAGE_WORDS[id === STAGE_LANES.music ? "music" : "sfx"]} lane. Choose another round name`;
    }
    return null;
  }
  const lane = p.lanes.find((l) => l.id === STAGE_LANES[stage]);
  if (lane && lane.stage !== stage) return `The ${STAGE_WORDS[stage]} lane's name is taken by the ${STAGE_WORDS[lane.stage]} round “${lane.name}”`;
  return null;
}

/** `name`, shortened only as far as its id needs. */
function fitName(name: string): string {
  let chars = [...name];
  while (chars.length > 1 && slugify(chars.join("")).length > NAME_SLUG_MAX) chars = chars.slice(0, -1);
  return chars.join("").trim() || name;
}

function isInside(realRoot: string, real: string): boolean {
  return real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
}

/** A version's added time as a number, for ordering (a hand-edited, unreadable one counts as oldest). */
function addedTime(v: Version): number {
  const t = Date.parse(v.addedAt);
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * §20.4's cut: the named film's newest version when it has one, otherwise the newest registered
 * cut of any film (latest `addedAt`; on a tie, the later one in the project).
 */
export function anchorCut(p: Project, film: string | undefined): { video: Video; version: Version } | null {
  if (film !== undefined) {
    try {
      const video = resolveVideo(p, film);
      const version = video.versions[video.versions.length - 1];
      if (version) return { video, version };
    } catch {
      // Not a film in this project: the newest cut stands in.
    }
  }
  let best: { video: Video; version: Version } | null = null;
  for (const video of p.videos) {
    for (const version of video.versions) {
      if (!best || addedTime(version) >= addedTime(best.version)) best = { video, version };
    }
  }
  return best;
}

/** The film a found cut joins: the anchor cut's film, else the first film. Null with no films. */
function filmFor(p: Project, film: string | undefined): string | null {
  return anchorCut(p, film)?.video.id ?? p.videos[0]?.id ?? null;
}

interface Located {
  /** The manifest path in its spelling on disk. */
  rel: string;
  /** The real absolute path: the file's identity. */
  abs: string;
  size: number;
  modified: number;
}

interface Planned extends Located {
  item: BringInItem;
  kind: BringInKind;
  reasons: string[];
}

/** Thrown inside a project update when nothing in it succeeded, so nothing is written. */
class NothingAdded extends Error {
  constructor(readonly refused: BringInResult["failed"]) {
    super("nothing added");
  }
}

/** How many times a bring-in re-reads and retries after another writer changed the project. */
const BRING_IN_ATTEMPTS = 5;

/** The most entries `list()` returns (§20.6). */
export const FOUND_LIST_CAP = 2000;
/** Background probes run this many at a time (global constraints). */
export const FOUND_PROBE_CONCURRENCY = 2;
/** While probes keep landing, a `change` goes out after this many new durations (and always when they're all done). */
export const FOUND_ANNOUNCE_EVERY = 20;
/** The time budget for carrying a scan on in the background after the first pass ran out of time (§20.2). */
export const CONTINUE_BUDGET_MS = 30_000;
/** The most dismissed paths kept (the schema's limit): the oldest go first. */
const MAX_DISMISSED = 10000;
/** How many probe results are remembered. */
const DURATION_CACHE_LIMIT = 10000;

/** The default probe: ffprobe's duration, or null without ffprobe. */
export const ffprobeDuration: FoundProbe = async (abs, signal) => (await ffprobe(abs, { signal })).duration;

/**
 * The scanner's `announce` for a server: a `change` event on the store, which the SSE route sends
 * to every open tab so it reads the state again. Its `file` is "found"; its `rev` counts the
 * scanner's announcements this session (found.json's own writes announce its real rev as usual).
 */
export function foundAnnouncer(store: Store): () => void {
  let seq = 0;
  return () => {
    store.emit("change", { file: "found", rev: ++seq } satisfies ChangeEvent);
  };
}

/** Every manifest path the project has registered: cuts, variants, library files and script takes. */
export function registeredPaths(project: Project, script: Script): string[] {
  const out: string[] = [];
  for (const v of project.videos) for (const ver of v.versions) out.push(ver.file);
  for (const l of project.lanes) for (const variant of l.variants) out.push(variant.file);
  for (const f of project.files) out.push(f.file);
  for (const s of script.sections) for (const t of s.takes) out.push(t.file);
  return out;
}

/**
 * A path's identity on disk: its real path when it exists (case, symlinks, `..` and Unicode
 * spelling all resolved by the file system), otherwise the plain resolved spelling.
 */
export async function realIdentity(abs: string): Promise<string> {
  try {
    return await realpath(abs);
  } catch {
    return resolve(abs);
  }
}

/**
 * `path` (relative to `root`, or absolute inside it) as a manifest path in its spelling on disk,
 * when it names a plain file inside the project reached without any symlink on the way. Null for
 * anything else: missing, a folder, a symlink or a path through one, outside the root, or a path
 * with an empty, `.` or `..` segment.
 */
export async function plainFileInside(root: string, path: string): Promise<string | null> {
  try {
    const realRoot = await realpath(root);
    let rel = path;
    if (isAbsolute(path)) {
      rel = toManifestPath(realRoot, path);
      if (isAbsolute(rel)) rel = toManifestPath(root, path);
      if (isAbsolute(rel)) return null;
    }
    if (rel === "" || rel.includes("\\") || rel.includes("\0")) return null;
    const parts = rel.split("/");
    if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
    // Every folder on the way, then the file itself, must be the real thing, never a symlink.
    let at = realRoot;
    for (let i = 0; i < parts.length; i++) {
      at = join(at, parts[i]);
      const info = await lstat(at);
      if (info.isSymbolicLink()) return null;
      if (i < parts.length - 1 ? !info.isDirectory() : !info.isFile()) return null;
    }
    const out = toManifestPath(realRoot, await realpath(at));
    return isAbsolute(out) ? null : out;
  } catch {
    return null;
  }
}

const revKey = (f: { abs: string; size: number; modified: number }) => `${f.abs}\0${f.size}\0${f.modified}`;

/**
 * The probe queue's order. Adoption needs the anchor's length and every voice and music file's
 * (registered ones first: they hold the current set's place), so those go before the lengths
 * the list only shows. Sound effects get no length score (§20.4).
 */
const PROBE_TIER = { anchor: 0, competitor: 1, candidate: 2, listed: 3, cut: 4 } as const;
type ProbeTier = (typeof PROBE_TIER)[keyof typeof PROBE_TIER];

interface ProbeItem {
  key: string;
  abs: string;
  tier: ProbeTier;
}

export class FoundScanner {
  protected readonly store: Store;
  private readonly probeFile: FoundProbe;
  private readonly announceChange: () => void;
  private readonly limits: Partial<ScanLimits>;
  private readonly continueBudgetMs: number;

  /** Everything the last walk found, registered or not. */
  private files: FoundFile[] = [];
  private scannedAt: string | null = null;
  private complete = false;
  private walking = false;
  /** The first pass in flight, which a second scan() joins. */
  private firstPass: Promise<void> | null = null;
  /** The whole walk in flight, continuation included. */
  private walk: Promise<void> | null = null;
  private film: string | undefined;
  private closing = false;
  /** Aborted by close(): a walk in flight stops before its next folder. */
  private readonly walkAbort = new AbortController();
  /**
   * Bumped by every dismiss and restore. A read of found.json that started before one of them is
   * stale by the time it lands, and is dropped rather than undoing the change in has().
   */
  private dismissedGeneration = 0;

  /** Dismissed manifest paths, as last read from or written to found.json. */
  private dismissed = new Set<string>();
  /** The paths `has()` answers yes for: found, not registered, not dismissed. */
  private current = new Set<string>();
  /** Registered real paths, by project and script rev. */
  private registeredCache: { key: string; real: Set<string> } | null = null;

  /** Durations by path, size and mtime. */
  private readonly durations = new Map<string, number | null>();
  private readonly queue: ProbeItem[] = [];
  private readonly queued = new Set<string>();
  private readonly probing = new Set<string>();
  private readonly inflight = new Set<AbortController>();
  private landedSinceAnnounce = 0;
  private idle: { promise: Promise<void>; resolve: () => void } | null = null;

  /** Paths brought in this session, by hand or adopted. Not persisted. */
  protected readonly broughtIn: string[] = [];
  /** The same, with where each went and why (§20.7), in the order they came in. */
  private readonly broughtInLog: BroughtInEntry[] = [];
  private readonly adoptWaitMs: number;
  /** Bring-ins (and adoptions) run one at a time, so two never add the same file. */
  private bringing: Promise<unknown> = Promise.resolve();
  /** Adoptions still running, which settled() waits for. */
  private readonly adoptions = new Set<Promise<unknown>>();
  /** Woken each time a probe lands (and on close), for adoption's wait on lengths. */
  private readonly lengthWaiters = new Set<() => void>();

  constructor(opts: FoundScannerOptions) {
    this.store = opts.store;
    this.probeFile = opts.probe;
    this.announceChange = opts.announce;
    this.limits = opts.limits ?? {};
    this.continueBudgetMs = opts.continueBudgetMs ?? CONTINUE_BUDGET_MS;
    this.adoptWaitMs = opts.adoptWaitMs ?? ADOPT_WAIT_MS;
  }

  /**
   * Scans now, or joins a scan whose first pass is still running. Resolves when the first pass
   * (the walk and the kinds) is done; probing, and a continuation when the first pass ran out of
   * time, carry on in the background. `film` names the video (id, slug or name) whose newest cut
   * anchors the scoring, and is remembered for later lists. Never rejects.
   */
  scan(opts: { film?: string } = {}): Promise<void> {
    if (opts.film !== undefined) this.film = opts.film;
    if (this.firstPass) return this.firstPass;
    // The first pass is done and its background continuation is still walking: that walk is
    // already the fresh look a second scan would take.
    if (this.walk || this.closing) return Promise.resolve();
    let firstDone!: () => void;
    const first = new Promise<void>((r) => (firstDone = r));
    this.firstPass = first;
    this.walking = true;
    this.announce();
    this.walk = this.runWalk(() => {
      this.firstPass = null;
      firstDone();
    })
      .catch(() => undefined)
      .finally(() => {
        this.walking = false;
        this.walk = null;
        this.firstPass = null;
        firstDone();
        this.announce();
        this.resolveIdle();
      });
    return first;
  }

  private async runWalk(firstPassDone: () => void): Promise<void> {
    let result = await this.walkOnce(this.limits);
    await this.land(result);
    firstPassDone();
    if (this.closing) return;
    // §20.2: a first pass that ran out of time (not out of entries or room) carries on in the
    // background, and the tabs hear when it lands (the walk's end announces).
    const limits: ScanLimits = { ...DEFAULT_LIMITS, ...this.limits };
    const outOfTime = !result.complete && result.examined < limits.maxExamined && result.files.length < limits.maxKept;
    if (outOfTime) {
      this.announce();
      result = await this.walkOnce({ ...this.limits, budgetMs: this.continueBudgetMs });
      await this.land(result);
    }
  }

  private async walkOnce(limits: Partial<ScanLimits>): Promise<{ files: FoundFile[]; complete: boolean; examined: number }> {
    try {
      return await scanFolder(this.store.root, { limits, signal: this.walkAbort.signal });
    } catch {
      // The root has gone or can't be read: nothing found, and not complete.
      return { files: [], complete: false, examined: 0 };
    }
  }

  /** Takes a walk's result as the current one, and queues probes for what's new. */
  private async land(result: { files: FoundFile[]; complete: boolean }): Promise<void> {
    if (this.closing) return;
    this.files = result.files;
    this.complete = result.complete;
    this.scannedAt = new Date().toISOString();
    try {
      const ctx = await this.context();
      const candidates = this.candidates(ctx.registered);
      const listed = new Set(candidates.map((c) => c.path));
      // In the order adoption needs them (see PROBE_TIER): the anchor's own length, when the
      // project doesn't know it; registered and dismissed voice and music, which still compete
      // for the current set; voice and music candidates; then the rest of the list.
      await this.anchor(ctx.project);
      const lengthScored = (f: FoundFile) => f.kind === "voice" || f.kind === "music";
      for (const f of this.files.filter((c) => lengthScored(c) && !listed.has(c.path))) this.enqueue(f, PROBE_TIER.competitor);
      for (const f of candidates.filter(lengthScored)) this.enqueue(f, PROBE_TIER.candidate);
      for (const f of candidates.filter((c) => c.kind === "sfx" || c.kind === "other")) this.enqueue(f, PROBE_TIER.listed);
      for (const f of candidates.filter((c) => c.kind === "cut")) this.enqueue(f, PROBE_TIER.cut);
    } catch {
      // project.json or script.json unreadable right now: the watcher reports that. has() still
      // only knows this walk's files (less the dismissed), and the next list() tries again.
      this.current = new Set(this.files.filter((f) => !this.dismissed.has(f.path)).map((f) => f.path));
    }
  }

  async summary(): Promise<FoundSummary> {
    const counts: FoundCounts = { voice: 0, music: 0, sfx: 0, cut: 0, other: 0 };
    const identities: string[] = [];
    try {
      const ctx = await this.context();
      for (const f of this.candidates(ctx.registered)) {
        counts[f.kind]++;
        identities.push(`${f.kind}:${f.path}`);
      }
    } catch {
      // Unreadable project files: counts stay at zero; the watcher reports the file.
    }
    const digest = createHash("sha1")
      .update([...identities.sort(), "|", ...[...this.broughtIn].sort()].join("\n"))
      .digest("hex")
      .slice(0, 16);
    return { scanning: this.walking, scannedAt: this.scannedAt, complete: this.complete, counts, broughtIn: [...this.broughtIn], digest };
  }

  /** Everything brought in this server session, with where it went and why (§20.7). */
  broughtInDetail(): BroughtInEntry[] {
    return this.broughtInLog.map((e) => ({ ...e, reasons: [...e.reasons] }));
  }

  /** Candidates not registered and not dismissed, best score first, at most 2,000. */
  async list(): Promise<FoundEntry[]> {
    const { candidates, byPath, suggested } = await this.scoring(await this.context());
    const entries: FoundEntry[] = candidates.map((f) => {
      const s = byPath.get(f.path);
      return { ...f, score: s ? s.score : null, reasons: s ? s.reasons : [], suggested: suggested.has(f.path) };
    });
    entries.sort((a, b) => {
      if (a.score !== b.score) {
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        return b.score - a.score;
      }
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    return entries.slice(0, FOUND_LIST_CAP);
  }

  /** The files the user hid with "Not these" that the last walk still found, so the dashboard can offer to restore them. By path. */
  async hidden(): Promise<FoundFile[]> {
    const { registered } = await this.context();
    return this.files
      .filter((f) => this.dismissed.has(f.path) && !registered.has(f.abs))
      .map((f) => ({ ...f, duration: this.durations.get(revKey(f)) ?? null }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /**
   * §20.5's Bring in: registers each item as an unpicked variant (voice, music, sfx), a new
   * version of the film (cut) or a library doc, in one write for the whole request, and no write
   * when nothing can come in. An item that can't come in fails with a reason and the rest still
   * go in. Nothing is ever picked. At most 60 items. `reasons` (by manifest path) describe the
   * variants; without it, the current scoring's are used.
   */
  bringIn(items: BringInItem[], opts: { reasons?: Map<string, string[]>; film?: string; origin?: BringInOrigin } = {}): Promise<BringInResult> {
    if (items.length > BRING_IN_MAX) return Promise.reject(new InvalidError(`Up to ${BRING_IN_MAX} files at a time`));
    return this.oneAtATime(() => this.bringInNow(items, opts));
  }

  /**
   * §20.4's auto-add: brings in the current set's file for each kind (at most one per kind, and
   * none on a tie or a low score), unpicked, described by its reasons. Adds nothing without an
   * anchor cut, and nothing twice: the winner keeps its place once it's in, so the runner-up never
   * moves up. It waits for the walk to end, then up to `adoptWaitMs` for the lengths scoring needs
   * (the anchor's, and every voice and music file's). A kind whose lengths are still unknown then
   * is skipped, never guessed from part of the picture; the next scan decides it. `skipKinds`
   * leaves out kinds the caller has already settled (§20.7: what an agent includes wins).
   */
  adoptCurrentSet(opts: { film?: string; skipKinds?: BringInKind[] } = {}): Promise<BringInResult> {
    if (opts.film !== undefined) this.film = opts.film;
    const run = this.adopt(opts.film, new Set(opts.skipKinds ?? []));
    const tracked: Promise<unknown> = run.then(
      () => this.adoptions.delete(tracked),
      () => this.adoptions.delete(tracked),
    );
    this.adoptions.add(tracked);
    return run;
  }

  private async adopt(film: string | undefined, skip: Set<BringInKind>): Promise<BringInResult> {
    const none = (): BringInResult => ({ added: [], failed: [] });
    if (this.closing) return none();
    // The walk is bounded by its own budgets (3 s, then 30 s), and close() stops it.
    if (this.walk) await this.walk;
    await this.lengthsKnown(Date.now() + this.adoptWaitMs);
    return this.oneAtATime(async () => {
      if (this.closing) return none();
      let picked: FoundFile[];
      let byPath: Map<string, Scored>;
      let anchor: { video: Video; version: Version } | null = null;
      let films = 1;
      try {
        const ctx = await this.context();
        const unknown = await this.pendingLengths(ctx.project);
        const s = await this.scoring(ctx);
        if (!s.anchor) return none();
        // What an agent's include settled for this cut (§20.7), read here so a start-up adoption,
        // a later scan and a restart all honour it.
        const settled = await this.settledFor(ctx.project);
        picked = s.candidates.filter((f) => s.suggested.has(f.path) && !unknown.has(f.kind) && !skip.has(f.kind as BringInKind) && !settled.has(f.kind));
        byPath = s.byPath;
        anchor = anchorCut(ctx.project, this.film);
        films = ctx.project.videos.length;
      } catch {
        return none(); // project files unreadable right now: the watcher reports them
      }
      if (picked.length === 0) return none();
      const reasons = new Map(picked.map((f) => [f.path, byPath.get(f.path)?.reasons ?? []]));
      const result = await this.bringInNow(picked.map((f) => ({ path: f.path, kind: f.kind as BringInKind })), { reasons, film, origin: "auto" });
      // §22.5: what the current set brought in is one line, by Rushes (R8, R9); its variants are dated (R5).
      // Built inside add's guard, so a line that can't be made never undoes the bring-in (M1).
      const cut = anchor;
      if (result.added.length) await logBookFor(this.store).add(() => broughtInEvent(result.added, cut ? cutName(films, cut.video, cut.version.id) : null), "rushes");
      return result;
    });
  }

  /** The kinds an agent's include settled for the current anchor cut. */
  private async settledFor(project: Project): Promise<Set<FoundFile["kind"]>> {
    const cut = anchorCut(project, this.film);
    if (!cut) return new Set();
    const entry = (await this.store.read("found")).settled.find((e) => e.video === cut.video.id && e.version === cut.version.id);
    return new Set(entry?.kinds ?? []);
  }

  /**
   * §20.7: an agent's `include` wins over the scoring. The audio kinds of the items (the kind
   * given, else what the name says, else the lane a file already registered sits in) are kept in
   * found.json against the anchor cut, so no adoption adds a file of that kind for that cut again.
   * It runs ahead of every adoption not yet at its write, and registrations are never removed.
   * Items outside the project settle nothing. Returns the audio kinds the items settle, once they're written (or none to write: with no cut, nothing is recorded).
   */
  settleKinds(items: BringInItem[], film?: string): Promise<BringInKind[]> {
    if (film !== undefined) this.film = film;
    return this.oneAtATime(async () => {
      const project = await this.store.read("project");
      const cut = anchorCut(project, this.film);
      const root = this.store.root;
      const realRoot = await realIdentity(root);
      const kinds = new Set<FoundFile["kind"]>();
      let lanes: Map<string, FoundFile["kind"]> | null = null;
      for (const item of items) {
        const given = isAbsolute(item.path) ? resolve(item.path) : resolve(root, ...item.path.split("/"));
        let rel = toManifestPath(realRoot, given);
        if (isAbsolute(rel)) rel = toManifestPath(root, given);
        if (isAbsolute(rel) || rel === "" || rel.startsWith("../") || rel === "..") continue;
        const ext = extname(rel).toLowerCase();
        let kind: FoundFile["kind"] | undefined = item.kind !== undefined && AUDIO_KINDS.has(item.kind) ? (item.kind as FoundFile["kind"]) : undefined;
        if (kind === undefined && item.kind === undefined && AUDIO_EXT.has(ext)) {
          const guess = kindOf(rel);
          if (AUDIO_KINDS.has(guess)) kind = guess;
        }
        if (kind === undefined && item.kind === undefined && AUDIO_EXT.has(ext)) {
          // A name that says nothing, but the file may be registered already: its lane says.
          if (!lanes) {
            lanes = new Map();
            for (const l of project.lanes) for (const v of l.variants) lanes.set(await realIdentity(fromManifestPath(root, v.file)), l.stage as FoundFile["kind"]);
          }
          kind = lanes.get(await realIdentity(fromManifestPath(root, rel)));
        }
        if (kind !== undefined) kinds.add(kind);
      }
      const settled = [...kinds] as BringInKind[];
      // With no cut there is nothing to record against yet; the caller records again once one exists.
      if (kinds.size === 0 || !cut) return settled;
      await this.store.update("found", (f) => {
        const entry = f.settled.find((e) => e.video === cut.video.id && e.version === cut.version.id);
        if (entry) {
          const add = [...kinds].filter((k) => !entry.kinds.includes(k));
          if (add.length === 0) return;
          entry.kinds.push(...add);
          return;
        }
        f.settled.push({ video: cut.video.id, version: cut.version.id, kinds: [...kinds] });
        if (f.settled.length > MAX_SETTLED) f.settled = f.settled.slice(-MAX_SETTLED);
      });
      return settled;
    });
  }

  /** The kinds whose scoring still waits on a length: voice and music files, or the anchor (both). */
  private async pendingLengths(project: Project): Promise<Set<FoundFile["kind"]>> {
    const out = new Set<FoundFile["kind"]>();
    const { anchor, pending } = await this.anchorState(project);
    if (!anchor) return out;
    if (pending) return new Set(["voice", "music"]);
    for (const f of this.files) {
      if ((f.kind === "voice" || f.kind === "music") && !this.durations.has(revKey(f))) out.add(f.kind);
    }
    return out;
  }

  /** Waits until no length adoption needs is pending, or until `deadline`, or close(). */
  private async lengthsKnown(deadline: number): Promise<void> {
    while (!this.closing) {
      let pending: Set<FoundFile["kind"]>;
      try {
        pending = await this.pendingLengths(await this.store.read("project"));
      } catch {
        return;
      }
      const left = deadline - Date.now();
      if (pending.size === 0 || left <= 0) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        new Promise<void>((r) => this.lengthWaiters.add(r)),
        new Promise<void>((r) => {
          timer = setTimeout(r, left);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    }
  }

  private wakeLengthWaiters(): void {
    const waiters = [...this.lengthWaiters];
    this.lengthWaiters.clear();
    for (const w of waiters) w();
  }

  private oneAtATime<T>(job: () => Promise<T>): Promise<T> {
    const run = this.bringing.then(job, job);
    this.bringing = run.catch(() => undefined);
    return run;
  }

  private async bringInNow(items: BringInItem[], opts: { reasons?: Map<string, string[]>; film?: string; origin?: BringInOrigin }): Promise<BringInResult> {
    const reasons = opts.reasons ?? (await this.currentReasons());
    const film = opts.film ?? this.film;
    for (let attempt = 1; ; attempt++) {
      const [project, script] = await Promise.all([this.store.read("project"), this.store.read("script")]);
      // "Already in the project" by real path, freshly read: never has(), which can lag a
      // registration. The write below only lands if the project is still this rev.
      const registered = new Set(await Promise.all(registeredPaths(project, script).map((p) => realIdentity(fromManifestPath(this.store.root, p)))));
      const failed: BringInResult["failed"] = [];
      const plan: Planned[] = [];
      for (const item of items) {
        const where = await this.locate(item.path);
        if ("reason" in where) {
          failed.push(refusal(item.path, where.reason));
          continue;
        }
        // Already in wins over a kind it can't be given: a file the agent registered itself and
        // names again has nothing to choose.
        if (registered.has(where.abs)) {
          failed.push(refusal(item.path, R.already));
          continue;
        }
        const kind = this.kindFor(item, where.rel);
        if (typeof kind !== "string") {
          failed.push(refusal(item.path, kind.reason));
          continue;
        }
        registered.add(where.abs); // another spelling later in this request is the same file
        plan.push({ ...where, item, kind, reasons: reasons.get(where.rel) ?? reasons.get(item.path) ?? [] });
      }
      if (plan.length === 0) return { added: [], failed };
      try {
        const { result } = await this.store.update(
          "project",
          (p) => {
            const out = this.applyPlan(p, plan, film);
            if (out.ok.length === 0) throw new NothingAdded(out.refused);
            return out;
          },
          project.rev,
        );
        for (const a of result.ok) {
          if (!this.broughtIn.includes(a.path)) this.broughtIn.push(a.path);
          this.broughtInLog.push({ ...a, reasons: plan.find((it) => it.rel === a.path)?.reasons ?? [], origin: opts.origin ?? "hand" });
          this.current.delete(a.path);
        }
        this.announce();
        return { added: result.ok, failed: [...failed, ...result.refused] };
      } catch (e) {
        if (e instanceof NothingAdded) return { added: [], failed: [...failed, ...e.refused] };
        // Another writer changed the project since it was read: check everything again.
        if (e instanceof RevConflictError && attempt < BRING_IN_ATTEMPTS) continue;
        throw e;
      }
    }
  }

  /** Registers the plan in the project draft, in order. The cap counts only what goes in. */
  private applyPlan(p: Project, plan: Planned[], film: string | undefined): { ok: BringInAdded[]; refused: BringInResult["failed"] } {
    const ok: BringInAdded[] = [];
    const refused: BringInResult["failed"] = [];
    const perKind = new Map<BringInKind, number>();
    for (const it of plan) {
      if ((perKind.get(it.kind) ?? 0) >= BRING_IN_PER_KIND) {
        refused.push(refusal(it.item.path, R.cap));
        continue;
      }
      const out = this.register(p, it, film);
      if ("reason" in out) {
        refused.push(refusal(it.item.path, out.reason));
        continue;
      }
      ok.push(out);
      perKind.set(it.kind, (perKind.get(it.kind) ?? 0) + 1);
    }
    return { ok, refused };
  }

  /** Registers one planned item in the project draft, or says why it can't, changing nothing. */
  private register(p: Project, it: Planned, film: string | undefined): BringInAdded | { reason: string } {
    const stem = basename(it.rel, extname(it.rel));
    const name = fitName(stem);
    switch (it.kind) {
      case "voice":
      case "music":
      case "sfx": {
        const round = it.kind !== "voice" ? undefined : it.item.round !== undefined ? it.item.round : voiceRound(p, folderOf(it.rel));
        const clash = laneClash(p, it.kind, round);
        if (clash) return { reason: clash };
        const description = it.reasons.length > 0 ? it.reasons.join(" · ") : undefined;
        try {
          const { lane, variant } = addVariant(p, { stage: it.kind, round, name, file: it.rel, description });
          return { path: it.rel, kind: it.kind, lane: lane.id, variant: variant.id };
        } catch (e) {
          return { reason: e instanceof RushesError ? e.message : "That file couldn't be brought in" };
        }
      }
      case "cut": {
        const duration = this.durations.get(revKey(it)) ?? null;
        const { video, version } = addVersion(p, { video: filmFor(p, film) ?? (film ? fitName(film) : name), file: it.rel, duration });
        return { path: it.rel, kind: it.kind, video: video.id, version: version.id };
      }
      case "doc":
        addFile(p, { kind: "doc", file: it.rel });
        return { path: it.rel, kind: it.kind };
    }
  }

  /**
   * Where a bring-in path is: a plain file inside the project, reached without a symlink, not
   * hidden and not in a folder the scan leaves alone, in its spelling on disk. Symlinks are never
   * followed (§20.2); where one leads only decides the reason.
   */
  private async locate(path: string): Promise<Located | { reason: string }> {
    if (path.includes("\0")) return { reason: R.outside };
    const root = this.store.root;
    const realRoot = await realIdentity(root);
    // `..` and `.` resolve by name only. The path that results is the one checked and registered.
    const given = isAbsolute(path) ? resolve(path) : resolve(root, ...path.split("/"));
    let rel = toManifestPath(realRoot, given);
    if (isAbsolute(rel)) rel = toManifestPath(root, given);
    if (isAbsolute(rel)) return { reason: R.outside };
    if (rel === "") return { reason: R.folder };
    const parts = rel.split("/");
    // §20.2's skipped folders and hidden names: the scan never offers them, so neither does this.
    if (parts.slice(0, -1).some((d) => d.startsWith(".") || SKIPPED_FOLDERS.has(d.toLowerCase()))) return { reason: R.skippedFolder };
    if (parts[parts.length - 1].startsWith(".")) return { reason: R.hiddenFile };
    let at = realRoot;
    for (let i = 0; i < parts.length; i++) {
      at = join(at, parts[i]);
      let info;
      try {
        info = await lstat(at);
      } catch {
        return { reason: R.gone };
      }
      if (info.isSymbolicLink()) {
        const target = await realpath(at).catch(() => null);
        if (target === null) return { reason: R.gone };
        return { reason: isInside(realRoot, target) ? R.link : R.outside };
      }
      if (i < parts.length - 1) {
        if (!info.isDirectory()) return { reason: R.gone };
        continue;
      }
      if (info.isDirectory()) return { reason: R.folder };
      if (!info.isFile()) return { reason: R.unknownType };
      // The spelling on disk (case and Unicode form), as the scan records it.
      const real = await realpath(at).catch(() => null);
      if (real === null) return { reason: R.gone };
      const onDisk = toManifestPath(realRoot, real);
      if (isAbsolute(onDisk)) return { reason: R.outside };
      return { rel: onDisk, abs: real, size: info.size, modified: info.mtimeMs };
    }
    return { reason: R.gone };
  }

  /** The kind an item comes in as: the one asked for, if the file suits it, or the one its name suggests. */
  private kindFor(item: BringInItem, rel: string): BringInKind | { reason: string } {
    const ext = extname(rel).toLowerCase();
    const audio = AUDIO_EXT.has(ext);
    const video = VIDEO_EXT.has(ext);
    const doc = DOC_EXT.has(ext);
    let kind = item.kind;
    if (kind === undefined) {
      if (video) return "cut";
      if (doc) return "doc";
      if (!audio) return { reason: R.unknownType };
      const guess = kindOf(rel);
      if (guess !== "voice" && guess !== "music" && guess !== "sfx") return { reason: R.chooseKind };
      kind = guess;
    }
    if ((kind === "voice" || kind === "music" || kind === "sfx") && !audio) return { reason: R.notAudio };
    if (kind === "cut" && !video) return { reason: R.notVideo };
    if (kind === "doc" && !doc) return { reason: R.notDoc };
    return kind;
  }

  /** The current scoring's reasons by path, for describing what's brought in by hand. */
  private async currentReasons(): Promise<Map<string, string[]>> {
    try {
      return new Map((await this.list()).filter((e) => e.reasons.length > 0).map((e) => [e.path, e.reasons]));
    } catch {
      return new Map();
    }
  }

  /**
   * §20.4 against the anchor cut. Every audio file the walk found competes for the current set,
   * registered and dismissed ones included, so bringing the winner in (or hiding it) never hands
   * its place to the runner-up: adoption stays idempotent, across restarts too. Only candidates
   * are suggested. Common words are counted over the whole walk, so a score doesn't shift as
   * files are brought in.
   */
  private async scoring(ctx: { project: Project; registered: Set<string> }): Promise<{
    candidates: FoundFile[];
    anchor: Anchor | null;
    byPath: Map<string, Scored>;
    suggested: Set<string>;
  }> {
    const withDuration = (f: FoundFile): FoundFile => ({ ...f, duration: this.durations.get(revKey(f)) ?? null });
    const candidates = this.candidates(ctx.registered).map(withDuration);
    const anchor = await this.anchor(ctx.project);
    const byPath = new Map<string, Scored>();
    const suggested = new Set<string>();
    if (anchor) {
      const all = this.files.map(withDuration);
      const common = commonWordsOf(all);
      const scored = all.filter((f) => f.kind !== "cut").map((f) => scoreCandidate(f, anchor, common));
      for (const s of scored) byPath.set(s.file.path, s);
      const listed = new Set(candidates.map((c) => c.path));
      for (const s of Object.values(pickCurrentSet(scored))) if (s && listed.has(s.file.path)) suggested.add(s.file.path);
    }
    return { candidates, anchor, byPath, suggested };
  }

  /** Whether `rel` is a current found candidate, exactly as the scan recorded it (for /media). */
  has(rel: string): boolean {
    return this.current.has(rel);
  }

  /** Hides paths for good (found.json). Each path may be absolute or relative; it's kept as a manifest path. */
  async dismiss(paths: string[]): Promise<void> {
    const rels = await this.dismissablePaths(paths);
    if (rels.length === 0) return;
    const already = new Set((await this.store.read("found")).dismissed);
    if (rels.every((p) => already.has(p))) {
      this.setDismissed(already);
      for (const p of rels) this.current.delete(p);
      return;
    }
    const { data } = await this.store.update("found", (f) => {
      const set = new Set(f.dismissed);
      for (const p of rels) {
        set.delete(p); // re-added at the end, so the newest are the ones kept
        set.add(p);
      }
      f.dismissed = [...set].slice(-MAX_DISMISSED);
    });
    this.setDismissed(new Set(data.dismissed));
    for (const p of rels) this.current.delete(p);
  }

  /**
   * The paths worth keeping as dismissed: a current candidate as listed, or a plain file inside
   * the project (in its spelling on disk). Junk, a folder, a path with an empty or dotted segment,
   * and anything reached through a symlink are dropped. No duplicates.
   */
  private async dismissablePaths(paths: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const p of paths) {
      const rel = this.current.has(p) ? p : await plainFileInside(this.store.root, p);
      if (rel !== null && !out.includes(rel)) out.push(rel);
    }
    return out;
  }

  /** Records the dismissed set this server just wrote or read, and makes reads already in flight stale. */
  private setDismissed(set: Set<string>): void {
    this.dismissed = set;
    this.dismissedGeneration++;
  }

  /** Brings dismissed paths back into the list. */
  async restore(paths: string[]): Promise<void> {
    const rels = new Set(await this.manifestPaths(paths));
    if (rels.size === 0) return;
    const before = await this.store.read("found");
    if (!before.dismissed.some((p) => rels.has(p))) {
      this.setDismissed(new Set(before.dismissed));
      return;
    }
    const { data } = await this.store.update("found", (f) => {
      f.dismissed = f.dismissed.filter((p) => !rels.has(p));
    });
    this.setDismissed(new Set(data.dismissed));
    // Back in has() straight away, unless it's registered: the next context() settles that.
    try {
      const ctx = await this.context();
      this.candidates(ctx.registered);
    } catch {
      // Left for the next list().
    }
  }

  /** Stops probing (nothing queued starts, and probes in flight are aborted) and stops announcing. */
  close(): void {
    this.closing = true;
    this.walkAbort.abort();
    this.queue.length = 0;
    this.queued.clear();
    for (const c of this.inflight) c.abort();
    this.resolveIdle();
    this.wakeLengthWaiters();
  }

  /**
   * Resolves once nothing runs in the background: no walk, no probe queued or running, and no
   * adoption of the current set (which reads and may write the project) still to finish. Never
   * waits longer than `maxMs` (30 s by default), so a hung probe can't hang a caller.
   */
  async settled(maxMs = SETTLED_MAX_MS): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((r) => {
      timer = setTimeout(r, maxMs);
      timer.unref?.();
    });
    const all = (async () => {
      await this.workSettled();
      while (this.adoptions.size > 0) {
        await Promise.all([...this.adoptions]);
        await this.workSettled();
      }
    })();
    try {
      await Promise.race([all, bound]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolves once no walk is running and no probe is queued or running. */
  private workSettled(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    if (!this.idle) {
      let resolveIt!: () => void;
      const promise = new Promise<void>((r) => (resolveIt = r));
      this.idle = { promise, resolve: resolveIt };
    }
    return this.idle.promise;
  }

  // ---- internals ----

  private isIdle(): boolean {
    if (this.walk) return false;
    if (this.closing) return true; // probes in flight are abandoned once closing
    return this.probing.size === 0 && this.queue.length === 0;
  }

  private resolveIdle(): void {
    if (this.idle && this.isIdle()) {
      this.idle.resolve();
      this.idle = null;
    }
  }

  private announce(): void {
    if (this.closing) return;
    try {
      this.announceChange();
    } catch {
      // An announcement is a courtesy; it never breaks a scan.
    }
  }

  /** The project, and the real paths of everything it has registered. Refreshes the dismissed set too. */
  private async context(): Promise<{ project: Project; registered: Set<string> }> {
    const [project, script] = await Promise.all([this.store.read("project"), this.store.read("script")]);
    await this.refreshDismissed();
    const key = `${project.rev}\0${script.rev}\0${this.scannedAt}`;
    if (this.registeredCache?.key !== key) {
      const real = new Set(await Promise.all(registeredPaths(project, script).map((p) => realIdentity(fromManifestPath(this.store.root, p)))));
      this.registeredCache = { key, real };
    }
    return { project, registered: this.registeredCache.real };
  }

  /** found.json's dismissed paths. A file that can't be read leaves the last known set in place (the watcher reports it). */
  private async refreshDismissed(): Promise<void> {
    const generation = this.dismissedGeneration;
    try {
      const { dismissed } = await this.store.read("found");
      // A dismiss or restore landed while this read was in flight: what it read may predate that
      // write, so it must not replace the set the write left (Review: the has() race).
      if (generation !== this.dismissedGeneration) return;
      this.dismissed = new Set(dismissed);
    } catch {
      // Corrupt by hand: keep what we had.
    }
  }

  /** The walk's files minus registered and dismissed ones. Keeps `has()` in step. */
  private candidates(registered: Set<string>): FoundFile[] {
    const out = this.files.filter((f) => !registered.has(f.abs) && !this.dismissed.has(f.path));
    this.current = new Set(out.map((f) => f.path));
    return out;
  }

  /** Each path as the manifest path found.json keeps: inside the root, relative, real spelling when it exists. */
  private async manifestPaths(paths: string[]): Promise<string[]> {
    const root = this.store.root;
    const realRoot = await realIdentity(root);
    const out: string[] = [];
    for (const p of paths) {
      const abs = isAbsolute(p) ? p : resolve(root, ...p.split("/"));
      // The spelling on disk when the file is there, so a dismissed path matches what the scan lists.
      let rel = toManifestPath(realRoot, await realIdentity(abs));
      if (isAbsolute(rel)) rel = toManifestPath(root, abs);
      // Only paths inside the project folder mean anything here.
      if (isAbsolute(rel)) continue;
      if (!out.includes(rel)) out.push(rel);
    }
    return out;
  }

  /**
   * §20.4's anchor: the named film's newest cut, otherwise the newest cut of any film (§20.4; see anchorCut). Its
   * duration comes from the version, else a probe (queued, not waited on). Null when there's no
   * registered cut, or its file can't be read.
   */
  private async anchor(project: Project): Promise<Anchor | null> {
    return (await this.anchorState(project)).anchor;
  }

  /** The anchor, and whether its length is still waiting on a probe. */
  private async anchorState(project: Project): Promise<{ anchor: Anchor | null; pending: boolean }> {
    const version = anchorCut(project, this.film)?.version;
    if (!version) return { anchor: null, pending: false };
    const abs = fromManifestPath(this.store.root, version.file);
    let info;
    try {
      info = await stat(abs);
    } catch {
      return { anchor: null, pending: false };
    }
    let duration = version.duration;
    let pending = false;
    if (duration === null) {
      const item = { abs, size: info.size, modified: info.mtimeMs };
      const key = revKey(item);
      if (this.durations.has(key)) duration = this.durations.get(key)!;
      else {
        this.enqueue(item, PROBE_TIER.anchor);
        pending = true;
      }
    }
    const name = basename(version.file, extname(version.file));
    return { anchor: { duration, modified: info.mtimeMs, words: wordsOf(name) }, pending };
  }

  /** Queues a probe in its tier's place (after others of the same tier), or moves a queued one up. */
  private enqueue(f: { abs: string; size: number; modified: number }, tier: ProbeTier): void {
    if (this.closing) return;
    const key = revKey(f);
    if (this.durations.has(key) || this.probing.has(key)) return;
    if (this.queued.has(key)) {
      const at = this.queue.findIndex((q) => q.key === key);
      if (at < 0 || this.queue[at].tier <= tier) return;
      this.queue.splice(at, 1);
    }
    this.queued.add(key);
    const before = this.queue.findIndex((q) => q.tier > tier);
    const item = { key, abs: f.abs, tier };
    if (before < 0) this.queue.push(item);
    else this.queue.splice(before, 0, item);
    this.pump();
  }

  private pump(): void {
    while (!this.closing && this.probing.size < FOUND_PROBE_CONCURRENCY && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.queued.delete(item.key);
      this.probing.add(item.key);
      void this.probeOne(item);
    }
  }

  private async probeOne(item: ProbeItem): Promise<void> {
    const controller = new AbortController();
    this.inflight.add(controller);
    let duration: number | null = null;
    try {
      const d = await this.probeFile(item.abs, controller.signal);
      duration = typeof d === "number" && Number.isFinite(d) && d >= 0 ? d : null;
    } catch {
      duration = null;
    } finally {
      this.inflight.delete(controller);
    }
    if (this.closing) return;
    this.remember(item.key, duration);
    if (duration !== null) this.landedSinceAnnounce++;
    this.probing.delete(item.key);
    this.wakeLengthWaiters();
    const drained = this.probing.size === 0 && this.queue.length === 0;
    if (this.landedSinceAnnounce >= FOUND_ANNOUNCE_EVERY || (drained && this.landedSinceAnnounce > 0)) {
      this.landedSinceAnnounce = 0;
      this.announce();
    }
    this.pump();
    this.resolveIdle();
  }

  private remember(key: string, duration: number | null): void {
    this.durations.delete(key);
    this.durations.set(key, duration);
    while (this.durations.size > DURATION_CACHE_LIMIT) this.durations.delete(this.durations.keys().next().value!);
  }
}
