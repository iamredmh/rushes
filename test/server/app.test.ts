import { describe, expect, it } from "vitest";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Store } from "../../src/core/store.js";
import { tmpProject } from "../helpers/tmp.js";
import { createApp, type AppOptions } from "../../src/server/app.js";
import type { LoudnessRunner } from "../../src/server/loudness.js";
import { ProjectIdSchema } from "../../src/core/schema.js";
import { addVersion } from "../../src/core/project.js";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Probe } from "../../src/core/media.js";
import { ProxyJobs, type FfmpegRunner } from "../../src/server/proxy.js";
import { startServer } from "../../src/server/start.js";
import { sse } from "../helpers/sse.js";

// The smallest valid PNG (1×1, transparent).
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function setup(opts: AppOptions = {}) {
  const { root, store } = await tmpProject("spring-launch");
  const app = createApp(store, opts);
  const call = async (method: string, path: string, json?: unknown, init: RequestInit = {}) => {
    const res = await app.request(path, {
      method,
      headers: json === undefined ? init.headers : { "content-type": "application/json", ...init.headers },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    let parsed: any = null;
    const text = await res.text();
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, json: parsed, headers: res.headers, res };
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

  it("a variant's description is stored as meta.description, merged with meta, and wins over meta's own", async () => {
    const { call } = await setup();
    const a = await call("POST", "/api/variants", { stage: "voice", name: "Gerald", file: "audio/g.wav", round: "Round 1", description: "Warmer, slower intro" });
    expect(a.status).toBe(201);
    expect(a.json.variant.meta).toEqual({ description: "Warmer, slower intro" });
    const b = await call("POST", "/api/variants", { stage: "music", name: "Bed", file: "audio/b.wav", meta: { bpm: 120, description: "old" }, description: "New" });
    expect(b.json.variant.meta).toEqual({ bpm: 120, description: "New" });
    const c = await call("POST", "/api/variants", { stage: "music", name: "Bed 2", file: "audio/b2.wav", meta: { description: "Kept" } });
    expect(c.json.variant.meta).toEqual({ description: "Kept" });
    expect((await call("POST", "/api/variants", { stage: "music", name: "Bed 3", file: "audio/b3.wav", description: "x".repeat(201) })).status).toBe(400);
  });

  it("a round name is capped at 64 characters, so its lane id always fits", async () => {
    const { call } = await setup();
    const ok = await call("POST", "/api/variants", { stage: "voice", name: "Gerald", file: "audio/g.wav", round: "R".repeat(64) });
    expect(ok.status).toBe(201);
    const long = await call("POST", "/api/variants", { stage: "voice", name: "Jane", file: "audio/j.wav", round: "R".repeat(65) });
    expect(long.status).toBe(400);
    expect(JSON.stringify(long.json)).toContain("round");
    // A name that grows when slugged (ligatures) still gets a lane id that fits.
    const lig = await call("POST", "/api/variants", { stage: "voice", name: "Louise", file: "audio/l.wav", round: "\uFB03".repeat(64) });
    expect(lig.status).toBe(201);
    expect(lig.json.lane.id.length).toBeLessThanOrEqual(64);
    const lane = await call("POST", "/api/variants", { stage: "music", name: "Bed", file: "audio/b.wav", lane: "m".repeat(90) });
    expect(lane.status).toBe(201);
    expect(lane.json.lane.id.length).toBeLessThanOrEqual(64);
  });

  it("picks: null clears a lane or section pick, and leaves the rest", async () => {
    const { call, store } = await setup();
    await call("PUT", "/api/picks", { lanes: { music: "deep-house", sfx: "pass-a", voice: "warm" }, sections: { s1: "t1", s2: "t3" } });
    const cleared = await call("PUT", "/api/picks", { lanes: { music: null, voice: null }, sections: { s2: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.json.lanes).toEqual({ sfx: "pass-a" });
    expect(cleared.json.sections).toEqual({ s1: "t1" });
    // Cleared keys are gone from disk, not saved as null: picks.json stays a map of strings.
    const saved = await store.read("picks");
    expect(saved.lanes).toEqual({ sfx: "pass-a" });
    expect(Object.keys(saved.sections)).toEqual(["s1"]);
    // Clearing what isn't picked is a no-op, and a set and a clear can share one request.
    const mixed = await call("PUT", "/api/picks", { lanes: { music: null, sfx: "pass-b" }, sections: { s9: null } });
    expect(mixed.json.lanes).toEqual({ sfx: "pass-b" });
    expect(mixed.json.sections).toEqual({ s1: "t1" });
    // Anything other than a string or null is still refused.
    expect((await call("PUT", "/api/picks", { lanes: { music: 3 } })).status).toBe(400);
    expect((await call("PUT", "/api/picks", { sections: { s1: false } })).status).toBe(400);
  });

  it("picks: levels (§19.6) are set, range/step-checked, and null resets to 0", async () => {
    const { call, store } = await setup();
    const set = await call("PUT", "/api/picks", { levels: { music: -14 } });
    expect(set.status).toBe(200);
    expect(set.json.levels).toEqual({ music: -14 });
    // Out of range, and off the 0.5 dB step, are both refused -- nothing is saved either time.
    expect((await call("PUT", "/api/picks", { levels: { music: -30 } })).status).toBe(400);
    expect((await call("PUT", "/api/picks", { levels: { music: -13.3 } })).status).toBe(400);
    expect((await call("PUT", "/api/picks", { levels: { voice: 6.5 } })).status).toBe(400);
    const unchanged = await store.read("picks");
    expect(unchanged.levels).toEqual({ music: -14 });
    // Other lanes, and a set and a clear sharing one request.
    const more = await call("PUT", "/api/picks", { levels: { voice: 6, sfx: null, music: -24 } });
    expect(more.json.levels).toEqual({ voice: 6, music: -24 });
    // null resets to 0, which means the key is gone from disk -- same rule as lanes/sections.
    const cleared = await call("PUT", "/api/picks", { levels: { music: null } });
    expect(cleared.json.levels).toEqual({ voice: 6 });
    const saved = await store.read("picks");
    expect(Object.keys(saved.levels)).toEqual(["voice"]);
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

describe("GET /api/assets", () => {
  it("lists registered media and filters by kind", async () => {
    const { call, root } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4` });
    await call("POST", "/api/variants", { stage: "music", name: "Deep house", file: "audio/a.wav" });
    const all = await call("GET", "/api/assets");
    expect(all.status).toBe(200);
    expect(all.json.assets.map((a: any) => a.kind).sort()).toEqual(["cut", "music"]);
    const cuts = await call("GET", "/api/assets?kind=cut");
    expect(cuts.json.assets).toHaveLength(1);
    expect(cuts.json.assets[0]).toMatchObject({ kind: "cut", video: "hero", version: "v1" });
  });

  it("reports a cut whose file is gone from disk as missing", async () => {
    const { call } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: "renders/gone.mp4" });
    const r = await call("GET", "/api/assets");
    expect(r.json.assets[0]).toMatchObject({ missing: true, size: null, modified: null });
  });
});

describe("POST /api/reveal", () => {
  async function withRevealer() {
    const revealed: string[] = [];
    const fake = async (abs: string) => { revealed.push(abs); };
    const { store, root } = await tmpProject("reveal");
    const app = createApp(store, { reveal: fake });
    const call = async (method: string, path: string, json?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: json === undefined ? {} : { "content-type": "application/json" },
        body: json === undefined ? undefined : JSON.stringify(json),
      });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    };
    await mkdir(join(root, "renders"), { recursive: true });
    await writeFile(join(root, "renders", "hero.mp4"), "x");
    await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mp4" });
    return { call, root, revealed };
  }

  it("calls the revealer with the asset's absolute path for a listed asset", async () => {
    const { call, root, revealed } = await withRevealer();
    const r = await call("POST", "/api/reveal", { path: "renders/hero.mp4" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(revealed).toEqual([join(root, "renders", "hero.mp4")]);
  });

  it("404s on traversal, an absolute path, an unregistered path and a path that only looks safe, never calling the revealer", async () => {
    const { call, revealed } = await withRevealer();
    const bad = ["../../etc/passwd", "/etc/passwd", "renders/not-registered.mp4", "screenshots/../.rushes/notes.json"];
    for (const path of bad) {
      expect((await call("POST", "/api/reveal", { path })).status).toBe(404);
    }
    expect(revealed).toEqual([]);
  });

  it("404s for a registered file that's missing from disk, without calling the revealer", async () => {
    const { call, revealed } = await withRevealer();
    await call("POST", "/api/versions", { video: "Hero", file: "renders/missing-take.mp4" });
    const r = await call("POST", "/api/reveal", { path: "renders/missing-take.mp4" });
    expect(r.status).toBe(404);
    expect(revealed).toEqual([]);
  });

  it("{ project: true } reveals the project root, with no listed-path check", async () => {
    const { call, root, revealed } = await withRevealer();
    const r = await call("POST", "/api/reveal", { project: true });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(revealed).toEqual([root]);
  });
});

describe("POST /api/open", () => {
  async function withOpener() {
    const opened: string[] = [];
    const fake = async (abs: string) => { opened.push(abs); };
    const { store, root, call: baseCall } = await setup({ open: fake });
    await mkdir(join(root, "renders"), { recursive: true });
    await writeFile(join(root, "renders", "hero.mp4"), "x");
    await writeFile(join(root, "brief.md"), "# brief");
    await baseCall("POST", "/api/versions", { video: "Hero", file: "renders/hero.mp4" });
    await baseCall("POST", "/api/files", { kind: "edit", file: "evil.command", name: "evil" });
    return { call: baseCall, root, store, opened };
  }

  it("calls the opener with a listed .md's absolute path", async () => {
    const { call, root, opened } = await withOpener();
    const r = await call("POST", "/api/open", { path: "brief.md" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(opened).toEqual([join(root, "brief.md")]);
  });

  it("returns 415 unsafe_type for a registered but unsafe extension, and never calls the opener (no stat needed: evil.command doesn't exist on disk)", async () => {
    const { call, opened } = await withOpener();
    const r = await call("POST", "/api/open", { path: "evil.command" });
    expect(r.status).toBe(415);
    expect(r.json).toMatchObject({ error: "unsafe_type" });
    expect(opened).toEqual([]);
  });

  it("returns 404 for an unlisted .md, never calling the opener", async () => {
    const { call, opened } = await withOpener();
    const r = await call("POST", "/api/open", { path: "unlisted.md" });
    expect(r.status).toBe(404);
    expect(opened).toEqual([]);
  });

  it("returns 404 for a listed, safe path that's missing from disk", async () => {
    const { call, opened } = await withOpener();
    const added = await call("POST", "/api/files", { kind: "doc", file: "gone.md" });
    const r = await call("POST", "/api/open", { path: added.json.file });
    expect(r.status).toBe(404);
    expect(opened).toEqual([]);
  });

  it("refuses a registered .svg with 415, never calling the opener", async () => {
    const { call, root, opened } = await withOpener();
    await writeFile(join(root, "icon.svg"), "<svg></svg>");
    await call("POST", "/api/files", { kind: "image", file: "icon.svg" });
    const r = await call("POST", "/api/open", { path: "icon.svg" });
    expect(r.status).toBe(415);
    expect(r.json).toMatchObject({ error: "unsafe_type" });
    expect(opened).toEqual([]);
  });

  it("refuses a registered file that's a symlink to a directory, never calling the opener", async () => {
    const { call, root, opened } = await withOpener();
    await mkdir(join(root, "bundle.app"), { recursive: true });
    await symlink(join(root, "bundle.app"), join(root, "brief2.md"));
    await call("POST", "/api/files", { kind: "doc", file: "brief2.md" });
    const r = await call("POST", "/api/open", { path: "brief2.md" });
    expect(r.status).toBe(415);
    expect(r.json).toMatchObject({ error: "unsafe_type" });
    expect(opened).toEqual([]);
  });

  it("refuses a registered file that's a symlink to a regular, safe file -- no links at all", async () => {
    const { call, root, opened } = await withOpener();
    await writeFile(join(root, "real.md"), "# real");
    await symlink(join(root, "real.md"), join(root, "linked.md"));
    await call("POST", "/api/files", { kind: "doc", file: "linked.md" });
    const r = await call("POST", "/api/open", { path: "linked.md" });
    expect(r.status).toBe(415);
    expect(r.json).toMatchObject({ error: "unsafe_type" });
    expect(opened).toEqual([]);
  });

  it("refuses a registered real directory whose name merely ends in .md", async () => {
    const { call, root, opened } = await withOpener();
    await mkdir(join(root, "x.md"), { recursive: true });
    await call("POST", "/api/files", { kind: "doc", file: "x.md" });
    const r = await call("POST", "/api/open", { path: "x.md" });
    expect(r.status).toBe(415);
    expect(r.json).toMatchObject({ error: "unsafe_type" });
    expect(opened).toEqual([]);
  });

  it("refuses a registered, safe-extension file with any execute bit set (M6)", async () => {
    const { call, root, opened } = await withOpener();
    await writeFile(join(root, "runnable.md"), "# not actually safe");
    await chmod(join(root, "runnable.md"), 0o755);
    await call("POST", "/api/files", { kind: "doc", file: "runnable.md" });
    const r = await call("POST", "/api/open", { path: "runnable.md" });
    if (process.platform === "win32") {
      // No execute bit to check on Windows -- the mode check is skipped there.
      expect(r.status).toBe(200);
      expect(opened).toEqual([join(root, "runnable.md")]);
    } else {
      expect(r.status).toBe(415);
      expect(r.json).toMatchObject({ error: "unsafe_type" });
      expect(opened).toEqual([]);
    }
  });

  it("still opens a registered, safe-extension file with no execute bit set", async () => {
    const { call, root, opened } = await withOpener();
    await writeFile(join(root, "readable.md"), "# fine");
    await chmod(join(root, "readable.md"), 0o644);
    await call("POST", "/api/files", { kind: "doc", file: "readable.md" });
    const r = await call("POST", "/api/open", { path: "readable.md" });
    expect(r.status).toBe(200);
    expect(opened).toEqual([join(root, "readable.md")]);
  });
});

describe("GET /media?download=1", () => {
  async function withFile(name: string) {
    const { call, root, store } = await setup();
    await mkdir(join(root, "renders"), { recursive: true });
    await writeFile(join(root, "renders", name), "x");
    await call("POST", "/api/versions", { video: "Hero", file: `renders/${name}` });
    return { call, store };
  }

  it("adds Content-Disposition with an ASCII fallback and a UTF-8 percent-encoded name", async () => {
    const { call } = await withFile("clip with spaces.mp4");
    const r = await call("GET", "/media?path=renders%2Fclip%20with%20spaces.mp4&download=1");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toBe(
      `attachment; filename="clip with spaces.mp4"; filename*=UTF-8''${encodeURIComponent("clip with spaces.mp4")}`,
    );
  });

  it("replaces non-ASCII characters, quotes and backslashes in the ASCII fallback with _", async () => {
    // café "clip"\.mp4 -- é, both quotes and the backslash each become _ in the fallback only.
    const name = 'café "clip"\\.mp4';
    const { call } = await withFile(name);
    const r = await call("GET", `/media?path=${encodeURIComponent(`renders/${name}`)}&download=1`);
    expect(r.status).toBe(200);
    const disposition = r.headers.get("content-disposition")!;
    expect(disposition).toContain('filename="caf_ _clip__.mp4"');
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent(name)}`);
  });

  it("doesn't add Content-Disposition without download=1", async () => {
    const { call } = await withFile("clip.mp4");
    const r = await call("GET", "/media?path=renders%2Fclip.mp4");
    expect(r.headers.get("content-disposition")).toBeNull();
  });

  it("a file name containing a newline still gets a clean header instead of a 500 (Headers.set would otherwise throw)", async () => {
    const name = "evil\nfile.mp4";
    let s: Awaited<ReturnType<typeof withFile>>;
    try {
      s = await withFile(name);
    } catch {
      // Some filesystems refuse a newline in a file name: fall back to checking contentDisposition
      // itself, which is exercised directly in test/server/files.test.ts.
      return;
    }
    const r = await s.call("GET", `/media?path=${encodeURIComponent(`renders/${name}`)}&download=1`);
    expect(r.status).toBe(200);
    const disposition = r.headers.get("content-disposition")!;
    expect(disposition).not.toContain("\n");
    expect(disposition).toContain('filename="evil_file.mp4"');
  });
});

describe("POST /api/files", () => {
  it("registers a file and it appears in /api/assets under its kind", async () => {
    const { call } = await setup();
    const r = await call("POST", "/api/files", { kind: "doc", file: "brief.md", name: "Creative brief", note: "v2" });
    expect(r.status).toBe(201);
    // The manifest entry itself still keeps the display name the caller gave it.
    expect(r.json).toMatchObject({ kind: "doc", file: "brief.md", name: "Creative brief", note: "v2", video: null });
    // But the asset served to the dashboard keeps `name` as the file's own basename -- Save-as,
    // Open and the extension checks all read it -- and carries the display name in `label` (I2).
    const assets = await call("GET", "/api/assets?kind=doc");
    expect(assets.json.assets).toMatchObject([{ path: "brief.md", name: "brief.md", label: "Creative brief", note: "v2" }]);
  });

  it("resolves video by name and rejects an unknown one", async () => {
    const { call } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mp4" });
    const ok = await call("POST", "/api/files", { kind: "delivery", file: "exports/hero.mov", video: "Hero" });
    expect(ok.json.video).toBe("hero");
    const bad = await call("POST", "/api/files", { kind: "delivery", file: "exports/x.mov", video: "nope" });
    expect(bad.status).toBe(404);
  });
});

describe("POST /api/exports/notes", () => {
  it("writes exports/<slug>-notes-<date>.md and the file then appears under kind export", async () => {
    const { call, root } = await setup();
    await call("POST", "/api/notes", { stage: "mix", scope: "whole", text: "Loudness check" });
    const r = await call("POST", "/api/exports/notes", {});
    expect(r.status).toBe(201);
    expect(r.json.path).toMatch(/^exports\/spring-launch-notes-\d{4}-\d{2}-\d{2}\.md$/);
    const written = await readFile(join(root, r.json.path), "utf8");
    expect(written).toContain("# spring-launch — notes");
    expect(written).toContain("Loudness check");
    const assets = await call("GET", "/api/assets?kind=export");
    expect(assets.json.assets.map((a: { path: string }) => a.path)).toContain(r.json.path);
  });

  it("exporting again the same day overwrites the file rather than leaving two", async () => {
    const { call, root } = await setup();
    await call("POST", "/api/exports/notes", {});
    const second = await call("POST", "/api/exports/notes", {});
    const { readdir } = await import("node:fs/promises");
    const names = (await readdir(join(root, "exports"))).filter((n) => n.endsWith(".md"));
    // §22.7 (R17): the change log written beside the notes is replaced the same way.
    expect(names.sort()).toEqual([basename(second.json.path), basename(second.json.changeLog)].sort());
  });

  it("two concurrent exports in the same process don't race each other's temp file (M1)", async () => {
    const { call, root } = await setup();
    // Same pid for both, since they're the same test process -- only a random temp name tells
    // them apart. Both must still succeed and leave one valid file.
    const [a, b] = await Promise.all([call("POST", "/api/exports/notes", {}), call("POST", "/api/exports/notes", {})]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const written = await readFile(join(root, a.json.path), "utf8");
    expect(written).toContain("notes");
  });
});

describe("POST /api/mix/loudness (§17.6)", () => {
  const EBUR128 = "  Integrated loudness:\n    I:         -20.0 LUFS\n\n  True peak:\n    Peak:      -6.0 dBFS\n";

  async function withVariant(run: LoudnessRunner, opts: Partial<AppOptions> = {}) {
    const { call, root } = await setup({ loudnessRunner: run, ...opts });
    await mkdir(join(root, "audio"), { recursive: true });
    await writeFile(join(root, "audio", "a.wav"), "not real audio");
    await call("POST", "/api/variants", { stage: "music", name: "Deep house", file: "audio/a.wav" });
    // Only picked variants are measured, as only they play on Mix (I2).
    await call("PUT", "/api/picks", { lanes: { music: "deep-house" } });
    return { call };
  }

  it("measures nothing on a lane with nothing picked, as Mix plays nothing there (I2)", async () => {
    const calls: string[][] = [];
    const run: LoudnessRunner = async (args) => {
      calls.push(args);
      return args[0] === "-version" ? { code: 0, stderr: "" } : { code: 0, stderr: EBUR128 };
    };
    const { call } = await withVariant(run);
    await call("PUT", "/api/picks", { lanes: { music: null } });
    const r = await call("POST", "/api/mix/loudness", { lanes: ["music"] });
    expect(r.json).toEqual({ available: true, integrated: null, truePeak: null, musicUnderVo: null, silent: false });
    expect(calls.filter((a) => a[0] !== "-version")).toEqual([]);
  });

  it("returns the measured loudness, available: true", async () => {
    const run: LoudnessRunner = async (args) => (args[0] === "-version" ? { code: 0, stderr: "" } : { code: 0, stderr: EBUR128 });
    const { call } = await withVariant(run);
    const r = await call("POST", "/api/mix/loudness", { lanes: ["music"] });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ available: true, integrated: -20, truePeak: -6, musicUnderVo: null, silent: false });
  });

  it("applies the lane's saved level before measuring (§19.6)", async () => {
    const calls: string[][] = [];
    const run: LoudnessRunner = async (args) => {
      calls.push(args);
      return args[0] === "-version" ? { code: 0, stderr: "" } : { code: 0, stderr: EBUR128 };
    };
    const { call } = await withVariant(run);
    await call("PUT", "/api/picks", { levels: { music: -14 } });
    await call("POST", "/api/mix/loudness", { lanes: ["music"] });
    const filter = calls.find((a) => a[0] !== "-version")!;
    expect(filter.join(" ")).toContain("volume=-14dB");
  });

  it("caches: the runner isn't called again for a second, identical request", async () => {
    let calls = 0;
    const run: LoudnessRunner = async (args) => {
      calls++;
      return args[0] === "-version" ? { code: 0, stderr: "" } : { code: 0, stderr: EBUR128 };
    };
    const { call } = await withVariant(run);
    await call("POST", "/api/mix/loudness", { lanes: ["music"] });
    const callsAfterFirst = calls;
    const second = await call("POST", "/api/mix/loudness", { lanes: ["music"] });
    expect(second.json).toEqual({ available: true, integrated: -20, truePeak: -6, musicUnderVo: null, silent: false });
    expect(calls).toBe(callsAfterFirst);
  });

  it("returns { available: false } when ffmpeg is missing", async () => {
    const run: LoudnessRunner = async () => ({ code: 1, stderr: "ffmpeg: command not found" });
    const { call } = await withVariant(run);
    const r = await call("POST", "/api/mix/loudness", { lanes: ["music"] });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ available: false });
  });

  it("returns silence as null + silent: true, not a bare -Infinity (I1)", async () => {
    const silentSummary = "  Integrated loudness:\n    I:         -inf LUFS\n\n  True peak:\n    Peak:       -inf dBFS\n";
    const run: LoudnessRunner = async (args) => (args[0] === "-version" ? { code: 0, stderr: "" } : { code: 0, stderr: silentSummary });
    const { call } = await withVariant(run);
    const r = await call("POST", "/api/mix/loudness", { lanes: ["music"] });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ available: true, integrated: null, truePeak: null, musicUnderVo: null, silent: true });
  });

  it("returns 504 and aborts the runner's signal when a run hangs past the timeout (C1)", async () => {
    let aborted = false;
    const run: LoudnessRunner = (args, signal) => {
      if (args[0] === "-version") return Promise.resolve({ code: 0, stderr: "" });
      return new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          setTimeout(() => resolve({ code: 137, stderr: "" }), 0);
        });
      });
    };
    const { call } = await withVariant(run, { loudnessTimeoutMs: 50 });
    const r = await call("POST", "/api/mix/loudness", { lanes: ["music"] });
    expect(r.status).toBe(504);
    expect(r.json).toMatchObject({ error: "loudness_timeout" });
    expect(aborted).toBe(true);
  });
});

// ---- §19.5 proxies: routes, state, settings and the frame endpoint ----

const hasBin = (bin: string) => {
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const HAS_FFMPEG = hasBin("ffmpeg") && hasBin("ffprobe");

const PRORES_4K: Probe = { duration: 2, fps: 25, codec: "prores", width: 3840, height: 2160, pixFmt: "yuv422p10le" };
const H264_1080: Probe = { duration: 2, fps: 25, codec: "h264", width: 1920, height: 1080, pixFmt: "yuv420p" };

/**
 * A stand-in ffmpeg that writes its output and then waits for `hold` (or a kill). An encode's last
 * argument is the .mp4 it writes; a frame extraction's is `pipe:1`, so it answers with a PNG on
 * stdout instead, and never writes a file of that name into the working directory.
 */
function holdingRunner(hold: Promise<void> = Promise.resolve()): FfmpegRunner {
  return async (args, o = {}) => {
    if (args[0] === "-version") return { code: 0, stderr: "" };
    const out = args[args.length - 1];
    if (!out.endsWith(".mp4")) {
      o.onStdout?.(Buffer.from(PNG_1PX, "base64"));
      return { code: 0, stderr: "" };
    }
    await writeFile(out, "proxy bytes");
    o.onStdout?.(Buffer.from("out_time_us=1000000\n"));
    const killed = await Promise.race([
      hold.then(() => false),
      new Promise<boolean>((res) => o.signal?.addEventListener("abort", () => res(true))),
    ]);
    return { code: killed ? 255 : 0, stderr: "" };
  };
}

async function proxySetup(opts: { hold?: Promise<void>; available?: boolean; probe?: (abs: string) => Promise<Probe> } = {}) {
  const { root, store } = await tmpProject("spring-launch");
  const jobs = new ProxyJobs(store, {
    run: holdingRunner(opts.hold),
    probe: opts.probe ?? (async (abs) => (abs.endsWith("_proxy.mp4") ? H264_1080 : PRORES_4K)),
    available: async () => opts.available ?? true,
  });
  const ctx = await setupWith(store, { proxyJobs: jobs });
  await mkdir(join(root, "renders"), { recursive: true });
  await writeFile(join(root, "renders", "hero.mov"), "original");
  return { ...ctx, root, store, jobs };
}

async function setupWith(store: Store, opts: AppOptions) {
  const app = createApp(store, opts);
  const call = async (method: string, path: string, json?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: json === undefined ? undefined : { "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, json: parsed, headers: res.headers };
  };
  return { app, call };
}

describe("proxies (§19.5)", () => {
  it("POST …/proxy starts one job per cut: 202, then 200 joining it (Review Focus 2)", async () => {
    const hold = gateOpen();
    const { call, jobs } = await proxySetup({ hold: hold.promise });
    await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mov" });
    const first = await call("POST", "/api/videos/hero/versions/v1/proxy", {});
    expect(first.status).toBe(202);
    expect(first.json.job).toMatchObject({ video: "hero", version: "v1", state: "running", pct: 0, id: expect.any(String) });
    const second = await call("POST", "/api/videos/hero/versions/v1/proxy", {});
    expect(second.status).toBe(200);
    expect(second.json.job.id).toBe(first.json.job.id);
    hold.open();
    expect((await jobs.wait(first.json.job.id)).state).toBe("done");
  });

  it("the finished proxy is recorded on the version and served by /media", async () => {
    const { call, jobs, store } = await proxySetup();
    await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mov" });
    const { json } = await call("POST", "/api/videos/hero/versions/v1/proxy", {});
    await jobs.wait(json.job.id);
    const v = (await store.read("project")).videos[0].versions[0];
    expect(v.proxy).toMatchObject({ file: "proxies/hero_v1_proxy.mp4", width: 1920, height: 1080, bytes: "proxy bytes".length, createdAt: expect.any(String) });
    const media = await call("GET", "/media?path=proxies%2Fhero_v1_proxy.mp4");
    expect(media.status).toBe(200);
    expect(media.headers.get("content-type")).toBe("video/mp4");
  });

  it("404s for an unknown film or cut", async () => {
    const { call } = await proxySetup();
    await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mov" });
    expect((await call("POST", "/api/videos/nope/versions/v1/proxy", {})).status).toBe(404);
    expect((await call("POST", "/api/videos/hero/versions/v9/proxy", {})).status).toBe(404);
    expect((await call("GET", "/api/videos/hero/versions/v9/frame?t=0")).status).toBe(404);
  });

  it("DELETE /api/proxy-jobs/:job cancels it; an unknown job is 404", async () => {
    const { call, root } = await proxySetup({ hold: new Promise(() => undefined) });
    await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mov" });
    const { json } = await call("POST", "/api/videos/hero/versions/v1/proxy", {});
    while (!existsSync(join(root, "proxies", "hero_v1_proxy.partial.mp4"))) await new Promise((r) => setTimeout(r, 5));
    const r = await call("DELETE", `/api/proxy-jobs/${json.job.id}`, {});
    expect(r.status).toBe(200);
    expect(r.json.job).toMatchObject({ id: json.job.id, state: "cancelled" });
    expect(existsSync(join(root, "proxies", "hero_v1_proxy.partial.mp4"))).toBe(false);
    expect((await call("DELETE", `/api/proxy-jobs/${json.job.id}`, {})).status).toBe(404);
  });

  it("DELETE …/proxy removes the file and the record, never the original", async () => {
    const { call, jobs, store, root } = await proxySetup();
    await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mov" });
    const { json } = await call("POST", "/api/videos/hero/versions/v1/proxy", {});
    await jobs.wait(json.job.id);
    const r = await call("DELETE", "/api/videos/hero/versions/v1/proxy", {});
    expect(r.status).toBe(200);
    expect(r.json.version).toMatchObject({ id: "v1", proxy: null });
    expect((await store.read("project")).videos[0].versions[0].proxy).toBeNull();
    expect(existsSync(join(root, "proxies", "hero_v1_proxy.mp4"))).toBe(false);
    expect(existsSync(join(root, "renders", "hero.mov"))).toBe(true);
    expect((await call("DELETE", "/api/videos/hero/versions/v1/proxy", {})).status).toBe(404);
  });

  it("PUT /api/project/settings saves autoProxy; anything else is 400", async () => {
    const { call, store } = await proxySetup();
    expect((await store.read("project")).autoProxy).toBe(false);
    const r = await call("PUT", "/api/project/settings", { autoProxy: true });
    expect(r).toMatchObject({ status: 200, json: { autoProxy: true } });
    expect((await store.read("project")).autoProxy).toBe(true);
    expect((await call("PUT", "/api/project/settings", { autoProxy: "yes" })).status).toBe(400);
    expect((await call("PUT", "/api/project/settings", { autoProxy: true, fps: 12 })).status).toBe(400);
  });

  it("adding a cut that needs one says so; with autoProxy on, its job starts at once", async () => {
    const hold = gateOpen();
    const { call, jobs } = await proxySetup({ hold: hold.promise });
    const off = await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mov" });
    expect(off.status).toBe(201);
    expect(off.json).toMatchObject({ proxySuggested: true, proxyReason: "It's a 4K ProRes file, which browsers struggle with" });
    expect(off.json.proxyJob).toBeUndefined();
    expect(jobs.list()).toEqual([]);

    await call("PUT", "/api/project/settings", { autoProxy: true });
    const on = await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mov" });
    expect(on.json).toMatchObject({ proxySuggested: true, proxyJob: { video: "hero", version: "v2", state: "running" } });
    expect(jobs.list()).toEqual([expect.objectContaining({ video: "hero", version: "v2" })]);
    hold.open();
    await jobs.wait(on.json.proxyJob.id);
  });

  it("a cut that plays fine gets no suggestion, and autoProxy leaves it alone", async () => {
    const { call, jobs } = await proxySetup({ probe: async () => H264_1080 });
    await call("PUT", "/api/project/settings", { autoProxy: true });
    const r = await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mov" });
    expect(r.json.proxySuggested).toBeUndefined();
    expect(r.json.proxyReason).toBeUndefined();
    expect(jobs.list()).toEqual([]);
  });

  it("GET /api/state carries proxyNeed per version, probed once per file revision", async () => {
    let probes = 0;
    const { call, root } = await proxySetup({
      probe: async (abs) => {
        probes++;
        return abs.endsWith("hero.mov") ? PRORES_4K : H264_1080;
      },
    });
    await writeFile(join(root, "renders", "small.mp4"), "small");
    await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mov" });
    await call("POST", "/api/versions", { video: "Hero", file: "renders/small.mp4" });
    await call("POST", "/api/versions", { video: "Hero", file: "renders/gone.mp4" });
    const before = probes;
    const s1 = await call("GET", "/api/state");
    const s2 = await call("GET", "/api/state");
    expect(probes).toBe(before);
    for (const s of [s1, s2]) {
      expect(s.json.project.videos[0].versions.map((v: any) => v.proxyNeed)).toEqual(["It's a 4K ProRes file, which browsers struggle with", null, null]);
      expect(s.json.proxies).toEqual({ ffmpeg: true, jobs: [] });
    }
    // A new render at the same path is a new revision: probed again, once.
    await writeFile(join(root, "renders", "small.mp4"), "a bigger re-render of the small cut");
    await call("GET", "/api/state");
    await call("GET", "/api/state");
    expect(probes).toBe(before + 1);
  });

  it("without ffmpeg: proxyNeed is null, nothing is suggested, and the routes say no_ffmpeg (501)", async () => {
    const { call } = await proxySetup({ available: false });
    const add = await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mov" });
    expect(add.status).toBe(201);
    expect(add.json.proxySuggested).toBeUndefined();
    const state = await call("GET", "/api/state");
    expect(state.json.project.videos[0].versions[0].proxyNeed).toBeNull();
    expect(state.json.proxies).toEqual({ ffmpeg: false, jobs: [] });
    const post = await call("POST", "/api/videos/hero/versions/v1/proxy", {});
    expect(post.status).toBe(501);
    expect(post.json).toMatchObject({ error: "no_ffmpeg", message: expect.stringContaining("ffmpeg") });
    const frame = await call("GET", "/api/videos/hero/versions/v1/frame?t=0");
    expect(frame.status).toBe(501);
    expect(frame.json.error).toBe("no_ffmpeg");
  });

  it("the frame endpoint rejects a bad t", async () => {
    const { call } = await proxySetup();
    await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mov" });
    expect((await call("GET", "/api/videos/hero/versions/v1/frame")).status).toBe(400);
    expect((await call("GET", "/api/videos/hero/versions/v1/frame?t=-1")).status).toBe(400);
    expect((await call("GET", "/api/videos/hero/versions/v1/frame?t=abc")).status).toBe(400);
  });

  it("the frame endpoint says when the original is missing", async () => {
    const { call } = await proxySetup();
    await call("POST", "/api/versions", { video: "Hero", file: "renders/gone.mov" });
    const r = await call("GET", "/api/videos/hero/versions/v1/frame?t=0");
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ error: "missing_file", message: "The original file is missing" });
  });

  it("broadcasts progress to every tab as an SSE proxy event", async () => {
    const { root } = await tmpProject();
    await mkdir(join(root, "renders"), { recursive: true });
    await writeFile(join(root, "renders", "hero.mov"), "original");
    const proxy = { run: holdingRunner(), probe: async (abs: string) => (abs.endsWith("_proxy.mp4") ? H264_1080 : PRORES_4K), available: async () => true };
    const s = await startServer(root, { port: 0, proxy });
    try {
      const a = await sse(s.url);
      const b = await sse(s.url);
      await a.until("hello");
      await b.until("hello");
      await fetch(`${s.url}/api/versions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ video: "Hero", file: "renders/hero.mov" }) });
      const r = await (await fetch(`${s.url}/api/videos/hero/versions/v1/proxy`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
      for (const tab of [a, b]) {
        const text = await tab.until('"state":"done"');
        expect(text).toContain("event: proxy");
        expect(text).toContain(JSON.stringify({ job: r.job.id, video: "hero", version: "v1", pct: 50, state: "running" }));
        expect(text).toContain(JSON.stringify({ job: r.job.id, video: "hero", version: "v1", pct: 100, state: "done" }));
        tab.stop();
      }
    } finally {
      await s.close();
    }
  });
});

describe.skipIf(!HAS_FFMPEG)("the frame endpoint, with real ffmpeg", () => {
  /** Width and height from a PNG's IHDR chunk. */
  const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
  /** Frame `n` of `file`, decoded to raw RGB by a select filter: the reference the endpoint must match. */
  const rgbOfFrame = (file: string, n: number) =>
    execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 << 20 });
  const rgbOfPng = (png: Buffer) => execFileSync("ffmpeg", ["-v", "error", "-f", "png_pipe", "-i", "-", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { input: png, maxBuffer: 64 << 20 });

  it("returns the original's exact frame as a PNG at the original's size, which saves as a grab", async () => {
    const { root, store } = await tmpProject();
    await mkdir(join(root, "renders"));
    const orig = join(root, "renders", "hero.mov");
    execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30000/1001:duration=2", "-c:v", "prores_ks", "-profile:v", "1", orig]);
    const { call, app } = await setupWith(store, {});
    const add = await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mov" });
    expect(add.json.version.fps).toBeCloseTo(29.97, 2);

    // t = 0.45 s at 29.97 fps is frame round(13.49) = 13.
    const res = await app.request("/api/videos/hero/versions/v1/frame?t=0.45");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-rushes-frame")).toBe("13");
    const png = Buffer.from(await res.arrayBuffer());
    expect(pngSize(png)).toEqual({ width: 1280, height: 720 });
    expect(rgbOfPng(png).equals(rgbOfFrame(orig, 13))).toBe(true);

    // Past the end lands on the last frame.
    const last = await app.request("/api/videos/hero/versions/v1/frame?t=99");
    expect(last.status).toBe(200);
    const lastFrame = Number(last.headers.get("x-rushes-frame"));
    expect(lastFrame).toBe(59);
    expect(rgbOfPng(Buffer.from(await last.arrayBuffer())).equals(rgbOfFrame(orig, 59))).toBe(true);

    // Picture posts it as the grab.
    const grab = await call("POST", "/api/grabs", { video: "hero", version: "v1", frame: 13, png: png.toString("base64") });
    expect(grab.status).toBe(201);
    expect(grab.json.grab).toMatch(/^screenshots\/hero_v1_00m00\.43s_f13\.png$/);
    expect(pngSize(await readFile(join(root, grab.json.grab)))).toEqual({ width: 1280, height: 720 });
  });
});

describe("proxies, fix round 1", () => {
  it("GET /api/state never waits on a probe: null at once, then a change when the probe finds a need (ruling B)", async () => {
    let land!: (p: Probe) => void;
    const pending = new Promise<Probe>((r) => (land = r));
    let probes = 0;
    const { call, store, jobs } = await proxySetup({
      probe: (abs) => {
        probes++;
        return abs.endsWith("hero.mov") ? pending : Promise.resolve(H264_1080);
      },
    });
    // Registered by hand, so nothing has probed it yet.
    await store.update("project", (p) => {
      addVersion(p, { video: "Hero", file: "renders/hero.mov", duration: 2, fps: 25 });
    });
    const changes: unknown[] = [];
    store.on("change", (e) => changes.push(e));
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1000));
    const state = await Promise.race([call("GET", "/api/state"), timeout]);
    expect(state).not.toBe("timeout");
    expect((state as any).json.project.videos[0].versions[0].proxyNeed).toBeNull();
    expect(probes).toBe(1);
    // A second read while it's still probing doesn't start another probe.
    await call("GET", "/api/state");
    expect(probes).toBe(1);
    expect(changes).toEqual([]);

    land(PRORES_4K);
    await jobs.probesIdle();
    expect(changes).toEqual([{ file: "project", rev: (await store.read("project")).rev }]);
    const after = await call("GET", "/api/state");
    expect(after.json.project.videos[0].versions[0].proxyNeed).toBe("It's a 4K ProRes file, which browsers struggle with");
    expect(probes).toBe(1);
  });

  it("a cut whose job failed can be tried again: 202 with a new job id", async () => {
    const { call, jobs } = await proxySetup();
    await call("POST", "/api/versions", { video: "Hero", file: "renders/gone.mov" });
    const first = await call("POST", "/api/videos/hero/versions/v1/proxy", {});
    expect(first.status).toBe(202);
    expect(await jobs.wait(first.json.job.id)).toMatchObject({ state: "failed", reason: "The original file is missing" });
    const again = await call("POST", "/api/videos/hero/versions/v1/proxy", {});
    expect(again.status).toBe(202);
    expect(again.json.job.id).not.toBe(first.json.job.id);
    await jobs.wait(again.json.job.id);
  });

  it("/media serves a proxy record only at a proxies/…_proxy.mp4 name", async () => {
    const { call, store, root } = await proxySetup();
    await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mov" });
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "private.txt"), "not for the browser");
    await store.update("project", (p) => {
      p.videos[0].versions[0].proxy = { file: "notes/private.txt", width: 2, height: 2, bytes: 1, createdAt: "2026-10-04T00:00:00Z" };
    });
    expect((await call("GET", "/media?path=notes%2Fprivate.txt")).status).toBe(404);
  });

  it("/media never follows a symlink planted at a proxy's name", async () => {
    const { call, store, root } = await proxySetup();
    await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mov" });
    await mkdir(join(root, "proxies"), { recursive: true });
    await writeFile(join(root, "elsewhere.mp4"), "someone else's file");
    await symlink(join(root, "elsewhere.mp4"), join(root, "proxies", "hero_v1_proxy.mp4"));
    await store.update("project", (p) => {
      p.videos[0].versions[0].proxy = { file: "proxies/hero_v1_proxy.mp4", width: 2, height: 2, bytes: 1, createdAt: "2026-10-04T00:00:00Z" };
    });
    expect((await call("GET", "/media?path=proxies%2Fhero_v1_proxy.mp4")).status).toBe(404);
  });

  it("DELETE …/proxy never deletes a file outside proxies/, even when the record was hand-edited to point there", async () => {
    const { call, store, root } = await proxySetup();
    await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mov" });
    await store.update("project", (p) => {
      p.videos[0].versions[0].proxy = { file: "renders/hero.mov", width: 2, height: 2, bytes: 1, createdAt: "2026-10-04T00:00:00Z" };
    });
    const r = await call("DELETE", "/api/videos/hero/versions/v1/proxy", {});
    expect(r.status).toBe(200);
    expect(r.json.version.proxy).toBeNull();
    expect(existsSync(join(root, "renders", "hero.mov"))).toBe(true);
  });

  it("the stand-in ffmpeg answers a frame extraction on stdout and writes no pipe:1 file", async () => {
    const { call, app } = await proxySetup();
    await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mov" });
    const res = await app.request("/api/videos/hero/versions/v1/frame?t=0");
    expect(res.status).toBe(200);
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.equals(Buffer.from(PNG_1PX, "base64"))).toBe(true);
    expect(existsSync(join(process.cwd(), "pipe:1"))).toBe(false);
  });

  it("the frame endpoint's t must be a time from 0 to 24 h", async () => {
    const { call } = await proxySetup();
    await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mov" });
    for (const t of ["", "NaN", "Infinity", "1e9", "86400.5", "-0.1", "abc"]) {
      const r = await call("GET", `/api/videos/hero/versions/v1/frame?t=${encodeURIComponent(t)}`);
      expect([t, r.status]).toEqual([t, 400]);
    }
  });
});

function gateOpen() {
  let open!: () => void;
  const promise = new Promise<void>((res) => (open = res));
  return { promise, open };
}

// Last in the file: nothing above may leave a stray `pipe:1` (a frame extraction's stdout target)
// in the working directory.
describe("after the server tests", () => {
  it("there's no pipe:1 file in the working directory", () => {
    expect(existsSync(join(process.cwd(), "pipe:1"))).toBe(false);
  });
});
