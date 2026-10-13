import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { createApp } from "../../src/server/app.js";
import { FoundScanner } from "../../src/server/found.js";
import { addVersion, shelveFilm } from "../../src/core/project.js";

// §26.4 and §26.7 through Found: a file brought in for no film in particular never lands on a film the user shelved, and
// a bring-in that does restore a film (it names it, or every film is shelved) says so, as a cut does.
async function setup() {
  const { root, store } = await tmpProject("lumen");
  const scanner = new FoundScanner({ store, probe: async () => null, announce: () => undefined });
  const app = createApp(store, { found: scanner });
  const call = async (method: string, path: string, json?: unknown) => {
    const res = await app.request(path, { method, headers: json === undefined ? undefined : { "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });
    return { status: res.status, json: (await res.json()) as any };
  };
  await store.update("project", (p) => {
    addVersion(p, { video: "Hero", file: "renders/hero.mp4" }, new Date("2026-10-13T09:00:00Z"));
    addVersion(p, { video: "Teaser", file: "renders/teaser.mp4" }, new Date("2026-10-13T10:00:00Z")); // the newest cut
  });
  const put = async (rel: string) => {
    const abs = join(root, ...rel.split("/"));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, "bytes");
  };
  await put("renders/new-cut.mp4");
  const shelve = (...ids: string[]) => store.update("project", (p) => ids.forEach((id) => shelveFilm(p, id, true)));
  const film = async (id: string) => (await call("GET", "/api/state")).json.project.videos.find((v: any) => v.id === id);
  const log = async () => JSON.stringify((await call("GET", "/api/log")).json);
  return { call, shelve, film, log };
}
const bringIn = (call: Awaited<ReturnType<typeof setup>>["call"], film?: string) =>
  call("POST", "/api/found/bring-in", { files: [{ path: "renders/new-cut.mp4", kind: "cut" }], ...(film ? { film } : {}) });

describe("a cut brought in through Found", () => {
  it("joins a film in play, not the shelved film whose cut is the newest, and restores nothing", async () => {
    const { call, shelve, film, log } = await setup();
    await shelve("teaser");
    const r = await bringIn(call);
    expect(r.json.added).toEqual([{ path: "renders/new-cut.mp4", kind: "cut", video: "hero", version: "v2" }]);
    expect(r.json.restored).toBeUndefined();
    expect(typeof (await film("teaser")).shelved).toBe("string");
    expect(await log()).not.toContain("restored");
  });

  it("restores a shelved film it is told to join, says so in the reply, and logs the restore before the bring-in", async () => {
    const { call, shelve, film, log } = await setup();
    await shelve("teaser");
    const r = await bringIn(call, "teaser");
    expect(r.json.added[0]).toMatchObject({ video: "teaser", version: "v2" });
    expect(r.json.restored).toEqual([{ id: "teaser", name: "Teaser" }]);
    expect("shelved" in (await film("teaser"))).toBe(false);
    const text = await log();
    expect(text).toContain("Film “Teaser” restored");
    expect(text.indexOf("Film “Teaser” restored")).toBeGreaterThan(text.indexOf("Brought in"));
  });

  it("restores the newest film when every film is shelved, and says so", async () => {
    const { call, shelve, film } = await setup();
    await shelve("hero", "teaser");
    const r = await bringIn(call);
    expect(r.json.added[0]).toMatchObject({ video: "teaser" });
    expect(r.json.restored).toEqual([{ id: "teaser", name: "Teaser" }]);
    expect("shelved" in (await film("teaser"))).toBe(false);
    expect(typeof (await film("hero")).shelved).toBe("string");
  });
});
