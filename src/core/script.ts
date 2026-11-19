import { statusAfterEdit } from "./approval.js";
import type { Script, ScriptFile, Section, Take, Video } from "./schema.js";

/** Anything that lists its films in order (a Project, or a test's stand-in). */
type HasFilms = { videos: readonly Pick<Video, "id">[] };
import { InvalidError, NotFoundError } from "./errors.js";
import { uniqueId } from "./ids.js";

export type FitState = "ok" | "tight" | "over";

/** Does this line fit its slot at reading speed? "tight" means over 80% of the slot. */
export function fit(text: string, slotSeconds: number, wordsPerSecond: number): { words: number; seconds: number; ratio: number; state: FitState } {
  const words = (text.trim().match(/\S+/g) ?? []).length;
  const seconds = words / wordsPerSecond;
  const ratio = slotSeconds > 0 ? seconds / slotSeconds : Infinity;
  const state: FitState = ratio > 1 ? "over" : ratio > 0.8 ? "tight" : "ok";
  return { words, seconds, ratio, state };
}

/** A row counts as changed when the user's version differs from the agent's line. */
export function isChanged(s: Section): boolean {
  return s.proposed !== null && s.proposed.trim() !== s.current.trim();
}

/** A take is stale once the section's line no longer matches the text it was read from. */
export function isTakeStale(take: Take, s: Section): boolean {
  return take.forText.trim() !== s.current.trim();
}

export interface SectionInput {
  id?: string;
  start: number;
  end: number;
  current: string;
}

export interface SetSectionsOptions {
  /** Make the input the whole list. By default the input is merged into the script by id. */
  replace?: boolean;
}

/**
 * Write the agent's sections into the script and return the full, sorted list.
 *
 * By default this merges: an input whose id exists updates that section's
 * start, end and current line; an input with no id or an unknown id is a new
 * section; sections left out stay as they are. With `replace: true` the input
 * becomes the whole list.
 *
 * Either way, a section that keeps its id keeps the user's proposed text,
 * direction, status and takes. A proposal the agent adopts as the current line
 * is cleared because it has landed. A section whose line the agent changed goes
 * back to draft, whatever its status: a flag has been acted on, and an approval
 * was for the words the user read, not the new ones. Re-sending the same words
 * (spacing aside) leaves the status alone.
 *
 * A section sent without an id is given the next s<n> number that has never been
 * used in this script, so a replace with no ids carries on from where the old
 * numbers stopped instead of starting again at s1.
 */
export function setSections(script: Script, input: SectionInput[], { replace = false }: SetSectionsOptions = {}): Section[] {
  const seen = new Set<string>();
  const existing = new Set(script.sections.map((s) => s.id));
  for (const s of input) {
    if (!(s.end > s.start)) throw new InvalidError(`Section at ${s.start}s must end after it starts`);
    if (s.id === undefined) continue;
    if (seen.has(s.id)) throw new InvalidError(`Section id "${s.id}" appears twice`);
    // A note's `on` reads "vo" as the read, "<section>:<take>" as a take and "<lane>/<variant>" as
    // a variant, so a new section can't take an id that would read as one of those. Only new ids
    // are checked: a script saved before this rule still loads and updates.
    if (!existing.has(s.id) && (s.id === "vo" || /[:/]/.test(s.id))) {
      throw new InvalidError(`Section id "${s.id}" can't be "vo" or contain ":" or "/"`);
    }
    seen.add(s.id);
  }

  const old = new Map(script.sections.map((s) => [s.id, s]));
  type Draft = Omit<Section, "id"> & { id: string | null };
  const kept: Draft[] = replace ? [] : script.sections.filter((s) => !seen.has(s.id));
  const incoming: Draft[] = input.map((s) => {
    const prev = s.id === undefined ? undefined : old.get(s.id);
    const landed = prev?.proposed != null && prev.proposed.trim() === s.current.trim();
    const reworked = prev !== undefined && prev.current.trim() !== s.current.trim();
    const status = !prev || landed || reworked ? "draft" : prev.status;
    return {
      id: s.id ?? null,
      start: s.start,
      end: s.end,
      current: s.current,
      proposed: landed ? null : prev?.proposed ?? null,
      direction: prev?.direction ?? "",
      status,
      takes: prev?.takes ?? [],
    };
  });

  const sorted = [...kept, ...incoming].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) throw new InvalidError(`Sections overlap at ${sorted[i].start}s`);
  }

  // New sections without an id get s<n>, starting from their position, skipping ids already taken
  // and every number that was ever handed out: notes and picks name a section by id, so a removed
  // section's id must not come back for new words. `top` is the highest number seen, whether it is
  // in the script now, was in it before this call, or was recorded when it was given out.
  const taken = new Set(sorted.flatMap((s) => (s.id === null ? [] : [s.id])));
  let top = script.sectionCounter ?? 0;
  for (const id of [...taken, ...existing]) top = Math.max(top, Number(/^s(\d+)$/.exec(id)?.[1] ?? 0));
  const next: Section[] = sorted.map((s, i) => {
    if (s.id !== null) return s as Section;
    let n = Math.max(i + 1, top + 1);
    while (taken.has(`s${n}`)) n++;
    taken.add(`s${n}`);
    top = n;
    return { ...s, id: `s${n}` };
  });
  script.sections = next;
  script.sectionCounter = top;
  return next;
}

export function findSection(script: Script, id: string): Section {
  const s = script.sections.find((x) => x.id === id);
  if (!s) throw new NotFoundError("section", id);
  return s;
}

export interface SectionEdit {
  proposed?: string | null;
  direction?: string;
  status?: Section["status"];
}

/** The user's edit to a section. A change to an approved section's words or direction reopens it (approval.ts). */
export function editSection(script: Script, id: string, edit: SectionEdit): Section {
  const s = findSection(script, id);
  const words = (x: { proposed: string | null; current: string }) => (x.proposed ?? x.current).trim();
  const wordsChanged =
    (edit.proposed !== undefined && words({ proposed: edit.proposed, current: s.current }) !== words(s)) ||
    (edit.direction !== undefined && edit.direction.trim() !== s.direction.trim());
  s.status = statusAfterEdit(s.status, { wordsChanged, status: edit.status });
  if (edit.proposed !== undefined) s.proposed = edit.proposed;
  if (edit.direction !== undefined) s.direction = edit.direction;
  return s;
}

export function addTake(script: Script, sectionId: string, input: { file: string; duration?: number | null }): Take {
  const s = findSection(script, sectionId);
  const take: Take = {
    id: uniqueId(`t${s.takes.length + 1}`, s.takes.map((t) => t.id)),
    file: input.file,
    duration: input.duration ?? null,
    forText: s.current,
  };
  s.takes.push(take);
  return take;
}

// ---- §31.3: one script per film ----

const WPS = 2.6;

/** A film with no script yet: nothing in it, at the usual reading speed. */
export const emptyScript = (): Script => ({ wordsPerSecond: WPS, sections: [] });

/**
 * The film whose script a schema 1 file is: the project's first film, or none while there is no film (§31.3: a
 * project with no film yet keeps its plan files as they are, and they become the first film's when it is made).
 */
const firstFilmId = (project: HasFilms): string | null => project.videos[0]?.id ?? null;

/**
 * One film's script, read from script.json. With no film named (a project with no film yet, or a caller that doesn't
 * know one) it is the first film's. A schema 1 file is the first film's script; any other film has none until one is
 * set. What comes back is the file's own object where there is one, so a caller inside a store update may change it;
 * use filmScriptDraft to change a film's script, since it also makes the room.
 */
export function filmScript(file: ScriptFile, project: HasFilms, video?: string | null): Script {
  const first = firstFilmId(project);
  const film = video ?? first;
  if (file.schema === 1) return film === null || film === first ? file : emptyScript();
  if (film === null) return emptyScript();
  return file.films[film] ?? emptyScript();
}

/**
 * The script to change for a film, inside a store update of script.json. A schema 1 file becomes schema 2 here, its
 * script kept as the first film's, once the project has a second film to tell it from (§31.3). With no film yet, or
 * one film, it is changed as it is, so a one-film project keeps the very file it had (§31.7). A film with no script
 * gets an empty one.
 */
export function filmScriptDraft(file: ScriptFile, project: HasFilms, video?: string | null): Script {
  const first = firstFilmId(project);
  const film = video ?? first;
  if (file.schema === 1) {
    if (first === null || (film === first && project.videos.length < 2)) return file;
    toSchema2(file, first);
  }
  const v2 = file as Extract<ScriptFile, { schema: 2 }>;
  if (film === null) throw new InvalidError("Name the film this script is for");
  return (v2.films[film] ??= emptyScript());
}

/** Rewrites a schema 1 draft in place as schema 2, its script the first film's. */
export function toSchema2(file: ScriptFile, first: string): void {
  if (file.schema !== 1) return;
  const { wordsPerSecond, sections, sectionCounter } = file;
  const loose = file as unknown as Record<string, unknown>;
  delete loose.wordsPerSecond;
  delete loose.sections;
  delete loose.sectionCounter;
  loose.schema = 2;
  loose.films = { [first]: { wordsPerSecond, sections, ...(sectionCounter === undefined ? {} : { sectionCounter }) } };
}

/** Every film's scripts, for what has to know every take whichever film it belongs to (media, the Assets list, the log). */
export function scriptsOf(file: ScriptFile): { video: string | null; script: Script }[] {
  return file.schema === 1 ? [{ video: null, script: file }] : Object.entries(file.films).map(([video, script]) => ({ video, script }));
}

/** The sections of one film's script, or of every film's when given the whole file. */
export function sectionsOf(script: ScriptFile | Pick<Script, "sections">): Section[] {
  return "sections" in script ? script.sections : allSections(script);
}

/** Every film's sections in one list (ids may repeat across films: each film numbers its own). */
export function allSections(file: ScriptFile): Section[] {
  return scriptsOf(file).flatMap((s) => s.script.sections);
}
