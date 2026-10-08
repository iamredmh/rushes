import { describe, expect, it } from "vitest";
import { access, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { sse } from "../helpers/sse.js";
import { createApp } from "../../src/server/app.js";
import { FoundScanner } from "../../src/server/found.js";
import { LogBook, byOf, logBookFor } from "../../src/server/logbook.js";
import { startServer } from "../../src/server/start.js";
import { addFile, addVariant, addVersion } from "../../src/core/project.js";
import { lineEvent } from "../../src/core/logEvents.js";
import { Store } from "../../src/core/store.js";

async function setup(name = "Lumen launch film") {
  const { root, store } = await tmpProject(name);
  const app = createApp(store);
  const call = async (method: string, path: string, json?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: json === undefined ? headers : { "content-type": "application/json", ...headers },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const id = (await call("GET", "/api/health")).json.id as string;
  const asUser = { "x-rushes-project": id };
  const texts = async () => (await call("GET", "/api/log?limit=200")).json.entries.map((e: { text: string; by: string }) => `${e.text} | ${e.by}`);
  return { root, store, app, call, asUser, texts };
}

const DAY = 86_400_000;

describe("the server writes the log as things happen (§22.5)", () => {
  it("adds one line per change, at the moment it commits, saying who caused it (R8)", async () => {
    const { root, call, asUser, texts } = await setup();
    await call("POST", "/api/versions", { video: "Lumen launch film", file: `${root}/renders/lumen v1.mp4`, note: "v1: first pass; rough timing" });
    await call("PUT", "/api/videos/lumen-launch-film/lock", { version: "v1" }, asUser);
    await call("POST", "/api/variants", { stage: "music", lane: "night-drive", name: "Night drive", file: "audio/night.wav" });
    await call("PUT", "/api/picks", { lanes: { "night-drive": "night-drive" } }, asUser);
    await call("PUT", "/api/script", { sections: [{ start: 0, end: 4, current: "Every launch starts with a single request." }, { start: 4, end: 8, current: "Then the world asks." }] });
    await call("POST", "/api/script/s1/takes", { file: "audio/s1-take.wav" });
    await call("POST", "/api/notes", { stage: "picture", video: "lumen-launch-film", version: "v1", scope: "point", t: 1, text: "Logo lands early" }, asUser);
    const { batch } = (await call("POST", "/api/batches", { stage: "picture" }, asUser)).json;
    await call("POST", "/api/replies", { replies: [{ id: batch.noteIds[0], reply: "Held it", status: "done" }] });
    await call("POST", "/api/files", { kind: "doc", file: "brief.md", name: "Creative brief" });
    expect(await texts()).toEqual([
      "File added: Creative brief (Scripts & docs) | agent",
      "Agent replied to 1 note (1 done) | agent",
      "1 note sent from Picture | user",
      "Voiceover: take 1 added to S1 “Every launch starts with a…” | agent",
      "Script set: 2 sections | agent",
      "Picks: music “Night drive” | user",
      "Music: “Night drive” added to night-drive | agent",
      "Picture locked at v1 | user",
      "v1 added: first pass | agent",
    ]);
  });

  it("leaves out notes, shots, settings, levels, a lock that changes nothing and the user's script edits (R10)", async () => {
    const { root, call, asUser } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4`, note: "first" });
    await call("PUT", "/api/script", { sections: [{ start: 0, end: 4, current: "A line." }] });
    const count = async () => (await call("GET", "/api/log?limit=200")).json.entries.length;
    const n = await count();
    const note = (await call("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Too dark" }, asUser)).json.note;
    await call("PATCH", `/api/notes/${note.id}`, { text: "Much too dark" }, asUser);
    await call("PUT", "/api/videos/hero/shots", { shots: [{ name: "Wide", start: 0 }] });
    await call("PUT", "/api/project/settings", { autoProxy: true }, asUser);
    await call("PUT", "/api/picks", { levels: { music: -3 } }, asUser);
    await call("PUT", "/api/videos/hero/lock", { version: null }, asUser);
    await call("PATCH", "/api/script/s1", { proposed: "A better line." }, asUser);
    expect(await count()).toBe(n);
  });

  it("collapses a burst: ten variants at once are one line; interleaved music and sound effects are two (§22.11, Review Focus 3)", async () => {
    const { call, texts } = await setup();
    await Promise.all(Array.from({ length: 10 }, (_, i) => call("POST", "/api/variants", { stage: "music", name: `Bed ${i + 1}`, file: `audio/bed-${i + 1}.wav` })));
    expect(await texts()).toEqual(["Music: 10 variants added | agent"]);
    for (let i = 0; i < 3; i++) {
      await call("POST", "/api/variants", { stage: "sfx", name: `Pass ${i + 1}`, file: `audio/pass-${i + 1}.wav` });
      await call("POST", "/api/variants", { stage: "music", name: `Alt ${i + 1}`, file: `audio/alt-${i + 1}.wav` });
    }
    expect(await texts()).toEqual(["Music: 13 variants added | agent", "Sound effects: 3 variants added | agent"]);
  });

  it("a retried reply isn't doubled (§22.9)", async () => {
    const { root, call, texts } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4` });
    const note = (await call("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "x" })).json.note;
    const reply = { replies: [{ id: note.id, reply: "Fixed", status: "done" }] };
    await call("POST", "/api/replies", reply);
    await call("POST", "/api/replies", reply);
    expect((await texts()).filter((t: string) => t.startsWith("Agent replied"))).toEqual(["Agent replied to 1 note (1 done) | agent"]);
  });

  it("the current set the scanner brings in is one line by Rushes, and never also Before the log (R5, R9)", async () => {
    const { root, store } = await tmpProject("adopt");
    await store.update("project", (p) => addVersion(p, { video: "hero", file: "renders/hero v3.mov", duration: 60, fps: 25 }));
    for (const f of ["renders/hero v3.mov", "bed/hero v3 theme.wav", "vo_jules/hero v3 read.wav"]) {
      await mkdir(dirname(join(root, f)), { recursive: true });
      await writeFile(join(root, f), "bytes");
    }
    const lengths: Record<string, number> = { "hero v3 theme.wav": 60, "hero v3 read.wav": 60.4 };
    const s = await startServer(root, { port: 0, found: { probe: async (abs) => lengths[abs.split("/").pop()!] ?? null } });
    let view: { entries: { text: string; by: string }[]; undated: unknown[] } = { entries: [], undated: [] };
    await expect
      .poll(async () => {
        view = await (await fetch(`${s.url}/api/log`)).json();
        return view.entries.map((e) => `${e.text} | ${e.by}`);
      }, { timeout: 10_000 })
      .toEqual(["Brought in 2 files with v1 | rushes", "v1 added: hero v3 | rushes"]);
    expect(view.undated).toEqual([]);
    await s.close();
  });

  it("files brought in by hand, or included in a waiting scan, are one line by whoever asked (R9)", async () => {
    const { root, store } = await tmpProject("found");
    for (const f of ["bed/theme.wav", "bed/drive.wav", "vo/a.wav"]) {
      await mkdir(dirname(join(root, f)), { recursive: true });
      await writeFile(join(root, f), "bytes");
    }
    const scanner = new FoundScanner({ store, probe: async () => 60, announce: () => undefined });
    const app = createApp(store, { found: scanner });
    const id = (await (await app.request("/api/health")).json()).id as string;
    const post = (path: string, json: unknown, headers: Record<string, string> = {}) =>
      app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(json) });
    await scanner.scan();
    expect((await post("/api/found/bring-in", { files: [{ path: "bed/theme.wav" }, { path: "bed/drive.wav" }] }, { "x-rushes-project": id })).status).toBe(200);
    // Nothing brought in, nothing logged.
    expect((await post("/api/found/bring-in", { files: [{ path: "../nope.wav", kind: "music" }] })).status).toBe(200);
    expect((await post("/api/found/scan", { wait: true, include: [{ path: "vo/a.wav", kind: "voice" }] })).status).toBe(200);
    const view = await (await app.request("/api/log")).json();
    expect(view.entries.map((e: { text: string; by: string; area: string }) => `${e.text} | ${e.by} | ${e.area}`)).toEqual([
      "Brought in 1 file | agent | assets",
      "Brought in 2 files | user | assets",
    ]);
    await scanner.settled();
  });
});

describe("projects that already exist (§22.6)", () => {
  it("backfills a 0.2.2 project once, from its dated cuts, batches and files, by Rushes; its audio is listed undated", async () => {
    const { root, store } = await tmpProject("old");
    const t = Date.now();
    await store.update("project", (p) => {
      addVersion(p, { video: "Hero", file: "renders/hero_v1.mp4", note: "v1: first pass; rough" }, new Date(t - 3 * DAY));
      addVersion(p, { video: "Hero", file: "renders/hero_v2.mp4", note: "v2 (batch b_1): tighter cut" }, new Date(t - DAY));
      addFile(p, { kind: "doc", file: "brief.md", name: "Creative brief" }, new Date(t - 4 * DAY));
      for (const name of ["Night drive", "Held back", "Quiet bed"]) addVariant(p, { stage: "music", lane: "night-drive", name, file: `audio/${name}.wav` });
      p.videos[0].versions.push({ ...p.videos[0].versions[0], id: "v3", addedAt: "" });
    });
    await store.update("batches", (b) => {
      b.batches.push({ id: "b_1", stage: "picture", noteIds: ["n_1", "n_2"], sectionIds: [], sentAt: new Date(t - 2 * DAY).toISOString(), prompt: "" });
    });
    await expect(access(store.path("log"))).rejects.toThrow();
    const app = createApp(store);
    const view = await (await app.request("/api/log?limit=50")).json();
    expect(view.entries.map((e: { text: string; by: string }) => `${e.text} | ${e.by}`)).toEqual([
      "v2 added: tighter cut | rushes",
      "2 notes sent from Picture | rushes",
      "v1 added: first pass | rushes",
      "File added: Creative brief (Scripts & docs) | rushes",
    ]);
    expect(view.undated).toEqual([{ area: "music", text: "Music: night-drive (3 variants)" }]);
    expect(JSON.parse(await readFile(store.path("log"), "utf8")).backfilled).toBe(true);
    // Never again: a second server on the same folder adds nothing old.
    const again = createApp(new Store(root));
    expect((await (await again.request("/api/log?limit=50")).json()).entries).toHaveLength(4);
  });

  it("two first reads at once backfill once (Review Focus 1)", async () => {
    const { store } = await tmpProject("race");
    await store.update("project", (p) => {
      for (const n of [1, 2, 3]) addVersion(p, { video: "Hero", file: `renders/hero_v${n}.mp4`, note: `cut ${n}` }, new Date(Date.now() - n * DAY));
    });
    const a = new LogBook(store);
    const b = new LogBook(store);
    const ctx = { project: await store.read("project"), script: await store.read("script") };
    await Promise.all([a.view({ limit: 50 }, ctx), b.view({ limit: 50 }, ctx), a.add(lineEvent("Picked the slower cut", "project"), "agent"), b.ready()]);
    const file = await store.read("log");
    expect(file.entries.filter((e) => e.by === "rushes")).toHaveLength(3);
    expect(file.entries).toHaveLength(4);
    // One write for the backfill and one for the line: the second book's backfill wrote nothing.
    expect(file.rev).toBe(2);
  });

  it("a cut registered on a new project is logged once, never also read in as history (R6)", async () => {
    const { root, call, texts } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4`, note: "v1: first pass; more" });
    expect(await texts()).toEqual(["v1 added: first pass | agent"]);
  });

  it("reading a log that is already backfilled writes nothing, however many read at once (ruling b)", async () => {
    const { store, call } = await setup();
    await call("POST", "/api/log", { text: "Kept the wide" });
    const before = await readFile(store.path("log"), "utf8");
    const rev = (await store.read("log")).rev;
    const reads = await Promise.all(Array.from({ length: 5 }, () => call("GET", "/api/log")));
    expect(reads.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    // Five fresh books (five servers starting on the folder) read it too.
    const ctx = { project: await store.read("project"), script: await store.read("script") };
    await Promise.all(Array.from({ length: 5 }, () => new LogBook(store).view({ limit: 5 }, ctx)));
    expect((await store.read("log")).rev).toBe(rev);
    expect(await readFile(store.path("log"), "utf8")).toBe(before);
  });

  it("an idle project is never written to: the state, the health and the head never make log.json (ruling f)", async () => {
    const { root, store } = await tmpProject("idle");
    const s = await startServer(root, { port: 0 });
    const revs = async () => Promise.all((["project", "script", "notes", "picks", "batches"] as const).map(async (k) => (await store.read(k)).rev));
    const start = await revs();
    for (let i = 0; i < 3; i++) {
      expect((await fetch(`${s.url}/api/state`)).status).toBe(200);
      expect((await fetch(`${s.url}/api/health`)).status).toBe(200);
    }
    await expect(access(store.path("log"))).rejects.toThrow();
    expect(await revs()).toEqual(start);
    await s.close();
  });
});

describe("a log that is missing, corrupt or huge (§22.9)", () => {
  it("moves a corrupt log aside as log.json.bad, reads as empty, and never breaks the state (R7)", async () => {
    const { store, call } = await setup();
    await call("POST", "/api/log", { text: "First decision" });
    await writeFile(store.path("log"), "{ nope", "utf8");
    const state = await call("GET", "/api/state");
    expect(state.status).toBe(200);
    expect(state.json.log).toBeNull();
    const view = (await call("GET", "/api/log")).json;
    expect(view).toMatchObject({ entries: [], undated: [], dropped: 0 });
    expect(await readFile(`${store.path("log")}.bad`, "utf8")).toBe("{ nope");
    expect(JSON.parse(await readFile(store.path("log"), "utf8"))).toMatchObject({ backfilled: true, entries: [] });
    await call("POST", "/api/log", { text: "Second decision" });
    expect((await call("GET", "/api/log")).json.entries.map((e: { text: string }) => e.text)).toEqual(["Second decision"]);
  });

  it("many requests that meet a corrupt log at once set it aside once, and every one answers (R7)", async () => {
    const { root, store, call } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4` });
    await writeFile(store.path("log"), "[]", "utf8");
    const answers = await Promise.all([
      call("GET", "/api/log"),
      call("GET", "/api/log"),
      call("POST", "/api/log", { text: "Kept the wide" }),
      call("POST", "/api/variants", { stage: "music", name: "Night drive", file: "audio/night.wav" }),
      call("GET", "/api/state"),
    ]);
    expect(answers.map((a) => a.status)).toEqual([200, 200, 201, 201, 200]);
    expect(await readFile(`${store.path("log")}.bad`, "utf8")).toBe("[]");
    const texts = (await call("GET", "/api/log")).json.entries.map((e: { text: string }) => e.text).sort();
    expect(texts).toEqual(["Kept the wide", "Music: “Night drive” added"]);
  });

  it("keeps the newest 5000, counts what it dropped, and still answers quickly (Review Focus 5)", async () => {
    const { store, call } = await setup();
    const start = Date.now() - 6000 * 60_000;
    const entries = Array.from({ length: 5000 }, (_, i) => ({
      id: `l_${String(i).padStart(6, "0")}`, at: new Date(start + i * 60_000).toISOString(), area: "project", kind: "entry", text: `Line ${i}`, video: null, version: null, ref: null, by: "agent",
    }));
    await writeFile(store.path("log"), JSON.stringify({ schema: 1, rev: 1, backfilled: true, undated: [], dropped: 0, entries }));
    const t0 = performance.now();
    expect((await call("POST", "/api/log", { text: "One more" })).status).toBe(201);
    expect(performance.now() - t0).toBeLessThan(1500);
    const file = await store.read("log");
    expect(file.entries).toHaveLength(5000);
    expect(file.dropped).toBe(1);
    expect(file.entries[0].text).toBe("Line 1");
    const view = (await call("GET", "/api/log?limit=10")).json;
    expect(view).toMatchObject({ dropped: 1, total: 5000, earlier: 4990 });
    expect(view.entries[0].text).toBe("One more");
  });

  it("GET /api/state carries a read-only head for the dot: it never backfills or writes (R6, R19)", async () => {
    const { store, call } = await setup();
    expect((await call("GET", "/api/state")).json.log).toEqual({ rev: 0, mark: null, total: 0 });
    await expect(access(store.path("log"))).rejects.toThrow();
    const { entry } = (await call("POST", "/api/log", { text: "Kept the wide" })).json;
    const head = (await call("GET", "/api/state")).json.log;
    expect(head).toMatchObject({ mark: `${entry.id}@${entry.at}`, total: 1 });
    expect(head.rev).toBeGreaterThan(0);
  });
});

/** A route's answer with what differs between two runs (folders, times, random ids) taken out. */
function normalise(value: unknown, root: string): unknown {
  if (typeof value === "string") {
    return value.split(root).join("<root>").replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<t>").replace(/\b[a-z]_[0-9a-f]{6}\b/g, "<id>");
  }
  if (Array.isArray(value)) return value.map((v) => normalise(v, root));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === "prompt" && typeof v === "string" ? normalise(v.split("\n\nRecent changes")[0], root) : normalise(v, root)]),
    );
  }
  return value;
}

describe("logging never changes what a change answers (ruling e)", () => {
  it("a log write that fails leaves every write route's status and body as they were, and is counted for doctor", async () => {
    const run = async (broken: boolean) => {
      const s = await setup();
      if (broken) {
        const real = s.store.update.bind(s.store);
        s.store.update = ((key: string, fn: never, rev?: number) =>
          key === "log" ? Promise.reject(new Error("ENOSPC: no space left on device")) : real(key as "project", fn, rev)) as Store["update"];
      }
      const out: { route: string; status: number; body: unknown }[] = [];
      const step = async (method: string, path: string, json?: unknown, headers: Record<string, string> = {}) => {
        const r = await s.call(method, path, json, headers);
        out.push({ route: `${method} ${path}`, status: r.status, body: normalise(r.json, s.root) });
        return r;
      };
      await step("POST", "/api/versions", { video: "Hero", file: `${s.root}/renders/hero.mp4`, note: "v1: first pass" });
      await step("PUT", "/api/videos/hero/lock", { version: "v1" }, s.asUser);
      await step("POST", "/api/variants", { stage: "music", lane: "night-drive", name: "Night drive", file: "audio/night.wav" });
      await step("PUT", "/api/picks", { lanes: { "night-drive": "night-drive" } }, s.asUser);
      await step("PUT", "/api/script", { sections: [{ start: 0, end: 4, current: "A line." }] });
      await step("POST", "/api/script/s1/takes", { file: "audio/s1.wav" });
      const note = await step("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Too dark" }, s.asUser);
      await step("POST", "/api/batches", { stage: "picture" }, s.asUser);
      await step("POST", "/api/replies", { replies: [{ id: note.json.note.id, reply: "Lifted", status: "done" }] });
      await step("POST", "/api/files", { kind: "doc", file: "brief.md", name: "Creative brief" });
      const exp = await step("POST", "/api/exports/notes", {});
      const state = await s.call("GET", "/api/state");
      const health = (await s.call("GET", "/api/health")).json;
      const line = await s.call("POST", "/api/log", { text: "Kept the wide" });
      return { out, state, health, line, exp };
    };
    const good = await run(false);
    const bad = await run(true);
    expect(bad.out.map((o) => `${o.route} ${o.status}`)).toEqual(good.out.map((o) => `${o.route} ${o.status}`));
    expect(bad.out).toEqual(good.out);
    expect(bad.exp).toMatchObject({ status: 201, json: { path: good.exp.json.path, changeLog: good.exp.json.changeLog } });
    expect(bad.state.status).toBe(200);
    // Only the route whose whole job is the line says it couldn't.
    expect(good.line.status).toBe(201);
    expect(bad.line).toMatchObject({ status: 500, json: { error: "log_unwritable" } });
    expect(good.health.logFailures).toBeUndefined();
    // The nine changes that are logged, each counted once (the health was read before the line).
    expect(bad.health.logFailures).toBe(9);
  });
});

describe("a log that can't be read at all (ruling e)", () => {
  it("a folder where log.json should be never stops a send, an export or the state", async () => {
    const { root, store, call, asUser } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4` });
    await rm(store.path("log"));
    await mkdir(store.path("log"));
    await call("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Too dark" }, asUser);
    const sent = await call("POST", "/api/batches", { stage: "picture" }, asUser);
    expect(sent.status).toBe(201);
    expect(sent.json.batch.prompt).not.toContain("Recent changes");
    expect((await store.read("batches")).batches).toHaveLength(1);
    const exp = await call("POST", "/api/exports/notes", {});
    expect(exp).toMatchObject({ status: 201, json: { changeLog: null } });
    expect(exp.json.path).toMatch(/^exports\//);
    const state = await call("GET", "/api/state");
    expect(state.status).toBe(200);
    expect(state.json.log).toBeNull();
    expect((await call("GET", "/api/health")).json.logFailures).toBe(1);
  });
});

describe("the log's routes (§22.7)", () => {
  it("POST /api/log: one clean line of 160 at most, by whoever sent it; blank and unknown places are refused (R21, Review Focus 2)", async () => {
    const { root, call, asUser } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4` });
    const a = (await call("POST", "/api/log", { text: "  Slowed the zooms\n\tbecause the first cut\u0007 felt rushed  " })).json.entry;
    expect(a).toMatchObject({ text: "Slowed the zooms because the first cut felt rushed", by: "agent", area: "project", kind: "entry", video: null });
    const long = (await call("POST", "/api/log", { text: `${"a".repeat(158)}🎬🎬🎬`, area: "picture" }, asUser)).json.entry;
    expect(long).toMatchObject({ text: `${"a".repeat(158)}🎬…`, by: "user", area: "picture" });
    const linked = (await call("POST", "/api/log", { text: "Look at the end card", video: "Hero", version: "v1" })).json.entry;
    expect(linked).toMatchObject({ video: "hero", version: "v1" });
    expect((await call("POST", "/api/log", { text: "   " })).status).toBe(400);
    expect((await call("POST", "/api/log", { text: "x".repeat(2001) })).status).toBe(400);
    expect((await call("POST", "/api/log", { text: "x", video: "Nope" })).status).toBe(404);
    expect((await call("POST", "/api/log", { text: "x", video: "hero", version: "v9" })).status).toBe(404);
    expect((await call("POST", "/api/log", { text: "x", version: "v1" })).status).toBe(400);
    expect((await call("POST", "/api/log", { text: "x", area: "elsewhere" })).status).toBe(400);
  });

  it("POST /api/log: the writer comes from the caller, never the body; a line of only invisible characters is blank; a ref must name a variant or take that exists", async () => {
    const { call } = await setup();
    await call("POST", "/api/variants", { stage: "music", lane: "night-drive", name: "Night drive", file: "audio/night.wav" });
    await call("PUT", "/api/script", { sections: [{ start: 0, end: 4, current: "A line." }] });
    const take = (await call("POST", "/api/script/s1/takes", { file: "audio/s1.wav" })).json.take;
    expect((await call("POST", "/api/log", { text: "Said it was Rushes", by: "rushes" })).json.entry.by).toBe("agent");
    for (const blank of ["\u0007\u0008", "​​", "\n\t\r"]) {
      const r = await call("POST", "/api/log", { text: blank });
      expect(r.status, JSON.stringify(blank)).toBe(400);
      expect(r.json.message).toMatch(/text is empty/);
    }
    expect((await call("POST", "/api/log", { text: "Use this bed", area: "music", ref: "night-drive/night-drive" })).json.entry.ref).toBe("night-drive/night-drive");
    expect((await call("POST", "/api/log", { text: "Use this take", area: "voice", ref: `s1:${take.id}` })).json.entry.ref).toBe(`s1:${take.id}`);
    expect((await call("POST", "/api/log", { text: "x", ref: "night-drive/gone" })).status).toBe(404);
    expect((await call("POST", "/api/log", { text: "x", ref: "s9:t_000000" })).status).toBe(404);
    expect((await call("POST", "/api/log", { text: "x", ref: "../../etc/passwd" })).status).toBe(404);
    expect((await call("POST", "/api/log", { text: "x", ref: "r".repeat(301) })).status).toBe(400);
    // What it refuses is never echoed back with control characters in it.
    for (const body of [{ text: "x", video: "Nope\u001b[31m‮" }, { text: "x", ref: "a/b\u0000\u001b" }, { text: "x", video: "hero\n", version: "v9\u0007" }]) {
      const r = await call("POST", "/api/log", body);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(r.json)).not.toMatch(/\\u00(0|1)[0-9a-f]|\\u007f|‮|\\n/i);
    }
  });

  it("GET /api/log: newest first, with limit, area and since, and how many it left out", async () => {
    const { call } = await setup();
    for (const [text, area] of [["One", "picture"], ["Two", "music"], ["Three", "picture"]] as const) await call("POST", "/api/log", { text, area });
    const all = (await call("GET", "/api/log")).json;
    expect(all.entries.map((e: { text: string }) => e.text)).toEqual(["Three", "Two", "One"]);
    expect(all.earlier).toBe(0);
    expect((await call("GET", "/api/log?limit=1")).json).toMatchObject({ earlier: 2, entries: [{ text: "Three" }] });
    expect((await call("GET", "/api/log?area=picture")).json.entries.map((e: { text: string }) => e.text)).toEqual(["Three", "One"]);
    expect((await call("GET", "/api/log?since=2000-01-01T00:00:00Z")).json.entries).toHaveLength(3);
    expect((await call("GET", "/api/log?since=2999-01-01T00:00:00Z")).json.entries).toHaveLength(0);
    for (const bad of ["limit=0", "limit=5001", "area=elsewhere", "since=yesterday"]) expect((await call("GET", `/api/log?${bad}`)).status, bad).toBe(400);
  });

  it("GET /api/log: a limit, since or area it can't use is a 400 that says what to send, never a quiet default (ruling a)", async () => {
    const { call } = await setup();
    await call("POST", "/api/log", { text: "One" });
    const cases: [string, RegExp][] = [
      ["limit=abc", /limit must be a whole number from 1 to 5000/],
      ["limit=Infinity", /limit must be a whole number from 1 to 5000/],
      ["limit=1.5", /limit must be a whole number from 1 to 5000/],
      ["limit=", /limit must be a whole number from 1 to 5000/],
      ["limit=-3", /limit must be a whole number from 1 to 5000/],
      ["limit=0x10", /limit must be a whole number from 1 to 5000/],
      ["limit=1e3", /limit must be a whole number from 1 to 5000/],
      ["limit=%205", /limit must be a whole number from 1 to 5000/],
      ["since=yesterday", /since must be a date and time/],
      ["since=", /since must be a date and time/],
      ["area=elsewhere", /area must be one of script, picture, voice, music, sfx, mix, notes, assets, project/],
    ];
    for (const [q, message] of cases) {
      const r = await call("GET", `/api/log?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.json.message, q).toMatch(message);
    }
    expect((await call("GET", "/api/log?limit=5000&area=project&since=2000-01-01")).status).toBe(200);
  });

  it("Send to agent's prompt ends with the last five lines, newest first; an empty log adds nothing (R11)", async () => {
    const { root, call, asUser } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4`, note: "v1: first pass; rough" });
    await call("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Too dark" }, asUser);
    for (let i = 1; i <= 6; i++) await call("POST", "/api/log", { text: `Decision ${i}` });
    const { batch } = (await call("POST", "/api/batches", { stage: "picture" }, asUser)).json;
    const [head, block] = batch.prompt.split("\n\nRecent changes (newest first):\n");
    expect(head).toContain("Work through picture batch b_1");
    expect(block.split("\n").map((l: string) => l.replace(/^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} /, ""))).toEqual(["Decision 6", "Decision 5", "Decision 4", "Decision 3", "Decision 2"]);
    expect((await call("GET", "/api/log?limit=1")).json.entries[0].text).toBe("1 note sent from Picture");
    const fresh = await setup();
    await fresh.call("POST", "/api/notes", { stage: "music", scope: "whole", text: "Warmer" }, fresh.asUser);
    expect((await fresh.call("POST", "/api/batches", { stage: "music" }, fresh.asUser)).json.batch.prompt).not.toContain("Recent changes");
  });

  it("the Recent changes block never carries a note's or a reply's words (R9, ruling d)", async () => {
    const { root, call, asUser } = await setup();
    await call("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero.mp4` });
    const note = (await call("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Secret plum note" }, asUser)).json.note;
    await call("POST", "/api/batches", { stage: "picture" }, asUser);
    await call("POST", "/api/replies", { replies: [{ id: note.id, reply: "Secret damson reply", status: "todo" }] });
    await call("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 2, text: "Another quince note" }, asUser);
    const { batch } = (await call("POST", "/api/batches", { stage: "picture" }, asUser)).json;
    const block = batch.prompt.split("\n\nRecent changes (newest first):\n")[1];
    expect(block).toContain("Agent replied to 1 note");
    expect(block).not.toMatch(/plum|damson|quince/);
    expect(await readFile(join(root, ".rushes", "log.json"), "utf8")).not.toMatch(/plum|damson|quince/);
  });

  it("Export notes also writes exports/change-log-<date>.md, and the drawer's export writes it alone (R17)", async () => {
    const { root, call } = await setup("Lumen launch film");
    await call("POST", "/api/versions", { video: "Lumen launch film", file: `${root}/renders/lumen.mp4`, note: "v1: first pass; rough" });
    const r = (await call("POST", "/api/exports/notes", {})).json;
    expect(r.changeLog).toMatch(/^exports\/change-log-\d{4}-\d{2}-\d{2}\.md$/);
    const md = await readFile(join(root, r.changeLog), "utf8");
    expect(md).toMatch(/^# Lumen launch film — change log\nExported \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n\n## \w+day \d+ \w+ \d{4}\n- \d{2}:\d{2} · Picture · v1 added: first pass \(agent\)\n$/);
    expect((await call("POST", "/api/exports/change-log", {})).json).toEqual({ path: r.changeLog });
  });

  it("the change log export replaces a link planted at its name rather than writing through it", async () => {
    const { root, call } = await setup();
    await call("POST", "/api/log", { text: "Kept the wide" });
    const outside = join(dirname(root), "outside.txt");
    await writeFile(outside, "untouched", "utf8");
    const name = `change-log-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}.md`;
    await mkdir(join(root, "exports"), { recursive: true });
    await symlink(outside, join(root, "exports", name));
    const r = await call("POST", "/api/exports/change-log", {});
    expect(r).toEqual({ status: 201, json: { path: `exports/${name}` } });
    expect(await readFile(outside, "utf8")).toBe("untouched");
    expect((await lstat(join(root, "exports", name))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(root, "exports", name), "utf8")).toContain("Kept the wide");
  });

  it("announces each write as a change to log, so open dashboards refetch (§22.8)", async () => {
    const { root } = await tmpProject("live");
    const s = await startServer(root, { port: 0 });
    const events = await sse(s.url);
    await events.until("event: hello");
    await fetch(`${s.url}/api/log`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Kept the wide" }) });
    expect(await events.until('"file":"log"')).toContain('"file":"log"');
    events.stop();
    await s.close();
  });
});

describe("LogBook", () => {
  it("is one per store, and says who caused a request from the dashboard's header (R8)", async () => {
    const { store } = await tmpProject("one");
    expect(logBookFor(store)).toBe(logBookFor(store));
    expect(logBookFor(store)).not.toBe(logBookFor(new Store(store.root)));
    expect(byOf("abcdefgh")).toBe("user");
    expect(byOf(undefined)).toBe("agent");
    expect(byOf("")).toBe("agent");
  });
});
