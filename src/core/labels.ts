// §22.4: a cut's short label, and the one-line clipping the Change Log shares. Pure and import-free,
// because the dashboard bundles this file: nothing here may pull zod or Node in, and no lookbehind
// (Safari before 16.4 can't parse one). test/core/labels.test.ts checks both, and that every
// invisible character below is written as an escape.

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
// Code points that belong to the character before them: combining marks, the zero-width joiner
// (U+200D), variation selectors (U+FE0F), skin-tone modifiers and tag characters.
const EXTENDS = /^[\p{M}\u200d\ufe0f\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]$/u;
const REGIONAL = /^[\u{1F1E6}-\u{1F1FF}]$/u;
// A surrogate that has no partner: a paired one is a single code point under the u flag.
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu;
// Control characters, including the C1 ones (U+0085), and the line and paragraph separators.
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
// Format characters (bidi overrides, zero-width spaces, the word joiner, the byte-order mark) go,
// except the two joiners (U+200C, U+200D) and the tag characters, which emoji sequences need.
const INVISIBLE = /(?![\u200c\u200d\u{E0000}-\u{E007F}])\p{Cf}/gu;
// Tag characters mean something only straight after the black flag (U+1F3F4), where they spell a
// region ("England"). Anywhere else they're invisible text, so they go; a run after the flag stays.
const TAGS = /(\u{1F3F4})([\u{E0000}-\u{E007F}]*)|[\u{E0000}-\u{E007F}]+/gu;
// Text made only of these shows nothing: format characters, spaces, and the characters that draw as
// a blank (the combining grapheme joiner, the Hangul fillers, the Khmer inherent vowels, the braille blank).
const NOTHING_VISIBLE = /^[\p{Cf}\s\u034f\u115f\u1160\u17b4\u17b5\u2800\u3164\uffa0]*$/u;

/**
 * One clean line: a lone surrogate becomes U+FFFD, control characters and every run of whitespace
 * become one space, bidi and zero-width characters go, and the ends are trimmed. Text with nothing
 * visible in it comes back empty.
 */
export function oneLineOf(text: string): string {
  const line = text
    .replace(LONE_SURROGATE, "\uFFFD")
    .replace(BREAKS, " ")
    .replace(INVISIBLE, "")
    .replace(TAGS, (_all, flag?: string, tags?: string) => (flag ? flag + tags : ""))
    .replace(/\s+/g, " ")
    .trim();
  return NOTHING_VISIBLE.test(line) ? "" : line;
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
    joined = p === "\u200d";
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
  // One character with no room for it (a base under hundreds of marks): keep its base. Marks with
  // no base at all still come back as a bare ellipsis, which callers treat as nothing to show.
  const base = chars.length > 0 ? Array.from(chars[0])[0] : "";
  if (head.length === 0 && max > 1 && base && !EXTENDS.test(base)) return base + "…";
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
const CLAUSE_MIN = 12;

/** How many UTF-16 units the first `n` code points of `text` take up. */
function unitsOfFirst(text: string, n: number): number {
  let units = 0;
  let seen = 0;
  for (const ch of text) {
    if (seen++ >= n) break;
    units += ch.length;
  }
  return units;
}

// `skipped` is how many code points were stripped from the note's start (a "v6: " or a
// "(batch b_1): "): the 12 count from the note as written, so "v1: first pass; rough" still ends at
// "first pass".
function firstClause(text: string, skipped: number): string {
  const from = unitsOfFirst(text, Math.max(0, CLAUSE_MIN - skipped));
  let end = text.length;
  for (const sep of CLAUSE_ENDS) {
    const i = text.indexOf(sep, from);
    if (i >= 0 && i < end) end = i;
  }
  return text.slice(0, end).trim();
}

/** The file's name without its folder or extension, on one line: "renders/lumen_v6.mp4" gives "lumen_v6". */
function fileStem(file: string): string {
  const name = file.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return oneLineOf(dot > 0 ? name.slice(0, dot) : name);
}

// A leading "v6" is this cut's own id when it's followed by ":", ",", a dash, a full stop and a
// space, the end, or a "(batch …)": "v6.5 slower" and "v60: x" are not.
// Built once per version number: a backfill reads thousands of cuts (Task 3 review, minor 7).
const LEADING_IDS = new Map<string, RegExp>();
function leadingId(digits: string): RegExp {
  const n = digits.replace(/^0+/, "") || "0";
  let re = LEADING_IDS.get(n);
  if (!re) {
    if (LEADING_IDS.size >= 2000) LEADING_IDS.clear();
    re = buildLeadingId(n);
    LEADING_IDS.set(n, re);
  }
  return re;
}
function buildLeadingId(n: string): RegExp {
  return new RegExp(`^v0*${n}(?![\\p{L}\\p{N}])(?:(?:\\s*[:,\\-–—]|\\.(?=\\s|$))[\\s:,.\\-–—]*|\\s*$|\\s+(?=\\(batch\\b))`, "iu");
}

// Something to show: not empty, and not a bare ellipsis left by a cut that had nothing before it.
const usable = (s: string): boolean => s !== "" && s !== "…";

/**
 * §22.4: the version's own label when it has one. Otherwise its note's first clause, without a
 * leading "v6:" that repeats the id or a "(batch b_1):". Otherwise the file's name, then the id.
 * Always one line, never over LABEL_MAX characters, never empty.
 */
export function shortLabel(v: Labelled): string {
  const own = clip(oneLineOf(v.label ?? ""), LABEL_MAX);
  if (usable(own)) return own;
  const note = oneLineOf(v.note ?? "");
  let text = note;
  const n = /^v(\d+)$/i.exec(v.id)?.[1];
  if (n !== undefined) text = text.replace(leadingId(n), "");
  text = text.replace(/^\(batch\b[^)]*\)\s*:?\s*/i, "");
  const skipped = Array.from(note.slice(0, note.length - text.length)).length;
  text = firstClause(text, skipped);
  if (WORD.test(text)) {
    const fromNote = clip(text, LABEL_MAX);
    if (usable(fromNote)) return fromNote;
  }
  const stem = clip(fileStem(v.file), LABEL_MAX);
  if (usable(stem)) return stem;
  const id = clip(oneLineOf(v.id), LABEL_MAX);
  return usable(id) ? id : "Untitled";
}
