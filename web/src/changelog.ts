// §22.8: the Change Log drawer's helpers. Pure, so they're unit-tested in Node. The words and dates
// come from src/core/logText.ts, which imports nothing but labels.ts.
import { AREA_LABELS, dayHeading, localDate, type LogArea, type LogBy, type LogLine } from "../../src/core/logText.js";
import type { LaneStage, Stage } from "./types.js";
export { AREA_LABELS, clock, localDate } from "../../src/core/logText.js";

export type Filter = "all" | Exclude<LogArea, "script" | "project">;

/** The mockup's chips, in order. */
export const FILTERS: readonly (readonly [Filter, string])[] = [
  ["all", "All"], ["picture", AREA_LABELS.picture], ["voice", AREA_LABELS.voice], ["music", AREA_LABELS.music],
  ["sfx", AREA_LABELS.sfx], ["mix", AREA_LABELS.mix], ["notes", AREA_LABELS.notes], ["assets", AREA_LABELS.assets],
];

export function isFilter(s: string | null): s is Filter {
  return FILTERS.some(([f]) => f === s);
}

/** Who wrote a row, under its text (the mockup's words). */
export const BY_UI: Record<LogBy, string> = { user: "added by you", agent: "agent", rushes: "Rushes" };

export interface DayGroup {
  key: string;
  heading: string;
  entries: LogLine[];
}

/**
 * Newest-first lines under their local day's heading (§22.8). `key` is the local date, so it stays
 * the same as newer days arrive above it and the rows inside never remount (a focused row keeps its
 * focus, fix round 1 I1). A day split in two by a line out of order (a hand edit, a clock change)
 * gets "~2", "~3" on its older halves, counted from the oldest so a new line at the top moves nothing.
 */
export function groupByDay(entries: readonly LogLine[], now: Date): DayGroup[] {
  const groups: (DayGroup & { date: string })[] = [];
  for (const e of entries) {
    const d = new Date(e.at);
    const date = localDate(d);
    const last = groups[groups.length - 1];
    if (last && last.date === date) last.entries.push(e);
    else groups.push({ key: date, date, heading: dayHeading(d, now, true), entries: [e] });
  }
  const seen = new Map<string, number>();
  for (let i = groups.length - 1; i >= 0; i--) {
    const n = (seen.get(groups[i].date) ?? 0) + 1;
    seen.set(groups[i].date, n);
    if (n > 1) groups[i].key = `${groups[i].date}~${n}`;
  }
  return groups.map(({ key, heading, entries: lines }) => ({ key, heading, entries: lines }));
}

/** Whether a filter shows a line about `area` (a line added under another filter would otherwise vanish, fix round 1 M1). */
export function filterShows(filter: Filter, area: LogArea): boolean {
  return filter === "all" || filter === area;
}

const OWN_KEYS = new Set([" ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/**
 * Keys the drawer uses itself (moving through the chips, scrolling the list, pressing a row): they
 * stop there, so they never step the picture's frames or play it. A combination with Alt, Ctrl or
 * Cmd is the page's (a shortcut, not a movement), so it always goes through (fix round 1, M4).
 */
export function ownKey(e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): boolean {
  return OWN_KEYS.has(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey;
}

export type JumpTarget = { tab: Stage | "assets"; video?: string; version?: string; row?: string };

const TABS: readonly string[] = ["script", "picture", "voice", "music", "sfx", "mix"];

/** R18: where a row goes, as far as what still exists allows. Null when it has nowhere to go (R14). */
export function jumpOf(
  e: LogLine,
  project: { videos: { id: string; versions: { id: string }[] }[]; lanes: { id: string; stage: LaneStage }[] },
): JumpTarget | null {
  // A line written by hand goes somewhere only when it carries a film, a version or a ref (R14).
  if (e.kind === "entry" && !e.video && !e.version && !e.ref) return null;
  const film = e.video ? project.videos.find((v) => v.id === e.video) : undefined;
  if (film) return e.version && film.versions.some((v) => v.id === e.version) ? { tab: "picture", video: film.id, version: e.version } : { tab: "picture", video: film.id };
  const slash = e.ref ? e.ref.indexOf("/") : -1;
  const lane = slash > 0 ? project.lanes.find((l) => l.id === e.ref!.slice(0, slash)) : undefined;
  if (lane) return { tab: lane.stage, row: e.ref! };
  if (e.tab && TABS.includes(e.tab)) return { tab: e.tab as Stage };
  if (e.area === "assets") return { tab: "assets" };
  if (TABS.includes(e.area)) return { tab: e.area as Stage };
  return null;
}

/** How many lines in `next` are new or updated since `shown` (the "N new" pill). */
export function newCount(shown: readonly LogLine[], next: readonly LogLine[]): number {
  const seen = new Set(shown.map((e) => `${e.id}@${e.at}`));
  return next.filter((e) => !seen.has(`${e.id}@${e.at}`)).length;
}

/** The footer's words (R16, §22.9). */
export function footText(v: { entries: readonly unknown[]; earlier: number; dropped: number }): string {
  const matching = v.entries.length + v.earlier;
  const count = v.earlier > 0 ? `Showing the newest ${v.entries.length} of ${matching}` : `${matching} entr${matching === 1 ? "y" : "ies"}`;
  return v.dropped > 0 ? `${count} · Earlier entries were removed` : count;
}

/** A row's accessible name, in full words: what happened, then where, when and who (the arrow and tag alone say nothing). */
export function rowName(e: Pick<LogLine, "text" | "area" | "by">, time: string): string {
  const who = e.by === "user" ? "added by you" : e.by === "agent" ? "by the agent" : "by Rushes";
  return `${e.text} (${AREA_LABELS[e.area]}, ${time}, ${who})`;
}

/**
 * §22.8: what went wrong, in plain words. Never the raw error: a server's 500 can carry an errno
 * ("EISDIR: illegal operation…"), and a dropped connection only says "Load failed".
 */
export function problemText(action: "read" | "add" | "export", err: unknown): string {
  const status = typeof (err as { status?: unknown } | null)?.status === "number" ? (err as { status: number }).status : null;
  const doctor = "Run rushes doctor to see why.";
  if (status === null) {
    const what = action === "read" ? "The Change Log couldn't be loaded" : action === "add" ? "That line wasn't added" : "The Markdown wasn't saved";
    return `${what}: Rushes didn't answer. Check it's still running, then try again.`;
  }
  if (action === "add") return status < 500 ? "That line wasn't added: it needs a few words of text." : `That line wasn't added: the Change Log couldn't be written. ${doctor}`;
  if (action === "export") return `The Markdown wasn't saved: the Change Log couldn't be read or written. ${doctor}`;
  return status < 500 ? "The Change Log couldn't show that filter. Choose All and try again." : `The Change Log couldn't be read. ${doctor}`;
}

/**
 * R19: whether the log's head (`id@at` of its newest line) is news since `seen`. The drawer marks
 * what it has shown as seen, which can be ahead of the head the page last fetched (the log answered
 * before the state did, fix round 1): a head older than that isn't news.
 */
export function isNews(mark: string | null, seen: string | null): boolean {
  if (!mark || mark === seen) return false;
  if (!seen) return true;
  const time = (m: string) => Date.parse(m.slice(m.lastIndexOf("@") + 1));
  const a = time(mark);
  const b = time(seen);
  return !(Number.isFinite(a) && Number.isFinite(b) && a < b);
}

export interface KeyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function storageKey(projectId: string, what: "log-open" | "log-seen" | "log-filter"): string {
  return `rushes:${projectId}:${what}`;
}

/** Storage that's blocked, missing or full (a private window, say) reads as nothing and never breaks the drawer. */
export function recall(store: KeyStore | undefined, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function remember(store: KeyStore | undefined, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    // Nothing to do: the choice just isn't remembered.
  }
}
