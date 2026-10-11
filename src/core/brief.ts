import { createHash } from "node:crypto";

// §24 step 2: brief.md is the file of record for a film's brief. These are pure functions over its
// text: parse it into sections, replace one section's body, set the Status line. Everything else in
// the file (the preamble, other sections, the user's own formatting) is left exactly as it was.

/** The brief's file name, in the project folder's root. */
export const BRIEF_FILE = "brief.md";

export type BriefStatus = "draft" | "approved";

export interface BriefSection {
  /** The heading text after "## ", trimmed. */
  heading: string;
  /** Everything under the heading up to the next one, without leading or trailing blank lines. */
  body: string;
}

export interface ParsedBrief {
  /** The "# ..." title line without a leading "Brief: ", or "" when there is none. */
  title: string;
  /** The first `Status: draft|approved` line above the first section, or null. */
  status: BriefStatus | null;
  sections: BriefSection[];
}

/** `Status: approved`, and the same in bold or italics (`**Status:** approved`): an agent often writes the line that way. */
const STATUS_LINE = /^[*_]{0,2}Status[*_]{0,2}:[*_]{0,2}[ \t]*(draft|approved)[ \t]*$/i;

/** A short fingerprint of the file's text: what a page sends back to prove it saw the current file. */
export function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

interface Span {
  heading: string;
  /** Line index of the "## " line. */
  at: number;
  /** Line index one past the section's last line. */
  end: number;
}

/** The file's own line ending: CRLF when its first line break is one, else LF. */
const eolOf = (text: string): string => (/\r?\n/.exec(text)?.[0] === "\r\n" ? "\r\n" : "\n");

/** Lines of `text` (either line ending), and the "## " headings in them. A "## " inside a fenced code block is not a heading. */
function scan(text: string): { lines: string[]; spans: Span[] } {
  const lines = text.split(/\r?\n/);
  const spans: Span[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    const m = !fenced && /^## +(.+?) *$/.exec(line);
    if (m) {
      if (spans.length) spans[spans.length - 1].end = i;
      spans.push({ heading: m[1], at: i, end: lines.length });
    }
  });
  return { lines, spans };
}

const trimBlank = (ls: string[]): string[] => {
  let a = 0;
  let b = ls.length;
  while (a < b && ls[a].trim() === "") a++;
  while (b > a && ls[b - 1].trim() === "") b--;
  return ls.slice(a, b);
};

export function parseBrief(text: string): ParsedBrief {
  const { lines, spans } = scan(text);
  const preamble = lines.slice(0, spans.length ? spans[0].at : lines.length);
  const titleLine = preamble.map((l) => /^# +(.+?) *$/.exec(l)).find(Boolean);
  const title = titleLine ? titleLine[1].replace(/^Brief:[ \t]*/i, "") : "";
  const statusMatch = preamble.map((l) => STATUS_LINE.exec(l)).find(Boolean);
  const status = statusMatch ? (statusMatch[1].toLowerCase() as BriefStatus) : null;
  const sections = spans.map((s) => ({ heading: s.heading, body: trimBlank(lines.slice(s.at + 1, s.end)).join("\n") }));
  return { title, status, sections };
}

/**
 * `text` with the body of the section at `index` replaced by `body`. `heading` must be that section's
 * heading (so a file that was reordered under you is refused, not edited in the wrong place).
 * Spacing is kept: one blank line before the next heading, and a single newline at the end of the file.
 */
export function setSectionBody(text: string, index: number, heading: string, body: string): string {
  const { lines, spans } = scan(text);
  const span = spans[index];
  if (!span || span.heading !== heading) throw new Error(`No section "${heading}" at position ${index + 1}`);
  const next = trimBlank(body.replace(/\r\n/g, "\n").split("\n"));
  const isLast = index === spans.length - 1;
  const replacement = [...next, ...(isLast ? [] : [""])];
  const out = [...lines.slice(0, span.at + 1), ...replacement, ...lines.slice(span.end)];
  const eol = eolOf(text);
  return out.join(eol).replace(/(\r?\n)*$/, eol);
}

/** `text` with its `Status:` line set. With no such line, one is added under the title (or at the top). */
export function setStatus(text: string, status: BriefStatus): string {
  const { lines, spans } = scan(text);
  const limit = spans.length ? spans[0].at : lines.length;
  const at = lines.slice(0, limit).findIndex((l) => STATUS_LINE.test(l));
  if (at >= 0) {
    const out = [...lines];
    out[at] = `Status: ${status}`;
    return out.join(eolOf(text));
  }
  const title = lines.slice(0, limit).findIndex((l) => /^# /.test(l));
  const insertAt = title >= 0 ? title + 1 : 0;
  const out = [...lines.slice(0, insertAt), "", `Status: ${status}`, ...(title >= 0 ? [] : [""]), ...lines.slice(insertAt)];
  return out.join(eolOf(text));
}
