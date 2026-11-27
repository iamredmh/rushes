// §38.5: the script's own versions, separate from the cut's. Each time the agent writes a film's script and the words of a
// line changed (or a line came or went), the script as the agent wrote it is kept as the next version. The user's edits are
// not versions: they are proposals on the newest one. Pure: the server keeps the list in .rushes/script-versions.json.
import type { ScriptVersion, ScriptVersionLine, Section } from "./schema.js";

export type { ScriptVersion, ScriptVersionLine };

/** At most this many versions per film; the oldest go first. */
export const MAX_SCRIPT_VERSIONS = 50;

/** Where a film's versions are kept in the file: its id, or "_" for a script on no film. */
export const filmKey = (film: string | null | undefined): string => film ?? "_";

/** The script as the agent wrote it: each line's id, times and words (never the user's proposal). */
export function snapshotOf(sections: readonly Pick<Section, "id" | "start" | "end" | "current">[]): ScriptVersionLine[] {
  return sections.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.current }));
}

const words = (t: string) => t.trim().replace(/\s+/g, " ");
const sameWords = (a: ScriptVersionLine[], b: ScriptVersionLine[]) => a.length === b.length && a.every((l, i) => l.id === b[i].id && words(l.text) === words(b[i].text));
const numberOf = (id: string) => Number(/^v(\d+)$/.exec(id)?.[1] ?? 0);

/**
 * `list` with the script now kept, when its words differ from the newest version; the same list (the same array) when
 * they don't. `prior` is the script before this write: kept as v1 when there are no versions yet and it had lines.
 */
export function recordVersion(list: ScriptVersion[], sections: readonly Pick<Section, "id" | "start" | "end" | "current">[], at: string, prior?: readonly Pick<Section, "id" | "start" | "end" | "current">[]): ScriptVersion[] {
  let out = list;
  let top = list.reduce((m, v) => Math.max(m, numberOf(v.id)), 0);
  if (out.length === 0 && prior && prior.length > 0) {
    top += 1;
    out = [{ id: `v${top}`, at, lines: snapshotOf(prior) }];
  }
  const next = snapshotOf(sections);
  if (next.length === 0) return out;
  const last = out[out.length - 1];
  if (last && sameWords(last.lines, next)) return out;
  out = [...out, { id: `v${top + 1}`, at, lines: next }];
  return out.length > MAX_SCRIPT_VERSIONS ? out.slice(out.length - MAX_SCRIPT_VERSIONS) : out;
}

/**
 * The versions to show: those kept, or, for a script the agent wrote before versions were kept, the script as it is now
 * as v1 (not written: the next write of the agent's keeps it).
 */
export function shownVersions(kept: ScriptVersion[], sections: readonly Pick<Section, "id" | "start" | "end" | "current">[]): ScriptVersion[] {
  if (kept.length > 0 || sections.length === 0) return kept;
  return [{ id: "v1", at: "", lines: snapshotOf(sections) }];
}
