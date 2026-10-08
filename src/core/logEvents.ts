// §22.5: the words for each thing Rushes logs, one builder per event. Built from short labels and
// names, never from a note's or a reply's text. R9 fixes the wording.
import { clip, oneLineOf, shortLabel, type Labelled } from "./labels.js";
import type { LogEvent } from "./log.js";
import { PICKS_MERGE_MS, type LogArea } from "./logText.js";
import type { Batch, FileEntry, FileKind, Lane, LaneStage, Note, Picks, Project, Section, Stage, Take, Variant, Video } from "./schema.js";

/** The tabs' own names, as the dashboard shows them. */
export const TAB_NAMES: Record<Stage, string> = { script: "Script", picture: "Picture", voice: "Voiceover", music: "Music", sfx: "Sound effects", mix: "Mix" };
/** How a lane's stage starts a line. It's also its default lane's name (project.ts LANE_NAMES), which "to <lane>" leaves out. */
export const STAGE_WORDS: Record<LaneStage, string> = { voice: "Voiceover", music: "Music", sfx: "Sound effects" };
/** §16.1's Assets folders, by the kind of file they hold (web/src/lib.ts FOLDERS; test/core/log.test.ts keeps them equal). */
export const FILE_FOLDERS: Record<FileKind, string> = { doc: "Scripts & docs", image: "Images", caption: "Captions", export: "Exports", delivery: "Delivery", edit: "Edit files" };
const PICK_WORDS: Record<LaneStage, string> = { voice: "voice", music: "music", sfx: "sound effects" };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const quoted = (s: string) => `“${oneLineOf(s)}”`;

/** "v6" on a one-film project; "Teaser v2" when there are more (R9). */
export function cutName(films: number, video: Pick<Video, "name">, versionId: string): string {
  return films > 1 ? `${oneLineOf(video.name)} ${versionId}` : versionId;
}

/** "v6 added: launch 1.45x slower". */
export function cutEvent(films: number, video: Pick<Video, "id" | "name">, version: Labelled): LogEvent {
  const name = cutName(films, video, version.id);
  const label = shortLabel(version);
  return {
    area: "picture", kind: "cut", merge: "count", subject: video.id,
    text: `${name} added: ${label}`,
    video: video.id, version: version.id,
    many: (n, subject) => `${n} cuts added${films > 1 && subject ? ` to ${oneLineOf(video.name)}` : ""}, the latest ${name}: ${label}`,
  };
}

/** `Music: “Night drive, driving drop” added to night-drive`; a voice read is a "read". */
export function variantEvent(lane: Pick<Lane, "id" | "stage" | "name">, variant: Pick<Variant, "id" | "name">): LogEvent {
  const word = STAGE_WORDS[lane.stage];
  const [one, many] = lane.stage === "voice" ? ["read", "reads"] : ["variant", "variants"];
  const to = (name: string) => (name && name !== word ? ` to ${oneLineOf(name)}` : "");
  return {
    area: lane.stage, kind: "variant", merge: "count", subject: lane.name,
    text: `${word}: ${quoted(variant.name)} added${to(lane.name)}`,
    ref: `${lane.id}/${variant.id}`,
    many: (n, subject) => `${word}: ${plural(n, one, many)} added${to(subject)}`,
  };
}

/** `Voiceover: take 2 added to S1 “Every launch starts with a…”`. */
export function takeEvent(section: Pick<Section, "id" | "current">, take: Pick<Take, "id">, number: number): LogEvent {
  const where = section.id.toUpperCase();
  const line = oneLineOf(section.current);
  return {
    area: "voice", kind: "take", merge: "count", subject: where,
    text: `Voiceover: take ${number} added to ${where}${line ? ` ${quoted(clip(line, 32))}` : ""}`,
    ref: `${section.id}:${take.id}`,
    many: (n, subject) => `Voiceover: ${plural(n, "take", "takes")} added${subject ? ` to ${subject}` : ""}`,
  };
}

/** "Script set: 6 sections". */
export function scriptEvent(sections: number): LogEvent {
  return { area: "script", kind: "script", merge: "replace", text: `Script set: ${plural(sections, "section", "sections")}` };
}

/** `Picks: voice “Vo Jules, full read”, music “Night drive, held back”`, the whole set after the change. */
export function picksEvent(project: Pick<Project, "lanes">, lanes: Picks["lanes"]): LogEvent {
  const parts: string[] = [];
  for (const lane of project.lanes) {
    const v = lane.variants.find((x) => x.id === lanes[lane.id]);
    if (v) parts.push(`${PICK_WORDS[lane.stage]} ${quoted(v.name)}`);
  }
  return { area: "mix", kind: "picks", merge: "replace", windowMs: PICKS_MERGE_MS, text: parts.length ? `Picks: ${parts.join(", ")}` : "Picks cleared" };
}

/** "Picture locked at v6", "Picture unlocked". */
export function lockEvent(films: number, video: Pick<Video, "id" | "name" | "lockedVersion">): LogEvent {
  const text = video.lockedVersion ? `Picture locked at ${cutName(films, video, video.lockedVersion)}` : `Picture unlocked${films > 1 ? ` for ${oneLineOf(video.name)}` : ""}`;
  return { area: "picture", kind: "lock", merge: "replace", subject: video.id, text, video: video.id, version: video.lockedVersion };
}

/** "3 notes sent from Picture"; on Script, "1 note and 2 script edits sent from Script". */
export function notesSentEvent(batch: Pick<Batch, "stage" | "noteIds" | "sectionIds">): LogEvent {
  const tab = TAB_NAMES[batch.stage];
  const notes = batch.noteIds.length;
  const edits = batch.sectionIds.length;
  const what = notes && edits
    ? `${plural(notes, "note", "notes")} and ${plural(edits, "script edit", "script edits")}`
    : edits ? plural(edits, "script edit", "script edits") : plural(notes, "note", "notes");
  return {
    area: "notes", kind: "notes-sent", merge: "count", count: Math.max(1, notes + edits), subject: tab, tab: batch.stage,
    text: `${what} sent from ${tab}`,
    many: (n, subject) => `${plural(n, "note", "notes")} sent from ${subject || "several tabs"}`,
  };
}

/** "Agent replied to 3 notes (2 done)", one line per reply call (§22.5). */
export function repliesEvent(notes: Pick<Note, "status" | "stage">[]): LogEvent {
  const done = notes.filter((n) => n.status === "done").length;
  const stages = new Set(notes.map((n) => n.stage));
  return {
    area: "notes", kind: "replies", merge: "once", tab: stages.size === 1 ? [...stages][0] : null,
    text: `Agent replied to ${plural(notes.length, "note", "notes")}${done ? ` (${done} done)` : ""}`,
  };
}

/** "File added: Creative brief (Scripts & docs)"; merged, "2 files added: Scripts & docs". */
export function fileEvent(entry: Pick<FileEntry, "kind" | "name">): LogEvent {
  const folder = FILE_FOLDERS[entry.kind];
  return {
    area: "assets", kind: "files", merge: "count", subject: folder,
    text: `File added: ${oneLineOf(entry.name)} (${folder})`,
    many: (n, subject) => `${plural(n, "file", "files")} added${subject ? `: ${subject}` : ""}`,
  };
}

/** "Brought in 3 files with v6" (R9). Its variants leave Before the log (R5). */
export function broughtInEvent(added: { lane?: string; variant?: string }[], cut: string | null): LogEvent {
  return {
    area: "assets", kind: "files", merge: "count", count: Math.max(1, added.length), subject: cut ?? "",
    text: `Brought in ${plural(added.length, "file", "files")}${cut ? ` with ${cut}` : ""}`,
    clears: added.filter((a) => a.lane && a.variant).map((a) => `${a.lane}/${a.variant}`),
    many: (n, subject) => `Brought in ${plural(n, "file", "files")}${subject ? ` with ${subject}` : ""}`,
  };
}

/** A line somebody wrote (§22.7): never merged, except that an identical repeat isn't doubled. */
export function lineEvent(text: string, area: LogArea, link: { video?: string | null; version?: string | null; ref?: string | null } = {}): LogEvent {
  return { area, kind: "entry", merge: "once", text, ...link };
}
