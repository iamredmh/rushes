import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { createApp } from "../../src/server/app.js";
import { addVersion } from "../../src/core/project.js";
import type { Probe } from "../../src/core/media.js";
import type { ChangeEvent, Store } from "../../src/core/store.js";
import { ProxyJobs, type FfmpegRunner } from "../../src/server/proxy.js";
import { PEAK_BUCKETS, PEAKS_CONCURRENCY, PEAKS_FILE, PEAKS_MAX_BYTES, PeakJobs, peaksTimeoutMs, removeOrphanPeaks, removePeakTemps } from "../../src/server/peaks.js";
import { startServer } from "../../src/server/start.js";

const has = (bin: string) => {
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const FFMPEG = has("ffmpeg") && has("ffprobe");

const H264: Probe = { duration: 2, fps: 25, codec: "h264", width: 1280, height: 720, pixFmt: "yuv420p" };

function f32(samples: number[]): Buffer {
  const b = Buffer.alloc(samples.length * 4);
  samples.forEach((s, i) => b.writeFloatLE(s, i * 4));
  return b;
}

interface Fake extends FfmpegRunner {
  calls: string[][];
  killed: number;
}

/**
 * A stand-in for ffmpeg's audio decode. Answers `-version`; otherwise writes `samples` (as f32le)
 * to stdout, waits on `gate` (or an abort, which it answers like a killed ffmpeg), and exits with
 * `code` and `stderr`. `behaviour` picks per input file.
 */
function fakeDecoder(behaviour: (input: string) => { samples?: number[]; code?: number; stderr?: string; gate?: Promise<void> } = () => ({})): Fake {
  const fake = (async (args, o = {}) => {
    if (args[0] === "-version") return { code: 0, stderr: "" };
    fake.calls.push(args);
    const b = behaviour(args[args.indexOf("-i") + 1]);
    o.onStdout?.(f32(b.samples ?? [0.1, 0.5, -1, 0.25]));
    const aborted = new Promise<"abort">((res) => {
      if (o.signal?.aborted) res("abort");
      o.signal?.addEventListener("abort", () => res("abort"));
    });
    const r = await Promise.race([b.gate ?? Promise.resolve(), aborted]);
    if (r === "abort") {
      fake.killed++;
      return { code: 255, stderr: "Exiting normally, received signal 15." };
    }
    return { code: b.code ?? 0, stderr: b.stderr ?? "" };
  }) as Fake;
  fake.calls = [];
  fake.killed = 0;
  return fake;
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((res) => (open = res));
  return { promise, open };
}

const NO_STREAM = "[out#0/f32le @ 0x1] Output file does not contain any stream\nError opening output file pipe:1.";

async function setup(run: FfmpegRunner, opts: { available?: boolean; cuts?: string[] } = {}) {
  const { root, store } = await tmpProject("spring-launch");
  await mkdir(join(root, "renders"), { recursive: true });
  const proxyJobs = new ProxyJobs(store, { run, probe: async () => H264, available: async () => opts.available ?? true });
  const peaks = new PeakJobs(store, { run, available: async () => opts.available ?? true });
  const app = createApp(store, { proxyJobs, peakJobs: peaks });
  const call = async (method: string, path: string, json?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: json === undefined ? headers : { "content-type": "application/json", ...headers },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, json: parsed };
  };
  /** Writes a cut's file and registers it straight in project.json (as `rushes demo` would): nothing is queued. */
  const register = async (file: string, bytes = "original bytes") => {
    await writeFile(join(root, file), bytes);
    await store.update("project", (p) => {
      addVersion(p, { video: "hero", file, duration: 2, fps: 25 });
    });
  };
  const changes = (s: Store) => {
    const seen: ChangeEvent[] = [];
    s.on("change", (e: ChangeEvent) => seen.push(e));
    return seen;
  };
  const files = async () => (await readdir(join(root, ".rushes", "peaks")).catch(() => [] as string[])).sort();
  return { root, store, app, call, peaks, register, changes, files };
}

const URL1 = "/api/videos/hero/versions/v1/peaks";
const URL2 = "/api/videos/hero/versions/v2/peaks";

describe("GET …/peaks (§19.9)", () => {
  it("202 while the waveform is made, then 200 with the peaks; a cut with no audio is 204", async () => {
    const hold = gate();
    const run = fakeDecoder((input) =>
      input.endsWith("silent.mp4") ? { code: 234, stderr: NO_STREAM } : { samples: [0.1, 0.5, -1, 0.25], gate: hold.promise },
    );
    const { call, peaks, register, changes, store, files } = await setup(run);
    await register("renders/hero.mp4");
    await register("renders/silent.mp4");
    const seen = changes(store);

    const first = await call("GET", URL1);
    expect(first).toEqual({ status: 202, json: { state: "computing" } });
    // Asking again while it's running joins the same decode.
    expect((await call("GET", URL1)).status).toBe(202);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]).toContain("pipe:1");

    hold.open();
    await peaks.idle();
    const ready = await call("GET", URL1);
    expect(ready.status).toBe(200);
    expect(ready.json).toEqual({ v: 1, buckets: 4, duration: 0.001, peaks: [0.1, 0.5, 1, 0.25] });
    // A change went out when it landed, so open tabs ask again.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[seen.length - 1].file).toBe("project");

    expect((await call("GET", URL2)).status).toBe(202);
    await peaks.idle();
    const none = await call("GET", URL2);
    expect(none.status).toBe(204);
    expect(none.json).toBeNull();

    const names = await files();
    expect(names).toHaveLength(2);
    for (const n of names) expect(n).toMatch(PEAKS_FILE);
    expect(names.some((n) => n.startsWith("hero_v1_"))).toBe(true);
    expect(names.some((n) => n.startsWith("hero_v2_"))).toBe(true);
  });

  it("no audio is recorded, so a restarted server answers 204 without decoding again", async () => {
    const run = fakeDecoder(() => ({ code: 234, stderr: NO_STREAM }));
    const { root, call, peaks, register, store } = await setup(run);
    await register("renders/hero.mp4");
    await call("GET", URL1);
    await peaks.idle();
    const name = (await readdir(join(root, ".rushes", "peaks")))[0];
    expect(JSON.parse(await readFile(join(root, ".rushes", "peaks", name), "utf8"))).toEqual({ v: 1, audio: false });

    const again = fakeDecoder();
    const app = createApp(store, { peakJobs: new PeakJobs(store, { run: again, available: async () => true }), proxyJobs: new ProxyJobs(store, { run: again, available: async () => true }) });
    expect((await app.request(URL1)).status).toBe(204);
    expect(again.calls).toHaveLength(0);
  });

  it("a decode that ends with no samples at all is no audio too", async () => {
    const run = fakeDecoder(() => ({ samples: [] }));
    const { call, peaks, register } = await setup(run);
    await register("renders/hero.mp4");
    await call("GET", URL1);
    await peaks.idle();
    expect((await call("GET", URL1)).status).toBe(204);
  });

  it("501 no_ffmpeg without ffmpeg, and nothing is run", async () => {
    const run = fakeDecoder();
    const { call, register } = await setup(run, { available: false });
    await register("renders/hero.mp4");
    const r = await call("GET", URL1);
    expect(r.status).toBe(501);
    expect(r.json.error).toBe("no_ffmpeg");
    expect(run.calls).toHaveLength(0);
  });

  it("applies the project guard, and 404s an unknown cut or a missing original", async () => {
    const { call, register, root } = await setup(fakeDecoder());
    await register("renders/hero.mp4");
    expect((await call("GET", URL1, undefined, { "x-rushes-project": "wrongwrg" })).status).toBe(409);
    expect((await call("GET", `${URL1}?project=wrongwrg`)).status).toBe(409);
    expect((await call("GET", "/api/videos/nope/versions/v1/peaks")).status).toBe(404);
    expect((await call("GET", "/api/videos/hero/versions/v9/peaks")).status).toBe(404);
    await register("renders/gone.mp4");
    const { rm } = await import("node:fs/promises");
    await rm(join(root, "renders", "gone.mp4"));
    const missing = await call("GET", URL2);
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe("missing_file");
  });

  it("a failed decode records nothing and leaves no temp file; it's answered 422 and not retried on every request", async () => {
    const run = fakeDecoder(() => ({ code: 1, stderr: "renders/hero.mp4: Invalid data found when processing input" }));
    const { call, peaks, register, store, root } = await setup(run);
    await register("renders/hero.mp4");
    const seen: ChangeEvent[] = [];
    store.on("change", (e: ChangeEvent) => seen.push(e));
    expect((await call("GET", URL1)).status).toBe(202);
    await peaks.idle();
    expect(existsSync(join(root, ".rushes", "peaks")) ? await readdir(join(root, ".rushes", "peaks")) : []).toEqual([]);
    expect(seen).toEqual([]);
    const failed = await call("GET", URL1);
    expect(failed.status).toBe(422);
    expect(failed.json).toMatchObject({ error: "no_peaks", message: expect.stringContaining("Invalid data found") });
    expect(run.calls).toHaveLength(1);
  });

  it("a re-rendered file gets fresh peaks, and the stale file for that cut is removed", async () => {
    let level = 0.5;
    const run = fakeDecoder(() => ({ samples: [level, level / 2] }));
    const { call, peaks, register, root, files } = await setup(run);
    await register("renders/hero.mp4");
    // Another cut's peaks must survive the clean-up.
    await register("renders/other.mp4");
    await call("GET", URL1);
    await call("GET", URL2);
    await peaks.idle();
    const before = await files();
    expect(before).toHaveLength(2);
    const oldV1 = before.find((n) => n.startsWith("hero_v1_"))!;

    level = 1;
    await writeFile(join(root, "renders", "hero.mp4"), "re-rendered, longer bytes");
    expect((await call("GET", URL1)).status).toBe(202);
    await peaks.idle();
    const after = await files();
    expect(after).toHaveLength(2);
    expect(after).not.toContain(oldV1);
    expect(after.filter((n) => n.startsWith("hero_v1_"))).toHaveLength(1);
    expect(after).toContain(before.find((n) => n.startsWith("hero_v2_")));
    expect((await call("GET", URL1)).status).toBe(200);
    expect(run.calls).toHaveLength(3);
  });

  it("a peaks file that doesn't read as one is made again", async () => {
    const run = fakeDecoder();
    const { call, peaks, register, root, files } = await setup(run);
    await register("renders/hero.mp4");
    await call("GET", URL1);
    await peaks.idle();
    const [name] = await files();
    await writeFile(join(root, ".rushes", "peaks", name), "{ not json");
    expect((await call("GET", URL1)).status).toBe(202);
    await peaks.idle();
    expect((await call("GET", URL1)).status).toBe(200);
    expect(run.calls).toHaveLength(2);
  });
});

describe("a peaks file is only believed when it's one this server could have written (fix round 2)", () => {
  const ok = { v: 1, buckets: 3, duration: 1, peaks: [0, 0.5, 1] };
  const big = new Array(PEAK_BUCKETS + 1).fill(0.5);
  it.each([
    ["a peak above 1", { ...ok, peaks: [0, 0.5, 1.5] }],
    ["a negative peak", { ...ok, peaks: [0, -0.5, 1] }],
    ["a buckets count that doesn't match the peaks", { ...ok, buckets: 4 }],
    [`more than ${PEAK_BUCKETS} peaks`, { v: 1, buckets: big.length, duration: 1, peaks: big }],
    ["no duration", { v: 1, buckets: 3, peaks: [0, 0.5, 1] }],
    ["another format version", { ...ok, v: 2 }],
  ])("%s is made again", async (_what, body) => {
    const run = fakeDecoder();
    const { call, peaks, register, root, files } = await setup(run);
    await register("renders/hero.mp4");
    await call("GET", URL1);
    await peaks.idle();
    const [name] = await files();
    await writeFile(join(root, ".rushes", "peaks", name), JSON.stringify(body));
    expect((await call("GET", URL1)).status).toBe(202);
    await peaks.idle();
    expect((await call("GET", URL1)).json).toEqual({ v: 1, buckets: 4, duration: 0.001, peaks: [0.1, 0.5, 1, 0.25] });
  });

  it(`a file over ${PEAKS_MAX_BYTES / 1024} KB isn't read at all, even if it would parse`, async () => {
    const run = fakeDecoder();
    const { call, peaks, register, root, files } = await setup(run);
    await register("renders/hero.mp4");
    await call("GET", URL1);
    await peaks.idle();
    const [name] = await files();
    const padded = JSON.stringify(ok) + " ".repeat(PEAKS_MAX_BYTES);
    await writeFile(join(root, ".rushes", "peaks", name), padded);
    expect((await call("GET", URL1)).status).toBe(202);
    // Just under the limit, the same content is believed.
    await peaks.idle();
    await writeFile(join(root, ".rushes", "peaks", name), JSON.stringify(ok) + " ".repeat(1000));
    expect((await call("GET", URL1)).json).toEqual(ok);
  });
});

describe("the decode's timeout scales with the file (fix round 2)", () => {
  it("is 60 s plus the size at 5 MB/s, held between 5 and 60 minutes", () => {
    const min = 60_000;
    expect(peaksTimeoutMs(0)).toBe(5 * min);
    expect(peaksTimeoutMs(1.2e9)).toBe(5 * min);
    expect(peaksTimeoutMs(2e9)).toBe(60_000 + 400_000);
    expect(peaksTimeoutMs(17.7e9)).toBe(60 * min);
    expect(peaksTimeoutMs(100e9)).toBe(60 * min);
  });

  it("a 3 GB file isn't killed at 5 minutes, only past its own 11", async () => {
    const { root, store } = await tmpProject();
    await mkdir(join(root, "renders"), { recursive: true });
    // Sparse: 3 GB by its size, nothing on disk.
    await writeFile(join(root, "renders", "hero.mov"), "");
    await truncate(join(root, "renders", "hero.mov"), 3e9);
    await store.update("project", (p) => {
      addVersion(p, { video: "hero", file: "renders/hero.mov", duration: 2, fps: 25 });
    });
    const run = fakeDecoder(() => ({ gate: new Promise(() => undefined) }));
    const peaks = new PeakJobs(store, { run, available: async () => true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      expect((await peaks.answer("hero", "v1", "renders/hero.mov")).state).toBe("computing");
      await vi.waitFor(() => expect(run.calls).toHaveLength(1), { interval: 1 });
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
      expect(run.killed).toBe(0);
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(run.killed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    await peaks.idle();
    expect((await peaks.answer("hero", "v1", "renders/hero.mov")).state).toBe("failed");
  });
});

describe("peaks files that no cut owns (fix round 2)", () => {
  const HASH = "0123456789abcdef";
  const peaksDir = (root: string) => join(root, ".rushes", "peaks");

  it("are deleted at start-up; a current cut's file stays, and nothing outside .rushes/peaks/ is touched", async () => {
    const { root, store } = await tmpProject();
    await mkdir(join(root, "renders"), { recursive: true });
    await writeFile(join(root, "renders", "hero.mp4"), "x");
    await store.update("project", (p) => {
      addVersion(p, { video: "hero", file: "renders/hero.mp4", duration: 2, fps: 25 });
    });
    await mkdir(peaksDir(root), { recursive: true });
    const names = [
      `hero_v1_${HASH}.json`, // the current cut: kept
      `hero_v10_${HASH}.json`, // v10 isn't a cut, whatever v1's prefix looks like: gone
      `hero_v2_${HASH}.json`, // a cut that's gone: gone
      `trailer_v1_${HASH}.json`, // a film that's gone: gone
      "notes.txt", // not a peaks file at all, but in peaks/: gone
    ];
    for (const n of names) await writeFile(join(peaksDir(root), n), '{"v":1,"audio":false}');
    await writeFile(join(root, "renders", `hero_v2_${HASH}.json`), "not in peaks/");
    await writeFile(join(root, ".rushes", `hero_v2_${HASH}.json`), "not in peaks/");

    expect((await removeOrphanPeaks(root, await store.read("project"))).sort()).toEqual(names.slice(1).sort());
    expect(await readdir(peaksDir(root))).toEqual([`hero_v1_${HASH}.json`]);
    expect(existsSync(join(root, "renders", `hero_v2_${HASH}.json`))).toBe(true);
    expect(existsSync(join(root, ".rushes", `hero_v2_${HASH}.json`))).toBe(true);

    // And it's what a starting server does.
    await writeFile(join(peaksDir(root), `hero_v3_${HASH}.json`), "{}");
    const s = await startServer(root, { port: 0, peaks: { run: fakeDecoder(), available: async () => true } });
    try {
      expect(await readdir(peaksDir(root))).toEqual([`hero_v1_${HASH}.json`]);
    } finally {
      await s.close();
    }
  });

  it("with v1 and v10 both current, both files stay at start-up, and v1's re-render leaves v10's alone", async () => {
    const run = fakeDecoder();
    const { call, peaks, register, root, store, files } = await setup(run);
    for (let i = 1; i <= 10; i++) await register(`renders/c${i}.mp4`);
    await call("GET", URL1);
    await call("GET", "/api/videos/hero/versions/v10/peaks");
    await peaks.idle();
    const before = await files();
    expect(before.map((n) => n.split("_")[1]).sort()).toEqual(["v1", "v10"]);
    expect(await removeOrphanPeaks(root, await store.read("project"))).toEqual([]);

    await writeFile(join(root, "renders", "c1.mp4"), "re-rendered, longer bytes");
    expect((await call("GET", URL1)).status).toBe(202);
    await peaks.idle();
    const after = await files();
    expect(after).toHaveLength(2);
    expect(after).toContain(before.find((n) => n.startsWith("hero_v10_")));
  });
});

describe("PeakJobs: one decode per cut (fix round 2)", () => {
  /** A decoder that holds until aborted, counting how many run at once. */
  function holding() {
    let now = 0;
    const seen = { max: 0 };
    const run = fakeDecoder(() => {
      now++;
      seen.max = Math.max(seen.max, now);
      return { gate: new Promise(() => undefined) };
    });
    const wrapped = (async (args, o) => {
      try {
        return await run(args, o);
      } finally {
        if (args[0] !== "-version") now--;
      }
    }) as Fake;
    Object.defineProperty(wrapped, "calls", { get: () => run.calls });
    Object.defineProperty(wrapped, "killed", { get: () => run.killed });
    return { run: wrapped, seen };
  }

  it("a cut added while a tab asks for its waveform is decoded once, and close() kills that one decode", async () => {
    const { run } = holding();
    const { call, peaks, register } = await setup(run);
    await register("renders/hero.mp4");
    // All three pass their checks before any has queued: what the route does (answer) twice, as
    // two tabs would, and the add's queueCut.
    const [, a, b] = await Promise.all([
      peaks.queueCut("hero", "v1", "renders/hero.mp4"),
      peaks.answer("hero", "v1", "renders/hero.mp4"),
      peaks.answer("hero", "v1", "renders/hero.mp4"),
    ]);
    expect([a.state, b.state]).toEqual(["computing", "computing"]);
    expect((await call("GET", URL1)).status).toBe(202);
    await expect.poll(() => run.calls.length).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(run.calls).toHaveLength(1);
    await peaks.close();
    expect(run.killed).toBe(1);
  });

  it("five cuts asked for at once never run more than two decodes", async () => {
    const { run, seen } = holding();
    const { call, peaks, register } = await setup(run);
    for (let i = 1; i <= 5; i++) await register(`renders/c${i}.mp4`);
    await Promise.all(
      [1, 2, 3, 4, 5].flatMap((i) => [
        peaks.queueCut("hero", `v${i}`, `renders/c${i}.mp4`),
        peaks.answer("hero", `v${i}`, `renders/c${i}.mp4`),
        call("GET", `/api/videos/hero/versions/v${i}/peaks`),
      ]),
    );
    await expect.poll(() => run.calls.length).toBe(2);
    await new Promise((r) => setTimeout(r, 30));
    expect(seen.max).toBe(2);
    expect(run.calls).toHaveLength(2);
    await peaks.close();
    expect(run.killed).toBe(2);
  });
});

describe("PeakJobs in the background (§19.9)", () => {
  it("adding a cut starts its waveform without waiting for it, and GET /api/state never waits either", async () => {
    const run = fakeDecoder(() => ({ gate: new Promise(() => undefined) }));
    const { call, peaks, root } = await setup(run);
    await writeFile(join(root, "renders", "hero.mp4"), "original bytes");
    const added = await call("POST", "/api/versions", { video: "Hero", file: "renders/hero.mp4" });
    expect(added.status).toBe(201);
    await expect.poll(() => run.calls.length).toBe(1);
    // The decode is still running (it never finishes on its own here), and state answers anyway.
    const state = await call("GET", "/api/state");
    expect(state.status).toBe(200);
    expect(state.json.project.videos[0].versions[0].id).toBe("v1");
    expect((await call("GET", URL1)).status).toBe(202);
    await peaks.close();
    expect(run.killed).toBe(1);
    expect(existsSync(join(root, ".rushes", "peaks")) ? await readdir(join(root, ".rushes", "peaks")) : []).toEqual([]);
  });

  it(`decodes ${PEAKS_CONCURRENCY} cuts at a time`, async () => {
    const hold = gate();
    const run = fakeDecoder(() => ({ gate: hold.promise }));
    const { peaks, register, files } = await setup(run);
    for (const f of ["a", "b", "c"]) {
      await register(`renders/${f}.mp4`);
    }
    for (const v of ["v1", "v2", "v3"]) await peaks.queueCut("hero", v, `renders/${["a", "b", "c"][Number(v[1]) - 1]}.mp4`);
    await expect.poll(() => run.calls.length).toBe(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(run.calls).toHaveLength(2);
    hold.open();
    await peaks.idle();
    expect(run.calls).toHaveLength(3);
    expect(await files()).toHaveLength(3);
  });

  it("a decode past its timeout is killed and records nothing", async () => {
    const { root, store } = await tmpProject();
    await mkdir(join(root, "renders"), { recursive: true });
    await writeFile(join(root, "renders", "hero.mp4"), "x");
    await store.update("project", (p) => {
      addVersion(p, { video: "hero", file: "renders/hero.mp4", duration: 2, fps: 25 });
    });
    const run = fakeDecoder(() => ({ gate: new Promise(() => undefined) }));
    const peaks = new PeakJobs(store, { run, available: async () => true, timeoutMs: 30 });
    expect((await peaks.answer("hero", "v1", "renders/hero.mp4")).state).toBe("computing");
    await peaks.idle();
    expect(run.killed).toBe(1);
    expect(await peaks.answer("hero", "v1", "renders/hero.mp4")).toEqual({ state: "failed", reason: "ffmpeg took too long reading the audio" });
    expect(existsSync(join(root, ".rushes", "peaks"))).toBe(false);
  });

  it("refuses a hand-edited id that would name a file outside peaks/", async () => {
    const { store } = await tmpProject();
    const run = fakeDecoder();
    const peaks = new PeakJobs(store, { run, available: async () => true });
    expect((await peaks.answer("../x", "v1", "renders/hero.mp4")).state).toBe("failed");
    await peaks.queueCut("../x", "v1", "renders/hero.mp4");
    expect(run.calls).toHaveLength(0);
  });

  it("a stray temp file in .rushes/peaks/ is deleted when the server starts", async () => {
    const { root } = await tmpProject();
    await mkdir(join(root, ".rushes", "peaks"), { recursive: true });
    await writeFile(join(root, ".rushes", "peaks", ".hero_v1_0123456789abcdef.json.x.tmp"), "half");
    await writeFile(join(root, ".rushes", "peaks", "hero_v1_0123456789abcdef.json"), '{"v":1,"audio":false}');
    expect(await removePeakTemps(root)).toEqual([".hero_v1_0123456789abcdef.json.x.tmp"]);
    await writeFile(join(root, ".rushes", "peaks", ".again.tmp"), "half");
    const s = await startServer(root, { port: 0, peaks: { run: fakeDecoder(), available: async () => true } });
    try {
      expect(await readdir(join(root, ".rushes", "peaks"))).toEqual(["hero_v1_0123456789abcdef.json"]);
    } finally {
      await s.close();
    }
  });

  it("closing the server kills a decode in flight", async () => {
    const { root, store } = await tmpProject();
    await mkdir(join(root, "renders"), { recursive: true });
    await writeFile(join(root, "renders", "hero.mp4"), "x");
    await store.update("project", (p) => {
      addVersion(p, { video: "hero", file: "renders/hero.mp4", duration: 2, fps: 25 });
    });
    const run = fakeDecoder(() => ({ gate: new Promise(() => undefined) }));
    const s = await startServer(root, { port: 0, proxy: { available: async () => true, probe: async () => H264 }, peaks: { run, available: async () => true } });
    const res = await fetch(`${s.url}${URL1}`);
    expect(res.status).toBe(202);
    await expect.poll(() => run.calls.length).toBe(1);
    await s.close();
    expect(run.killed).toBe(1);
  });
});

describe.skipIf(!FFMPEG)("peaks with real ffmpeg", () => {
  it("a 2 s tone gives a waveform that isn't flat, and a clip with no audio gives 204", async () => {
    const { root, store } = await tmpProject();
    await mkdir(join(root, "renders"), { recursive: true });
    const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "ignore" });
    // One second of tone, one of silence: the first half is loud, the second is quiet.
    ff([
      "-f", "lavfi", "-i", "testsrc2=s=180x320:d=2",
      "-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,1)\\,0.8*sin(2*PI*440*t)\\,0):s=48000:d=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(root, "renders", "tone.mp4"),
    ]);
    ff(["-f", "lavfi", "-i", "testsrc2=s=180x320:d=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(root, "renders", "mute.mp4")]);
    const peaks = new PeakJobs(store);
    const app = createApp(store, { peakJobs: peaks });
    const post = (file: string) => app.request("/api/versions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ video: "Hero", file }) });
    expect((await post("renders/tone.mp4")).status).toBe(201);
    expect((await post("renders/mute.mp4")).status).toBe(201);
    await expect.poll(async () => (await app.request(URL1)).status, { timeout: 10_000 }).toBe(200);
    const data = (await (await app.request(URL1)).json()) as { v: number; buckets: number; duration: number; peaks: number[] };
    expect(data.v).toBe(1);
    expect(data.buckets).toBe(2000);
    expect(data.peaks).toHaveLength(2000);
    expect(data.duration).toBeGreaterThan(1.9);
    expect(data.duration).toBeLessThan(2.2);
    expect(Math.max(...data.peaks)).toBe(1);
    const loud = data.peaks.slice(100, 900);
    const quiet = data.peaks.slice(1200, 1900);
    expect(Math.min(...loud)).toBeGreaterThan(0.5);
    expect(Math.max(...quiet)).toBeLessThan(0.05);
    await expect.poll(async () => (await app.request(URL2)).status, { timeout: 10_000 }).toBe(204);
    await peaks.close();
  });
});
