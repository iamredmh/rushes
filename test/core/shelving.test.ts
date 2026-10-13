import { describe, expect, it } from "vitest";
import { addVersion, inPlay, noteInPlay, shelveFilm } from "../../src/core/project.js";
import { tabStates } from "../../src/core/tabs.js";
import { createBatch } from "../../src/core/batches.js";
import { notesMarkdown } from "../../src/core/exportNotes.js";
import { addNote } from "../../src/core/notes.js";
import { filmEvent } from "../../src/core/logEvents.js";
import { EmptyBatchError, NotFoundError } from "../../src/core/errors.js";
import { VideoSchema, type BatchesFile, type NotesFile, type Project, type Script } from "../../src/core/schema.js";

// §26: a shelved film is out of play (its open notes stop counting) and nothing about it is lost.
const AT = new Date("2026-10-13T10:00:00.000Z");

function ctx() {
  const project: Project = { schema: 1, rev: 0, name: "Lumen", fps: 30, videos: [], lanes: [], files: [], autoProxy: false };
  const script: Script = { schema: 1, rev: 0, wordsPerSecond: 2.6, sections: [] };
  const notes: NotesFile = { schema: 1, rev: 0, notes: [] };
  const batches: BatchesFile = { schema: 1, rev: 0, batches: [] };
  addVersion(project, { video: "Hero", file: "renders/hero.mp4" });
  addVersion(project, { video: "Teaser", file: "renders/teaser.mp4" });
  addNote(notes, { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Hero fix." });
  addNote(notes, { stage: "picture", video: "teaser", version: "v1", scope: "point", t: 2, text: "Teaser fix one." });
  addNote(notes, { stage: "picture", video: "teaser", version: "v1", scope: "point", t: 3, text: "Teaser fix two." });
  addNote(notes, { stage: "mix", scope: "whole", text: "Loudness check." });
  return { project, script, notes, batches };
}
const picture = (c: ReturnType<typeof ctx>) => tabStates(c.project, c.script, c.notes).find((t) => t.stage === "picture")!;

describe("shelveFilm", () => {
  it("marks a film shelved with the time, and removes the mark to restore it", () => {
    const { project } = ctx();
    const film = shelveFilm(project, "teaser", true, AT);
    expect(film.shelved).toBe(AT.toISOString());
    expect(inPlay(film)).toBe(false);
    const back = shelveFilm(project, "teaser", false);
    expect("shelved" in back).toBe(false);
    expect(inPlay(back)).toBe(true);
  });
  it("is the same call twice: shelving a shelved film keeps its first time, restoring a film in play changes nothing", () => {
    const { project } = ctx();
    shelveFilm(project, "teaser", true, AT);
    expect(shelveFilm(project, "teaser", true, new Date("2026-10-14T00:00:00Z")).shelved).toBe(AT.toISOString());
    expect(inPlay(shelveFilm(project, "hero", false))).toBe(true);
  });
  it("finds the film by id or name, and refuses one that is not there", () => {
    const { project } = ctx();
    expect(shelveFilm(project, "Teaser", true, AT).id).toBe("teaser");
    expect(() => shelveFilm(project, "nope", true)).toThrow(NotFoundError);
  });
  it("touches nothing else about the film", () => {
    const { project } = ctx();
    const before = JSON.stringify(project.videos[1].versions);
    shelveFilm(project, "teaser", true, AT);
    expect(JSON.stringify(project.videos[1].versions)).toBe(before);
    expect(project.videos[1].lockedVersion).toBeNull();
  });
});

describe("a film from before shelving", () => {
  it("loads and saves with no shelved key, and a restore leaves none behind", () => {
    const parsed = VideoSchema.parse({ id: "hero", name: "Hero", versions: [], lockedVersion: null });
    expect("shelved" in parsed).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("shelved");
    const { project } = ctx();
    shelveFilm(project, "hero", true, AT);
    shelveFilm(project, "hero", false);
    expect(JSON.stringify(project.videos[0])).not.toContain("shelved");
    // A null from a hand-edited file is read as in play too.
    expect(inPlay(VideoSchema.parse({ id: "x", name: "X", shelved: null }))).toBe(true);
  });
});

describe("noteInPlay", () => {
  it("is false only for a note on a shelved film; a note on no film is always in play", () => {
    const c = ctx();
    shelveFilm(c.project, "teaser", true, AT);
    const [hero, teaser, , mix] = c.notes.notes;
    expect(noteInPlay(hero, c.project)).toBe(true);
    expect(noteInPlay(teaser, c.project)).toBe(false);
    expect(noteInPlay(mix, c.project)).toBe(true);
  });
  it("is true for a note whose film is gone: only a shelved film is set aside", () => {
    const c = ctx();
    addNote(c.notes, { stage: "picture", video: "removed", version: "v1", scope: "point", t: 1, text: "Orphan." });
    expect(noteInPlay(c.notes.notes[4], c.project)).toBe(true);
  });
});

describe("what a shelved film's open notes stop doing", () => {
  it("leaves the tab's to-do count, and comes back on restore", () => {
    const c = ctx();
    expect(picture(c).todo).toBe(3);
    shelveFilm(c.project, "teaser", true, AT);
    expect(picture(c).todo).toBe(1);
    shelveFilm(c.project, "teaser", false);
    expect(picture(c).todo).toBe(3);
  });
  it("keeps the notes of a film in play and notes that belong to no film", () => {
    const c = ctx();
    shelveFilm(c.project, "hero", true, AT);
    expect(tabStates(c.project, c.script, c.notes).find((t) => t.stage === "mix")!.todo).toBe(1);
    expect(picture(c).todo).toBe(2);
  });
  it("leaves new batches: only the films in play are asked about", () => {
    const c = ctx();
    shelveFilm(c.project, "teaser", true, AT);
    const batch = createBatch(c, "picture", AT);
    expect(batch.noteIds).toHaveLength(1);
    expect(batch.prompt).not.toContain("Teaser");
    // The shelved film's notes were not marked as sent.
    expect(c.notes.notes.filter((n) => n.batch === null).map((n) => n.text)).toEqual(["Teaser fix one.", "Teaser fix two.", "Loudness check."]);
  });
  it("is an empty batch when only a shelved film has open notes", () => {
    const c = ctx();
    shelveFilm(c.project, "hero", true, AT);
    shelveFilm(c.project, "teaser", true, AT);
    expect(() => createBatch(c, "picture", AT)).toThrow(EmptyBatchError);
  });
  it("leaves Export notes, which has no section for a shelved film", () => {
    const c = ctx();
    shelveFilm(c.project, "teaser", true, AT);
    const md = notesMarkdown(c.project, c.notes.notes, new Date(2026, 9, 13, 10, 0));
    expect(md).toContain("Hero fix.");
    expect(md).not.toContain("Teaser");
    shelveFilm(c.project, "teaser", false);
    expect(notesMarkdown(c.project, c.notes.notes, new Date(2026, 9, 13, 10, 0))).toContain("Teaser fix one.");
  });
});

describe("a new cut on a shelved film", () => {
  it("restores it, and says so", () => {
    const { project } = ctx();
    shelveFilm(project, "teaser", true, AT);
    const out = addVersion(project, { video: "teaser", file: "renders/teaser-2.mp4" });
    expect(out.restored).toBe(true);
    expect(inPlay(out.video)).toBe(true);
    expect("shelved" in out.video).toBe(false);
    expect(out.version.id).toBe("v2");
  });
  it("says nothing of restoring for a film in play, or a new film", () => {
    const { project } = ctx();
    expect(addVersion(project, { video: "hero", file: "renders/hero-2.mp4" }).restored).toBe(false);
    expect(addVersion(project, { video: "Brand new", file: "renders/new.mp4" }).restored).toBe(false);
  });
});

describe("filmEvent", () => {
  it("names the film as the Change Log names films, and is one line per change", () => {
    const shelved = filmEvent({ id: "key", name: "Key" }, true);
    expect(shelved).toMatchObject({ area: "picture", kind: "film", subject: "key", text: "Film “Key” shelved", video: "key" });
    expect(filmEvent({ id: "key", name: "Key" }, false).text).toBe("Film “Key” restored");
  });
});
