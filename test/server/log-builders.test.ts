import { describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// M1: every Change Log line is built inside LogBook.add's own guard, so a builder that throws can
// never break the change it describes. Here every builder in logEvents.ts throws while `boom` is on.
const state = vi.hoisted(() => ({ boom: false }));
vi.mock("../../src/core/logEvents.js", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(real).map(([name, value]) => [
      name,
      typeof value === "function"
        ? (...args: unknown[]) => {
            if (state.boom) throw new Error(`${name} broke`);
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value,
    ]),
  );
});

const { tmpProject } = await import("../helpers/tmp.js");
const { createApp } = await import("../../src/server/app.js");
const { FoundScanner } = await import("../../src/server/found.js");
const { addVersion } = await import("../../src/core/project.js");

async function put(root: string, rel: string) {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), "bytes");
}

describe("a Change Log line that can't be built (M1)", () => {
  it("never changes a route's answer: every write route still answers as it should, and the misses are counted", async () => {
    const { root, store } = await tmpProject("Lumen launch film");
    await store.update("project", (p) => addVersion(p, { video: "Hero", file: "renders/hero.mp4" }, new Date(Date.now() - 60_000)));
    for (const f of ["bed/theme.wav", "bed/drive.wav", "renders/hero.mp4"]) await put(root, f);
    const scanner = new FoundScanner({ store, probe: async () => null, announce: () => undefined });
    const app = createApp(store, { found: scanner });
    const call = async (method: string, path: string, json?: unknown, headers: Record<string, string> = {}) => {
      const res = await app.request(path, { method, headers: json === undefined ? headers : { "content-type": "application/json", ...headers }, body: json === undefined ? undefined : JSON.stringify(json) });
      return { status: res.status, json: await res.json() };
    };
    const asUser = { "x-rushes-project": (await call("GET", "/api/health")).json.id as string };
    await scanner.scan();
    state.boom = true;
    try {
      const answers: [string, number][] = [];
      const step = async (method: string, path: string, json?: unknown, headers?: Record<string, string>) => {
        const r = await call(method, path, json, headers);
        answers.push([`${method} ${path}`, r.status]);
        return r;
      };
      await step("POST", "/api/versions", { video: "Hero", file: `${root}/renders/hero v2.mp4` });
      await step("PUT", "/api/videos/hero/lock", { version: "v2" }, asUser);
      await step("POST", "/api/variants", { stage: "music", lane: "night-drive", name: "Night drive", file: "audio/night.wav" });
      await step("PUT", "/api/picks", { lanes: { "night-drive": "night-drive" } }, asUser);
      await step("PUT", "/api/script", { sections: [{ start: 0, end: 4, current: "A line." }] });
      await step("POST", "/api/script/s1/takes", { file: "audio/s1.wav" });
      const note = await step("POST", "/api/notes", { stage: "picture", video: "hero", version: "v2", scope: "point", t: 1, text: "Too dark" }, asUser);
      await step("POST", "/api/batches", { stage: "picture" }, asUser);
      await step("POST", "/api/replies", { replies: [{ id: note.json.note.id, reply: "Lifted", status: "done" }] });
      await step("POST", "/api/files", { kind: "doc", file: "brief.md", name: "Creative brief" });
      const brought = await step("POST", "/api/found/bring-in", { files: [{ path: "bed/theme.wav", kind: "music" }] });
      const included = await step("POST", "/api/found/scan", { wait: true, include: [{ path: "bed/drive.wav", kind: "music" }] });
      expect(answers).toEqual([
        ["POST /api/versions", 201],
        ["PUT /api/videos/hero/lock", 200],
        ["POST /api/variants", 201],
        ["PUT /api/picks", 200],
        ["PUT /api/script", 200],
        ["POST /api/script/s1/takes", 201],
        ["POST /api/notes", 201],
        ["POST /api/batches", 201],
        ["POST /api/replies", 200],
        ["POST /api/files", 201],
        ["POST /api/found/bring-in", 200],
        ["POST /api/found/scan", 200],
      ]);
      expect(brought.json.added).toHaveLength(1);
      expect(included.json.added.map((a: { path: string }) => a.path)).toContain("bed/drive.wav");
      // The changes themselves were all made.
      const project = await store.read("project");
      expect(project.videos[0]).toMatchObject({ lockedVersion: "v2" });
      expect(project.lanes.flatMap((l) => l.variants.map((v) => v.id)).sort()).toEqual(["drive", "night-drive", "theme"]);
      expect((await store.read("batches")).batches).toHaveLength(1);
      // Eleven lines couldn't be built (versions, lock, variants, picks, script, take, batch, replies, file, two bring-ins).
      expect((await call("GET", "/api/health")).json.logFailures).toBe(11);
      // The route whose whole job is the line says so.
      expect((await call("POST", "/api/log", { text: "Kept the wide" })).json.error).toBe("log_unwritable");
    } finally {
      state.boom = false;
    }
    await scanner.settled();
  });

  it("the scanner's current set is still brought in when its line can't be built", async () => {
    const { root, store } = await tmpProject("adopt");
    await store.update("project", (p) => addVersion(p, { video: "hero", file: "renders/hero v3.mov", duration: 60, fps: 25 }, new Date(Date.now() - 60_000)));
    for (const f of ["renders/hero v3.mov", "bed/hero v3 theme.wav"]) await put(root, f);
    const scanner = new FoundScanner({ store, probe: async (abs) => (abs.endsWith("theme.wav") ? 60 : null), announce: () => undefined });
    createApp(store, { found: scanner });
    await scanner.scan();
    state.boom = true;
    try {
      expect((await scanner.adoptCurrentSet()).added).toHaveLength(1);
    } finally {
      state.boom = false;
    }
    expect((await store.read("project")).lanes).toHaveLength(1);
    await scanner.settled();
  });
});
