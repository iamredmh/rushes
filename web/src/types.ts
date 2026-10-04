// The server's data types, re-exported for the dashboard. Type-only, so nothing from src/ is bundled.
export type { Batch, Cue, Lane, LaneStage, Mark, Note, Picks, Proxy, Script, Section, Shot, Stage, Take, Variant } from "../../src/core/schema.js";
export type { LoudnessResult } from "../../src/server/loudness.js";
export type { TabState } from "../../src/core/tabs.js";
export type { Asset, AssetKind } from "../../src/server/assets.js";
export type { ProxyEvent, ProxyJob } from "../../src/server/proxy.js";

import type { BatchesFile, NotesFile, Picks, Project as StoredProject, Script, Version as StoredVersion, Video as StoredVideo } from "../../src/core/schema.js";
import type { TabState } from "../../src/core/tabs.js";
import type { ProxyJob } from "../../src/server/proxy.js";

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
}
