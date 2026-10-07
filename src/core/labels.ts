// §22.4: a cut's short label, and the one-line clipping the Change Log shares. Pure and import-free,
// because the dashboard bundles this file: nothing here may pull zod or Node in, and no lookbehind
// (Safari before 16.4 can't parse one). test/core/labels.test.ts checks both.

/** A version's short label is at most this long (§22.3). */
export const LABEL_MAX = 48;

/** What shortLabel reads: a version as stored. `label` is optional, so a 0.2.x shape works too. */
export interface Labelled {
  id: string;
  note: string;
  file: string;
  label?: string;
}

const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
const JOINER = /[_\-/]/;
// Left at the end of a cut, these read as a broken sentence, so they go before the ellipsis.
const TRAILING = /[\s,;:.\-–—(_/]+$/u;
// Code points that belong to the character before them: combining marks, the joiner, variation
// selectors, skin-tone modifiers and tag characters.
const EXTENDS = /^[\p{M}‍️\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]$/u;
const REGIONAL = /^[\u{1F1E6}-\u{1F1FF}]$/u;

/** Control characters and every run of whitespace become one space; the ends are trimmed. */
export function oneLineOf(text: string): string {
  // eslint-disable-next-line no-control-regex -- the point is to match control characters.
  return text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Code points grouped into what a reader sees as one character: an emoji sequence, a letter and its accents, a flag. */
function characters(points: string[]): string[] {
  const out: string[] = [];
  let joined = false; // the last code point was a zero-width joiner: the next one belongs to it
  let regionals = 0; // regional indicators in the last cluster (a flag is a pair)
  for (const p of points) {
    const last = out.length - 1;
    if (last >= 0 && (joined || EXTENDS.test(p) || (REGIONAL.test(p) && regionals === 1))) {
      out[last] += p;
      regionals = REGIONAL.test(p) ? regionals + 1 : regionals;
    } else {
      out.push(p);
      regionals = REGIONAL.test(p) ? 1 : 0;
    }
    joined = p === "‍";
  }
  return out;
}

function lastIndex(chars: string[], re: RegExp): number {
  for (let i = chars.length - 1; i > 0; i--) if (re.test(chars[i])) return i;
  return -1;
}

/**
 * `text`, at most `max` characters. They're counted as code points, and a cut never falls inside
 * an emoji sequence or between a letter and its accents. The cut falls at the last word boundary
 * that leaves room for "…" (§22.4 (4)). A boundary is a space; in a name with none (a file name),
 * an underscore, a hyphen or a slash. Only a single unbroken word is cut inside it.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const points = Array.from(text);
  if (points.length <= max) return text;
  // Only the start matters, so a very long note isn't grouped all the way down.
  const chars = characters(points.slice(0, max + 32));
  const head: string[] = [];
  let used = 0;
  for (const c of chars) {
    const n = Array.from(c).length;
    if (used + n > max - 1) break;
    head.push(c);
    used += n;
  }
  let cut = head.length;
  const next = chars[head.length];
  if (next !== undefined && !SPACE.test(next)) {
    let at = lastIndex(head, SPACE);
    if (at <= 0) at = lastIndex(head, JOINER);
    if (at > 0) cut = at;
  }
  return head.slice(0, cut).join("").replace(TRAILING, "") + "…";
}

/** One line, clipped: how every Change Log line is stored (§22.3: 160 characters at most). */
export function oneLine(text: string, max: number): string {
  return clip(oneLineOf(text), max);
}

// §22.4 (3): a note's first clause ends at the first of these that comes after its first 12 characters.
const CLAUSE_ENDS = [";", ". ", " — ", " ("];

// `skipped` is how much of the note's start was stripped (a "v6: " or "(batch b_1): "): the 12
// characters count from the note as written, so "v1: first pass; rough" still ends at "first pass".
function firstClause(text: string, skipped: number): string {
  let end = text.length;
  for (const sep of CLAUSE_ENDS) {
    const i = text.indexOf(sep, Math.max(0, 12 - skipped));
    if (i >= 0 && i < end) end = i;
  }
  return text.slice(0, end).trim();
}

/** The file's name without its folder or extension: "renders/lumen_v6.mp4" gives "lumen_v6". */
function fileStem(file: string): string {
  const name = file.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * §22.4: the version's own label when it has one. Otherwise its note's first clause, without a
 * leading "v6:" that repeats the id or a "(batch b_1):". Otherwise the file's name. Always one
 * line, never over LABEL_MAX characters.
 */
export function shortLabel(v: Labelled): string {
  const own = oneLineOf(v.label ?? "");
  if (own) return clip(own, LABEL_MAX);
  const note = oneLineOf(v.note ?? "");
  let text = note;
  const n = /^v(\d+)$/i.exec(v.id)?.[1];
  if (n !== undefined) text = text.replace(new RegExp(`^v0*${Number(n)}(?![\\p{L}\\p{N}])[\\s:,.\\-–—]*`, "iu"), "");
  text = text.replace(/^\(batch[^)]*\)\s*:?\s*/i, "");
  text = firstClause(text, note.length - text.length);
  if (WORD.test(text)) return clip(text, LABEL_MAX);
  return clip(fileStem(v.file), LABEL_MAX) || v.id;
}
