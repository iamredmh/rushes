// §22.4 and §22.8: the version list's helpers. Pure, so they're unit-tested in Node. shortLabel comes
// from src/core/labels.ts, which has no imports at all, so nothing from the server reaches the bundle.
import { shortLabel, type Labelled } from "../../src/core/labels.js";
import { dayDiff } from "../../src/core/logText.js";
export { LABEL_MAX, oneLineOf, shortLabel, type Labelled } from "../../src/core/labels.js";
// The calendar-day rule lives with the Change Log's words (logText.ts imports only labels.ts), so
// "yesterday" here and the log's "Yesterday" heading can never disagree.
export { dayDiff } from "../../src/core/logText.js";

/** Assets › Cuts (§22.4): a cut's subtitle is its short label. A cut with no label and no note has none, because its file name is already shown. */
export function cutSubtitle(v: Labelled | undefined): string | null {
  if (!v || !((v.label ?? "").trim() || v.note.trim())) return null;
  return shortLabel(v);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

type Ago = { just: true } | { n: number; unit: "minute" | "hour" | "day" } | { yesterday: true } | { date: Date };

function agoOf(iso: string, now: Date): Ago | null {
  const days = dayDiff(iso, now);
  if (days === null) return null;
  const s = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000);
  if (s < 60) return { just: true };
  if (s < 3600) return { n: Math.floor(s / 60), unit: "minute" };
  if (days <= 0) return { n: Math.floor(s / 3600), unit: "hour" };
  if (days === 1) return { yesterday: true };
  if (days < 7) return { n: days, unit: "day" };
  return { date: new Date(Date.parse(iso)) };
}

function words(a: Ago | null, now: Date, short: boolean): string {
  if (!a) return "";
  if ("just" in a) return "just now";
  if ("yesterday" in a) return "yesterday";
  if ("date" in a) {
    const d = a.date;
    const month = short ? MONTHS[d.getMonth()].slice(0, 3) : MONTHS[d.getMonth()];
    return `${d.getDate()} ${month}${d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`}`;
  }
  if (a.unit === "day") return `${a.n} days ago`;
  if (short) return `${a.n} ${a.unit === "minute" ? "min" : "h"} ago`;
  return `${a.n} ${a.unit}${a.n === 1 ? "" : "s"} ago`;
}

/** R22: "just now", "12 min ago", "2 h ago", "yesterday" (the previous calendar day), "3 days ago", then "5 Oct" (and the year when it isn't this one). */
export function ago(iso: string, now: Date): string {
  return words(agoOf(iso, now), now, true);
}

/** `ago` in full words, for a screen reader: "2 hours ago", "12 minutes ago", "5 October". */
export function agoSpoken(iso: string, now: Date): string {
  return words(agoOf(iso, now), now, false);
}

/** §22.8's type-ahead on the version number: the exact number first, then the newest whose number starts with what was typed. */
export function typeAhead(ids: readonly string[], typed: string): string | null {
  const num = (id: string) => id.replace(/^v/i, "");
  return ids.find((id) => num(id) === typed) ?? ids.find((id) => num(id).startsWith(typed)) ?? null;
}

/** Where a key moves the active item in a list of `count` (§22.8): arrows wrap, Home and End jump. Left and right count only when `horizontal`. Null for any other key. */
export function moveActive(key: string, index: number, count: number, horizontal = false): number | null {
  if (count <= 0) return null;
  const next = key === "ArrowDown" || (horizontal && key === "ArrowRight");
  const prev = key === "ArrowUp" || (horizontal && key === "ArrowLeft");
  if (next) return index < 0 ? 0 : (index + 1) % count;
  if (prev) return index < 0 ? count - 1 : (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** The detail panel's last line (§22.8): "39.7 s · 11 shots · 2 h ago". */
export function versionMeta(v: { duration: number | null; shots: readonly unknown[]; addedAt: string }, now: Date): string {
  const parts: string[] = [];
  if (v.duration !== null) parts.push(`${v.duration.toFixed(1)} s`);
  parts.push(v.shots.length === 0 ? "no shots" : `${v.shots.length} shot${v.shots.length === 1 ? "" : "s"}`);
  const when = ago(v.addedAt, now);
  if (when) parts.push(when);
  return parts.join(" · ");
}

/**
 * A cut's note, laid out to read (Red, 16 Nov: the Cut menu's note was one wall of text). The first sentence is the lead;
 * the rest are points, one a sentence. A note the agent already wrote as a list ("- ", "* ", "• " or "1. " lines) keeps its
 * own points, with what comes before them as the lead. A point that opens with a short name and a colon ("Workload: the
 * camera ...") has that name as its `head`.
 */
export interface NotePoint {
  head: string | null;
  text: string;
}
export function notePoints(note: string): { lead: string; points: NotePoint[] } {
  const text = note.trim();
  if (!text) return { lead: "", points: [] };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bullet = /^(?:[-*•]|\d+[.)])\s+/;
  let lead: string;
  let items: string[];
  if (lines.some((l) => bullet.test(l))) {
    const first = lines.findIndex((l) => bullet.test(l));
    lead = lines.slice(0, first).join(" ");
    items = [];
    for (const l of lines.slice(first)) {
      if (bullet.test(l)) items.push(l.replace(bullet, ""));
      else if (items.length) items[items.length - 1] += ` ${l}`;
    }
  } else {
    const sentences = splitSentences(lines.join(" "));
    lead = sentences[0] ?? "";
    items = sentences.slice(1);
  }
  return {
    lead,
    points: items.map((s) => {
      const m = /^([^:.()]{1,28}):\s+(.+)$/s.exec(s);
      return m ? { head: m[1], text: m[2] } : { head: null, text: s };
    }),
  };
}

/** Sentences: a break after ., ! or ? and a space, outside brackets, before a capital, a digit or a quote. */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[") depth++;
    else if ((c === ")" || c === "]") && depth > 0) depth--;
    else if ((c === "." || c === "!" || c === "?") && depth === 0 && text[i + 1] === " " && /["'“A-Z0-9]/.test(text[i + 2] ?? "")) {
      // Not after a short abbreviation such as "e.g." or "vs.".
      if (c === "." && /\b(?:e\.g|i\.e|vs|etc|approx|cf)$/i.test(text.slice(start, i))) continue;
      out.push(text.slice(start, i + 1).trim());
      start = i + 2;
    }
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}
