// The server's data types, re-exported for the dashboard. Type-only, so nothing from src/ is bundled.
export type { Batch, Note, Picks, Project, Script, Section, Shot, Stage, Take, Variant, Version, Video } from "../../src/core/schema.js";
export type { TabState } from "../../src/core/tabs.js";
export type { Asset, AssetKind } from "../../src/server/assets.js";

import type { BatchesFile, NotesFile, Picks, Project, Script } from "../../src/core/schema.js";
import type { TabState } from "../../src/core/tabs.js";

/** GET /api/state */
export interface State {
  project: Project;
  script: Script;
  notes: NotesFile;
  picks: Picks;
  batches: BatchesFile;
  tabs: TabState[];
}
