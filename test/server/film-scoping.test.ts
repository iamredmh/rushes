import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { createApp } from "../../src/server/app.js";
import { addVariant, addVersion, addFile } from "../../src/core/project.js";
import { addNote } from "../../src/core/notes.js";
import { setSections, filmScript, filmScriptDraft } from "../../src/core/script.js";
import { chooseFilm, filmPlace, noteOnFilm } from "../../src/core/films.js";
import { moveToFirstFilmOnce } from "../../src/server/films.js";
import { ScriptSchema, type Script, type ScriptFile } from "../../src/core/schema.js";
import type { Store } from "../../src/core/store.js";

// §31: everything on the desk belongs to a film.

const BRIEF = (title: string) => `# Brief: ${title}\n\nStatus: draft\n\n## Purpose\n${title} purpose.\n`;
const BOARD = (len: number) => `# Storyboard: x\n\n## Shot 01 · Open\nTag: ESTABLISH\nLength: ${len}\nStatus: draft\n\nA wide.\n\n## Shot 02 · Close\nLength: 2\nStatus: draft\n\nA close.\n`;

async function project(films: string[] = ["Meet your agents", "Five views"]) {
  const { root, store } = await tmpProject("caffeine");
  await store.update("project", (p) => {
    for (const f of films) addVersion(p, { video: f, file: `renders/${f}.mp4`, duration: 20, fps: 25 });
  });
  const app = createApp(store);
  const call = async (method: string, path: string, json?: unknown) => {
    const res = await app.request(path, { method, headers: json === undefined ? undefined : { "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { root, store, call };
}

const v1Script = (sections: Script["sections"]): ScriptFile => ({ schema: 1, rev: 0, wordsPerSecond: 2.6, sections });
const section = (id: string, current: string) => ({ id, start: 0, end: 3, current, proposed: null, direction: "", status: "draft" as const, takes: [] });

describe("script.json schema 2 (§31.3)", () => {
  const two = { videos: [{ id: "a" }, { id: "b" }] };
  it("reads a schema 1 file as the first film's script, and gives any other film none", () => {
    const f = v1Script([section("s1", "Hello")]);
    expect(filmScript(f, two, "a").sections.map((s) => s.current)).toEqual(["Hello"]);
    expect(filmScript(f, two, null).sections.map((s) => s.current)).toEqual(["Hello"]);
    expect(filmScript(f, two, "b").sections).toEqual([]);
  });

  it("writes a schema 1 file back as schema 2 once there is a second film, the old script the first film's", () => {
    const f = v1Script([section("s1", "Hello")]);
    setSections(filmScriptDraft(f, two, "b"), [{ start: 0, end: 4, current: "Five views" }]);
    const parsed = ScriptSchema.parse(JSON.parse(JSON.stringify(f)));
    expect(parsed.schema).toBe(2);
    expect(parsed).not.toHaveProperty("sections");
    expect(filmScript(parsed, two, "a").sections.map((s) => s.current)).toEqual(["Hello"]);
    expect(filmScript(parsed, two, "b").sections.map((s) => [s.id, s.current])).toEqual([["s1", "Five views"]]);
  });

  it("leaves a one-film project's schema 1 file as it is (§31.7)", () => {
    const f = v1Script([]);
    setSections(filmScriptDraft(f, { videos: [{ id: "a" }] }, "a"), [{ start: 0, end: 4, current: "Only" }]);
    expect(f.schema).toBe(1);
    expect((f as Script).sections.map((s) => s.current)).toEqual(["Only"]);
  });

  it("each film has its own script over HTTP, and with two films a script call must name one", async () => {
    const t = await project();
    expect((await t.call("PUT", "/api/script", { video: "meet-your-agents", sections: [{ start: 0, end: 3, current: "Meet them" }] })).status).toBe(200);
    expect((await t.call("PUT", "/api/script", { video: "Five views", sections: [{ start: 0, end: 3, current: "Five ways" }] })).status).toBe(200);
    const a = (await t.call("GET", "/api/script?video=meet-your-agents")).json.script;
    const b = (await t.call("GET", "/api/script?video=five-views")).json.script;
    expect(a.sections.map((s: Script["sections"][number]) => s.current)).toEqual(["Meet them"]);
    expect(b.sections.map((s: Script["sections"][number]) => s.current)).toEqual(["Five ways"]);
    const refused = await t.call("GET", "/api/script");
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe("film_required");
    expect(refused.json.message).toContain("Meet your agents (meet-your-agents)");
    expect(refused.json.message).toContain("Five views (five-views)");
    expect((await t.call("PATCH", "/api/script/s1", { video: "five-views", status: "approved" })).json.section.current).toBe("Five ways");
    expect(filmScript(await t.store.read("script"), await t.store.read("project"), "meet-your-agents").sections[0].status).toBe("draft");
    // The script line is the film's.
    const lines = (await t.store.read("log")).entries.filter((e) => e.kind === "script").map((e) => e.video);
    expect(lines).toEqual(["meet-your-agents", "five-views"]);
  });

  it("a one-film project's script calls need no film, and its file stays schema 1", async () => {
    const t = await project(["Hero"]);
    expect((await t.call("PUT", "/api/script", { sections: [{ start: 0, end: 3, current: "Hi" }] })).status).toBe(200);
    expect((await t.call("GET", "/api/script")).json.script.sections).toHaveLength(1);
    expect(JSON.parse(await readFile(join(t.root, ".rushes", "script.json"), "utf8")).schema).toBe(1);
  });
});

describe("each film's brief and storyboard (§31.3)", () => {
  it("names the paths in one place: the first film's at the root, every other film's under films/<id>/", () => {
    const p = { videos: [{ id: "a" }, { id: "b" }] };
    expect(filmPlace(p, "a")).toMatchObject({ brief: "brief.md", storyboard: "storyboard.md", slot: null });
    expect(filmPlace(p, null)).toMatchObject({ brief: "brief.md", slot: null });
    expect(filmPlace(p, "b")).toMatchObject({ brief: "films/b/brief.md", storyboard: "films/b/storyboard.md", slot: "b" });
    expect(filmPlace({ videos: [] }, null)).toMatchObject({ brief: "brief.md", first: true });
  });

  it("keeps two films' briefs and storyboards apart, saves to the film named, and keeps each baseline", async () => {
    const t = await project();
    await writeFile(join(t.root, "brief.md"), BRIEF("Meet"));
    await mkdir(join(t.root, "films", "five-views"), { recursive: true });
    await writeFile(join(t.root, "films", "five-views", "brief.md"), BRIEF("Five"));
    await writeFile(join(t.root, "films", "five-views", "storyboard.md"), BOARD(4));
    const state = (await t.call("GET", "/api/state")).json;
    expect(state.films["meet-your-agents"].brief.title).toBe("Meet");
    expect(state.films["five-views"].brief.title).toBe("Five");
    expect(state.films["meet-your-agents"].storyboard.exists).toBe(false);
    expect(state.films["five-views"].storyboard.total).toBe(2);
    expect(state.films["five-views"].paths).toEqual({ brief: "films/five-views/brief.md", storyboard: "films/five-views/storyboard.md" });

    const five = (await t.call("GET", "/api/brief?video=five-views")).json.brief;
    const saved = await t.call("PUT", "/api/brief/sections/0", { video: "five-views", heading: "Purpose", text: "Mine.", hash: five.hash });
    expect(saved.status).toBe(200);
    expect(saved.json.brief.sections[0]).toMatchObject({ current: "Five purpose.", yours: "Mine.", changed: true });
    expect(await readFile(join(t.root, "films", "five-views", "brief.md"), "utf8")).toContain("Mine.");
    expect(await readFile(join(t.root, "brief.md"), "utf8")).toBe(BRIEF("Meet"));
    // The first film's baseline is the top-level one, the other's under its id.
    const kept = await t.store.read("brief");
    expect(kept.films?.["five-views"]?.baseline).toBe(BRIEF("Five"));
    expect((await t.call("GET", "/api/brief?video=meet-your-agents")).json.brief.changed).toBe(0);
    expect((await t.call("GET", "/api/brief")).status).toBe(400);

    const board = (await t.call("GET", "/api/storyboard?video=five-views")).json.storyboard;
    const shot = await t.call("PUT", "/api/storyboard/shots/0", { video: "five-views", heading: board.shots[0].heading, status: "approved", hash: board.hash });
    expect(shot.json.storyboard.approved).toBe(1);
    // Status is per film too.
    const tabs = (await t.call("GET", "/api/tabs?video=five-views")).json;
    expect(tabs.storyboard).toEqual({ exists: true, shots: 2, approved: 1, changed: 0 });
    expect(tabs.plans["five-views"]).toEqual({ brief: "films/five-views/brief.md", storyboard: "films/five-views/storyboard.md" });
  });

  it("§38.3: gives every film but the first the project brief it builds on, whether or not it has its own", async () => {
    const t = await project(["Meet your agents", "Five views", "Third"]);
    await writeFile(join(t.root, "brief.md"), BRIEF("Project"));
    await mkdir(join(t.root, "films", "five-views"), { recursive: true });
    await writeFile(join(t.root, "films", "five-views", "brief.md"), BRIEF("Five"));
    const state = (await t.call("GET", "/api/state")).json;
    expect(state.films["meet-your-agents"].projectBrief).toBeNull();
    expect(state.films["five-views"].brief.title).toBe("Five");
    expect(state.films["five-views"].projectBrief.title).toBe("Project");
    expect(state.films.third.brief.exists).toBe(false);
    expect(state.films.third.projectBrief.exists).toBe(true);
    expect(state.films.third.projectBrief.title).toBe("Project");
  });

  it("§38.3: a later film with no brief and no project brief has neither", async () => {
    const t = await project();
    const state = (await t.call("GET", "/api/state")).json;
    expect(state.films["five-views"].brief.exists).toBe(false);
    expect(state.films["five-views"].projectBrief.exists).toBe(false);
  });

  it("seeds only a film's own first cut from its own storyboard", async () => {
    const { root, store } = await tmpProject("caffeine");
    await writeFile(join(root, "storyboard.md"), BOARD(3));
    await mkdir(join(root, "films", "five-views"), { recursive: true });
    await writeFile(join(root, "films", "five-views", "storyboard.md"), BOARD(6));
    const app = createApp(store);
    const post = async (video: string) => (await (await app.request("/api/versions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ video, file: `renders/${video}.mp4` }) })).json()) as { version: { shots: { start: number }[] } };
    expect((await post("Meet your agents")).version.shots.map((s) => s.start)).toEqual([0, 3]);
    expect((await post("Five views")).version.shots.map((s) => s.start)).toEqual([0, 6]);
    expect((await post("Third")).version.shots).toEqual([]);
  });
});

async function seedOnNoFilm(store: Store) {
  await store.update("notes", (f) => {
    addNote(f, { stage: "picture", scope: "whole", text: "Old picture note" });
    addNote(f, { stage: "script", scope: "whole", text: "Old script note" });
    addNote(f, { stage: "visuals", scope: "whole", on: "v", text: "A visual's note" });
    addNote(f, { stage: "picture", video: "five-views", scope: "whole", text: "Five's own" });
  });
  await store.update("project", (p) => {
    addVariant(p, { stage: "music", name: "Loose bed", file: "audio/music/loose.wav" });
    addFile(p, { kind: "doc", file: "notes.md" });
  });
  await store.update("script", (s) => setSections(s as Script, [{ start: 0, end: 3, current: "Old line" }]));
}

describe("the one-time move (§31.4)", () => {
  it("gives the first film every note, take, file and the script on no film, writes one line, and does nothing the second time", async () => {
    const { store } = await tmpProject("caffeine");
    await store.update("project", (p) => {
      addVersion(p, { video: "Meet your agents", file: "renders/a.mp4" });
    });
    await seedOnNoFilm(store);
    await store.update("project", (p) => {
      addVersion(p, { video: "Five views", file: "renders/b.mp4" });
    });
    await store.update("visuals", (f) => { f.visuals = []; });
    const visualsBefore = await store.read("visuals");
    const moved = await moveToFirstFilmOnce(store);
    expect(moved).toMatchObject({ notes: 2, takes: 1, files: 1, sections: 1, script: true });
    const notes = (await store.read("notes")).notes;
    expect(notes.map((n) => [n.text, n.video])).toEqual([
      ["Old picture note", "meet-your-agents"], ["Old script note", "meet-your-agents"], ["A visual's note", null], ["Five's own", "five-views"],
    ]);
    const project = await store.read("project");
    expect(project.lanes[0].variants[0].videos).toEqual(["meet-your-agents"]);
    expect(project.files[0].video).toBe("meet-your-agents");
    const script = await store.read("script");
    expect(script.schema).toBe(2);
    expect(filmScript(script, project, "meet-your-agents").sections[0].current).toBe("Old line");
    const lines = (await store.read("log")).entries.filter((e) => e.text.startsWith("Moved to"));
    expect(lines.map((l) => [l.text, l.video])).toEqual([["Moved to Meet your agents: 2 notes, 1 take, 1 file and the script (1 section), which were on no film", null]]);
    // Idempotent: nothing more to move, nothing written.
    const revs = await Promise.all((["notes", "project", "script", "log"] as const).map(async (k) => (await store.read(k)).rev));
    expect(await moveToFirstFilmOnce(store)).toBeNull();
    expect(await Promise.all((["notes", "project", "script", "log"] as const).map(async (k) => (await store.read(k)).rev))).toEqual(revs);
    expect(await store.read("visuals")).toEqual(visualsBefore);
  });

  it("leaves a one-film project exactly as it is (§31.7)", async () => {
    const { store } = await tmpProject("caffeine");
    await store.update("project", (p) => {
      addVersion(p, { video: "Hero", file: "renders/a.mp4" });
    });
    await seedOnNoFilm(store);
    const revs = await Promise.all((["notes", "project", "script"] as const).map(async (k) => (await store.read(k)).rev));
    expect(await moveToFirstFilmOnce(store)).toBeNull();
    expect(await Promise.all((["notes", "project", "script"] as const).map(async (k) => (await store.read(k)).rev))).toEqual(revs);
    expect((await store.read("script")).schema).toBe(1);
  });

  it("runs when a project gains its second film", async () => {
    const { root, store } = await tmpProject("caffeine");
    const app = createApp(store);
    const post = (path: string, json: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });
    await post("/api/versions", { video: "Hero", file: `${root}/renders/a.mp4` });
    await post("/api/notes", { stage: "picture", scope: "whole", text: "No film named" });
    expect((await store.read("notes")).notes[0].video).toBeNull();
    await post("/api/versions", { video: "Teaser", file: `${root}/renders/b.mp4` });
    expect((await store.read("notes")).notes[0].video).toBe("hero");
  });
});

describe("Send per film (§31.2.2)", () => {
  it("sends only the film's notes (and the shared visuals') and its script, and the batch carries the film", async () => {
    const t = await project();
    const note = (video: string, text: string) => t.call("POST", "/api/notes", { stage: "picture", video, version: "v1", scope: "whole", text });
    await note("meet-your-agents", "Meet note");
    await note("five-views", "Five note 1");
    await note("five-views", "Five note 2");
    await t.call("PUT", "/api/script", { video: "five-views", sections: [{ start: 0, end: 3, current: "Line" }] });
    await t.call("PATCH", "/api/script/s1", { video: "five-views", proposed: "Better line" });
    const sent = await t.call("POST", "/api/batches", { video: "five-views" });
    expect(sent.status).toBe(201);
    const batch = sent.json.batch;
    expect(batch.video).toBe("five-views");
    expect(batch.noteIds).toHaveLength(2);
    expect(batch.sectionIds).toEqual(["s1"]);
    expect(batch.prompt).toContain('This batch is about the film "Five views" only');
    expect(batch.prompt).not.toContain("Meet your agents");
    const read = (await t.call("GET", "/api/batches/latest")).json;
    expect(read.film).toEqual({ id: "five-views", name: "Five views" });
    expect(read.sections.map((s: { current: string }) => s.current)).toEqual(["Line"]);
    // Meet your agents' note waits for its own Send.
    const notes = (await t.store.read("notes")).notes;
    expect(notes.find((n) => n.text === "Meet note")!.batch).toBeNull();
    // One Activity line, on the film, script edits and all.
    const lines = (await t.store.read("log")).entries.filter((e) => e.kind === "notes-sent").map((e) => [e.video, e.text]);
    expect(lines).toEqual([["five-views", "2 notes and 1 script edit sent from several tabs"]]);
    const other = await t.call("POST", "/api/batches", { video: "meet-your-agents" });
    expect(other.json.batch.noteIds).toHaveLength(1);
    expect(other.json.batch.video).toBe("meet-your-agents");
  });

  it("with one film, Send's batch and prompt are as they were", async () => {
    const t = await project(["Hero"]);
    await t.call("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "whole", text: "A note" });
    const batch = (await t.call("POST", "/api/batches", { video: "hero" })).json.batch;
    expect(batch.prompt.startsWith("Work through picture batch b_1 on caffeine: 1 note.")).toBe(true);
    expect(batch.prompt).not.toContain("about the film");
  });
});

describe("the API's ?video= filters (§31.6)", () => {
  it("notes, the log, assets and status follow the film", async () => {
    const t = await project();
    await t.call("POST", "/api/notes", { stage: "picture", video: "meet-your-agents", version: "v1", scope: "whole", text: "Meet note" });
    await t.call("POST", "/api/notes", { stage: "picture", video: "five-views", version: "v1", scope: "whole", text: "Five note" });
    await t.call("POST", "/api/notes", { stage: "visuals", on: "x", scope: "whole", text: "Visual note" }).catch(() => undefined);
    const notes = (await t.call("GET", "/api/notes?video=five-views")).json.notes.map((n: { text: string }) => n.text);
    expect(notes).toContain("Five note");
    expect(notes).not.toContain("Meet note");
    expect((await t.call("GET", "/api/notes")).json.notes.length).toBeGreaterThanOrEqual(2);

    await t.call("POST", "/api/log", { text: "About Meet", video: "meet-your-agents" });
    await t.call("POST", "/api/log", { text: "About Five", video: "five-views" });
    await t.call("POST", "/api/log", { text: "About the project" });
    const log = (await t.call("GET", "/api/log?video=five-views")).json.entries.map((e: { text: string }) => e.text);
    expect(log).toContain("About Five");
    expect(log).toContain("About the project");
    expect(log).not.toContain("About Meet");

    await t.call("POST", "/api/variants", { stage: "music", name: "Meet bed", file: "audio/meet.wav", video: "meet-your-agents" });
    await t.call("POST", "/api/variants", { stage: "music", name: "Both bed", file: "audio/both.wav", video: ["meet-your-agents", "five-views"] });
    const assets = (await t.call("GET", "/api/assets?video=five-views")).json.assets;
    expect(assets.filter((a: { kind: string }) => a.kind === "music").map((a: { label: string }) => a.label)).toEqual(["Both bed"]);
    expect(assets.filter((a: { kind: string }) => a.kind === "cut").map((a: { video: string }) => a.video)).toEqual(["five-views"]);

    const status = (await t.call("GET", "/api/tabs?video=five-views")).json;
    expect(status.film).toBe("five-views");
    expect(status.tabs.find((x: { stage: string }) => x.stage === "picture").todo).toBe(1);
    expect(status.tabs.find((x: { stage: string }) => x.stage === "music").unlocked).toBe(true);
  });

  it("chooseFilm and noteOnFilm: a named film, the only film, or an error listing them", () => {
    const p = { videos: [{ id: "a", name: "A", versions: [], lockedVersion: null }, { id: "b", name: "B", versions: [], lockedVersion: null }] };
    expect(chooseFilm(p, "B")!.id).toBe("b");
    expect(() => chooseFilm(p, undefined)).toThrow(/2 films.*A \(a\), B \(b\)/);
    expect(chooseFilm({ videos: [p.videos[0]] }, undefined)!.id).toBe("a");
    expect(chooseFilm({ videos: [] }, undefined)).toBeNull();
    expect(noteOnFilm({ stage: "picture", video: null }, "a", p.videos)).toBe(true);
    expect(noteOnFilm({ stage: "picture", video: null }, "b", p.videos)).toBe(false);
    expect(noteOnFilm({ stage: "visuals", video: null }, "b", p.videos)).toBe(true);
  });
});
