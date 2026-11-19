import { describe, expect, it } from "vitest";
import { tmpProject } from "../helpers/tmp.js";
import { createApp } from "../../src/server/app.js";
import { addVersion } from "../../src/core/project.js";
import { byFilm } from "../../src/core/notes.js";

// §30: a project with two films. The Change Log lines about notes are written per film, so Activity on one film never
// counts or tells the other's.

async function twoFilms() {
  const { store } = await tmpProject("spring-launch");
  await store.update("project", (p) => {
    addVersion(p, { video: "Hero", file: "renders/hero.mov", duration: 20, fps: 25 });
    addVersion(p, { video: "Teaser", file: "renders/teaser.mov", duration: 10, fps: 25 });
  });
  const app = createApp(store);
  const call = async (method: string, path: string, json?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: json === undefined ? undefined : { "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const note = async (video: string, text: string) =>
    (await call("POST", "/api/notes", { stage: "picture", video, version: "v1", scope: "point", t: 1, frame: 25, text })).json.note;
  const lines = async () => (await store.read("log")).entries.filter((e) => e.area === "notes").map((e) => [e.video, e.kind, e.text]);
  return { call, note, lines, store };
}

describe("Change Log lines about notes, per film (§30)", () => {
  it("a Send with notes on two films writes one line per film, each counting its own", async () => {
    const t = await twoFilms();
    await t.note("hero", "Logo lands early");
    await t.note("hero", "Hold the end card");
    await t.note("teaser", "Faster cut");
    expect((await t.call("POST", "/api/batches", {})).status).toBe(201);
    expect((await t.lines()).sort()).toEqual([
      ["hero", "notes-sent", "2 notes sent from Picture"],
      ["teaser", "notes-sent", "1 note sent from Picture"],
    ]);
  });

  it("replies to notes on two films are a line per film", async () => {
    const t = await twoFilms();
    const a = await t.note("hero", "Logo lands early");
    const b = await t.note("teaser", "Faster cut");
    const c = await t.note("teaser", "Shorter title");
    await t.call("POST", "/api/batches", {});
    const r = await t.call("POST", "/api/replies", { replies: [a, b, c].map((n) => ({ id: n.id, reply: "Done", status: "done" })) });
    expect(r.status).toBe(200);
    const replies = (await t.lines()).filter(([, kind]) => kind === "replies").sort();
    expect(replies).toEqual([
      ["hero", "replies", "Agent replied to 1 note (1 done)"],
      ["teaser", "replies", "Agent replied to 2 notes (2 done)"],
    ]);
  });
});

describe("byFilm (§30)", () => {
  it("groups by film in first-seen order, with no film under null", () => {
    const notes = [{ id: "a", video: "hero" }, { id: "b", video: null }, { id: "c", video: "teaser" }, { id: "d", video: "hero" }];
    expect(byFilm(notes, (n) => n.video).map(([f, ns]) => [f, ns.map((n) => n.id)])).toEqual([
      ["hero", ["a", "d"]],
      [null, ["b"]],
      ["teaser", ["c"]],
    ]);
  });
});

describe("a film's sent line names its own tab (§30)", () => {
  it("a batch from several tabs still says 'from Picture' for a film whose notes are all on Picture", async () => {
    const t = await twoFilms();
    await t.note("hero", "Logo lands early");
    await t.call("POST", "/api/notes", { stage: "voice", video: "teaser", scope: "whole", text: "Warmer read" });
    await t.note("teaser", "Faster cut");
    await t.call("POST", "/api/batches", {});
    expect((await t.lines()).sort()).toEqual([
      ["hero", "notes-sent", "1 note sent from Picture"],
      ["teaser", "notes-sent", "2 notes sent from several tabs"],
    ]);
  });
});
