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

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** 2.388 -> "2.39", 2.4 -> "2.4", 2 -> "2". */
const decimal = (n: number): string => String(Number(n.toFixed(2)));

/**
 * §21.3: the label for a picture `width` × `height` (its shape on screen). The nearest standard
 * ratio within 1%, otherwise the reduced fraction when both terms are 32 or less, otherwise a
 * decimal with the long side over the short (R13): "2.39:1", "1:2.39".
 */
export function ratioLabel(width: number, height: number): string {
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) {
    throw new RangeError(`Not a picture size: ${width}×${height}`);
  }
  const r = width / height;
  let best: readonly [number, number] | null = null;
  let bestErr = Infinity;
  for (const s of STANDARD_RATIOS) {
    const err = Math.abs(r - s[0] / s[1]) / (s[0] / s[1]);
    if (err < bestErr) {
      bestErr = err;
      best = s;
    }
  }
  if (best && bestErr <= 0.01 + 1e-12) return `${best[0]}:${best[1]}`;
  const w = Math.round(width);
  const h = Math.round(height);
  const g = gcd(w, h);
  if (w / g <= 32 && h / g <= 32) return `${w / g}:${h / g}`;
  return r >= 1 ? `${decimal(r)}:1` : `1:${decimal(1 / r)}`;
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

/**
 * §21.4's `label`, which is only a hint (R10): used when the measured ratio isn't a standard one and
 * the hint is within 2% of it. Otherwise the measured label stands, with a note saying why.
 */
export function settleLabel(width: number, height: number, hint?: string): { label: string; note: string | null } {
  const measured = ratioLabel(width, height);
  const given = hint?.trim() ?? "";
  if (given === "" || given === measured) return { label: measured, note: null };
  const v = ratioValue(given);
  if (v === null) return { label: measured, note: `"${given}" isn't a ratio like 2.39:1, so Rushes used the measured ${measured}.` };
  if (isStandard(measured)) return { label: measured, note: `The file measures ${measured}, a standard ratio, so the label "${given}" wasn't needed.` };
  const r = width / height;
  if (Math.abs(v - r) / r <= 0.02) return { label: given, note: null };
  return { label: measured, note: `The file measures ${measured}, too far from "${given}" to use it.` };
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
 * the formats as stored. Empty while the primary's size is unknown, unless `fallback` (the
 * player's measured size, R2) gives it.
 */
export function versionFormats(v: FormatSource, fallback?: { width: number; height: number } | null): FormatView[] {
  const width = v.width ?? fallback?.width ?? null;
  const height = v.height ?? fallback?.height ?? null;
  if (width === null || height === null) return [];
  const label = ratioLabel(width, height);
  const primary: FormatView = { id: ratioId(label), label, file: v.file, width, height, duration: v.duration, fps: v.fps, primary: true };
  return [
    primary,
    ...v.formats.map((f) => ({ id: f.id, label: f.label, file: f.file, width: f.width, height: f.height, duration: f.duration, fps: f.fps, primary: false })),
  ];
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
  if (note.format !== null) return labelOfId(note.format);
  const version = videos.find((v) => v.id === note.video)?.versions.find((v) => v.id === note.version);
  return version && versionFormats(version).length >= 2 ? "All" : null;
}
