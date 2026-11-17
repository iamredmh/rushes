import { describe, expect, it } from "vitest";
import { tmpProject } from "../helpers/tmp.js";
import { createApp } from "../../src/server/app.js";

async function setup() {
  const { store } = await tmpProject("lumen");
  const server = createApp(store, {});
  const call = async (method: string, path: string, json?: unknown) => {
    const res = await server.request(path, { method, headers: json === undefined ? undefined : { "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const sent = async () => {
    const { json } = await call("POST", "/api/notes", { stage: "script", scope: "whole", text: "Tighten the opening" });
    await call("POST", "/api/batches", { stage: "script" });
    return json.note.id as string;
  };
  return { store, call, sent };
}

describe("note reply threads over HTTP", () => {
  it("POST /api/notes/:id/replies appends the user's answer and announces it", async () => {
    const { store, call, sent } = await setup();
    const heard: unknown[] = [];
    store.on("user-reply", (e) => heard.push(e));
    const id = await sent();
    const res = await call("POST", `/api/notes/${id}/replies`, { text: "No full stop." });
    expect(res.status).toBe(201);
    expect(res.json.note.replies.at(-1)).toMatchObject({ by: "user", text: "No full stop." });
    expect(heard).toEqual([{ note: id, text: "No full stop." }]);
  });

  it("refuses an empty answer and an unknown note, announcing nothing", async () => {
    const { store, call, sent } = await setup();
    const heard: unknown[] = [];
    store.on("user-reply", (e) => heard.push(e));
    const id = await sent();
    expect((await call("POST", `/api/notes/${id}/replies`, { text: " " })).status).toBe(400);
    expect((await call("POST", "/api/notes/n_nope/replies", { text: "hi" })).status).toBe(404);
    expect(heard).toEqual([]);
  });

  it("GET /api/notes carries needsYou", async () => {
    const { call, sent } = await setup();
    const id = await sent();
    await call("POST", "/api/replies", { replies: [{ id, reply: "Which opening?" }] });
    const list = await call("GET", "/api/notes");
    expect(list.json.notes.find((n: { id: string }) => n.id === id)).toMatchObject({ state: "sent", needsYou: true });
    await call("POST", `/api/notes/${id}/replies`, { text: "The first." });
    const after = await call("GET", "/api/notes");
    expect(after.json.notes.find((n: { id: string }) => n.id === id).needsYou).toBe(false);
  });
});
