// §31: everything on the desk belongs to a film. With a film selected, every tab shows only that film's material.
// The one exception is Visuals, which stay project-wide (campaign material) and show on every film as shared.
// Nothing is on no film: a note, take or file that names none is the project's first film's (`videos[0]`), and the
// one-time move (server/films.ts) writes that down.
import { RushesError } from "./errors.js";
import { slugify } from "./ids.js";
import { toSchema2 } from "./script.js";
import { variantFilms, type FileEntry, type Note, type NotesFile, type Project, type ScriptFile, type Video } from "./schema.js";

type Films = readonly Pick<Video, "id">[];

/** The project's first film, whose the old project-wide plan files and anything on no film are (§31.2.1, §31.2.4). */
export function firstFilm(project: { videos: Films }): string | null {
  return project.videos[0]?.id ?? null;
}

/** Whether something that names `own` (a film id, or none) is on `film`. On no film is on the first film. */
function ownsFilm(own: string | null | undefined, film: string, videos: Films): boolean {
  return own ? own === film : videos.length === 0 || videos[0].id === film;
}

/**
 * §31.5: whether a note shows on `film`. A note on a visual shows on every film (Visuals are shared, §31.2.3); any
 * other note is its film's, and one that names none is the first film's. With no film named, every note.
 */
export function noteOnFilm(note: Pick<Note, "stage" | "video">, film: string | null | undefined, videos: Films): boolean {
  if (!film || note.stage === "visuals") return true;
  return ownsFilm(note.video, film, videos);
}

/** A registered file's film: its own, or (naming none) the first film's. */
export function fileOnFilm(file: Pick<FileEntry, "video">, film: string | null | undefined, videos: Films): boolean {
  return !film || ownsFilm(file.video, film, videos);
}

/** Where one film's brief, storyboard and their baselines are (§31.3). This is the only place their paths are named. */
export interface FilmPlace {
  /** The film, or null for a project with no film yet. */
  video: string | null;
  /** The first film (or no film yet) keeps the root files, so existing projects and agent sessions keep working. */
  first: boolean;
  /** Project-relative, forward slashes. */
  brief: string;
  storyboard: string;
  /** Where the baseline is kept in brief.json / storyboard.json: null for the top-level fields (the first film's), else this film's id under `films`. */
  slot: string | null;
}

export const BRIEF_NAME = "brief.md";
export const STORYBOARD_NAME = "storyboard.md";
/** The folder every film but the first keeps its own plan files in: films/<film-id>/. */
export const FILMS_DIR = "films";

/** The paths of a film's plan files (§31.3): the root's for the first film or no film, else films/<film-id>/. */
export function filmPlace(project: { videos: Films }, video: string | null | undefined): FilmPlace {
  const first = firstFilm(project);
  const film = video ?? first;
  if (film === null || film === first) return { video: film, first: true, brief: BRIEF_NAME, storyboard: STORYBOARD_NAME, slot: null };
  return { video: film, first: false, brief: `${FILMS_DIR}/${film}/${BRIEF_NAME}`, storyboard: `${FILMS_DIR}/${film}/${STORYBOARD_NAME}`, slot: film };
}

/** How a film is named back: "Five views (five-views)". */
const filmWords = (v: Pick<Video, "id" | "name">) => (v.name === v.id ? v.id : `${v.name} (${v.id})`);

/** §31.6: a film's material asked for without saying which film, in a project with several. Lists them. */
export class FilmRequiredError extends RushesError {
  constructor(videos: readonly Pick<Video, "id" | "name">[], what = "this") {
    super(
      `This project has ${videos.length} films, so say which one ${what} is for: ${videos.map(filmWords).join(", ")}.`,
      400,
      "film_required",
      { films: videos.map((v) => ({ id: v.id, name: v.name })) },
    );
  }
}

/**
 * The film a request is about (§31.6): the one it names (an id or a name, as resolveVideo reads them), or, naming none,
 * the only film. With several and none named, a FilmRequiredError that lists them. Null while there is no film.
 */
export function chooseFilm(project: Pick<Project, "videos">, given: string | null | undefined, what?: string): Video | null {
  if (given) {
    const slug = slugify(given);
    const v = project.videos.find((x) => x.id === given) ?? project.videos.find((x) => x.id === slug) ?? project.videos.find((x) => x.name.toLowerCase() === given.toLowerCase());
    if (!v) throw new RushesError(`No film "${given}". Films: ${project.videos.map(filmWords).join(", ") || "none yet"}.`, 404, "not_found", { films: project.videos.map((x) => ({ id: x.id, name: x.name })) });
    return v;
  }
  if (project.videos.length > 1) throw new FilmRequiredError(project.videos, what);
  return project.videos[0] ?? null;
}

/** What the one-time move found on no film, and gave to the first film (§31.4). */
export interface Moved {
  film: Pick<Video, "id" | "name">;
  notes: number;
  takes: number;
  files: number;
  /** Sections of a schema 1 script, which became the first film's. */
  sections: number;
  /** Whether script.json was rewritten as schema 2. */
  script: boolean;
}

export const movedAnything = (m: Moved): boolean => m.notes + m.takes + m.files > 0 || m.script;

/**
 * §31.4, on drafts: gives the first film every note on no film (except a visual's), every read, bed and pass on no
 * film, every registered file on no film, and a schema 1 script (as schema 2). Only with two or more films; a second
 * run finds nothing. Visuals (visuals.json) are never touched.
 */
export function moveToFirstFilm(d: { project?: Project; notes?: NotesFile; script?: ScriptFile }, film: Pick<Video, "id" | "name">, filmCount: number): Moved {
  const moved: Moved = { film, notes: 0, takes: 0, files: 0, sections: 0, script: false };
  if (filmCount < 2) return moved;
  for (const n of d.notes?.notes ?? []) {
    if (n.video || n.stage === "visuals") continue;
    n.video = film.id;
    moved.notes += 1;
  }
  for (const lane of d.project?.lanes ?? []) {
    for (const v of lane.variants) {
      if (variantFilms(v).length > 0) continue;
      v.videos = [film.id];
      moved.takes += 1;
    }
  }
  for (const f of d.project?.files ?? []) {
    if (f.video) continue;
    f.video = film.id;
    moved.files += 1;
  }
  if (d.script?.schema === 1) {
    moved.sections = d.script.sections.length;
    toSchema2(d.script, film.id);
    moved.script = true;
  }
  return moved;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The one Activity line the move writes: "Moved to Meet your agents: 3 notes, 2 takes and the script (4 sections)". */
export function movedText(m: Moved): string {
  const parts = [
    m.notes ? plural(m.notes, "note", "notes") : "",
    m.takes ? plural(m.takes, "take", "takes") : "",
    m.files ? plural(m.files, "file", "files") : "",
    m.script ? `the script (${plural(m.sections, "section", "sections")})` : "",
  ].filter(Boolean);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `Moved to ${m.film.name}: ${list}, which were on no film`;
}
