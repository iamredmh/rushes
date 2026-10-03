import { describe, expect, it } from "vitest";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { addVariant, addVersion } from "../../src/core/project.js";
import { addTake, setSections } from "../../src/core/script.js";
import { fromManifestPath } from "../../src/core/paths.js";
import { listAssets, screenshotName } from "../../src/server/assets.js";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("screenshotName", () => {
  it("names the file video_version_MMmSS.SSs_fFRAME.png, time from frame/fps", () => {
    expect(screenshotName("hero-60s", "v3", 726, 60)).toBe("hero-60s_v3_00m12.10s_f726.png");
  });

  it("rounds to hundredths before splitting minutes and seconds, same as fmt(): 59.999s carries into the next minute", () => {
    // frame/fps = 59999/1000 = 59.999 exactly.
    expect(screenshotName("hero", "v1", 59999, 1000)).toBe("hero_v1_01m00.00s_f59999.png");
  });

  it("zero-pads minutes to two digits", () => {
    expect(screenshotName("hero", "v1", 0, 30)).toBe("hero_v1_00m00.00s_f0.png");
  });
});

describe("listAssets", () => {
  async function seeded() {
    const { root, store } = await tmpProject("demo");
    await mkdir(join(root, "screenshots"), { recursive: true });

    await store.update("project", (p) => {
      addVersion(p, { video: "Hero", file: "renders/hero_v1.mp4" });
    });
    await store.update("project", (p) => {
      addVersion(p, { video: "Hero", file: "renders/hero_v2.mp4" });
    });
    await store.update("script", (s) => {
      setSections(s, [{ start: 0, end: 5, current: "Line one." }]);
    });
    await store.update("script", (s) => {
      addTake(s, "s1", { file: "audio/s1_take1.wav" });
    });
    await store.update("project", (p) => {
      addVariant(p, { stage: "voice", name: "Red", file: "audio/voice.wav" });
    });
    await store.update("project", (p) => {
      addVariant(p, { stage: "music", name: "Deep house", file: "audio/music.wav" });
    });
    await store.update("project", (p) => {
      addVariant(p, { stage: "sfx", name: "Whoosh", file: "audio/sfx.wav" });
    });

    // A screenshot whose name parses back to video/version/frame/t.
    const newest = join(root, "screenshots", "hero_v1_00m01.00s_f30.png");
    await writeFile(newest, PNG_HEADER);
    // An old-style grab from Plans 1-2: still listed and still served.
    const oldGrab = join(root, ".rushes", "grabs", "hero_v1_f15.png");
    await writeFile(oldGrab, PNG_HEADER);
    // Safe to serve, but doesn't match the video_version_time_frame pattern.
    const whiteboard = join(root, "screenshots", "whiteboard.png");
    await writeFile(whiteboard, PNG_HEADER);
    // Not a PNG: ignored entirely.
    await writeFile(join(root, "screenshots", "notes.txt"), "hello");
    // Unsafe name (uppercase first character): must never be listed, since /media could never serve it.
    await writeFile(join(root, "screenshots", "Capital.png"), PNG_HEADER);

    // Distinct, deterministic mtimes so "newest modified first" has one right answer.
    const now = Date.now();
    await utimes(whiteboard, new Date(now - 2000), new Date(now - 2000));
    await utimes(oldGrab, new Date(now - 1000), new Date(now - 1000));
    await utimes(newest, new Date(now), new Date(now));

    const [project, script] = await Promise.all([store.read("project"), store.read("script")]);
    return { root, store, project, script };
  }

  it("orders screenshots (newest first), then cuts (newest version first), then takes, voice, music, sfx", async () => {
    const { store, project, script } = await seeded();
    const assets = await listAssets(store, project, script);
    expect(assets.map((a) => a.kind)).toEqual([
      "screenshot", "screenshot", "screenshot",
      "cut", "cut",
      "take",
      "voice", "music", "sfx",
    ]);
    expect(assets.map((a) => a.path)).toEqual([
      "screenshots/hero_v1_00m01.00s_f30.png",
      ".rushes/grabs/hero_v1_f15.png",
      "screenshots/whiteboard.png",
      "renders/hero_v2.mp4",
      "renders/hero_v1.mp4",
      "audio/s1_take1.wav",
      "audio/voice.wav",
      "audio/music.wav",
      "audio/sfx.wav",
    ]);
  });

  it("parses video/version/frame/t off a new-style screenshot name", async () => {
    const { store, root, project, script } = await seeded();
    const assets = await listAssets(store, project, script);
    const shot = assets.find((a) => a.path === "screenshots/hero_v1_00m01.00s_f30.png")!;
    expect(shot).toMatchObject({ video: "hero", version: "v1", frame: 30, t: 1, missing: false });
    expect(shot.abs).toBe(fromManifestPath(root, shot.path));
    expect(typeof shot.size).toBe("number");
    expect(shot.modified).not.toBeNull();
  });

  it("parses an old-style grab name too", async () => {
    const { store, project, script } = await seeded();
    const assets = await listAssets(store, project, script);
    const grab = assets.find((a) => a.path === ".rushes/grabs/hero_v1_f15.png")!;
    expect(grab).toMatchObject({ video: "hero", version: "v1", frame: 15, t: 0.5 });
  });

  it("lists a screenshot with no video/version/frame when its name doesn't parse", async () => {
    const { store, project, script } = await seeded();
    const assets = await listAssets(store, project, script);
    const whiteboard = assets.find((a) => a.path === "screenshots/whiteboard.png")!;
    expect(whiteboard.video).toBeUndefined();
    expect(whiteboard.version).toBeUndefined();
    expect(whiteboard.frame).toBeUndefined();
    expect(whiteboard.t).toBeUndefined();
  });

  it("never lists a screenshot whose name /media couldn't serve, or a non-png file", async () => {
    const { store, project, script } = await seeded();
    const assets = await listAssets(store, project, script);
    expect(assets.some((a) => a.path.includes("Capital"))).toBe(false);
    expect(assets.some((a) => a.path.includes("notes.txt"))).toBe(false);
  });

  it("marks a registered file that's gone from disk as missing, with null size and modified", async () => {
    const { store, project, script } = await seeded();
    const assets = await listAssets(store, project, script);
    const cut = assets.find((a) => a.path === "renders/hero_v2.mp4")!;
    expect(cut).toMatchObject({ video: "hero", version: "v2", missing: true, size: null, modified: null });
    const take = assets.find((a) => a.path === "audio/s1_take1.wav")!;
    expect(take).toMatchObject({ section: "s1", missing: true });
    const voice = assets.find((a) => a.path === "audio/voice.wav")!;
    expect(voice).toMatchObject({ lane: "voice", variant: "red", missing: true });
    const music = assets.find((a) => a.path === "audio/music.wav")!;
    expect(music).toMatchObject({ lane: "music", variant: "deep-house", missing: true });
    const sfx = assets.find((a) => a.path === "audio/sfx.wav")!;
    expect(sfx).toMatchObject({ lane: "sfx", variant: "whoosh", missing: true });
  });

  it("is empty, not an error, when the project has nothing yet (no screenshots/ folder either)", async () => {
    const { root, store } = await tmpProject("empty");
    const [project, script] = await Promise.all([store.read("project"), store.read("script")]);
    expect(await listAssets(store, project, script)).toEqual([]);
    expect(root).toBeTruthy();
  });
});
