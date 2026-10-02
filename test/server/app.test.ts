import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "../../src/core/store.js";
import { tmpProject } from "../helpers/tmp.js";
import { createApp } from "../../src/server/app.js";
import { ProjectIdSchema } from "../../src/core/schema.js";

async function setup() {
  const { root, store } = await tmpProject("spring-launch");
  const app = createApp(store);
  const call = async (method: string, path: string, json?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: json === undefined ? {} : { "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { root, store, call };
}

describe("local-only guard", () => {
  it("rejects a Host that isn't 127.0.0.1 or localhost with 403", async () => {
    const { store } = await tmpProject();
    const app = createApp(store);
    const res = await app.request("/api/health", { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden_host", message: expect.any(String) });
    expect((await app.request("http://evil.example:4317/api/state")).status).toBe(403);
    expect((await app.request("/api/health", { headers: { host: "127.0.0.1:4317" } })).status).toBe(200);
    expect((await app.request("/api/health", { headers: { host: "localhost:9" } })).status).toBe(200);
  });

  it("returns 415 for a write that isn't application/json", async () => {
    const { store } = await tmpProject();
    const app = createApp(store);
    const res = await app.request("/api/notes", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ stage: "picture", scope: "point", t: 1, text: "x" }),
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ error: "unsupported_media_type" });
    expect((await store.read("notes")).notes).toHaveLength(0);
    expect((await app.request("/api/batches", { method: "POST" })).status).toBe(415);
  });

  it("rejects a write from a foreign Origin with 403 and accepts a local one", async () => {
    const { store } = await tmpProject();
    const app = createApp(store);
    const note = JSON.stringify({ stage: "picture", scope: "point", t: 1, text: "x" });
    const evil = await app.request("/api/notes", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: note });
    expect(evil.status).toBe(403);
    expect(await evil.json()).toMatchObject({ error: "forbidden_origin" });
    const local = await app.request("/api/notes", { method: "POST", headers: { "content-type": "application/json; charset=utf-8", origin: "http://localhost:4317" }, body: note });
    expect(local.status).toBe(201);
    expect((await store.read("notes")).notes).toHaveLength(1);
  });
});

describe("every project has an address", () => {
  it("GET / redirects to /p/<id>/", async () => {
    const { store } = await tmpProject();
    const app = createApp(store);
    const res = await app.request("/");
    expect(res.status).toBe(302);
    const id = (await store.read("project")).id!;
    expect(ProjectIdSchema.safeParse(id).success).toBe(true);
    expect(res.headers.get("location")).toBe(`/p/${id}/`);
  });

  it("GET /p/<id> (no trailing slash) redirects, adding the slash", async () => {
    const { store } = await tmpProject();
    const app = createApp(store);
    const { id } = (await (await app.request("/api/health")).json()) as { id: string };
    const res = await app.request(`/p/${id}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/p/${id}/`);
  });

  it("GET /p/<a well-shaped but foreign id> (no trailing slash) redirects to the slash route with that same id, not this project's own", async () => {
    const { store } = await tmpProject();
    const app = createApp(store);
    const { id: ownId } = (await (await app.request("/api/health")).json()) as { id: string };
    const res = await app.request("/p/zzzzzzzz");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/p/zzzzzzzz/");
    expect(res.headers.get("location")).not.toBe(`/p/${ownId}/`);
  });

  it("GET /p/<id with CRLF> (no trailing slash) never reflects it into Location: it gets the 404 page instead", async () => {
    const { store } = await tmpProject();
    const app = createApp(store);
    const res = await app.request(`/p/${encodeURIComponent("bad\r\nid")}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("isn't running on this port");
  });

  it("GET /p/<UPPERCASE> (no trailing slash) gives 404: the id shape is lower-case only", async () => {
    const { store } = await tmpProject();
    const app = createApp(store);
    const res = await app.request("/p/UPPERCASE");
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it("GET /p/<id>/ serves the placeholder page when the dashboard isn't built, with the root escaped", async () => {
    const { root } = await tmpProject();
    const odd = join(root, "<b>A&B</b>");
    const store = new Store(odd);
    await store.init("odd");
    const app = createApp(store, { webDir: join(root, "no-dashboard") });
    const { id } = (await (await app.request("/api/health")).json()) as { id: string };
    const res = await app.request(`/p/${id}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toBe(
      `<!doctype html><title>Rushes</title><p>Rushes is running for <code>${odd.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>. The dashboard isn't built: run <code>npm run build</code>.</p>`,
    );
    expect(html).not.toContain("<b>");
  });

  it("GET /p/<wrong-id>/ gives 404 and says the project isn't running on this port", async () => {
    const { store } = await tmpProject();
    const app = createApp(store);
    const res = await app.request("/p/zzzzzzzz/");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("isn't running on this port");
  });

  it("escapes a mismatched id that's echoed back", async () => {
    const { store } = await tmpProject();
    const app = createApp(store);
    const res = await app.request(`/p/${encodeURIComponent("<script>x</script>")}/`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("<script>x</script>");
  });

  it("health's id matches ProjectIdSchema and carries the project's name", async () => {
    const { store } = await tmpProject("spring-launch");
    const app = createApp(store);
    const json = (await (await app.request("/api/health")).json()) as { id: string; name: string };
    expect(ProjectIdSchema.safeParse(json.id).success).toBe(true);
    expect(json.name).toBe("spring-launch");
  });

  it("the project guard rejects a mismatching x-rushes-project header with 409, accepts the right one, and lets a request with none through", async () => {
    const { store } = await tmpProject();
    const app = createApp(store);
    const id = ((await (await app.request("/api/health")).json()) as { id: string }).id;
    const wrong = await app.request("/api/state", { headers: { "x-rushes-project": "wrongwrg" } });
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({ error: "wrong_project" });
    expect((await app.request("/api/state", { headers: { "x-rushes-project": id } })).status).toBe(200);
    expect((await app.request("/api/state")).status).toBe(200);
  });

  it("rejects a mismatching ?project= query param on /api/events with 409", async () => {
    const { store } = await tmpProject();
    const app = createApp(store);
    const res = await app.request("/api/events?project=wrongwrg");
    expect(res.status).toBe(409);
  });

  it("rejects a wrong project header on POST /api/notes with 409 and writes nothing", async () => {
    const { store } = await tmpProject();
    const app = createApp(store);
    const res = await app.request("/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json", "x-rushes-project": "wrongwrg" },
      body: JSON.stringify({ stage: "picture", scope: "point", t: 1, text: "x" }),
    });
    expect(res.status).toBe(409);
    expect((await store.read("notes")).notes).toHaveLength(0);
  });

  it("the project guard also covers /media and /assets", async () => {
    const { store } = await tmpProject();
    const app = createApp(store);
    expect((await app.request("/media?path=nope.mp4")).status).toBe(404); // no id: passes the guard, falls through to not-registered
    const wrongMedia = await app.request("/media?path=nope.mp4&project=wrongwrg");
    expect(wrongMedia.status).toBe(409);
    const wrongAssets = await app.request("/assets/app.js?project=wrongwrg");
    expect(wrongAssets.status).toBe(409);
  });

  it("lets any number of SSE clients listen without a warning", async () => {
    const { store } = await tmpProject();
    createApp(store);
    expect(store.getMaxListeners()).toBe(0);
  });
});

describe("API", () => {
  it("health names the app and the project root", async () => {
    const { call, root } = await setup();
    expect((await call("GET", "/api/health")).json).toMatchObject({ ok: true, app: "rushes", root });
  });

  it("state starts with every tab locked", async () => {
    const { call } = await setup();
    const { json } = await call("GET", "/api/state");
    expect(json.project.name).toBe("spring-launch");
    expect(json.tabs.every((t: any) => !t.unlocked)).toBe(true);
  });

  it("adding a version unlocks Picture and stores a relative path", async () => {
    const { call, root } = await setup();
    const r = await call("POST", "/api/versions", { video: "Hero 60s", file: `${root}/renders/hero v1.mp4`, note: "first cut" });
    expect(r.status).toBe(201);
    expect(r.json.version).toMatchObject({ id: "v1", file: "renders/hero v1.mp4", note: "first cut" });
    const tabs = (await call("GET", "/api/tabs")).json.tabs;
    expect(tabs.find((t: any) => t.stage === "picture").unlocked).toBe(true);
  });

  it("notes: create, list with filters, edit, reply", async () => {
    const { call } = await setup();
    const a = (await call("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 12.4, frame: 744, text: "Logo lands early" })).json.note;
    await call("POST", "/api/notes", { stage: "music", scope: "whole", on: "deep-house", text: "Make it 110 BPM" });
    expect((await call("GET", "/api/notes?stage=picture")).json.notes).toHaveLength(1);
    const edited = (await call("PATCH", `/api/notes/${a.id}`, { text: "Logo lands a beat early" })).json.note;
    expect(edited.text).toBe("Logo lands a beat early");
    const replied = (await call("POST", "/api/replies", { replies: [{ id: a.id, reply: "Held 0.5 s", status: "done", fixT: 12.9, fixVersion: "v2" }] })).json.notes[0];
    expect(replied).toMatchObject({ status: "done", reply: "Held 0.5 s", fixT: 12.9, text: "Logo lands a beat early" });
    expect((await call("GET", "/api/notes?status=todo")).json.notes).toHaveLength(1);
  });

  it("rejects bad input with 400 and an explanation, and unknown ids with 404", async () => {
    const { call } = await setup();
    const bad = await call("POST", "/api/notes", { stage: "picture", scope: "range", t: 5, tOut: 2, text: "x" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("invalid");
    expect(JSON.stringify(bad.json.issues)).toContain("tOut");
    expect((await call("GET", "/api/notes?stage=nope")).status).toBe(400);
    expect((await call("PATCH", "/api/notes/n_missing", { text: "x" })).status).toBe(404);
    expect((await call("POST", "/api/replies", { replies: [] })).status).toBe(400);
  });

  it("returns 500 with the file name when a data file is corrupt, and leaves it alone", async () => {
    const { call, store } = await setup();
    await writeFile(store.path("notes"), "{ not json", "utf8");
    const r = await call("POST", "/api/notes", { stage: "picture", scope: "point", t: 1, text: "x" });
    expect(r.status).toBe(500);
    expect(r.json).toMatchObject({ error: "corrupt_file", file: "notes.json" });
  });

  it("script: set sections, edit a row, add a take", async () => {
    const { call } = await setup();
    const set = await call("PUT", "/api/script", { sections: [{ start: 0, end: 13, current: "Your work lives on one laptop." }] });
    expect(set.json.sections[0].id).toBe("s1");
    const edit = await call("PATCH", "/api/script/s1", { proposed: "Your work lives on one machine.", status: "flagged" });
    expect(edit.json.section).toMatchObject({ proposed: "Your work lives on one machine.", status: "flagged" });
    const take = await call("POST", "/api/script/s1/takes", { file: "audio/vo_s1.wav" });
    expect(take.status).toBe(201);
    expect(take.json.take).toMatchObject({ id: "t1", forText: "Your work lives on one laptop." });
    expect((await call("PUT", "/api/script", { sections: [{ start: 0, end: 5, current: "a" }, { start: 4, end: 8, current: "b" }] })).status).toBe(400);
  });

  it("script: PUT merges by id unless replace is set, and GET returns the whole script", async () => {
    const { call } = await setup();
    await call("PUT", "/api/script", { sections: [{ start: 0, end: 10, current: "A" }, { start: 10, end: 20, current: "B" }] });
    await call("POST", "/api/script/s1/takes", { file: "audio/a.wav" });
    const merged = await call("PUT", "/api/script", { sections: [{ id: "s2", start: 10, end: 20, current: "B2" }] });
    expect(merged.status).toBe(200);
    expect(merged.json.sections.map((x: any) => [x.id, x.current])).toEqual([["s1", "A"], ["s2", "B2"]]);
    const got = await call("GET", "/api/script");
    expect(got.status).toBe(200);
    expect(got.json.script.wordsPerSecond).toBe(2.6);
    expect(got.json.script.sections[0].takes).toHaveLength(1);
    const replaced = await call("PUT", "/api/script", { replace: true, sections: [{ id: "s2", start: 0, end: 5, current: "B2" }] });
    expect(replaced.json.sections.map((x: any) => x.id)).toEqual(["s2"]);
    expect((await call("PUT", "/api/script", { replace: "yes", sections: [] })).status).toBe(400);
  });

  it("variants and picks", async () => {
    const { call } = await setup();
    const v = await call("POST", "/api/variants", { stage: "music", name: "Deep house", file: "audio/a.wav", meta: { bpm: 120 } });
    expect(v.json.variant.id).toBe("deep-house");
    const picks = await call("PUT", "/api/picks", { lanes: { music: "deep-house" } });
    expect(picks.json.lanes).toEqual({ music: "deep-house" });
  });

  it("batches: send the tab's open notes once, then 409 when nothing is left", async () => {
    const { call } = await setup();
    const n = (await call("POST", "/api/notes", { stage: "picture", scope: "point", t: 1, text: "x" })).json.note;
    const b = await call("POST", "/api/batches", { stage: "picture" });
    expect(b.status).toBe(201);
    expect(b.json.batch).toMatchObject({ id: "b_1", noteIds: [n.id] });
    expect((await call("POST", "/api/batches", { stage: "picture" })).status).toBe(409);
    const latest = await call("GET", "/api/batches/latest");
    expect(latest.json.batch.id).toBe("b_1");
    expect(latest.json.notes[0].batch).toBe("b_1");
    expect((await call("GET", "/api/batches/b_9")).status).toBe(404);
  });

  it("a note sent, marked done and reopened goes in the next batch", async () => {
    const { call } = await setup();
    const n = (await call("POST", "/api/notes", { stage: "picture", scope: "point", t: 1, text: "x" })).json.note;
    expect((await call("POST", "/api/batches", { stage: "picture" })).json.batch.noteIds).toEqual([n.id]);
    await call("POST", "/api/replies", { replies: [{ id: n.id, reply: "Fixed", status: "done" }] });
    await call("PATCH", `/api/notes/${n.id}`, { status: "todo" });
    const again = await call("POST", "/api/batches", { stage: "picture" });
    expect(again.status).toBe(201);
    expect(again.json.batch).toMatchObject({ id: "b_2", noteIds: [n.id] });
  });

  it("two batch requests at once get different ids and split the notes", async () => {
    const { call } = await setup();
    await call("POST", "/api/notes", { stage: "picture", scope: "point", t: 1, text: "x" });
    await call("POST", "/api/notes", { stage: "music", scope: "whole", text: "y" });
    const [a, b] = await Promise.all([call("POST", "/api/batches", { stage: "picture" }), call("POST", "/api/batches", { stage: "music" })]);
    expect(new Set([a.json.batch.id, b.json.batch.id]).size).toBe(2);
  });

  it("shots: sorts and renumbers", async () => {
    const { call, root } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4` });
    const r = await call("PUT", "/api/videos/hero/shots", { shots: [{ name: "B", start: 5 }, { name: "A", start: 1.7, tag: "ESTABLISH" }] });
    expect(r.status).toBe(200);
    expect(r.json.version.shots).toEqual([
      { n: 1, name: "A", start: 1.7, tag: "ESTABLISH" },
      { n: 2, name: "B", start: 5, tag: "" },
    ]);
  });

  it("shots: the video in the path can be its display name as well as its id", async () => {
    const { call, root } = await setup();
    await call("POST", "/api/versions", { video: "Hero 60s", file: `${root}/renders/hero.mp4` });
    const r = await call("PUT", "/api/videos/Hero%2060s/shots", { shots: [{ name: "A", start: 0 }] });
    expect(r.status).toBe(200);
    expect(r.json.version.shots).toEqual([{ n: 1, name: "A", start: 0, tag: "" }]);
  });

  it("shots: a 201st shot gives 400", async () => {
    const { call, root } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4` });
    const shots = Array.from({ length: 201 }, (_, i) => ({ name: `S${i}`, start: i }));
    expect((await call("PUT", "/api/videos/hero/shots", { shots })).status).toBe(400);
  });

  it("shots: an 81-character name gives 400", async () => {
    const { call, root } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4` });
    const r = await call("PUT", "/api/videos/hero/shots", { shots: [{ name: "x".repeat(81), start: 0 }] });
    expect(r.status).toBe(400);
  });

  it("shots: a duplicate start gives 400", async () => {
    const { call, root } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4` });
    const r = await call("PUT", "/api/videos/hero/shots", { shots: [{ name: "A", start: 1.7 }, { name: "B", start: 1.7 }] });
    expect(r.status).toBe(400);
  });

  it("lock: locks a video at a version, and locking an unknown version gives 404", async () => {
    const { call, root } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4` });
    const locked = await call("PUT", "/api/videos/hero/lock", { version: "v1" });
    expect(locked.status).toBe(200);
    expect(locked.json.video.lockedVersion).toBe("v1");
    expect((await call("PUT", "/api/videos/hero/lock", { version: "v9" })).status).toBe(404);
  });

  it("adding a cut to a locked video gives 201 with a warning", async () => {
    const { call, root } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4` });
    await call("PUT", "/api/videos/hero/lock", { version: "v1" });
    const r = await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero2.mp4` });
    expect(r.status).toBe(201);
    expect(r.json.version.id).toBe("v2");
    expect(r.json.warning).toBe("Picture is locked at v1");
  });

  it("a picture note is stamped with the shot it falls in, ignoring anything the client sent for shot", async () => {
    const { call, root } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4` });
    await call("PUT", "/api/videos/hero/shots", { shots: [{ name: "Title", start: 0 }, { name: "Window rises in", start: 1.7 }] });
    const onShot = await call("POST", "/api/notes", {
      stage: "picture", video: "hero", version: "v1", scope: "point", t: 1.7, text: "x",
      shot: { n: 9, name: "sneaked in" },
    });
    expect(onShot.json.note.shot).toEqual({ n: 2, name: "Window rises in" });
  });

  it("a script note gets shot: null", async () => {
    const { call } = await setup();
    const r = await call("POST", "/api/notes", { stage: "script", scope: "whole", text: "x" });
    expect(r.json.note.shot).toBeNull();
  });

  it("a picture note on a version with no shots gets shot: null", async () => {
    const { call, root } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4` });
    const r = await call("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1.7, text: "x" });
    expect(r.json.note.shot).toBeNull();
  });

  it("concurrent requests against a fresh app with no project id cause exactly one write, and agree on the id", async () => {
    const { store } = await tmpProject();
    const app = createApp(store);
    const before = await store.read("project");
    expect(before.id).toBeUndefined();
    const responses = await Promise.all(Array.from({ length: 8 }, () => app.request("/api/health")));
    const ids = await Promise.all(responses.map(async (r) => ((await r.json()) as { id: string }).id));
    expect(new Set(ids).size).toBe(1);
    expect(ProjectIdSchema.safeParse(ids[0]).success).toBe(true);
    const after = await store.read("project");
    expect(after.rev).toBe(before.rev + 1);
    expect(after.id).toBe(ids[0]);
  });
});
