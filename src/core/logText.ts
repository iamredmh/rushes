// §22: the Change Log's shared words and dates, for the server, the CLI and the dashboard alike.
// Pure; its only import is labels.ts, which has none, because the dashboard bundles this file
// (test/core/logText.test.ts checks it).
import { oneLine, oneLineOf } from "./labels.js";

export const LOG_AREAS = ["script", "picture", "voice", "music", "sfx", "mix", "notes", "assets", "project"] as const;
export type LogArea = (typeof LOG_AREAS)[number];
export const LOG_KINDS = ["cut", "variant", "take", "script", "picks", "notes-sent", "replies", "lock", "files", "entry", "format"] as const;
export type LogKind = (typeof LOG_KINDS)[number];
export const LOG_BY = ["user", "agent", "rushes"] as const;
export type LogBy = (typeof LOG_BY)[number];

/** The most lines log.json keeps; past it the oldest go (§22.3). */
export const LOG_MAX = 5000;
/** A line is at most this long (§22.3). */
export const LOG_TEXT_MAX = 160;
/** §22.5: a line of the same kind and area by the same writer within this long merges (R4). */
export const MERGE_MS = 2 * 60_000;
/** §22.5: consecutive pick changes within this long are one line. */
export const PICKS_MERGE_MS = 10 * 60_000;

/** The words for an area: the filter chips, the row tags, the Markdown and the CLI (the mockup's labels). */
export const AREA_LABELS: Record<LogArea, string> = {
  script: "Script", picture: "Picture", voice: "Voice", music: "Music", sfx: "Sound effects", mix: "Mix", notes: "Notes", assets: "Files", project: "Project",
};
/** Who wrote a line, in the Markdown and the CLI. */
export const BY_WORDS: Record<LogBy, string> = { user: "you", agent: "agent", rushes: "Rushes" };

/** An area's words; one a newer Rushes wrote and this build doesn't know prints as it came. */
export function areaWord(area: string): string {
  return (AREA_LABELS as Record<string, string>)[area] ?? oneLineOf(area);
}
/** A writer's words, with the same fallback. */
export function byWord(by: string): string {
  return (BY_WORDS as Record<string, string>)[by] ?? oneLineOf(by);
}

/** A Change Log line as the API sends it (the stored entry, §22.3). */
export interface LogLine {
  id: string;
  at: string;
  area: LogArea;
  kind: LogKind;
  text: string;
  video: string | null;
  version: string | null;
  ref: string | null;
  by: LogBy;
  /** The tab a Notes line opens (R3). */
  tab?: string | null;
}

/** A "Before the log" line (§22.6): audio from before the log, computed when it's read. */
export interface UndatedLine {
  area: "voice" | "music" | "sfx";
  text: string;
}

/**
 * A line of text as the log keeps it: one line (labels.ts's oneLineOf), 160 code points at most,
 * never cut inside an emoji. Empty only when nothing in `text` is visible; the log refuses that.
 */
export function logText(text: string): string {
  return oneLine(text, LOG_TEXT_MAX);
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");
const valid = (d: Date) => Number.isFinite(d.getTime());

/**
 * How many calendar days, in local time, from the day of `iso` to the day of `now`: 0 is today, 1 is
 * yesterday, negative is a clock ahead; null when `iso` isn't a date. A day with a clock change (23 or
 * 25 hours) still counts as one. The version list (web/src/versions.ts) and the log's day headings both use it.
 */
export function dayDiff(iso: string, now: Date): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const day = (x: Date) => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()) / 86_400_000;
  return day(now) - day(d);
}

/** "14:32", local time; "--:--" for a date that doesn't parse (a hand-edited line). */
export function clock(d: Date): string {
  return valid(d) ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "--:--";
}

/** "2026-10-07", the local date. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "2026-10-07 14:32", local; "date unknown" for a date that doesn't parse. */
export function localStamp(d: Date): string {
  return valid(d) ? `${localDate(d)} ${clock(d)}` : "date unknown";
}

/**
 * A day's heading (§22.8). In the drawer: "Today", "Yesterday", then "Mon 5 Oct" (with the year
 * when it isn't this one). In a file, where "today" goes stale: "Wednesday 7 October 2026".
 */
export function dayHeading(d: Date, now: Date, relative: boolean): string {
  if (!valid(d)) return "Date unknown";
  if (!relative) return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const days = dayDiff(d.toISOString(), now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const year = d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${DAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}${year}`;
}

/** §22.7 (R17): the export's name, dated by the local clock. */
export function changeLogFileName(now: Date): string {
  return `change-log-${localDate(now)}.md`;
}

export interface LogMarkdownInput {
  project: string;
  /** Newest first. */
  entries: Pick<LogLine, "at" | "area" | "text" | "by">[];
  undated: Pick<UndatedLine, "text">[];
  dropped: number;
  /** Lines left out of `entries` (a limited `rushes log --md`). */
  earlier?: number;
  /** The one area `entries` was filtered to (`rushes log --md --area X`): named in the heading and in the empty line. */
  area?: LogArea;
  now: Date;
}

/** §22.7: the log as Markdown. Newest first, one heading per day; what Export writes and `rushes log --md` prints. */
export function logMarkdown(i: LogMarkdownInput): string {
  const project = oneLine(i.project, LOG_TEXT_MAX) || "Untitled project";
  const only = i.area === undefined ? "" : areaWord(i.area);
  const lines = [`# ${project} — change log${only ? `: ${only}` : ""}`, `Exported ${localStamp(i.now)}`];
  if (i.entries.length === 0 && i.undated.length === 0) lines.push("", only ? `Nothing in ${only} yet.` : "Nothing yet.");
  let day = "";
  for (const e of i.entries) {
    const d = new Date(e.at);
    const heading = dayHeading(d, i.now, false);
    if (heading !== day) {
      day = heading;
      lines.push("", `## ${heading}`);
    }
    // The words are made one clean line here too, whoever sent them (an older server doesn't clean what it reads).
    lines.push(`- ${clock(d)} · ${areaWord(e.area)} · ${oneLineOf(e.text)} (${byWord(e.by)})`);
  }
  if (i.earlier) lines.push("", `${i.earlier} earlier entr${i.earlier === 1 ? "y" : "ies"} not shown.`);
  if (i.undated.length) {
    lines.push("", "## Before the log");
    for (const u of i.undated) lines.push(`- ${oneLineOf(u.text)}`);
  }
  if (i.dropped > 0) lines.push("", "Earlier entries were removed.");
  return lines.join("\n") + "\n";
}

/** §22.7: Send to agent's "Recent changes" block. The last `max` lines, newest first; empty when there are none. */
export function recentChanges(entries: Pick<LogLine, "at" | "text">[], max = 5): string {
  const top = entries.slice(0, max);
  if (top.length === 0) return "";
  return ["Recent changes (newest first):", ...top.map((e) => `- ${localStamp(new Date(e.at))} ${oneLineOf(e.text)}`)].join("\n");
}
