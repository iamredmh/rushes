import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { createApp } from "../../src/server/app.js";

// §26.7: shelving a film over HTTP, and what the agent sees and no longer sees of a shelved film.
async function setup() {
  const { root, store } = await tmpProject("lumen");
  const server = createApp(store, {});
  const call = async (method: string, path: string, json?: unknown) => {
    const res = await server.request(path, { method, headers: json === undefined ? undefined : { "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, json: type.includes("json") ? ((await res.json()) as any) : null, text: type.includes("json") ? "" : await res.text() };
  };
  await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4` });
  await call("POST", "/api/versions", { video: "Teaser", file: `${root}/renders/teaser.mp4` });
  const note = (video: string, text: string, t: number) => call("POST", "/api/notes", { stage: "picture", video, version: "v1", scope: "point", t, text });
  await note("hero", "Hero fix.", 1);
  await note("teaser", "Teaser fix one.", 2);
  await note("teaser", "Teaser fix two.", 3);
  return { call, root, store };
}
const pictureTodo = async (call: Awaited<ReturnType<typeof setup>>["call"]) => (await call("GET", "/api/tabs")).json.tabs.find((t: any) => t.stage === "picture").todo;
const logText = async (call: Awaited<ReturnType<typeof setup>>["call"]) => JSON.stringify((await call("GET", "/api/log?area=picture")).json);

describe("PUT /api/videos/:video/shelve", () => {
  it("shelves a film, shows it in state, and says so in the Change Log", async () => {
    const { call } = await setup();
    const r = await call("PUT", "/api/videos/teaser/shelve", { shelved: true });
    expect(r.status).toBe(200);
    expect(typeof r.json.video.shelved).toBe("string");
    const state = await call("GET", "/api/state");
    expect(state.json.project.videos.find((v: any) => v.id === "teaser").shelved).toBe(r.json.video.shelved);
    expect(state.json.project.videos.find((v: any) => v.id === "hero").shelved ?? null).toBeNull();
    expect(await logText(call)).toContain("Film “Teaser” shelved");
  });

  it("restores it, and the film's cuts and notes are all still there", async () => {
    const { call } = await setup();
    await call("PUT", "/api/videos/teaser/shelve", { shelved: true });
    const r = await call("PUT", "/api/videos/teaser/shelve", { shelved: false });
    expect(r.status).toBe(200);
    expect("shelved" in r.json.video).toBe(false);
    expect(r.json.video.versions).toHaveLength(1);
    expect((await call("GET", "/api/state")).json.notes.notes.filter((n: any) => n.video === "teaser")).toHaveLength(2);
    expect(await logText(call)).toContain("Film “Teaser” restored");
  });

  it("is the same call twice, and logs a change once", async () => {
    const { call } = await setup();
    const first = await call("PUT", "/api/videos/teaser/shelve", { shelved: true });
    const second = await call("PUT", "/api/videos/teaser/shelve", { shelved: true });
    expect(second.json.video.shelved).toBe(first.json.video.shelved);
    const lines = ((await logText(call)).match(/Film “Teaser” shelved/g) ?? []).length;
    expect(lines).toBe(1);
    expect((await call("PUT", "/api/videos/hero/shelve", { shelved: false })).status).toBe(200);
    expect(await logText(call)).not.toContain("Film “Hero”");
  });

  it("refuses a film that is not there and a body that is not true or false", async () => {
    const { call } = await setup();
    expect((await call("PUT", "/api/videos/nope/shelve", { shelved: true })).status).toBe(404);
    expect((await call("PUT", "/api/videos/teaser/shelve", { shelved: "yes" })).status).toBe(400);
    expect((await call("PUT", "/api/videos/teaser/shelve", {})).status).toBe(400);
  });
});

describe("what the agent sees of a shelved film", () => {
  it("lists every film with its mark in /api/tabs, and counts only the films in play", async () => {
    const { call } = await setup();
    expect(await pictureTodo(call)).toBe(3);
    await call("PUT", "/api/videos/teaser/shelve", { shelved: true });
    const tabs = (await call("GET", "/api/tabs")).json;
    expect(tabs.films).toEqual([
      { id: "hero", name: "Hero", shelved: null },
      { id: "teaser", name: "Teaser", shelved: expect.any(String) },
    ]);
    expect(tabs.tabs.find((t: any) => t.stage === "picture").todo).toBe(1);
  });

  it("leaves a shelved film's notes out of GET /api/notes unless asked", async () => {
    const { call } = await setup();
    await call("PUT", "/api/videos/teaser/shelve", { shelved: true });
    expect((await call("GET", "/api/notes?stage=picture")).json.notes.map((n: any) => n.text)).toEqual(["Hero fix."]);
    expect((await call("GET", "/api/notes?stage=picture&includeShelved=true")).json.notes).toHaveLength(3);
  });

  it("keeps a sent batch's notes on a film shelved afterwards: asking for that batch lists them all", async () => {
    const { call } = await setup();
    const sent = await call("POST", "/api/batches", { stage: "picture" });
    expect(sent.json.batch.noteIds).toHaveLength(3);
    await call("PUT", "/api/videos/teaser/shelve", { shelved: true });
    expect((await call("GET", "/api/notes?stage=picture")).json.notes).toHaveLength(1);
    const batch = (await call("GET", `/api/notes?batch=${sent.json.batch.id}`)).json.notes;
    expect(batch.map((n: any) => n.text).sort()).toEqual(["Hero fix.", "Teaser fix one.", "Teaser fix two."]);
  });

  it("leaves it out of a batch, which keeps the film's notes unsent", async () => {
    const { call } = await setup();
    await call("PUT", "/api/videos/teaser/shelve", { shelved: true });
    const sent = await call("POST", "/api/batches", { stage: "picture" });
    expect(sent.status).toBe(201);
    expect(sent.json.batch.noteIds).toHaveLength(1);
    const notes = (await call("GET", "/api/state")).json.notes.notes;
    expect(notes.filter((n: any) => n.video === "teaser").every((n: any) => n.batch === null)).toBe(true);
    // Restored, the film's notes go to the agent with the next batch.
    await call("PUT", "/api/videos/teaser/shelve", { shelved: false });
    const next = await call("POST", "/api/batches", { stage: "picture" });
    expect(next.json.batch.noteIds).toHaveLength(2);
  });

  it("leaves it out of Export notes", async () => {
    const { call, root } = await setup();
    await call("PUT", "/api/videos/teaser/shelve", { shelved: true });
    const r = await call("POST", "/api/exports/notes", {});
    expect(r.status).toBe(201);
    const md = await readFile(join(root, r.json.path), "utf8");
    expect(md).toContain("Hero fix.");
    expect(md).not.toContain("Teaser fix");
  });
});

describe("a new cut on a shelved film", () => {
  it("restores it and says so, in the reply and in the Change Log", async () => {
    const { call, root } = await setup();
    await call("PUT", "/api/videos/teaser/shelve", { shelved: true });
    const r = await call("POST", "/api/versions", { video: "teaser", file: `${root}/renders/teaser-2.mp4` });
    expect(r.status).toBe(201);
    expect(r.json.restored).toBe(true);
    expect("shelved" in (await call("GET", "/api/state")).json.project.videos.find((v: any) => v.id === "teaser")).toBe(false);
    const log = await logText(call);
    expect(log).toContain("Film “Teaser” restored");
    expect(log).toContain("v2");
    expect(await pictureTodo(call)).toBe(3);
  });

  it("leaves it shelved when the cut is refused", async () => {
    const { call, root } = await setup();
    await call("PUT", "/api/videos/teaser/shelve", { shelved: true });
    const refused = await call("POST", "/api/versions", { video: "teaser", file: `${root}/renders/teaser-2.mp4`, label: "x".repeat(200) });
    expect(refused.status).toBe(400);
    const state = (await call("GET", "/api/state")).json;
    expect(typeof state.project.videos.find((v: any) => v.id === "teaser").shelved).toBe("string");
    expect(state.project.videos.find((v: any) => v.id === "teaser").versions).toHaveLength(1);
    expect(await logText(call)).not.toContain("restored");
  });

  it("does not say restored for a film that was in play", async () => {
    const { call, root } = await setup();
    const r = await call("POST", "/api/versions", { video: "hero", file: `${root}/renders/hero-2.mp4` });
    expect(r.json.restored).toBeUndefined();
  });
});
