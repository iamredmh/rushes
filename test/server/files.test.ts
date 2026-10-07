import { describe, expect, it } from "vitest";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { createApp } from "../../src/server/app.js";
import { addFormat, addVariant, addVersion } from "../../src/core/project.js";
import { parseRange, inside, contentDisposition, foundMediaFile, OUTSIDE_MEDIA_EXT, CONTENT_TYPES, isInlineSafeType, registeredMedia } from "../../src/server/files.js";
import { OPEN_SAFE_EXT as SERVER_OPEN_SAFE_EXT } from "../../src/server/reveal.js";
import { OPEN_SAFE_EXT as WEB_OPEN_SAFE_EXT, PREVIEWABLE_EXT, VIDEO_EXT as WEB_VIDEO_EXT } from "../../web/src/lib.js";
import { AUDIO_EXT, VIDEO_EXT } from "../../src/core/found.js";

// The smallest valid PNG (1×1, transparent).
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function setup() {
  const { root, store } = await tmpProject("files");
  const webDir = join(root, "web");
  await mkdir(join(webDir, "assets"), { recursive: true });
  await writeFile(join(webDir, "index.html"), "<!doctype html><title>Rushes</title><div id=app></div>");
  await writeFile(join(webDir, "assets", "app-abc123.js"), "console.log('hi')");
  const app = createApp(store, { webDir });
  const call = (path: string, init: RequestInit = {}) => app.request(path, init);
  const post = (path: string, json: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });
  return { root, store, call, post };
}

describe("parseRange", () => {
  it("reads start-end, open-ended and suffix ranges", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });
  it("rejects ranges it can't satisfy", () => {
    expect(parseRange("bytes=2000-", 1000)).toBeNull();
    expect(parseRange("bytes=5-1", 1000)).toBeNull();
    expect(parseRange("bytes=-", 1000)).toBeNull();
    expect(parseRange("items=0-1", 1000)).toBeNull();
    expect(parseRange(undefined, 1000)).toBeNull();
  });
});

describe("contentDisposition", () => {
  it("strips control characters (and DEL) from the ASCII fallback so a newline can never reach the header", () => {
    const header = contentDisposition("evil\nfile.mp4");
    expect(header).not.toContain("\n");
    expect(header).toContain('filename="evil_file.mp4"');
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent("evil\nfile.mp4")}`);
  });

  it("replaces non-ASCII characters, quotes, backslashes, C0 controls and DEL with _, leaving filename* untouched", () => {
    const name = 'caf\u00e9 "clip"\\.mp4\r\n\x7f';
    const header = contentDisposition(name);
    expect(header).toBe(`attachment; filename="caf_ _clip__.mp4___"; filename*=UTF-8''${encodeURIComponent(name)}`);
  });

  it("replaces an unpaired UTF-16 surrogate instead of letting encodeURIComponent throw", () => {
    const name = "clip_\uD800_end.mp4"; // a lone high surrogate: invalid UTF-16 on its own
    expect(() => contentDisposition(name)).not.toThrow();
    const header = contentDisposition(name);
    // The replaced surrogate is non-ASCII too, so it collapses to its own "_" in the fallback.
    expect(header).toContain('filename="clip___end.mp4"');
    expect(header).toContain("filename*=UTF-8''clip_%EF%BF%BD_end.mp4");
  });
});

describe("inside", () => {
  it("keeps paths inside the folder and refuses escapes", () => {
    expect(inside("/web", "assets/a.js")).toBe("/web/assets/a.js");
    expect(inside("/web", "../etc/passwd")).toBeNull();
    expect(inside("/web", "assets/../../etc/passwd")).toBeNull();
  });
});

describe("foundMediaFile", () => {
  it("gives the real file for a plain relative path inside the root, odd names included", async () => {
    const { root } = await tmpProject();
    const name = "Voice memo 10.02 AM é.wav";
    await mkdir(join(root, "vo jules"), { recursive: true });
    await writeFile(join(root, "vo jules", name), "x");
    expect(await foundMediaFile(root, `vo jules/${name}`)).toBe(join(root, "vo jules", name));
  });

  it("refuses absolute, dotted, empty-segment and backslash paths, folders and missing files", async () => {
    const { root } = await tmpProject();
    await mkdir(join(root, "vo"), { recursive: true });
    await writeFile(join(root, "vo", "a.wav"), "x");
    for (const bad of [join(root, "vo", "a.wav"), "../a.wav", "vo/../vo/a.wav", "./vo/a.wav", "vo//a.wav", "vo\\a.wav", "", "vo", "vo/missing.wav", "vo/a.wav/"]) {
      expect(await foundMediaFile(root, bad)).toBeNull();
    }
  });

  it("refuses a symlinked file, or a file reached through a symlinked folder, wherever it points", async () => {
    const { root } = await tmpProject();
    const outside = join(dirname(root), "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "a.wav"), "secret");
    await mkdir(join(root, "vo"), { recursive: true });
    await writeFile(join(root, "vo", "real.wav"), "x");
    await symlink(join(outside, "a.wav"), join(root, "vo", "out.wav"));
    await symlink(join(root, "vo", "real.wav"), join(root, "vo", "in.wav"));
    await symlink(outside, join(root, "linked"));
    await symlink(join(root, "vo"), join(root, "alias"));
    expect(await foundMediaFile(root, "vo/out.wav")).toBeNull();
    expect(await foundMediaFile(root, "vo/in.wav")).toBeNull();
    expect(await foundMediaFile(root, "linked/a.wav")).toBeNull();
    expect(await foundMediaFile(root, "alias/real.wav")).toBeNull();
    expect(await foundMediaFile(root, "vo/real.wav")).toBe(join(root, "vo", "real.wav"));
  });
});

describe("dashboard files", () => {
  it("serves the built index.html at /p/<id>/ and its assets", async () => {
    const { call } = await setup();
    const id = ((await (await call("/api/health")).json()) as { id: string }).id;
    const page = await call(`/p/${id}/`);
    expect(await page.text()).toContain("<div id=app>");
    const js = await call("/assets/app-abc123.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toBe("console.log('hi')");
  });
  it("404s for missing assets and refuses to leave the folder", async () => {
    const { call } = await setup();
    expect((await call("/assets/nope.js")).status).toBe(404);
    expect((await call("/assets/..%2F..%2Fpackage.json")).status).toBe(404);
  });
  it("404s rather than 500s on a path with bad percent-encoding", async () => {
    const { call } = await setup();
    expect((await call("/assets/%")).status).toBe(404);
  });
});

describe("media", () => {
  async function withClip() {
    const s = await setup();
    await mkdir(join(s.root, "renders"), { recursive: true });
    await writeFile(join(s.root, "renders", "hero v1.mp4"), Buffer.alloc(1000, 7));
    await s.post("/api/versions", { video: "Hero", file: "renders/hero v1.mp4" });
    return s;
  }

  it("serves AIFF and Opus variants inline as audio, never as an octet-stream download (M9)", async () => {
    const s = await setup();
    await mkdir(join(s.root, "audio"), { recursive: true });
    const cases: [string, string][] = [["bed.aif", "audio/aiff"], ["bed.AIFF", "audio/aiff"], ["read.opus", "audio/ogg"]];
    for (const [name] of cases) {
      await writeFile(join(s.root, "audio", name), Buffer.alloc(100, 1));
      await s.post("/api/variants", { stage: "music", name, file: `audio/${name}` });
    }
    for (const [name, type] of cases) {
      const res = await s.call(`/media?path=${encodeURIComponent(`audio/${name}`)}`);
      expect(res.status, name).toBe(200);
      expect(res.headers.get("content-type"), name).toBe(type);
      expect(res.headers.get("content-disposition"), name).toBeNull();
    }
  });

  it("streams a registered file, whole or by byte range", async () => {
    const { call } = await withClip();
    const whole = await call(`/media?path=${encodeURIComponent("renders/hero v1.mp4")}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(whole.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    // C1: an inline-safe type (video) still gets the CSP/nosniff pair every /media response
    // carries, and isn't forced to a download.
    expect(whole.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(whole.headers.get("x-content-type-options")).toBe("nosniff");
    expect(whole.headers.get("content-disposition")).toBeNull();
    expect((await whole.arrayBuffer()).byteLength).toBe(1000);
    const part = await call(`/media?path=${encodeURIComponent("renders/hero v1.mp4")}`, { headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    const bad = await call(`/media?path=${encodeURIComponent("renders/hero v1.mp4")}`, { headers: { range: "bytes=5000-" } });
    expect(bad.status).toBe(416);
  });

  it("refuses any path the project didn't register or auto-discover", async () => {
    const { call, root } = await withClip();
    // Not .md/.txt/.pdf (§16.2's auto-discovered doc extensions), so this one is still refused
    // on its own: it was never registered and nothing automatic picks it up either.
    await writeFile(join(root, "secret.bin"), "no");
    expect((await call("/media?path=secret.bin")).status).toBe(404);
    expect((await call("/media?path=..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await call("/media?path=.rushes%2Fnotes.json")).status).toBe(404);
  });

  it("serves an auto-discovered doc at the project root, even though nothing registered it (§16.2)", async () => {
    const { call, root } = await withClip();
    await writeFile(join(root, "brief.md"), "# Brief\n");
    const res = await call("/media?path=brief.md");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# Brief\n");
  });

  it("serves an image inline, with the CSP/nosniff pair, never forced to a download", async () => {
    const { call, post, root } = await setup();
    await writeFile(join(root, "image.png"), Buffer.alloc(16, 1));
    await post("/api/files", { file: "image.png", kind: "image" });
    const res = await call("/media?path=image.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("C1: never serves an exports/*.html file inline -- octet-stream, forced attachment, CSP", async () => {
    const { call, root } = await setup();
    await mkdir(join(root, "exports"), { recursive: true });
    await writeFile(join(root, "exports", "x.html"), "<script>fetch('/api/shutdown',{method:'POST'})</script>");
    const res = await call("/media?path=exports%2Fx.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain('filename="x.html"');
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("C1: never serves an exports/*.svg file inline -- octet-stream, forced attachment, CSP", async () => {
    const { call, root } = await setup();
    await mkdir(join(root, "exports"), { recursive: true });
    await writeFile(join(root, "exports", "x.svg"), '<svg onload="alert(1)"></svg>');
    const res = await call("/media?path=exports%2Fx.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("says when a registered file has gone missing", async () => {
    const { post, call } = await setup();
    await post("/api/versions", { video: "Hero", file: "renders/gone.mp4" });
    const r = await call("/media?path=renders%2Fgone.mp4");
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: "missing_file" });
  });
});

describe("registeredMedia and formats", () => {
  it("registeredMedia includes every format file of every cut (§21.6)", () => {
    const p = { schema: 1 as const, rev: 0, name: "demo", fps: 30, videos: [], lanes: [], files: [], autoProxy: false };
    addVersion(p, { video: "Hero", file: "renders/hero_v1.mp4", width: 1920, height: 1080 });
    addFormat(p, { file: "/elsewhere/hf/hero_v1_9x16.mp4", width: 1080, height: 1920, duration: 8, fps: 30 });
    expect(registeredMedia(p, { schema: 1, rev: 0, wordsPerSecond: 2.6, sections: [] }).has("/elsewhere/hf/hero_v1_9x16.mp4")).toBe(true);
  });
});

describe("registered files that are symlinks (§15.5)", () => {
  /** A project, a folder beside it ("outside"), and a way to register any path as a music variant. */
  async function linked() {
    const s = await setup();
    const outside = join(dirname(s.root), "outside drive");
    await mkdir(outside, { recursive: true });
    let n = 0;
    const reg = (file: string) => s.store.update("project", (p) => addVariant(p, { stage: "music", name: `v${++n}`, file }));
    const get = (path: string) => s.call(`/media?path=${encodeURIComponent(path)}`);
    await mkdir(join(s.root, "takes"), { recursive: true });
    return { ...s, outside, reg, get };
  }

  it("serves a symlink to media outside the project (footage on another drive)", async () => {
    const { root, outside, reg, get } = await linked();
    await writeFile(join(outside, "A001 clip.mov"), "footage");
    await symlink(join(outside, "A001 clip.mov"), join(root, "takes", "clip.mov"));
    await reg("takes/clip.mov");
    const res = await get("takes/clip.mov");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("footage");
  });

  it("serves a .mkv and a .aac linked in from another drive, which the dashboard plays", async () => {
    const { root, outside, reg, get } = await linked();
    for (const name of ["film.mkv", "bed.aac"]) {
      await writeFile(join(outside, name), "media");
      await symlink(join(outside, name), join(root, "takes", name));
      await reg(`takes/${name}`);
      const res = await get(`takes/${name}`);
      expect(res.status, name).toBe(200);
      expect(await res.text()).toBe("media");
    }
  });

  it("refuses a symlink out of the project to a file that isn't media, whatever the link is called", async () => {
    const { root, outside, reg, get } = await linked();
    for (const [link, target] of [["take1.wav", "credentials.json"], ["take2.wav", "id_ed25519"], ["take3.mp4", "server.pem"]]) {
      await writeFile(join(outside, target), "secret");
      await symlink(join(outside, target), join(root, "takes", link));
      await reg(`takes/${link}`);
      const res = await get(`takes/${link}`);
      expect(res.status, link).toBe(404);
      expect(await res.text(), link).not.toContain("secret");
    }
  });

  it("checks the final real path: a media-named link to a link to a secret is refused", async () => {
    const { root, outside, reg, get } = await linked();
    await writeFile(join(outside, "secret.pem"), "secret");
    await symlink(join(outside, "secret.pem"), join(outside, "looks like.wav"));
    await symlink(join(outside, "looks like.wav"), join(root, "takes", "chain.wav"));
    await reg("takes/chain.wav");
    expect((await get("takes/chain.wav")).status).toBe(404);
  });

  it("applies the same rule through a symlinked folder", async () => {
    const { root, outside, reg, get } = await linked();
    await writeFile(join(outside, "bed.wav"), "music");
    await writeFile(join(outside, "keys.json"), "secret");
    await symlink(outside, join(root, "drive"));
    await reg("drive/bed.wav");
    await reg("drive/keys.json");
    expect((await get("drive/bed.wav")).status).toBe(200);
    expect((await get("drive/keys.json")).status).toBe(404);
  });

  it("serves a symlink to a file inside the project as before, and an absolute registered path outside only if it's media", async () => {
    const { root, outside, reg, get } = await linked();
    await writeFile(join(root, "takes", "real.wav"), "inside");
    await symlink(join(root, "takes", "real.wav"), join(root, "takes", "alias.wav"));
    await reg("takes/alias.wav");
    expect(await (await get("takes/alias.wav")).text()).toBe("inside");
    await writeFile(join(outside, "render.mp4"), "render");
    await writeFile(join(outside, "notes.json"), "secret");
    await reg(join(outside, "render.mp4"));
    await reg(join(outside, "notes.json"));
    expect((await get(join(outside, "render.mp4"))).status).toBe(200);
    expect((await get(join(outside, "notes.json"))).status).toBe(404);
  });

  it("refuses an edit-app project file outside the project: it can be revealed, never downloaded", async () => {
    const { root, outside, reg, get } = await linked();
    await writeFile(join(outside, "Edit.prproj"), "project");
    await symlink(join(outside, "Edit.prproj"), join(root, "takes", "edit.prproj"));
    await reg("takes/edit.prproj");
    expect((await get("takes/edit.prproj")).status).toBe(404);
  });
});

describe("frame grabs", () => {
  it("saves a PNG under screenshots/, named by time, and serves it back", async () => {
    const { post, call, root } = await setup();
    // No version is registered, so fps falls back to the project default (30): 744/30 = 24.8s.
    const r = await post("/api/grabs", { video: "hero-60s", version: "v3", frame: 744, png: `data:image/png;base64,${PNG_1PX}` });
    expect(r.status).toBe(201);
    const { grab } = (await r.json()) as { grab: string };
    expect(grab).toBe("screenshots/hero-60s_v3_00m24.80s_f744.png");
    expect((await readFile(join(root, grab))).subarray(1, 4).toString()).toBe("PNG");
    const back = await call(`/media?path=${encodeURIComponent(grab)}`);
    expect(back.status).toBe(200);
    expect(back.headers.get("content-type")).toBe("image/png");
  });

  it("uses the version's own fps over the project default", async () => {
    const { post, call, store } = await setup();
    await store.update("project", (p) => {
      p.videos.push({ id: "hero-60s", name: "Hero 60s", lockedVersion: null, versions: [
        { id: "v3", file: "renders/hero.mp4", duration: null, fps: 60, addedAt: new Date().toISOString(), note: "", shots: [], proxy: null, width: null, height: null, formats: [] },
      ] });
    });
    const r = await post("/api/grabs", { video: "hero-60s", version: "v3", frame: 726, png: `data:image/png;base64,${PNG_1PX}` });
    const { grab } = (await r.json()) as { grab: string };
    expect(grab).toBe("screenshots/hero-60s_v3_00m12.10s_f726.png");
    expect((await call(`/media?path=${encodeURIComponent(grab)}`)).status).toBe(200);
  });

  it("rejects anything that isn't a PNG, and unsafe names", async () => {
    const { post } = await setup();
    expect((await post("/api/grabs", { video: "hero", version: "v1", frame: 1, png: Buffer.from("hello").toString("base64") })).status).toBe(400);
    expect((await post("/api/grabs", { video: "../x", version: "v1", frame: 1, png: PNG_1PX })).status).toBe(400);
    expect((await post("/api/grabs", { video: "hero", version: "latest", frame: 1, png: PNG_1PX })).status).toBe(400);
  });
  it("rejects a frame number so large it would print in exponent form", async () => {
    const { post } = await setup();
    expect((await post("/api/grabs", { video: "hero", version: "v1", frame: 10_000_001, png: PNG_1PX })).status).toBe(400);
  });

  it("an old-style .rushes/grabs/*.png from Plans 1-2 is still served", async () => {
    const { call, root } = await setup();
    await mkdir(join(root, ".rushes", "grabs"), { recursive: true });
    await writeFile(join(root, ".rushes", "grabs", "hero_v1_f60.png"), Buffer.from(PNG_1PX, "base64"));
    const back = await call(`/media?path=${encodeURIComponent(".rushes/grabs/hero_v1_f60.png")}`);
    expect(back.status).toBe(200);
    expect(back.headers.get("content-type")).toBe("image/png");
  });
});

// §15.5: what /media serves from outside the project must be exactly what the dashboard treats as
// media. A format the dashboard plays but /media refuses would stop playing, so any list that
// drifts from the others fails here.
describe("the outside-the-project allow-list matches every list of media extensions", () => {
  // Project files for an editing app: revealed from the dashboard, never served from outside.
  const EDIT_FILES = new Set(["prproj", "drp"]);
  const bare = (exts: Iterable<string>) => [...exts].map((e) => e.replace(/^\./, ""));
  const sources: Record<string, string[]> = {
    "the dashboard's open-safe list": bare(WEB_OPEN_SAFE_EXT),
    "the server's open-safe list": bare(SERVER_OPEN_SAFE_EXT),
    "the dashboard's video list": bare(WEB_VIDEO_EXT),
    "the dashboard's previewable list": bare(PREVIEWABLE_EXT),
    "the scan's audio list": bare(AUDIO_EXT),
    "the scan's video list": bare(VIDEO_EXT),
    "every inline-safe content type": Object.entries(CONTENT_TYPES).filter(([, t]) => isInlineSafeType(t)).map(([e]) => e.slice(1)),
  };

  it.each(Object.entries(sources))("serves every extension in %s", (_name, exts) => {
    const missing = exts.filter((e) => !EDIT_FILES.has(e) && !OUTSIDE_MEDIA_EXT.has(e));
    expect(missing).toEqual([]);
  });

  it("serves nothing the dashboard doesn't treat as media, and gives each extension a content type", () => {
    const known = new Set(Object.values(sources).flat());
    expect([...OUTSIDE_MEDIA_EXT].filter((e) => !known.has(e))).toEqual([]);
    for (const e of OUTSIDE_MEDIA_EXT) expect(CONTENT_TYPES[`.${e}`], e).toBeDefined();
  });
});
