import { describe, expect, it } from "vitest";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { createApp } from "../../src/server/app.js";
import { FoundScanner } from "../../src/server/found.js";

/** A project with an app on it, a scanner that's never run on its own, and a folder beside it ("outside drive"). */
async function setup() {
  const { root, store } = await tmpProject("cue-files");
  const found = new FoundScanner({ store, probe: async () => null, announce: () => undefined });
  const app = createApp(store, { found });
  const call = (path: string) => app.request(path);
  const post = (path: string, json: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });
  const put = async (rel: string, text = "sample") => {
    const abs = join(root, ...rel.split("/"));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text);
    return abs;
  };
  const media = (path: string) => call(`/media?path=${encodeURIComponent(path)}`);
  const outside = join(dirname(root), "outside drive");
  await mkdir(outside, { recursive: true });
  // The project's id is ensured (and written) on the first request: do it now, so later reads compare like with like.
  await call("/api/health");
  return { root, store, found, post, put, media, outside };
}

const pass = (cues: { name: string; t: number; file?: string }[]) => ({ stage: "sfx", name: "Effects for Lumen", file: "audio/sfx/pass.wav", cues });

describe("a cue's file (§23.3)", () => {
  it("POST /api/variants stores it as a manifest path and returns it; a cue without one has no key", async () => {
    const s = await setup();
    const r = await s.post("/api/variants", pass([{ name: "thud", t: 1, file: join(s.root, "audio", "sfx", "samples", "thud_low_03.wav") }, { name: "click", t: 2 }]));
    expect(r.status).toBe(201);
    const { variant } = (await r.json()) as { variant: { cues: unknown[] } };
    expect(variant.cues).toEqual([{ id: "thud", name: "thud", t: 1, file: "audio/sfx/samples/thud_low_03.wav" }, { id: "click", name: "click", t: 2 }]);
    const saved = JSON.parse(await readFile(join(s.root, ".rushes", "project.json"), "utf8"));
    expect(saved.lanes[0].variants[0].cues[1]).toEqual({ id: "click", name: "click", t: 2 });
  });

  it("refuses a cue file that isn't audio, or is over 1024 characters, and writes nothing", async () => {
    const s = await setup();
    const before = await readFile(join(s.root, ".rushes", "project.json"), "utf8");
    for (const file of ["notes.json", "../outside drive/id_ed25519", ".rushes/notes.json"]) {
      const r = await s.post("/api/variants", pass([{ name: "key", t: 1, file }]));
      expect(r.status, file).toBe(400);
      expect(((await r.json()) as { message: string }).message, file).toMatch(/^Cue "key": ".*" isn't an audio file/);
    }
    // §23.6: 1025 characters reaches checkCueFile (the body has no cap of its own), which names the cue.
    const long = await s.post("/api/variants", pass([{ name: "thud", t: 1, file: `${"a".repeat(1021)}.wav` }]));
    expect(long.status).toBe(400);
    expect(((await long.json()) as { message: string }).message).toBe('Cue "thud": its file path is over 1024 characters');
    expect(await readFile(join(s.root, ".rushes", "project.json"), "utf8")).toBe(before);
  });

  it("takes a long absolute path inside the project whose stored form is short (the limit is on the manifest path)", async () => {
    const s = await setup();
    // Built by hand: join() would normalise the "x/.." segments away.
    const file = `${s.root}/${"x/../".repeat(210)}audio/sfx/thud.wav`;
    expect(file.length).toBeGreaterThan(1024);
    const r = await s.post("/api/variants", pass([{ name: "thud", t: 1, file }]));
    expect(r.status).toBe(201);
    const { variant } = (await r.json()) as { variant: { cues: unknown[] } };
    expect(variant.cues).toEqual([{ id: "thud", name: "thud", t: 1, file: "audio/sfx/thud.wav" }]);
  });

  it("/media serves a registered cue's sample with the usual headers, and never the unregistered one beside it", async () => {
    const s = await setup();
    await s.put("audio/sfx/samples/thud_low_03.wav", "thud");
    await s.put("audio/sfx/samples/unused.wav", "unused");
    await s.post("/api/variants", pass([{ name: "thud", t: 1, file: "audio/sfx/samples/thud_low_03.wav" }]));
    const res = await s.media("audio/sfx/samples/thud_low_03.wav");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(await res.text()).toBe("thud");
    expect((await s.media("audio/sfx/samples/unused.wav")).status).toBe(404);
  });

  it("a cue's sample linked in from outside is served only when the real file is media (§15.5)", async () => {
    const s = await setup();
    await writeFile(join(s.outside, "boom.wav"), "boom");
    await writeFile(join(s.outside, "id_ed25519"), "secret");
    await mkdir(join(s.root, "audio", "sfx"), { recursive: true });
    await symlink(join(s.outside, "boom.wav"), join(s.root, "audio", "sfx", "boom.wav"));
    // key.wav starts as a link to real media, so it is registered and servable...
    const keyLink = join(s.root, "audio", "sfx", "key.wav");
    await symlink(join(s.outside, "boom.wav"), keyLink);
    const r = await s.post("/api/variants", pass([
      { name: "boom", t: 1, file: "audio/sfx/boom.wav" },
      { name: "key", t: 2, file: "audio/sfx/key.wav" },
      { name: "far", t: 3, file: join(s.outside, "boom.wav") },
    ]));
    expect(r.status).toBe(201);
    expect(await (await s.media("audio/sfx/boom.wav")).text()).toBe("boom");
    const before = await s.media("audio/sfx/key.wav");
    expect(before.status).toBe(200);
    expect(await before.text()).toBe("boom");
    // ...then it is swapped for a link to a key file. The same registered path is now refused,
    // and only §15.5's check of the real file can be what refuses it.
    await unlink(keyLink);
    await symlink(join(s.outside, "id_ed25519"), keyLink);
    const key = await s.media("audio/sfx/key.wav");
    expect(key.status).toBe(404);
    expect(await key.text()).not.toContain("secret");
    expect((await s.media(join(s.outside, "boom.wav"))).status).toBe(200);
    // Never registered, so refused before §15.5 is reached (the guard is proved by key.wav above).
    expect((await s.media(join(s.outside, "id_ed25519"))).status).toBe(404);
  });

  it("a hand-edited cue file that isn't audio is never served", async () => {
    const s = await setup();
    await s.post("/api/variants", pass([{ name: "thud", t: 1 }]));
    await s.store.update("notes", () => undefined); // so .rushes/notes.json is on disk
    const notes = await readFile(join(s.root, ".rushes", "notes.json"), "utf8");
    expect(notes).toContain('"notes"');
    await s.store.update("project", (p) => {
      p.lanes[0].variants[0].cues[0].file = ".rushes/notes.json";
    });
    const res = await s.media(".rushes/notes.json");
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toBe(notes);
    expect(text).not.toContain('"notes"');
  });

  it("Found leaves a registered cue's sample out (§20)", async () => {
    const s = await setup();
    await s.put("sfx/thud_low_03.wav");
    await s.put("sfx/whoosh_long_01.wav");
    await s.post("/api/variants", pass([{ name: "thud", t: 1, file: "sfx/thud_low_03.wav" }]));
    await s.found.scan();
    const paths = (await s.found.list()).map((f) => f.path);
    expect(paths).toContain("sfx/whoosh_long_01.wav");
    expect(paths).not.toContain("sfx/thud_low_03.wav");
  });
});
