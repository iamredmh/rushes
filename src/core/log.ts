// §22.5–§22.6: the Change Log's engine. Appending with collapsing (R4) and the 5000 cap, the
// one-time backfill (R6), "Before the log" (R5) and reading a page back. Pure apart from new ids;
// the server's LogBook owns the file.
import { newId } from "./ids.js";
import { oneLineOf } from "./labels.js";
import { STAGE_WORDS, cutEvent, fileEvent, notesSentEvent } from "./logEvents.js";
import { LOG_MAX, MERGE_MS, logText, type LogArea, type LogBy, type LogKind, type UndatedLine } from "./logText.js";
import type { BatchesFile, LogEntry, LogFile, Project, Script, Stage } from "./schema.js";

/** One thing that happened, as a builder in logEvents.ts describes it. */
export interface LogEvent {
  area: LogArea;
  kind: LogKind;
  /** The line for this one event. It's made one line and cut to 160 characters when stored. */
  text: string;
  video?: string | null;
  version?: string | null;
  ref?: string | null;
  /** The tab a Notes line opens (R3, R18). */
  tab?: Stage | null;
  /** R4: "count" sums `count` and rewrites the line with `many`; "replace" keeps the newest line for the same `subject`; "once" only drops an identical repeat. */
  merge: "count" | "replace" | "once";
  count?: number;
  subject?: string;
  /** `before` is the line's own text so far, for a line that also totals something `n` doesn't (the replies' done count). */
  many?: (n: number, subject: string, before?: string) => string;
  /** How soon after the last one this still merges (MERGE_MS unless given; picks use PICKS_MERGE_MS). */
  windowMs?: number;
  /** Undated refs this event dates, so they leave Before the log (R5). `ref` counts too. */
  clears?: string[];
}

/** The newest entry this event may merge into: same kind, area and writer, within the window (R4). */
function mergeTarget(entries: LogEntry[], event: LogEvent, by: LogBy, t: number): number {
  const window = event.windowMs ?? MERGE_MS;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const age = t - Date.parse(e.at);
    // More than a window ahead (written while a clock was ahead): never a target, or it would take
    // in everything until its time came round (I2). Look past it.
    if (age < -window) continue;
    if (!(age <= window)) return -1; // older than the window, and so is everything before it
    if (e.kind === event.kind && e.area === event.area && e.by === by) return i;
  }
  return -1;
}

type Link = Pick<LogEntry, "video" | "version" | "ref" | "tab">;

/** `wanted` when no line has it yet, otherwise a new id that none has. Ids are short and random, so a long log can draw one twice (I1). */
function freshId(taken: (id: string) => boolean, wanted?: string): string {
  let id = wanted ?? newId("l");
  while (taken(id)) id = newId("l");
  return id;
}

// §22.9: a retried request repeats the event it already logged. For a count, that's the same cut
// (video and version) or the same variant or take (ref) as the line's latest; files and notes have
// no identity, so two of them are two.
const sameThing = (e: LogEntry, link: Link): boolean =>
  (link.version !== null || link.ref !== null) && e.video === link.video && e.version === link.version && e.ref === link.ref;

function mergeInto(e: LogEntry, event: LogEvent, text: string, subject: string, count: number, link: Link): boolean {
  // A repeat is the same words about the same place (minor 4).
  if (event.merge === "once") return e.text === text && e.video === link.video && e.version === link.version && e.ref === link.ref && e.tab === link.tab;
  if (event.merge === "replace") {
    if (e.subject !== subject) return false;
    e.text = text;
    e.n += 1;
    Object.assign(e, link);
    return true;
  }
  if (sameThing(e, link)) return true;
  e.n += count;
  e.subject = e.subject === subject ? subject : "";
  e.text = logText(event.many ? event.many(e.n, e.subject, e.text) : text) || text;
  // A line opens a tab only when every event in it came from that one (minor 5).
  Object.assign(e, link, { tab: e.tab === link.tab ? link.tab : null });
  return true;
}

/**
 * §22.5: writes `event` into `file` at `at`, merging it into a recent line when R4 says so, and keeps
 * the newest LOG_MAX. Returns the line written or updated. A line with nothing visible in it is
 * refused with an error, and the file is left as it was.
 */
export function appendEvent(file: LogFile, event: LogEvent, by: LogBy, at: Date, id?: string): LogEntry {
  return place(file, event, by, at, id, (x) => file.entries.some((e) => e.id === x), true);
}

// appendEvent's work. `taken` says whether an id is in use; `cap` keeps the newest LOG_MAX as it
// goes. The backfill passes a Set and caps once at the end, so 30,000 dated items stay linear.
function place(file: LogFile, event: LogEvent, by: LogBy, at: Date, id: string | undefined, taken: (id: string) => boolean, cap: boolean): LogEntry {
  const t = at.getTime();
  const iso = at.toISOString();
  const text = logText(event.text);
  if (!text) throw new Error("A Change Log line can't be blank");
  // The schema keeps a subject to 200 characters; a lane name has no limit of its own.
  const subject = Array.from(event.subject ?? "").slice(0, 200).join("");
  const count = Math.max(1, Math.floor(event.count ?? 1));
  const link: Link = { video: event.video ?? null, version: event.version ?? null, ref: event.ref ?? null, tab: event.tab ?? null };
  const dated = [...(event.ref ? [event.ref] : []), ...(event.clears ?? [])];
  if (dated.length && file.undated.length) {
    const gone = new Set(dated);
    file.undated = file.undated.filter((r) => !gone.has(r));
  }
  const i = mergeTarget(file.entries, event, by, t);
  if (i >= 0) {
    const e = file.entries[i];
    if (mergeInto(e, event, text, subject, count, link)) {
      if (!(Date.parse(e.at) > t)) e.at = iso;
      file.entries.splice(i, 1);
      file.entries.push(e);
      return e;
    }
  }
  const entry: LogEntry = { id: freshId(taken, id), at: iso, area: event.area, kind: event.kind, text, ...link, by, n: count, subject };
  file.entries.push(entry);
  const extra = file.entries.length - LOG_MAX;
  if (cap && extra > 0) {
    file.entries.splice(0, extra);
    file.dropped += extra;
  }
  return entry;
}

export interface BackfillSource {
  project: Project;
  batches: BatchesFile;
  script: Script;
}

/**
 * §22.6: reads in, once, the history a project already has. Every cut, batch and file dated before
 * `before` (when this server's log began, R6) becomes a line by Rushes, in time order and collapsed
 * as live lines are. The variants and takes already there become `undated` (R5), less any a line in
 * the log already dates. A no-op once done.
 */
export function backfillLog(file: LogFile, src: BackfillSource, before: number): void {
  if (file.backfilled) return;
  const films = src.project.videos.length;
  const dated: { t: number; event: LogEvent }[] = [];
  const add = (when: string, event: LogEvent) => {
    const t = Date.parse(when);
    if (Number.isFinite(t) && t < before) dated.push({ t, event });
  };
  for (const video of src.project.videos) for (const version of video.versions) add(version.addedAt, cutEvent(films, video, version));
  for (const batch of src.batches.batches) add(batch.sentAt, notesSentEvent(batch));
  for (const entry of src.project.files) add(entry.addedAt, fileEvent(entry));
  dated.sort((a, b) => a.t - b.t);
  const past: LogFile = { schema: 1, rev: 0, backfilled: true, undated: [], dropped: 0, entries: [] };
  // Ids are drawn against the live lines too, so none is shared (I1).
  const ids = new Set(file.entries.map((e) => e.id));
  const taken = (x: string) => {
    if (ids.has(x)) return true;
    ids.add(x); // freshId keeps the first id that isn't taken, so it's now in use
    return false;
  };
  for (const d of dated) place(past, d.event, "rushes", new Date(d.t), undefined, taken, false);
  file.entries = [...past.entries, ...file.entries];
  const extra = file.entries.length - LOG_MAX;
  if (extra > 0) {
    file.entries.splice(0, extra);
    file.dropped += extra;
  }
  const live = new Set(file.entries.map((e) => e.ref));
  file.undated = undatedRefs(src.project, src.script).filter((r) => !live.has(r));
  file.backfilled = true;
}

/** Every variant ("<lane>/<variant>") and take ("<section>:<take>") the project has. */
export function undatedRefs(project: Pick<Project, "lanes">, script: Pick<Script, "sections">): string[] {
  const refs = [
    ...project.lanes.flatMap((l) => l.variants.map((v) => `${l.id}/${v.id}`)),
    ...script.sections.flatMap((s) => s.takes.map((t) => `${s.id}:${t.id}`)),
  ];
  return refs.slice(0, LOG_MAX);
}

export interface UndatedContext {
  project: Pick<Project, "lanes">;
  script: Pick<Script, "sections">;
}

/** §22.6's "Before the log": one line per lane, and one for takes, computed now from the refs that still exist. */
export function undatedLines(refs: readonly string[], ctx: UndatedContext): UndatedLine[] {
  const set = new Set(refs);
  const out: UndatedLine[] = [];
  for (const lane of ctx.project.lanes) {
    const n = lane.variants.filter((v) => set.has(`${lane.id}/${v.id}`)).length;
    if (n === 0) continue;
    const noun = lane.stage === "voice" ? (n === 1 ? "read" : "reads") : n === 1 ? "variant" : "variants";
    // A lane that carries its stage's own name (every 0.2.x project's defaults) isn't named twice.
    const word = STAGE_WORDS[lane.stage];
    const name = oneLineOf(lane.name);
    out.push({ area: lane.stage, text: logText(name && name !== word ? `${word}: ${lane.name} (${n} ${noun})` : `${word}: ${n} ${noun}`) });
  }
  const sections = ctx.script.sections.filter((s) => s.takes.some((t) => set.has(`${s.id}:${t.id}`))).length;
  if (sections) out.push({ area: "voice", text: `Voiceover: ${sections} section${sections === 1 ? "" : "s"} with takes` });
  return out;
}

export interface LogQuery {
  limit?: number;
  area?: LogArea;
  /** Only lines after this date and time. */
  since?: string;
}

export interface LogView {
  /** Newest first. */
  entries: LogEntry[];
  /** Lines that matched but were left out by `limit`. */
  earlier: number;
  undated: UndatedLine[];
  dropped: number;
  /** Every line in the file. */
  total: number;
}

/** §22.7: the newest `limit` lines (default 30), newest first, matching `area` and `since`. */
export function logView(file: LogFile, q: LogQuery, ctx: UndatedContext): LogView {
  const asked = Number.isFinite(q.limit) ? Math.floor(q.limit as number) : 30;
  const limit = Math.min(LOG_MAX, Math.max(1, asked));
  const from = q.since === undefined ? null : Date.parse(q.since);
  const matching: LogEntry[] = [];
  for (let i = file.entries.length - 1; i >= 0; i--) {
    const e = file.entries[i];
    if (q.area !== undefined && e.area !== q.area) continue;
    if (from !== null && !(Date.parse(e.at) > from)) continue;
    matching.push(e);
  }
  const undated = from !== null ? [] : undatedLines(file.undated, ctx).filter((l) => q.area === undefined || l.area === q.area);
  return { entries: matching.slice(0, limit), earlier: Math.max(0, matching.length - limit), undated, dropped: file.dropped, total: file.entries.length };
}
