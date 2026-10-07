// §21: a cut's formats -- the same edit rendered at other aspect ratios. Pure, and with type
// imports only, because the dashboard imports this file too: nothing here may pull zod or Node
// into the web bundle (test/core/formats.test.ts checks it).
import type { Note, Version } from "./schema.js";

/** §21.3's standard ratios, as [width, height]. */
export const STANDARD_RATIOS: readonly (readonly [number, number])[] = [
  [1, 1], [4, 5], [5, 4], [4, 3], [3, 4], [3, 2], [2, 3], [16, 9], [9, 16], [21, 9], [9, 21],
];

/** A format id: the label with ":" as "x", e.g. "9x16", "2.39x1", "10x7". */
export const FORMAT_ID_RE = /^\d+(?:\.\d+)?x\d+(?:\.\d+)?$/;

/** The most shapes one cut can have, the primary included (ruling R3). */
export const MAX_FORMATS = 8;

/** The order the chips always take (§21.5), so a chip never moves between projects. */
export const CHIP_ORDER: readonly string[] = ["9x16", "4x5", "1x1", "4x3", "16x9"];

/** The largest side, in pixels, that counts as a picture size (a guard against nonsense, not a codec limit). */
export const MAX_PICTURE_SIDE = 100000;

/** A picture size: two whole numbers, each from 1 to MAX_PICTURE_SIDE. */
export function isPictureSize(width: number, height: number): boolean {
  return [width, height].every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_PICTURE_SIDE);
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** 2.388 -> "2.39", 2.4 -> "2.4", 2 -> "2". */
const decimal = (n: number): string => String(Number(n.toFixed(2)));

/** R13: the long side over the short, to two decimals: "2.39:1", "1:2.39". */
const decimalLabel = (r: number): string => (r >= 1 ? `${decimal(r)}:1` : `1:${decimal(1 / r)}`);

/** 1% as a log ratio: |ln(a/b)| is the same for a landscape picture and its portrait twin. */
const SNAP = Math.log(1.01) + 1e-12;

/** The standard ratio nearest `r`, and how far off it is: |ln(r / standard)|, so 16:9 and 9:16 mirror. */
function nearestStandard(r: number): { best: readonly [number, number] | null; err: number } {
  let best: readonly [number, number] | null = null;
  let err = Infinity;
  for (const s of STANDARD_RATIOS) {
    const e = Math.abs(Math.log(r / (s[0] / s[1])));
    if (e < err) {
      err = e;
      best = s;
    }
  }
  return { best, err };
}

/**
 * §21.3: the label for a picture `width` × `height` (its shape on screen). The nearest standard
 * ratio within 1%, otherwise the reduced fraction when both terms are 32 or less, otherwise a
 * decimal with the long side over the short (R13): "2.39:1", "1:2.39".
 */
export function ratioLabel(width: number, height: number): string {
  if (!isPictureSize(width, height)) throw new RangeError(`Not a picture size: ${width}×${height}`);
  const r = width / height;
  const { best, err } = nearestStandard(r);
  if (best && err <= SNAP) return `${best[0]}:${best[1]}`;
  const g = gcd(width, height);
  if (width / g <= 32 && height / g <= 32) return `${width / g}:${height / g}`;
  // The long side over the short, worked out the same way for a picture and its portrait twin.
  return width >= height ? `${decimal(width / height)}:1` : `1:${decimal(height / width)}`;
}

export const ratioId = (label: string): string => label.replace(":", "x");
export const labelOfId = (id: string): string => id.replace("x", ":");

/** "9:16" -> 0.5625; null for anything that isn't "a:b" with both terms above 0. */
export function ratioValue(label: string): number | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(label.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > 0 && b > 0 ? a / b : null;
}

const isStandard = (label: string): boolean => STANDARD_RATIOS.some(([a, b]) => `${a}:${b}` === label);

/** The longest a label can be (it becomes a format id, which the schema caps at 16 characters). */
const MAX_LABEL = 16;

/**
 * §21.4's `label`, which is only a hint (R10). It is used only when the measured ratio isn't a
 * standard one, the hint isn't itself within 1% of a standard ratio (that would be §21.3's job, and
 * a render can't be labelled as a ratio it isn't), and the hint is within 2% of the measured shape.
 * A hint that is used is rewritten into the canonical R13 form ("12:5", "2.40:1" and "2.4:1.0"
 * all become "2.4:1"), so two spellings can never make two ids for one shape. Otherwise the
 * measured label stands, with a note saying why.
 */
export function settleLabel(width: number, height: number, hint?: string): { label: string; note: string | null } {
  const measured = ratioLabel(width, height);
  const given = hint?.trim() ?? "";
  if (given === "" || given === measured) return { label: measured, note: null };
  if (given.length > MAX_LABEL) return { label: measured, note: `The label is too long to be a ratio, so Rushes used the measured ${measured}.` };
  const v = ratioValue(given);
  if (v === null) return { label: measured, note: `"${given}" isn't a ratio like 2.39:1, so Rushes used the measured ${measured}.` };
  if (isStandard(measured)) return { label: measured, note: `The file measures ${measured}, a standard ratio, so the label "${given}" wasn't needed.` };
  const standard = nearestStandard(v);
  if (standard.best && standard.err <= SNAP) {
    return { label: measured, note: `"${given}" is a standard ratio, and the file isn't one, so Rushes used the measured ${measured}.` };
  }
  const r = width / height;
  if (Math.abs(Math.log(v / r)) > Math.log(1.02)) return { label: measured, note: `The file measures ${measured}, too far from "${given}" to use it.` };
  const canonical = decimalLabel(v);
  return { label: canonical, note: canonical === given ? null : `Rushes wrote the label "${given}" as ${canonical}.` };
}

/** §21.5: 9:16, 4:5, 1:1, 4:3, 16:9, then anything else from narrow to wide (width over height). */
export function chipOrder<T extends { id: string; width: number; height: number }>(list: readonly T[]): T[] {
  const rank = (f: T): number => {
    const i = CHIP_ORDER.indexOf(f.id);
    return i === -1 ? CHIP_ORDER.length : i;
  };
  return [...list].sort((a, b) => rank(a) - rank(b) || a.width / a.height - b.width / b.height || a.id.localeCompare(b.id));
}

/** One shape of a cut, the primary included. */
export interface FormatView {
  id: string;
  label: string;
  file: string;
  width: number;
  height: number;
  duration: number | null;
  fps: number | null;
  primary: boolean;
}

export type FormatSource = Pick<Version, "file" | "width" | "height" | "duration" | "fps" | "formats">;

/**
 * A version's shapes: the primary first (§21.2 (2): its ratio is read from its own size), then
 * the formats as stored. While the primary's size is unknown the primary is left out (never
 * guessed), unless `fallback` (the player's measured size, R2) gives it; the listed formats stay.
 */
export function versionFormats(v: FormatSource, fallback?: { width: number; height: number } | null): FormatView[] {
  const stored = v.width !== null && v.height !== null && isPictureSize(v.width, v.height) ? { width: v.width, height: v.height } : null;
  const size = stored ?? (fallback && isPictureSize(fallback.width, fallback.height) ? fallback : null);
  const rest: FormatView[] = v.formats.map((f) => ({ id: f.id, label: f.label, file: f.file, width: f.width, height: f.height, duration: f.duration, fps: f.fps, primary: false }));
  if (!size) return rest;
  const label = ratioLabel(size.width, size.height);
  return [{ id: ratioId(label), label, file: v.file, width: size.width, height: size.height, duration: v.duration, fps: v.fps, primary: true }, ...rest];
}

/** §21.3: "9:16 is 8.4 s; the cut is 8.0 s" when a format's length is more than 0.1 s off the cut's. */
export function durationWarning(label: string, formatDuration: number | null, cutDuration: number | null): string | null {
  if (formatDuration === null || cutDuration === null) return null;
  if (Math.abs(formatDuration - cutDuration) <= 0.1 + 1e-9) return null;
  return `${label} is ${formatDuration.toFixed(1)} s; the cut is ${cutDuration.toFixed(1)} s`;
}

/** §21.2 (5): does `note` show while `current` is on screen? `current` is null on a one-format cut. */
export function noteShowsOn(note: Pick<Note, "format">, current: string | null): boolean {
  return current === null || note.format === null || note.format === current;
}

/**
 * The tag a Picture note carries in export, the CLI and the list (R4): its format's label, "All"
 * on a cut with two or more formats, otherwise null (a one-format cut reads as it always did).
 */
export function formatTag(
  note: Pick<Note, "stage" | "video" | "version" | "format">,
  videos: readonly { id: string; versions: readonly (FormatSource & { id: string })[] }[],
): string | null {
  if (note.stage !== "picture") return null;
  // Null-safe: the CLI and agents read data from a 0.2.x server too, whose notes have no `format` and
  // whose versions have no `formats` (review I1).
  if (note.format != null) return labelOfId(note.format);
  const version = videos.find((v) => v.id === note.video)?.versions.find((v) => v.id === note.version);
  // Any listed format means two or more shapes, whether or not the primary's size is known.
  return (version?.formats?.length ?? 0) >= 1 ? "All" : null;
}
