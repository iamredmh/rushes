import type { Dirent } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { extname, join, sep } from "node:path";
import { toManifestPath } from "./paths.js";

/**
 * Finding the project's other files (spec §20.2 to §20.4). A bounded walk of
 * the project folder that lists audio and video files by name, size and
 * modified time (never their contents), a guess at what each one is, and a
 * score for how well each audio file goes with a given cut.
 *
 * Pure of anything but the file system: no server, no ffprobe. Durations are
 * left `null` here; the caller fills them in for candidates.
 */

export type FoundKind = "voice" | "music" | "sfx" | "cut" | "other";

export interface FoundFile {
  /** Manifest path: relative to the project root, forward slashes, as `toManifestPath` gives. */
  path: string;
  /** The real absolute path. */
  abs: string;
  kind: FoundKind;
  /** The file's folder, relative to the root ("" for the root itself). */
  folder: string;
  size: number;
  /** Milliseconds since the epoch. */
  modified: number;
  duration: number | null;
}

export interface ScanLimits {
  maxDepth: number;
  maxExamined: number;
  maxKept: number;
  budgetMs: number;
}

export const DEFAULT_LIMITS: ScanLimits = { maxDepth: 8, maxExamined: 5000, maxKept: 2000, budgetMs: 3000 };

export interface ScanResult {
  files: FoundFile[];
  /** False when the examined, kept or time limit stopped the walk early. */
  complete: boolean;
  /** Directory entries looked at, files and folders alike. */
  examined: number;
}

/** §20.2: audio files the scan lists. */
export const AUDIO_EXT: ReadonlySet<string> = new Set([".wav", ".mp3", ".m4a", ".aif", ".aiff", ".flac", ".ogg", ".opus"]);
/** §20.2: video files the scan lists, offered as cuts. */
export const VIDEO_EXT: ReadonlySet<string> = new Set([".mp4", ".mov", ".m4v", ".webm"]);
/** Folders that are never walked: the project's own, and tool clutter. */
export const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(["node_modules", ".rushes", "proxies", "screenshots", "exports"]);
/** Let the event loop breathe this often, so a server using the scan stays responsive. */
const YIELD_EVERY = 200;

const VOICE_WORDS = new Set(["vo", "voice", "voiceover", "narration", "narrator", "vox", "speech", "dub", "read"]);
const MUSIC_WORDS = new Set(["bed", "music", "score", "track", "song", "theme"]);
const SFX_WORDS = new Set(["sfx", "fx", "foley", "whoosh", "hit", "riser", "impact"]);

const VERSION_WORD = /^v\d+[a-z]?$/;

function isInside(realRoot: string, real: string): boolean {
  return real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
}

/** Plain code-unit order, so the walk is the same on every machine and locale. */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Reads at most `max` entries of a folder, so a folder with a hundred thousand
 * entries is never loaded in one go. The order the file system gives them in is
 * arbitrary, so the caller sorts what came back.
 */
async function readSome(dir: string, max: number): Promise<Dirent[]> {
  const handle = await opendir(dir);
  const out: Dirent[] = [];
  try {
    while (out.length < max) {
      const entry = await handle.read();
      if (entry === null) break;
      out.push(entry);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return out;
}

/**
 * Walks `root` within the limits, level by level, siblings in sorted order.
 * Symlinks are skipped. Never reads contents. Stops (not complete) once
 * `signal` aborts, checked before each folder is read. Rejects if `root` does not exist
 * or cannot be resolved; anything unreadable below it is skipped quietly.
 */
export async function scanFolder(
  root: string,
  opts: { limits?: Partial<ScanLimits>; skip?: (relPath: string) => boolean; now?: () => number; signal?: AbortSignal } = {},
): Promise<ScanResult> {
  const limits: ScanLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const now = opts.now ?? Date.now;
  const skip = opts.skip;
  const signal = opts.signal;
  const started = now();
  const realRoot = await realpath(root);

  const files: FoundFile[] = [];
  let examined = 0;
  let complete = true;
  let sinceYield = 0;

  const overBudget = () => now() - started >= limits.budgetMs;

  let level: string[] = [""];
  let depth = 0;

  walk: while (level.length > 0) {
    const next: string[] = [];
    for (const relDir of level) {
      // Checked between folder reads: a closing server stops the walk here, not 5,000 entries later.
      if (overBudget() || signal?.aborted) {
        complete = false;
        break walk;
      }
      const absDir = relDir === "" ? realRoot : join(realRoot, ...relDir.split("/"));
      let entries: Dirent[];
      try {
        // A real folder can still resolve outside the root (a bind mount, say): check it.
        if (relDir !== "" && !isInside(realRoot, await realpath(absDir))) continue;
        // One more than the examined limit still allows: enough to know there was more.
        entries = await readSome(absDir, limits.maxExamined - examined + 1);
      } catch {
        continue; // gone, or unreadable
      }
      entries.sort(byName);

      for (const entry of entries) {
        if (examined >= limits.maxExamined || overBudget()) {
          complete = false;
          break walk;
        }
        examined++;
        if (++sinceYield >= YIELD_EVERY) {
          sinceYield = 0;
          await yieldToLoop();
        }

        const name = entry.name;
        const rel = relDir === "" ? name : `${relDir}/${name}`;
        // Some drives (network, FUSE) list names without types: then the file system is asked.
        let isLink = entry.isSymbolicLink();
        let isDir = entry.isDirectory();
        let isPlain = entry.isFile();
        if (!isLink && !isDir && !isPlain) {
          try {
            const info = await lstat(join(absDir, name));
            isLink = info.isSymbolicLink();
            isDir = info.isDirectory();
            isPlain = info.isFile();
          } catch {
            continue; // vanished mid-scan
          }
        }
        if (isLink) continue; // never followed, never listed

        if (isDir) {
          if (name.startsWith(".") || SKIPPED_FOLDERS.has(name.toLowerCase())) continue;
          if (skip?.(rel)) continue;
          if (depth < limits.maxDepth) next.push(rel);
          continue;
        }

        if (!isPlain) continue;
        if (name.startsWith(".")) continue; // hidden files, such as macOS "._" companions
        const ext = extname(name).toLowerCase();
        const isAudio = AUDIO_EXT.has(ext);
        if (!isAudio && !VIDEO_EXT.has(ext)) continue;
        if (skip?.(rel)) continue;

        let stat;
        try {
          stat = await lstat(join(absDir, name));
        } catch {
          continue; // vanished mid-scan
        }
        if (!stat.isFile()) continue;

        if (files.length >= limits.maxKept) {
          complete = false;
          break walk;
        }
        const abs = join(absDir, name);
        files.push({
          path: toManifestPath(realRoot, abs),
          abs,
          kind: isAudio ? kindOf(rel) : "cut",
          folder: relDir,
          size: stat.size,
          modified: stat.mtimeMs,
          duration: null,
        });
      }
    }
    level = next;
    depth++;
  }

  return { files, complete, examined };
}

/**
 * The words of a name: lower-cased, split on non-letters and camel case, with
 * a version word such as "v20" or "v20J" kept whole. Digits are not words.
 */
export function wordsOf(text: string): string[] {
  const words: string[] = [];
  // NFKD, then drop the accents: "Thème" and "Theme", NFC or NFD, read alike.
  const plain = text.normalize("NFKD").replace(/\p{M}/gu, "");
  for (const chunk of plain.split(/[^\p{L}\p{N}]+/u)) {
    if (chunk === "") continue;
    if (VERSION_WORD.test(chunk.toLowerCase())) {
      words.push(chunk.toLowerCase());
      continue;
    }
    for (const run of chunk.split(/[^\p{L}]+/u)) {
      if (run === "") continue;
      const parts = run
        .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
        .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
        .split(" ");
      for (const part of parts) if (part !== "") words.push(part.toLowerCase());
    }
  }
  return words;
}

function kindOfWord(word: string): FoundKind | null {
  if (VOICE_WORDS.has(word)) return "voice";
  if (MUSIC_WORDS.has(word)) return "music";
  if (SFX_WORDS.has(word)) return "sfx";
  return null;
}

function withoutExtension(path: string): string {
  const ext = extname(path);
  return ext === "" ? path : path.slice(0, -ext.length);
}

/**
 * The kind a path suggests, from the nearest folder name or file-name word
 * (§20.3). The file's own name is nearest, then its folder, then the folder
 * above. Video files are cuts; an audio file with no match is "other".
 */
export function kindOf(relPath: string): FoundKind {
  const normal = relPath.split("\\").join("/");
  if (VIDEO_EXT.has(extname(normal).toLowerCase())) return "cut";
  const parts = withoutExtension(normal).split("/");
  for (let i = parts.length - 1; i >= 0; i--) {
    for (const word of wordsOf(parts[i])) {
      const kind = kindOfWord(word);
      if (kind) return kind;
    }
  }
  return "other";
}

export interface Anchor {
  /** The cut's length in seconds, when known. */
  duration: number | null;
  /** The cut's modified time, ms since the epoch. */
  modified: number;
  /** The words of the cut's name. */
  words: string[];
}

export interface Scored {
  file: FoundFile;
  score: number;
  reasons: string[];
}

const HOUR = 3600e3;

/** "12 min", "3 hours": the nearest minute, or the nearest hour once it is an hour or more. */
function spanText(ms: number): string {
  const minutes = Math.round(ms / 60e3);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

function seconds(value: number): string {
  return `${value.toFixed(1)} s`;
}

/** §20.4's scoring table for one audio candidate. `commonWords` are the words most files share. */
export function scoreCandidate(file: FoundFile, anchor: Anchor, commonWords: Set<string>): Scored {
  let score = 0;
  const reasons: string[] = [];

  // Length. Sound effects are short passes, so they get none.
  const d = anchor.duration;
  let lengthScored = false;
  if (file.kind !== "sfx" && file.duration !== null && d !== null && d > 0) {
    const off = Math.abs(file.duration - d) / d;
    if (off <= 0.02) {
      score += 3;
      reasons.push(`same length as the cut (${seconds(file.duration)} vs ${seconds(d)})`);
      lengthScored = true;
    } else if (off <= 0.1) {
      score += 2;
      reasons.push("close to the cut's length");
      lengthScored = true;
    } else if (off <= 0.25) {
      score += 1;
      reasons.push("in the region of the cut's length");
      lengthScored = true;
    }
  }
  if (!lengthScored && file.duration !== null && file.duration < 15 && (file.kind === "voice" || file.kind === "other")) {
    reasons.push(`a short line (${Math.round(file.duration)} s)`);
  }

  // Made around the same time as the cut.
  const delta = file.modified - anchor.modified; // negative: made before the cut
  if (delta >= -6 * HOUR && delta <= 1 * HOUR) {
    score += 2;
    reasons.push(timeReason(delta));
  } else if (delta >= -24 * HOUR && delta < -6 * HOUR) {
    score += 1;
    reasons.push(timeReason(delta));
  }

  // Name words the file and the cut share, ignoring words every file has.
  const fileWords = new Set(wordsOf(withoutExtension(file.path)));
  const shared: string[] = [];
  for (const word of new Set(anchor.words)) {
    if (word.length < 2 || VERSION_WORD.test(word) || commonWords.has(word)) continue;
    if (fileWords.has(word)) shared.push(word);
  }
  if (shared.length > 0) {
    const used = shared.slice(0, 2);
    score += used.length;
    reasons.push(`name shares ${used.map((w) => `“${w}”`).join(" and ")}`);
  }

  // The same version word.
  // A version word every file carries tells the cuts nothing apart, so it weighs nothing.
  const version = anchor.words.find((w) => VERSION_WORD.test(w) && fileWords.has(w) && !commonWords.has(w));
  if (version) {
    score += 2;
    reasons.push(`same version (${version})`);
  }

  return { file, score, reasons };
}

function timeReason(delta: number): string {
  const abs = Math.abs(delta);
  if (Math.round(abs / 60e3) === 0) return "made at about the same time";
  return `made ${spanText(abs)} ${delta < 0 ? "before" : "after"} it`;
}

/** The words that appear in more than half of `files`' paths: they say nothing about one cut. */
export function commonWordsOf(files: FoundFile[]): Set<string> {
  const counts = new Map<string, number>();
  for (const file of files) {
    for (const word of new Set(wordsOf(withoutExtension(file.path)))) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const common = new Set<string>();
  for (const [word, count] of counts) if (count > files.length / 2) common.add(word);
  return common;
}

/** Per kind (voice, music, sfx), the top candidate only when score >= 4 and it beats the runner-up by >= 1. */
export function pickCurrentSet(scored: Scored[]): Partial<Record<"voice" | "music" | "sfx", Scored>> {
  const picked: Partial<Record<"voice" | "music" | "sfx", Scored>> = {};
  for (const kind of ["voice", "music", "sfx"] as const) {
    const ranked = scored
      .filter((s) => s.file.kind === kind)
      .sort((a, b) => b.score - a.score || (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0));
    const [top, runnerUp] = ranked;
    if (!top || top.score < 4) continue;
    if (runnerUp && top.score - runnerUp.score < 1) continue;
    picked[kind] = top;
  }
  return picked;
}
