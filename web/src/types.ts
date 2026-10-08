// The server's data types, re-exported for the dashboard. Type-only, so nothing from src/ is bundled.
export type { Batch, Cue, Lane, LaneStage, Mark, Note, Picks, Proxy, Script, Section, Shot, Stage, Take, Variant } from "../../src/core/schema.js";
export type { LoudnessResult } from "../../src/server/loudness.js";
export type { TabState } from "../../src/core/tabs.js";
export type { Asset, AssetKind } from "../../src/server/assets.js";
export type { ProxyEvent, ProxyJob } from "../../src/server/proxy.js";
export type { FoundCounts, FoundSummary } from "../../src/server/found.js";
export type { FoundKind } from "../../src/core/found.js";
export type { LogLine, UndatedLine } from "../../src/core/logText.js";
export type { LogView } from "../../src/core/log.js";
export type { LogHead } from "../../src/server/logbook.js";

import type { BatchesFile, NotesFile, Picks, Project as StoredProject, Script, Version as StoredVersion, Video as StoredVideo } from "../../src/core/schema.js";
import type { TabState } from "../../src/core/tabs.js";
import type { ProxyJob } from "../../src/server/proxy.js";
import type { FoundKind } from "../../src/core/found.js";
import type { FoundSummary } from "../../src/server/found.js";
import type { LogHead } from "../../src/server/logbook.js";

/** A cut as GET /api/state sends it: the stored version plus §19.5's `proxyNeed`, why it may play
 *  badly (e.g. "It's a 4K ProRes file (2.3 GB), which browsers struggle with"), or null. Optional
 *  only so a test can build a version by hand; the server always sends it. */
export type Version = StoredVersion & { proxyNeed?: string | null };
export type Video = Omit<StoredVideo, "versions"> & { versions: Version[] };
export type Project = Omit<StoredProject, "videos"> & { videos: Video[] };

/** GET /api/state */
export interface State {
  project: Project;
  script: Script;
  notes: NotesFile;
  picks: Picks;
  batches: BatchesFile;
  tabs: TabState[];
  /** §19.5: whether the server has ffmpeg and ffprobe, and the proxy jobs running right now. */
  proxies: { ffmpeg: boolean; jobs: ProxyJob[] };
  /** §20.6: what the last scan of the folder left, and what has been brought in this session. */
  found: FoundSummary;
  /** §22.8: the Change Log's newest line and size, for the header button's dot (null if it couldn't be read). */
  log?: LogHead | null;
}

/** One file in GET /api/found (§20.6): a candidate, or a hidden one (the server's `abs` stays on the server). */
export interface FoundItem {
  /** Manifest path, relative to the project folder. */
  path: string;
  kind: FoundKind;
  folder: string;
  size: number;
  /** Milliseconds since the epoch. */
  modified: number;
  duration: number | null;
  score: number | null;
  reasons: string[];
  suggested: boolean;
}

/** A hidden file in GET /api/found: the same facts, none of the scoring. */
export type HiddenItem = Pick<FoundItem, "path" | "kind" | "folder" | "size" | "modified" | "duration">;

/** What POST /api/found/bring-in answers. */
export interface BringInResult {
  added: { path: string; kind: string }[];
  /** `code` names the refusal (see BringInCode on the server); the words are for the user. */
  failed: { path: string; reason: string; code: string }[];
}
