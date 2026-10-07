// §22.4 and §22.8: the version list's helpers. Pure, so they're unit-tested in Node. shortLabel comes
// from src/core/labels.ts, which has no imports at all, so nothing from the server reaches the bundle.
import { shortLabel, type Labelled } from "../../src/core/labels.js";
export { LABEL_MAX, shortLabel, type Labelled } from "../../src/core/labels.js";

/** Assets › Cuts (§22.4): a cut's subtitle is its short label. A cut with no label and no note has none, because its file name is already shown. */
export function cutSubtitle(v: Labelled | undefined): string | null {
  if (!v || !((v.label ?? "").trim() || v.note.trim())) return null;
  return shortLabel(v);
}
