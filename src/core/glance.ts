// §38.3: the brief's At a glance card. Pure, with no Node imports, so the dashboard uses it directly.
//
// The agent writes `## At a glance` as `- Label: value` lines (`- Ask: …`, `- Length: …`). A brief without one gets a
// card made from its other sections (the first sentence of each), which is shown, never written to the file.

export const GLANCE_HEADING = "At a glance";

export interface GlanceItem {
  /** "Ask", "Must"…; null for a line that is not `Label: value`. */
  label: string | null;
  values: string[];
}

/** A label is short: one to four words before the colon, no sentence. */
const LABELLED = /^(?:\*\*|__)?([A-Za-z][\w &/'’-]{0,30}?)(?::(?:\*\*|__)|(?:\*\*|__)?:)[ \t]+(.+)$/;

const stripMarker = (line: string): string => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();

/** The At a glance section's lines, a label's values together in the order the labels first appear. */
export function parseGlance(body: string): GlanceItem[] {
  const out: GlanceItem[] = [];
  const byLabel = new Map<string, GlanceItem>();
  for (const raw of body.split(/\r?\n/)) {
    const line = stripMarker(raw);
    if (!line) continue;
    const m = LABELLED.exec(line);
    if (m && m[1].trim().split(/\s+/).length <= 4) {
      const label = m[1].trim();
      const key = label.toLowerCase();
      const value = m[2].trim();
      const had = byLabel.get(key);
      if (had) had.values.push(value);
      else {
        const item = { label, values: [value] };
        byLabel.set(key, item);
        out.push(item);
      }
    } else {
      out.push({ label: null, values: [line] });
    }
  }
  return out;
}

/** Where the At a glance section is among the brief's sections, or -1. */
export function glanceIndex(sections: readonly { heading: string }[]): number {
  return sections.findIndex((s) => s.heading.trim().toLowerCase() === GLANCE_HEADING.toLowerCase());
}

const MAX_SENTENCE = 200;

/** The first prose line of a body: not inside a code fence, list markers and Markdown emphasis taken off. */
function firstProse(body: string): string {
  let fenced = false;
  for (const raw of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const line = stripMarker(raw.replace(/^#+\s+/, "").replace(/^>\s?/, ""))
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(\*|_)(.+?)\1/g, "$2")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .trim();
    if (line) return line;
  }
  return "";
}

/** With no At a glance section: the first sentence of each of the first five other sections that have one. */
export function glanceFallback(sections: readonly { heading: string; body: string }[]): { heading: string; sentence: string }[] {
  const out: { heading: string; sentence: string }[] = [];
  for (const s of sections) {
    if (out.length === 5) break;
    if (s.heading.trim().toLowerCase() === GLANCE_HEADING.toLowerCase()) continue;
    const line = firstProse(s.body);
    if (!line) continue;
    const m = /^.+?[.!?](?=\s|$)/.exec(line);
    let sentence = m ? m[0] : line;
    if (sentence.length > MAX_SENTENCE) sentence = `${sentence.slice(0, MAX_SENTENCE - 1).replace(/\s+\S*$/, "")}…`;
    out.push({ heading: s.heading, sentence });
  }
  return out;
}
