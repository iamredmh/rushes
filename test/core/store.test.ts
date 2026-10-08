import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { CorruptFileError, InvalidError, RevConflictError } from "../../src/core/errors.js";
import { backfillLog } from "../../src/core/log.js";
import { FILES, type FileKey } from "../../src/core/schema.js";
import { Store, type ChangeEvent } from "../../src/core/store.js";

describe("Store", () => {
  it("init writes every file with schema 1 and rev 0, plus a .gitignore", async () => {
    const { store } = await tmpProject("spring-launch");
    const project = await store.read("project");
    expect(project).toMatchObject({ schema: 1, rev: 0, name: "spring-launch", fps: 30, videos: [], lanes: [] });
    expect((await store.read("notes")).notes).toEqual([]);
    const ignore = await readFile(join(store.dir, ".gitignore"), "utf8");
    expect(ignore).toContain("server.json");
    expect(ignore).toContain("server.log");
  });

  it("init does not overwrite existing files", async () => {
    const { store } = await tmpProject("first");
    await store.update("project", (p) => { p.fps = 60; });
    await store.init("second");
    const p = await store.read("project");
    expect(p.name).toBe("first");
    expect(p.fps).toBe(60);
  });

  it("update bumps rev, writes pretty JSON and emits a change event", async () => {
    const { store } = await tmpProject();
    const events: ChangeEvent[] = [];
    store.on("change", (e: ChangeEvent) => events.push(e));
    const { data } = await store.update("project", (p) => { p.fps = 25; });
    expect(data.rev).toBe(1);
    const raw = await readFile(store.path("project"), "utf8");
    expect(raw).toContain('\n  "fps": 25,');
    expect(events).toEqual([{ file: "project", rev: 1 }]);
  });

  it("rejects a write when expectedRev is stale", async () => {
    const { store } = await tmpProject();
    await store.update("project", (p) => { p.fps = 24; });
    await expect(store.update("project", (p) => { p.fps = 50; }, 0)).rejects.toBeInstanceOf(RevConflictError);
    expect((await store.read("project")).fps).toBe(24);
  });

  it("serialises concurrent updates so none are lost", async () => {
    const { store } = await tmpProject();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.update("picks", (p) => { p.lanes[`lane${i}`] = "a"; }),
      ),
    );
    const picks = await store.read("picks");
    expect(Object.keys(picks.lanes)).toHaveLength(25);
    expect(picks.rev).toBe(25);
  });

  it("refuses to touch a hand-edited file with invalid JSON", async () => {
    const { store } = await tmpProject();
    await writeFile(store.path("notes"), '{ "schema": 1, "rev": 3, "notes": [ oops ', "utf8");
    await expect(store.update("notes", (n) => { n.notes = []; })).rejects.toBeInstanceOf(CorruptFileError);
    expect(await readFile(store.path("notes"), "utf8")).toContain("oops");
  });

  it("refuses a file that fails the schema and names the field", async () => {
    const { store } = await tmpProject();
    await writeFile(store.path("project"), JSON.stringify({ schema: 1, rev: 0, name: "", fps: -1 }), "utf8");
    await expect(store.read("project")).rejects.toThrow(/fps/);
  });

  it("rejects a change that would make the file invalid, leaving it as it was", async () => {
    const { store } = await tmpProject();
    await expect(store.update("project", (p) => { p.fps = -5; })).rejects.toBeInstanceOf(InvalidError);
    expect((await store.read("project")).rev).toBe(0);
  });

  it("found.json isn't written by init, reads as its default, and is created on its first write", async () => {
    const { store } = await tmpProject();
    await expect(readFile(store.path("found"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.read("found")).toEqual({ schema: 1, rev: 0, dismissed: [], settled: [] });
    const events: ChangeEvent[] = [];
    store.on("change", (e: ChangeEvent) => events.push(e));
    await store.update("found", (f) => { f.dismissed.push("vo/take 2.wav"); });
    expect(JSON.parse(await readFile(store.path("found"), "utf8"))).toEqual({ schema: 1, rev: 1, dismissed: ["vo/take 2.wav"], settled: [] });
    expect(await store.read("found")).toEqual({ schema: 1, rev: 1, dismissed: ["vo/take 2.wav"], settled: [] });
    expect(events).toEqual([{ file: "found", rev: 1 }]);
  });

  it("a found.json from before `settled` reads with it empty, and keeps what it had on the next write", async () => {
    const { store } = await tmpProject();
    await writeFile(store.path("found"), JSON.stringify({ schema: 1, rev: 3, dismissed: ["a.wav"] }), "utf8");
    expect(await store.read("found")).toEqual({ schema: 1, rev: 3, dismissed: ["a.wav"], settled: [] });
    await store.update("found", (f) => { f.settled.push({ video: "hero", version: "v1", kinds: ["music"] }); });
    expect(JSON.parse(await readFile(store.path("found"), "utf8"))).toEqual({
      schema: 1,
      rev: 4,
      dismissed: ["a.wav"],
      settled: [{ video: "hero", version: "v1", kinds: ["music"] }],
    });
  });

  it("reports a hand-edited found.json that fails the schema as corrupt", async () => {
    const { store } = await tmpProject();
    await writeFile(store.path("found"), JSON.stringify({ schema: 1, rev: 0, dismissed: [42] }), "utf8");
    await expect(store.read("found")).rejects.toBeInstanceOf(CorruptFileError);
    await expect(store.read("found")).rejects.toThrow(/found\.json.*dismissed/);
    await writeFile(store.path("found"), "{ nope", "utf8");
    await expect(store.update("found", (f) => { f.dismissed = []; })).rejects.toBeInstanceOf(CorruptFileError);
    expect(await readFile(store.path("found"), "utf8")).toBe("{ nope");
  });

  it("a 0.2.2 project with no log.json loads unchanged; the log reads as its default and is created on its first write (§22.3, §22.11 (1))", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "rushes test ")));
    const root = join(base, "Lumen launch film");
    const dir = join(root, ".rushes");
    try {
      await mkdir(dir, { recursive: true });
      // Written as 0.2.2 wrote them: no `label` on the cut, no found.json, no log.json.
      const files: Record<string, unknown> = {
        "project.json": {
          schema: 1, rev: 4, name: "Lumen launch film", fps: 30, autoProxy: false, lanes: [], files: [],
          videos: [{ id: "hero", name: "Hero", lockedVersion: null, versions: [{ id: "v1", file: "renders/hero_v1.mp4", note: "v1: first pass", addedAt: "2026-10-01T09:00:00.000Z", duration: null, proxy: null, shots: [] }] }],
        },
        "script.json": { schema: 1, rev: 0, wordsPerSecond: 2.6, sections: [] },
        "notes.json": { schema: 1, rev: 2, notes: [] },
        "picks.json": { schema: 1, rev: 0, lanes: {}, sections: {}, levels: {} },
        "batches.json": { schema: 1, rev: 1, batches: [{ id: "b_1", stage: "picture", noteIds: ["n_1"], sectionIds: [], sentAt: "2026-10-02T09:00:00.000Z", prompt: "" }] },
      };
      for (const [name, data] of Object.entries(files)) await writeFile(join(dir, name), JSON.stringify(data, null, 2) + "\n", "utf8");
      const bytes = async () => Object.fromEntries(await Promise.all(Object.keys(files).map(async (n) => [n, await readFile(join(dir, n), "utf8")])));
      const before = await bytes();

      const store = new Store(root);
      await store.init("ignored");
      for (const key of Object.keys(FILES) as FileKey[]) await store.read(key);
      expect(await store.read("log")).toEqual({ schema: 1, rev: 0, backfilled: false, undated: [], dropped: 0, entries: [] });
      await expect(access(store.path("log"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await bytes()).toEqual(before);

      const src = { project: await store.read("project"), batches: await store.read("batches"), script: await store.read("script") };
      await store.update("log", (f) => backfillLog(f, src, Date.parse("2026-10-07T09:00:00.000Z")));
      expect((await store.read("log")).entries.map((e) => e.text)).toEqual(["v1 added: first pass", "1 note sent from Picture"]);
      expect(await bytes()).toEqual(before);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("a log.json with only §22.3's fields reads with the rest defaulted; one that fails the schema is corrupt", async () => {
    const { store } = await tmpProject();
    const entry = { id: "l_1", at: "2026-10-07T09:00:00.000Z", area: "picture", kind: "cut", text: "v1 added: first pass", video: "hero", version: "v1", ref: null, by: "agent" };
    await writeFile(store.path("log"), JSON.stringify({ schema: 1, rev: 2, entries: [entry] }), "utf8");
    expect(await store.read("log")).toEqual({ schema: 1, rev: 2, backfilled: false, undated: [], dropped: 0, entries: [{ ...entry, tab: null, n: 1, subject: "" }] });
    await writeFile(store.path("log"), JSON.stringify({ schema: 1, rev: 2, entries: [{ ...entry, text: "" }] }), "utf8");
    await expect(store.read("log")).rejects.toThrow(/log\.json.*entries\.0\.text/);
    await writeFile(store.path("log"), "{ half a fil", "utf8");
    await expect(store.read("log")).rejects.toBeInstanceOf(CorruptFileError);
  });

  it("a failed update does not block the next one", async () => {
    const { store } = await tmpProject();
    await expect(store.update("project", () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const { data } = await store.update("project", (p) => { p.fps = 48; });
    expect(data.fps).toBe(48);
  });
});
