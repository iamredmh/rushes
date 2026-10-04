import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, chmod, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { addVersion } from "../../src/core/project.js";
import type { Probe } from "../../src/core/media.js";
import type { Store } from "../../src/core/store.js";
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  KILL_GRACE_MS,
  ProxyJobs,
  encodeArgs,
  hasFpsMode,
  makeFfmpegRunner,
  parseFfmpegVersion,
  removePartials,
  scaledSize,
  type FfmpegRunner,
  type ProxyEvent,
  type Spawner,
} from "../../src/server/proxy.js";
import { startServer } from "../../src/server/start.js";

function has(bin: string): boolean {
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const FFMPEG = has("ffmpeg") && has("ffprobe");

const exists = (p: string) => access(p).then(() => true, () => false);

/** A project with one cut, "hero" v1, whose original is renders/hero.mov (written unless `missing`). */
async function project(opts: { missing?: boolean; duration?: number | null } = {}) {
  const { root, store } = await tmpProject();
  await mkdir(join(root, "renders"), { recursive: true });
  if (!opts.missing) await writeFile(join(root, "renders", "hero.mov"), "original bytes");
  await store.update("project", (p) => {
    addVersion(p, { video: "hero", file: "renders/hero.mov", duration: opts.duration === undefined ? 2 : opts.duration, fps: 25 });
  });
  return { root, store };
}

const ORIGINAL: Probe = { duration: 2, fps: 25, codec: "prores", width: 3840, height: 2160, pixFmt: "yuv422p10le" };
const PROXY: Probe = { duration: 2, fps: 25, codec: "h264", width: 1920, height: 1080, pixFmt: "yuv420p" };
const fakeProbe = async (abs: string): Promise<Probe> => (abs.endsWith("_proxy.mp4") ? PROXY : ORIGINAL);

interface Fake extends FfmpegRunner {
  calls: string[][];
  killed: boolean;
}

/**
 * A stand-in for ffmpeg: writes the output file, reports `steps` (out_time_us values) on stdout,
 * then waits on `gate` (or an abort, which it answers like a killed ffmpeg) and exits `code`.
 */
function fakeRunner(opts: { steps?: number[]; code?: number; stderr?: string; gate?: Promise<void>; version?: string } = {}): Fake {
  const fake = (async (args, o = {}) => {
    fake.calls.push(args);
    if (args[0] === "-version") {
      o.onStdout?.(Buffer.from(opts.version ?? "ffmpeg version 8.1 Copyright (c) 2000-2026 the FFmpeg developers\n"));
      return { code: 0, stderr: "" };
    }
    await writeFile(args[args.length - 1], "partial bytes");
    for (const us of opts.steps ?? []) o.onStdout?.(Buffer.from(`frame=1\nout_time_us=${us}\nprogress=continue\n`));
    const aborted = new Promise<"abort">((res) => {
      if (o.signal?.aborted) res("abort");
      o.signal?.addEventListener("abort", () => res("abort"));
    });
    const r = await Promise.race([opts.gate ?? Promise.resolve(), aborted]);
    if (r === "abort") {
      fake.killed = true;
      return { code: 255, stderr: "Exiting normally, received signal 15." };
    }
    return { code: opts.code ?? 0, stderr: opts.stderr ?? "" };
  }) as Fake;
  fake.calls = [];
  fake.killed = false;
  return fake;
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((res) => (open = res));
  return { promise, open };
}

function listen(store: Store): ProxyEvent[] {
  const events: ProxyEvent[] = [];
  store.on("proxy", (e: ProxyEvent) => events.push(e));
  return events;
}

describe("encodeArgs", () => {
  it("is §19.5's encode, as an args array", () => {
    expect(encodeArgs("/in/a.mov", "/out/b.partial.mp4")).toEqual([
      "-hide_banner", "-y", "-i", "/in/a.mov",
      "-vf", "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
      "-progress", "pipe:1", "/out/b.partial.mp4",
    ]);
  });

  it("uses -vsync passthrough on ffmpeg before 5.1, and -fps_mode passthrough from 5.1 (ruling A)", () => {
    const old = encodeArgs("/in/a.mov", "/out/b.mp4", { major: 4, minor: 4 });
    expect(old.slice(old.indexOf("yuv420p") + 1, old.indexOf("yuv420p") + 3)).toEqual(["-vsync", "passthrough"]);
    expect(old).not.toContain("-fps_mode");
    expect(encodeArgs("/in/a.mov", "/out/b.mp4", { major: 5, minor: 0 })).toContain("-vsync");
    const current = encodeArgs("/in/a.mov", "/out/b.mp4", { major: 5, minor: 1 });
    expect(current.slice(current.indexOf("yuv420p") + 1, current.indexOf("yuv420p") + 3)).toEqual(["-fps_mode", "passthrough"]);
    expect(current).not.toContain("-vsync");
    expect(encodeArgs("/in/a.mov", "/out/b.mp4", { major: 8, minor: 0 })).toContain("-fps_mode");
    // An unknown version (a git build) is taken as current.
    expect(encodeArgs("/in/a.mov", "/out/b.mp4", null)).toContain("-fps_mode");
  });

  it("reads ffmpeg's version from -version", () => {
    expect(parseFfmpegVersion("ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021")).toEqual({ major: 4, minor: 4 });
    expect(parseFfmpegVersion("ffmpeg version n5.1.3 Copyright")).toEqual({ major: 5, minor: 1 });
    expect(parseFfmpegVersion("ffmpeg version 8.1 Copyright")).toEqual({ major: 8, minor: 1 });
    expect(parseFfmpegVersion("ffmpeg version N-112345-gabcdef Copyright")).toBeNull();
    expect(hasFpsMode({ major: 5, minor: 0 })).toBe(false);
    expect(hasFpsMode({ major: 6, minor: 0 })).toBe(true);
  });

  it("scales to at most 1920 on the long edge, keeping sizes even", () => {
    expect(scaledSize(3840, 2160)).toEqual({ width: 1920, height: 1080 });
    expect(scaledSize(2160, 3840)).toEqual({ width: 1080, height: 1920 });
    expect(scaledSize(640, 360)).toEqual({ width: 640, height: 360 });
  });
});

describe("ProxyJobs", () => {
  it("dedupes: two starts for the same cut return the same job", async () => {
    const { store } = await project();
    const g = gate();
    const jobs = new ProxyJobs(store, { run: fakeRunner({ gate: g.promise }), probe: fakeProbe, available: async () => true });
    const a = jobs.start("hero", "v1");
    const b = jobs.start("hero", "v1");
    expect(b.id).toBe(a.id);
    expect(jobs.list()).toHaveLength(1);
    g.open();
    await jobs.wait(a.id);
  });

  it("reports monotonic progress, ending at done with the record set", async () => {
    const { root, store } = await project();
    const events = listen(store);
    const run = fakeRunner({ steps: [200_000, 500_000, 400_000, 1_000_000, 1_900_000, 2_500_000] });
    const jobs = new ProxyJobs(store, { run, probe: fakeProbe, available: async () => true });
    const job = jobs.start("hero", "v1");
    const end = await jobs.wait(job.id);
    expect(end.state).toBe("done");
    expect(end.pct).toBe(100);

    const pcts = events.map((e) => e.pct);
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThan(pcts[i - 1]);
    expect(pcts).toEqual([0, 10, 25, 50, 95, 99, 100]);
    expect(events.at(-1)).toEqual({ job: job.id, video: "hero", version: "v1", pct: 100, state: "done" });
    expect(events.slice(0, -1).every((e) => e.state === "running")).toBe(true);

    const v = (await store.read("project")).videos[0].versions[0];
    expect(v.proxy).toMatchObject({ file: "proxies/hero_v1_proxy.mp4", width: 1920, height: 1080, bytes: "partial bytes".length });
    expect(await exists(join(root, "proxies", "hero_v1_proxy.mp4"))).toBe(true);
    expect(await exists(join(root, "proxies", "hero_v1_proxy.partial.mp4"))).toBe(false);
    // ffmpeg wrote to the partial name, never to the final one.
    expect(run.calls.at(-1)!.at(-1)).toBe(join(root, "proxies", "hero_v1_proxy.partial.mp4"));
    expect(jobs.list()).toEqual([]);
  });

  it("cancel kills the job and deletes the partial file", async () => {
    const { root, store } = await project();
    const events = listen(store);
    const run = fakeRunner({ steps: [500_000], gate: new Promise(() => undefined) });
    const jobs = new ProxyJobs(store, { run, probe: fakeProbe, available: async () => true });
    const job = jobs.start("hero", "v1");
    // Wait until ffmpeg has started and written its partial file.
    while (!(await exists(join(root, "proxies", "hero_v1_proxy.partial.mp4")))) await new Promise((r) => setTimeout(r, 5));
    const end = await jobs.cancel(job.id);
    expect(end.state).toBe("cancelled");
    expect(run.killed).toBe(true);
    expect(await readdir(join(root, "proxies"))).toEqual([]);
    expect((await store.read("project")).videos[0].versions[0].proxy).toBeNull();
    expect(events.at(-1)).toMatchObject({ job: job.id, state: "cancelled" });
    expect(jobs.list()).toEqual([]);
    await expect(jobs.cancel(job.id)).rejects.toMatchObject({ status: 404 });
  });

  it("a cancel before ffmpeg starts never spawns it", async () => {
    const { store } = await project();
    const run = fakeRunner();
    const jobs = new ProxyJobs(store, { run, probe: fakeProbe, available: async () => true });
    const job = jobs.start("hero", "v1");
    expect((await jobs.cancel(job.id)).state).toBe("cancelled");
    expect(run.calls.filter((a) => a[0] !== "-version")).toEqual([]);
  });

  it("a runner that exits non-zero gives failed, with a reason, and no record", async () => {
    const { root, store } = await project();
    const events = listen(store);
    const run = fakeRunner({ code: 1, stderr: "frame=  10 fps=0.0\nhero.mov: Invalid data found when processing input\n" });
    const jobs = new ProxyJobs(store, { run, probe: fakeProbe, available: async () => true });
    const end = await jobs.wait(jobs.start("hero", "v1").id);
    expect(end.state).toBe("failed");
    expect(end.reason).toBe("ffmpeg stopped: hero.mov: Invalid data found when processing input");
    expect(events.at(-1)).toMatchObject({ state: "failed", reason: end.reason });
    expect((await store.read("project")).videos[0].versions[0].proxy).toBeNull();
    expect(await readdir(join(root, "proxies"))).toEqual([]);
  });

  it("fails visibly when the original is missing, leaving nothing behind (Review Focus 3)", async () => {
    const { root, store } = await project({ missing: true });
    const events = listen(store);
    const run = fakeRunner();
    const jobs = new ProxyJobs(store, { run, probe: fakeProbe, available: async () => true });
    const end = await jobs.wait(jobs.start("hero", "v1").id);
    expect(end).toMatchObject({ state: "failed", reason: "The original file is missing" });
    expect(events.at(-1)).toMatchObject({ state: "failed", reason: "The original file is missing" });
    expect(run.calls.filter((a) => a[0] !== "-version")).toEqual([]);
    expect(await exists(join(root, "proxies"))).toBe(false);
    expect((await store.read("project")).videos[0].versions[0].proxy).toBeNull();
    // The offer comes back: a fresh start is a new job.
    expect(jobs.list()).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("fails the same way when the original is unreadable", async () => {
    const { root, store } = await project();
    await chmod(join(root, "renders", "hero.mov"), 0o000);
    const jobs = new ProxyJobs(store, { run: fakeRunner(), probe: fakeProbe, available: async () => true });
    const end = await jobs.wait(jobs.start("hero", "v1").id);
    expect(end).toMatchObject({ state: "failed", reason: "The original file is missing" });
    await chmod(join(root, "renders", "hero.mov"), 0o644);
  });

  it("needNow never waits: null at first, the probe runs in the background, then it's cached per file revision", async () => {
    const { root, store } = await project();
    let probes = 0;
    const probe = async (abs: string) => {
      probes++;
      return fakeProbe(abs);
    };
    const jobs = new ProxyJobs(store, { run: fakeRunner(), probe, available: async () => true });
    const file = join(root, "renders", "hero.mov");
    expect(await jobs.needNow(file)).toBeNull();
    await jobs.probesIdle();
    expect(await jobs.needNow(file)).toBe("It's a 4K ProRes file, which browsers struggle with");
    expect(await jobs.needNow(file)).toBe("It's a 4K ProRes file, which browsers struggle with");
    expect(probes).toBe(1);
    await writeFile(file, "a different render, a different size");
    expect(await jobs.needNow(file)).toBeNull();
    await jobs.probesIdle();
    expect(await jobs.needNow(file)).not.toBeNull();
    expect(probes).toBe(2);
    expect(await jobs.needNow(join(root, "nope.mov"))).toBeNull();
  });

  it("needNow is null without ffmpeg, and probes nothing", async () => {
    const { root, store } = await project();
    let probes = 0;
    const jobs = new ProxyJobs(store, { run: fakeRunner(), probe: async (a) => (probes++, fakeProbe(a)), available: async () => false });
    expect(await jobs.needNow(join(root, "renders", "hero.mov"))).toBeNull();
    await jobs.probesIdle();
    expect(probes).toBe(0);
  });

  it("background probes run two at a time", async () => {
    const { root, store } = await project();
    const files = ["a", "b", "c", "d", "e"].map((n) => join(root, "renders", `${n}.mov`));
    for (const f of files) await writeFile(f, f);
    let running = 0;
    let most = 0;
    const probe = async (abs: string) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return fakeProbe(abs);
    };
    const jobs = new ProxyJobs(store, { run: fakeRunner(), probe, available: async () => true });
    for (const f of files) expect(await jobs.needNow(f)).toBeNull();
    await jobs.probesIdle();
    expect(most).toBe(2);
    for (const f of files) expect(await jobs.needNow(f)).not.toBeNull();
  });

  it("a probe that finds a need announces a change; one that finds none stays quiet", async () => {
    const { root, store } = await project();
    await writeFile(join(root, "renders", "small.mp4"), "small");
    const changes: unknown[] = [];
    store.on("change", (e) => changes.push(e));
    const jobs = new ProxyJobs(store, { run: fakeRunner(), probe: async (a) => (a.endsWith("small.mp4") ? PROXY : ORIGINAL), available: async () => true });
    await jobs.needNow(join(root, "renders", "small.mp4"));
    await jobs.probesIdle();
    expect(changes).toEqual([]);
    await jobs.needNow(join(root, "renders", "hero.mov"));
    await jobs.probesIdle();
    expect(changes).toEqual([{ file: "project", rev: (await store.read("project")).rev }]);
  });

  it("remembers at most needCacheLimit file revisions, oldest out first", async () => {
    const { root, store } = await project();
    const files = ["a", "b", "c"].map((n) => join(root, "renders", `${n}.mov`));
    for (const f of files) await writeFile(f, f);
    let probes = 0;
    const jobs = new ProxyJobs(store, { run: fakeRunner(), probe: async (a) => (probes++, fakeProbe(a)), available: async () => true, needCacheLimit: 2 });
    for (const f of files) {
      await jobs.needNow(f);
      await jobs.probesIdle();
    }
    expect(probes).toBe(3);
    // b and c are remembered; a was dropped, so asking again re-probes it.
    expect(await jobs.needNow(files[2])).not.toBeNull();
    expect(await jobs.needNow(files[1])).not.toBeNull();
    expect(probes).toBe(3);
    expect(await jobs.needNow(files[0])).toBeNull();
    await jobs.probesIdle();
    expect(probes).toBe(4);
  });
});

describe("start-up clean-up (Review Focus 1)", () => {
  it("removePartials deletes only *.partial.mp4", async () => {
    const { root } = await tmpProject();
    await mkdir(join(root, "proxies"));
    await writeFile(join(root, "proxies", "x.partial.mp4"), "half");
    await writeFile(join(root, "proxies", "hero_v1_proxy.mp4"), "whole");
    expect(await removePartials(root)).toEqual(["x.partial.mp4"]);
    expect(await readdir(join(root, "proxies"))).toEqual(["hero_v1_proxy.mp4"]);
  });

  it("a stray proxies/x.partial.mp4 is deleted when the server starts", async () => {
    const { root } = await tmpProject();
    await mkdir(join(root, "proxies"));
    await writeFile(join(root, "proxies", "x.partial.mp4"), "half");
    await writeFile(join(root, "proxies", "hero_v1_proxy.mp4"), "whole");
    const s = await startServer(root, { port: 0 });
    try {
      expect(await exists(join(root, "proxies", "x.partial.mp4"))).toBe(false);
      expect(await exists(join(root, "proxies", "hero_v1_proxy.mp4"))).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("closing the server cancels a running job and deletes its partial file", async () => {
    const { root } = await project();
    const run = fakeRunner({ gate: new Promise(() => undefined) });
    const s = await startServer(root, { port: 0, proxy: { run, probe: fakeProbe, available: async () => true } });
    const res = await fetch(`${s.url}/api/videos/hero/versions/v1/proxy`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(202);
    while (!(await exists(join(root, "proxies", "hero_v1_proxy.partial.mp4")))) await new Promise((r) => setTimeout(r, 5));
    await s.close();
    expect(run.killed).toBe(true);
    expect(await readdir(join(root, "proxies"))).toEqual([]);
  });
});

describe.skipIf(!FFMPEG)("ProxyJobs with real ffmpeg", () => {
  it("makes an h264 proxy of a ProRes cut with the same frame count", async () => {
    const { root, store } = await tmpProject();
    await mkdir(join(root, "renders"));
    const orig = join(root, "renders", "hero.mov");
    execFileSync("ffmpeg", [
      "-hide_banner", "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "prores_ks", "-profile:v", "1", "-c:a", "pcm_s16le", "-shortest", orig,
    ]);
    await store.update("project", (p) => {
      addVersion(p, { video: "hero", file: "renders/hero.mov", duration: 2, fps: 25 });
    });
    const events = listen(store);
    const jobs = new ProxyJobs(store);
    expect(await jobs.needNow(orig)).toBeNull();
    await jobs.probesIdle();
    expect(await jobs.needNow(orig)).toBe("It's a ProRes file, which browsers struggle with");
    const end = await jobs.wait(jobs.start("hero", "v1").id);
    expect(end).toMatchObject({ state: "done", pct: 100 });

    const proxy = join(root, "proxies", "hero_v1_proxy.mp4");
    const info = await stat(proxy);
    const record = (await store.read("project")).videos[0].versions[0].proxy;
    expect(record).toMatchObject({ file: "proxies/hero_v1_proxy.mp4", width: 640, height: 360, bytes: info.size });

    const count = (file: string) =>
      execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=codec_name,nb_read_frames", "-of", "csv=p=0", file]).toString().trim();
    expect(count(proxy)).toBe("h264,50");
    expect(count(orig)).toBe("prores,50");

    const pcts = events.map((e) => e.pct);
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThan(pcts[i - 1]);
    expect(events.at(-1)?.state).toBe("done");
    expect(await readdir(join(root, "proxies"))).toEqual(["hero_v1_proxy.mp4"]);
  });
});

describe("ProxyJobs, risky paths (fix round 1)", () => {
  it("detects ffmpeg 4.x once and encodes with -vsync passthrough", async () => {
    const { store } = await project();
    const run = fakeRunner({ version: "ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021 the FFmpeg developers\n" });
    const jobs = new ProxyJobs(store, { run, probe: fakeProbe, available: async () => true });
    expect((await jobs.wait(jobs.start("hero", "v1").id)).state).toBe("done");
    expect((await jobs.wait(jobs.start("hero", "v1").id)).state).toBe("done");
    const encodes = run.calls.filter((a) => a[0] !== "-version");
    expect(encodes).toHaveLength(2);
    for (const args of encodes) {
      expect(args).toContain("-vsync");
      expect(args).not.toContain("-fps_mode");
    }
    expect(run.calls.filter((a) => a[0] === "-version")).toHaveLength(1);
  });

  it("encodes with -fps_mode passthrough on a current ffmpeg", async () => {
    const { store } = await project();
    const run = fakeRunner();
    const jobs = new ProxyJobs(store, { run, probe: fakeProbe, available: async () => true });
    await jobs.wait(jobs.start("hero", "v1").id);
    expect(run.calls.find((a) => a[0] !== "-version")).toContain("-fps_mode");
  });

  for (const duration of [null, 0]) {
    it(`with a ${duration === null ? "null" : "0"} duration, progress stays at 0 until done`, async () => {
      const { store } = await project({ duration });
      const events = listen(store);
      const nothingKnown = async (abs: string): Promise<Probe> => (abs.endsWith("_proxy.mp4") ? PROXY : { ...ORIGINAL, duration });
      const run = fakeRunner({ steps: [500_000, 1_000_000, 1_500_000] });
      const jobs = new ProxyJobs(store, { run, probe: nothingKnown, available: async () => true });
      await jobs.wait(jobs.start("hero", "v1").id);
      expect(events.map((e) => [e.state, e.pct])).toEqual([["running", 0], ["done", 100]]);
    });
  }

  it("refuses a hand-edited id that would put a file outside proxies/", async () => {
    const { root, store } = await project();
    await store.update("project", (p) => {
      p.videos.push({ id: "../x", name: "Escape", lockedVersion: null, versions: [{ ...p.videos[0].versions[0] }] });
    });
    const run = fakeRunner();
    const jobs = new ProxyJobs(store, { run, probe: fakeProbe, available: async () => true });
    const end = await jobs.wait(jobs.start("../x", "v1").id);
    expect(end).toMatchObject({ state: "failed", reason: "Rushes can't name a proxy for this cut" });
    expect(run.calls.filter((a) => a[0] !== "-version")).toEqual([]);
    expect((await readdir(root)).filter((n) => n.includes("proxy"))).toEqual([]);
    expect(await exists(join(root, "proxies"))).toBe(false);
  });

  it("records the proxy only after the file is renamed into place", async () => {
    const { root, store } = await project();
    const seen: { final: boolean; partial: boolean }[] = [];
    store.on("change", () => {
      // Checked synchronously at the moment project.json is written.
      seen.push({
        final: existsSync(join(root, "proxies", "hero_v1_proxy.mp4")),
        partial: existsSync(join(root, "proxies", "hero_v1_proxy.partial.mp4")),
      });
    });
    const jobs = new ProxyJobs(store, { run: fakeRunner(), probe: fakeProbe, available: async () => true });
    await jobs.wait(jobs.start("hero", "v1").id);
    expect(seen).toEqual([{ final: true, partial: false }]);
  });

  it("a cancel that lands while the proxy is being recorded returns done and kills nothing", async () => {
    const { root, store } = await project();
    let signal: AbortSignal | undefined;
    const base = fakeRunner();
    const run = (async (args, o) => {
      if (args[0] !== "-version") signal = o?.signal;
      return base(args, o);
    }) as FfmpegRunner;
    let jobs!: ProxyJobs;
    let jobId = "";
    let cancelling: Promise<unknown> | undefined;
    const probe = async (abs: string) => {
      // The probe of the finished file runs inside the commit: cancel right there.
      if (abs.endsWith("_proxy.mp4") && !cancelling) cancelling = jobs.cancel(jobId);
      return fakeProbe(abs);
    };
    jobs = new ProxyJobs(store, { run, probe, available: async () => true });
    jobId = jobs.start("hero", "v1").id;
    const end = await jobs.wait(jobId);
    expect(cancelling).toBeDefined();
    expect(await cancelling).toMatchObject({ state: "done" });
    expect(end.state).toBe("done");
    expect(signal?.aborted).toBe(false);
    expect((await store.read("project")).videos[0].versions[0].proxy?.file).toBe("proxies/hero_v1_proxy.mp4");
    expect(await exists(join(root, "proxies", "hero_v1_proxy.mp4"))).toBe(true);
  });

  it("when recording fails after the rename, a first proxy's file is removed", async () => {
    const { root, store } = await project();
    const real = store.update.bind(store);
    store.update = (async (k: any, fn: any, rev?: number) => {
      if (k === "project") throw new Error("disk full");
      return real(k, fn, rev);
    }) as typeof store.update;
    const jobs = new ProxyJobs(store, { run: fakeRunner(), probe: fakeProbe, available: async () => true });
    const end = await jobs.wait(jobs.start("hero", "v1").id);
    expect(end).toMatchObject({ state: "failed", reason: "Couldn't record the proxy: disk full" });
    expect(await readdir(join(root, "proxies"))).toEqual([]);
  });

  it("when recording a re-render fails after the rename, the file the record points at is kept", async () => {
    const { root, store } = await project();
    const jobs = new ProxyJobs(store, { run: fakeRunner(), probe: fakeProbe, available: async () => true });
    await jobs.wait(jobs.start("hero", "v1").id);
    const before = (await store.read("project")).videos[0].versions[0].proxy;
    expect(before?.file).toBe("proxies/hero_v1_proxy.mp4");

    const real = store.update.bind(store);
    store.update = (async (k: any, fn: any, rev?: number) => {
      if (k === "project") throw new Error("disk full");
      return real(k, fn, rev);
    }) as typeof store.update;
    const end = await jobs.wait(jobs.start("hero", "v1").id);
    expect(end).toMatchObject({ state: "failed", reason: "Couldn't record the proxy: disk full" });
    expect(await readdir(join(root, "proxies"))).toEqual(["hero_v1_proxy.mp4"]);
    expect((await store.read("project")).videos[0].versions[0].proxy).toEqual(before);
  });

  it("once closing, start refuses a new job (503 closing) and the running one is cancelled", async () => {
    const { store } = await project();
    const jobs = new ProxyJobs(store, { run: fakeRunner({ gate: new Promise(() => undefined) }), probe: fakeProbe, available: async () => true });
    const running = jobs.start("hero", "v1");
    await jobs.close();
    expect(jobs.isClosing).toBe(true);
    expect(jobs.list()).toEqual([]);
    expect(() => jobs.start("hero", "v1")).toThrow(expect.objectContaining({ status: 503, code: "closing" }));
    await expect(jobs.cancel(running.id)).rejects.toMatchObject({ status: 404 });
  });

  it("dedupes identical frame extractions in flight", async () => {
    const { store } = await project();
    let frames = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const run: FfmpegRunner = async (args, o) => {
      if (args[0] === "-version") return { code: 0, stderr: "" };
      frames++;
      await held;
      o?.onStdout?.(Buffer.from("png bytes"));
      return { code: 0, stderr: "" };
    };
    const jobs = new ProxyJobs(store, { run, probe: fakeProbe, available: async () => true });
    const a = jobs.frame("/abs/hero.mov", 0.4);
    const b = jobs.frame("/abs/hero.mov", 0.4);
    const c = jobs.frame("/abs/hero.mov", 0.8);
    release();
    expect((await a)?.toString()).toBe("png bytes");
    expect(await b).toBe(await a);
    await c;
    expect(frames).toBe(2);
    // Once settled, the same frame runs again rather than being cached forever.
    await jobs.frame("/abs/hero.mov", 0.4);
    expect(frames).toBe(3);
  });
});

describe("makeFfmpegRunner: the kill", () => {
  /** A child that ignores SIGTERM (or exits on it, with `exitOnTerm`) and records every signal. */
  function fakeChild(exitOnTerm = false) {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; signalCode: string | null; signals: string[]; kill(s: string): boolean };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.signals = [];
    child.kill = (sig: string) => {
      child.signals.push(sig);
      if (sig === "SIGKILL" || exitOnTerm) {
        child.signalCode = sig;
        queueMicrotask(() => child.emit("close", null));
      }
      return true;
    };
    return child;
  }

  it("escalates to SIGKILL 2 s after a SIGTERM that's ignored", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      let spawned = 0;
      const spawner: Spawner = (cmd, args, opts) => {
        spawned++;
        expect(cmd).toBe("ffmpeg");
        expect(opts.env.LC_ALL).toBe("C");
        return child as unknown as ChildProcess;
      };
      const run = makeFfmpegRunner(spawner);
      const controller = new AbortController();
      const done = run(["-i", "x"], { signal: controller.signal });
      controller.abort();
      expect(child.signals).toEqual(["SIGTERM"]);
      vi.advanceTimersByTime(KILL_GRACE_MS - 1);
      expect(child.signals).toEqual(["SIGTERM"]);
      vi.advanceTimersByTime(1);
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(await done).toEqual({ code: 1, stderr: "" });
      expect(spawned).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't SIGKILL a child that exited on SIGTERM", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild(true);
      const run = makeFfmpegRunner(() => child as unknown as ChildProcess);
      const controller = new AbortController();
      const done = run(["-i", "x"], { signal: controller.signal });
      controller.abort();
      await done;
      vi.advanceTimersByTime(KILL_GRACE_MS * 2);
      expect(child.signals).toEqual(["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never spawns when the signal has already aborted", async () => {
    let spawned = 0;
    const run = makeFfmpegRunner(() => {
      spawned++;
      return fakeChild() as unknown as ChildProcess;
    });
    const controller = new AbortController();
    controller.abort();
    expect(await run(["-i", "x"], { signal: controller.signal })).toEqual({ code: 1, stderr: "" });
    expect(spawned).toBe(0);
  });

  it("passes stdout through and resolves with the exit code", async () => {
    const child = fakeChild();
    const run = makeFfmpegRunner(() => child as unknown as ChildProcess);
    const chunks: string[] = [];
    const done = run(["-version"], { onStdout: (c) => chunks.push(c.toString()) });
    child.stdout.emit("data", Buffer.from("ffmpeg version 4.4"));
    child.stderr.emit("data", Buffer.from("warning"));
    child.emit("close", 0);
    expect(await done).toEqual({ code: 0, stderr: "warning" });
    expect(chunks).toEqual(["ffmpeg version 4.4"]);
  });
});
