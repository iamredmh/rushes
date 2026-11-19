// §31.4: the one-time move. On opening a project with two or more films (and whenever a project gains its second
// film), whatever is on no film becomes the first film's, and one Activity line says what moved and where. It is
// idempotent: a second run finds nothing on no film and writes nothing. Visuals are never touched.
import { moveToFirstFilm, movedAnything, movedText, type Moved } from "../core/films.js";
import type { Store } from "../core/store.js";
import { logBookFor, type LogBook } from "./logbook.js";

const runs = new WeakMap<Store, Promise<Moved | null>>();

/** Runs the move once at a time per store. Null when there was nothing to do (fewer than two films, or nothing on no film). */
export function moveToFirstFilmOnce(store: Store, log: LogBook = logBookFor(store)): Promise<Moved | null> {
  const prev = runs.get(store) ?? Promise.resolve(null);
  const run = prev.catch(() => null).then(() => move(store, log));
  runs.set(store, run);
  return run;
}

async function move(store: Store, log: LogBook): Promise<Moved | null> {
  const project = await store.read("project");
  if (project.videos.length < 2) return null;
  const film = { id: project.videos[0].id, name: project.videos[0].name };
  const count = project.videos.length;
  // Each file is changed in its own write, and only when something in it is on no film, so a second run writes nothing.
  const [notes, script] = await Promise.all([store.read("notes"), store.read("script")]);
  const total: Moved = { film, notes: 0, takes: 0, files: 0, sections: 0, script: false };
  if (notes.notes.some((n) => !n.video && n.stage !== "visuals")) {
    const { result } = await store.update("notes", (d) => moveToFirstFilm({ notes: d }, film, count));
    total.notes = result.notes;
  }
  if (project.lanes.some((l) => l.variants.some((v) => !v.videos?.length && v.video === undefined)) || project.files.some((f) => !f.video)) {
    const { result } = await store.update("project", (d) => (d.videos[0]?.id === film.id ? moveToFirstFilm({ project: d }, film, d.videos.length) : total));
    total.takes = result.takes;
    total.files = result.files;
  }
  // An empty schema 1 script has nothing to move: it is written as schema 2 by its first change (core/script.ts).
  if (script.schema === 1 && script.sections.length > 0) {
    const { result } = await store.update("script", (d) => moveToFirstFilm({ script: d }, film, count));
    total.sections = result.sections;
    total.script = result.script;
  }
  if (!movedAnything(total)) return null;
  // A project line (no film), so every film's Activity says where the things that were on no film went.
  await log.add({ area: "project", kind: "film", merge: "once", text: movedText(total), video: null }, "rushes");
  return total;
}
