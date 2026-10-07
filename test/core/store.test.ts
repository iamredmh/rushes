import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { CorruptFileError, InvalidError, RevConflictError } from "../../src/core/errors.js";
import type { ChangeEvent } from "../../src/core/store.js";

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

  it("a failed update does not block the next one", async () => {
    const { store } = await tmpProject();
    await expect(store.update("project", () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const { data } = await store.update("project", (p) => { p.fps = 48; });
    expect(data.fps).toBe(48);
  });
});
