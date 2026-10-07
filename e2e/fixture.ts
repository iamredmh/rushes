import { test as base, expect, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeWav } from "./fixtures/wav.js";

const CLI = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const CLIP = fileURLToPath(new URL("./fixtures/clip.mp4", import.meta.url));
const VERTICAL = fileURLToPath(new URL("./fixtures/vertical.mp4", import.meta.url));

const DASHBOARD_URL = /http:\/\/127\.0\.0\.1:\d+\/p\/[a-z2-9]{8}\//;

/** Whether ffmpeg and ffprobe are both on PATH: the proxy tests (§19.5) skip without them. */
export const hasFfmpeg = ["ffmpeg", "ffprobe"].every((bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0);

/** Run ffmpeg with an args array (never a shell), rejecting with its stderr on failure. */
function ffmpeg(args: string[]): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr!.on("data", (d) => (err += d));
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg failed (${code}): ${err}`))));
  });
}

/** PATH with every directory that holds ffmpeg or ffprobe left out: a server started on it has neither. */
function pathWithoutFfmpeg(): string {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir && !["ffmpeg", "ffprobe"].some((bin) => existsSync(join(dir, bin))))
    .join(delimiter);
}

export interface ProResOptions {
  width?: number;
  height?: number;
  /** "h264" makes a browser-playable MP4 instead (a 4K one still earns a proxy offer). */
  codec?: "prores" | "h264";
  /** Length in seconds. Defaults to 6. */
  seconds?: number;
  /**
   * A cut whose proxy takes several seconds to make, so Cancel is reachable: one second of a
   * small ProRes picture with AAC audio, stream-copied end to end `seconds` times. Copying is
   * near instant and keeps the file small; encoding its audio back to AAC is what takes the time.
   */
  long?: boolean;
  /** Adds a 440 Hz tone as AAC, so the cut has audio for the Picture waveform (§19.9). */
  audio?: boolean;
}

export interface VariantOptions {
  seconds: number;
  /** Tone frequency in Hz. */
  freq: number;
  meta?: Record<string, string | number>;
  cues?: { name: string; t: number }[];
  /** Lane id; defaults to the round, slugged, else the stage's own lane. */
  lane?: string;
  /** Voice only: the round's name, e.g. "Round 2 · Gerald, tone" (§18.2). */
  round?: string;
}

/** One render of a cut, for the format tests (§21): its picture size, and its length (default 4 s). */
export interface FormatSize {
  width: number;
  height: number;
  seconds?: number;
  /** "mpeg2": an MPEG-2 .mkv that ffprobe reads and no browser plays. Defaults to an H.264 MP4. */
  codec?: "h264" | "mpeg2";
}

/** A file for `writeFiles`: a generated sine WAV (the default), a copy of the 4 s test clip (`video`), or text. */
export interface TreeFile {
  /** Relative to the project folder, forward slashes. Folders are made as needed. */
  path: string;
  /** WAV length. Defaults to 2 s. */
  seconds?: number;
  freq?: number;
  /** Write the 4 s test clip instead of a WAV. */
  video?: boolean;
  /** Write this text instead. */
  text?: string;
}

export interface Rushes {
  /** The dashboard URL this tab should be on: `http://127.0.0.1:PORT/p/<id>/`. */
  url: string;
  /** The same URL with the test-only switches (`?test=1`, plus any extra query) that expose the audio engine. */
  testUrl(extra?: string): string;
  /** Origin only (no `/p/<id>/`), for calling the API the way an agent would. */
  base: string;
  root: string;
  /** Call the server's API the way an agent would. */
  api<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  /** Register the 4-second test clip as a new cut of `video` (default "Hero"). */
  addCut(note?: string, video?: string): Promise<{ version: { id: string } }>;
  /** Register the 9:16 test clip (360x640, 2 s) as a new cut of "Hero". */
  addVerticalCut(note?: string): Promise<{ version: { id: string } }>;
  /** Generate a ProRes test pattern (640x360, 6 s by default) into the project and register it as a new cut of "Hero". Needs ffmpeg. */
  addProResCut(opts?: ProResOptions, note?: string): Promise<{ version: { id: string }; proxySuggested?: true; proxyReason?: string; proxyJob?: { id: string; state: string } }>;
  /**
   * Register a new cut of `video` (default "Hero") in several shapes (§21): the first size is the
   * primary, the rest its formats. `audio` gives the primary a tone. Needs ffmpeg. Generated H.264
   * testsrc renders with invented names.
   */
  addFormatsCut(sizes: FormatSize[], opts?: { video?: string; note?: string; audio?: boolean }): Promise<{ version: { id: string; formats: { id: string; label: string; file: string }[] } }>;
  /** Register one more shape of a cut (default: the newest of "Hero"). Needs ffmpeg. Generated H.264 testsrc renders with invented names. */
  addFormatFile(size: FormatSize, opts?: { video?: string; version?: string }): Promise<{ format: { id: string; label: string; file: string } }>;
  /** Write a generated sine WAV into the project and register it as a variant on `stage`. */
  addVariant(stage: "voice" | "music" | "sfx", name: string, opts: VariantOptions): Promise<{ lane: { id: string }; variant: { id: string; cues: { id: string; name: string; t: number }[] } }>;
  /** Write generated files into the project folder (invented names, small WAVs, or the 4 s clip for a cut). Nothing is registered. */
  writeFiles(files: TreeFile[]): Promise<void>;
  /**
   * Ask the server to look through the folder (the way Look again does, so the current set is
   * brought in too) and wait until it has, and until every length ffprobe can give is known.
   */
  scan(): Promise<{ added: { path: string; kind: string }[]; found: Record<string, number> }>;
  /**
   * Stop this project's server and start a different, fresh project on exactly the
   * same port, simulating port reuse after `rushes stop`. Updates `url`, `base` and
   * `root` to the new project once it's up.
   */
  swapProject(): Promise<void>;
}

interface Started {
  child: ChildProcess;
  url: string;
  base: string;
  port: number;
  root: string;
  tmpDir: string;
}

/** Start `rushes serve` on a fresh project folder (with a space in its path) and wait for its dashboard URL. */
async function start(port = 0, noFfmpeg = false): Promise<Started> {
  const tmpDir = await mkdtemp(join(tmpdir(), "rushes e2e "));
  const root = join(tmpDir, "My Film");
  await mkdir(join(root, "renders"), { recursive: true });
  // RUSHES_NO_REVEAL stops the dashboard's "Show in Finder" (added in Plan 2c) from ever
  // actually opening Finder/Explorer during a test run.
  const child = spawn(process.execPath, [CLI, "serve", root, "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RUSHES_NO_REVEAL: "1", ...(noFfmpeg ? { PATH: pathWithoutFfmpeg() } : {}) },
  });
  const url = await new Promise<string>((ok, fail) => {
    let out = "";
    const timer = setTimeout(() => fail(new Error(`rushes serve didn't start:\n${out}`)), 10_000);
    child.stdout!.on("data", (d) => {
      out += d;
      const m = out.match(DASHBOARD_URL);
      if (m) {
        clearTimeout(timer);
        ok(m[0]);
      }
    });
    child.stderr!.on("data", (d) => (out += d));
    child.on("exit", (code) => fail(new Error(`rushes serve exited (${code}):\n${out}`)));
  });
  const u = new URL(url);
  return { child, url, base: u.origin, port: Number(u.port), root, tmpDir };
}

/** Kill a server and wait for it to exit. */
async function stop(child: ChildProcess): Promise<void> {
  child.kill("SIGTERM");
  await new Promise((ok) => child.once("exit", ok));
}

/**
 * Start a fresh project on exactly `port`. If the OS hands back a different port
 * (the original is briefly in TIME_WAIT and `rushes serve --port N` fell through to
 * N+1), kill that child and try again, up to ~5 s. Node sets SO_REUSEADDR by
 * default, so this is usually a no-op after the first attempt.
 */
async function startOnPort(port: number, noFfmpeg = false): Promise<Started> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const attempt = await start(port, noFfmpeg);
    if (attempt.port === port) return attempt;
    await stop(attempt.child);
    await rm(attempt.tmpDir, { recursive: true, force: true });
    if (Date.now() > deadline) {
      throw new Error(`rushes serve kept landing on ${attempt.port} instead of ${port} after 5 s`);
    }
  }
}

/**
 * Playwright's WebKit on Linux decodes video through the system's GStreamer, and H.264/AAC
 * playback there isn't something CI can count on (Playwright marks its own video tests fixme on
 * Linux WebKit). CI runs WebKit on macOS for that reason; this is the safety net for anyone
 * running WebKit locally on Linux. There only, a test that puts an H.264 cut or an H.264 proxy in
 * the player is skipped, with this reason in the report. Everywhere else (Chromium on every OS,
 * and WebKit on macOS, which plays through AVFoundation) every test runs. Set
 * `RUSHES_E2E_WEBKIT_H264=1` to run them on Linux WebKit anyway.
 */
const H264_SKIP_REASON = "needs H.264 playback, which Playwright's WebKit on Linux can't be relied on for";
export function needsH264(browserName: string): void {
  base.info().skip(browserName === "webkit" && process.platform === "linux" && process.env.RUSHES_E2E_WEBKIT_H264 !== "1", H264_SKIP_REASON);
}

/**
 * Runs in every page before the dashboard does, so a test run makes no sound: Playwright's WebKit
 * plays through the Mac's real speakers (it has no mute flag), and the fixtures are 440 Hz tones.
 * Whatever connects to a context's destination goes through a zero gain instead, so nodes upstream
 * still see the signal; a media element that plays on its own gets volume 0, which nothing in the
 * app reads. Playback, timing and `muted` are left alone.
 */
function silenceAudio(): void {
  const { connect, disconnect } = AudioNode.prototype;
  const zeros = new WeakMap<AudioDestinationNode, GainNode>();
  const zeroFor = (node: AudioNode, dest: AudioDestinationNode): GainNode => {
    let gain = zeros.get(dest);
    if (!gain) {
      gain = node.context.createGain();
      gain.gain.value = 0;
      (connect as Function).call(gain, dest);
      zeros.set(dest, gain);
    }
    return gain;
  };
  AudioNode.prototype.connect = function (this: AudioNode, dest: AudioNode | AudioParam, ...rest: number[]) {
    if (!(dest instanceof AudioDestinationNode)) return (connect as Function).call(this, dest, ...rest);
    (connect as Function).call(this, zeroFor(this, dest), ...rest);
    return dest;
  } as typeof connect;
  AudioNode.prototype.disconnect = function (this: AudioNode, ...args: unknown[]) {
    if (args[0] instanceof AudioDestinationNode) args[0] = zeroFor(this, args[0]);
    return (disconnect as Function).apply(this, args);
  } as typeof disconnect;

  // An element routed into a graph is silenced at the destination, so it keeps its own volume.
  const routed = new WeakSet<HTMLMediaElement>();
  const createSource = AudioContext.prototype.createMediaElementSource;
  AudioContext.prototype.createMediaElementSource = function (this: AudioContext, el: HTMLMediaElement) {
    routed.add(el);
    el.volume = 1;
    return createSource.call(this, el);
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    if (!routed.has(this)) this.volume = 0;
    return play.call(this);
  };
}

export const test = base.extend<{ rushes: Rushes; noFfmpeg: boolean }>({
  context: async ({ context }, use) => {
    await context.addInitScript(silenceAudio);
    await use(context);
  },
  /** Start the server without ffmpeg or ffprobe on its PATH (`test.use({ noFfmpeg: true })`). */
  noFfmpeg: [false, { option: true }],
  rushes: async ({ noFfmpeg, browserName }, use) => {
    const tmpDirs: string[] = [];
    let started = await start(0, noFfmpeg);
    tmpDirs.push(started.tmpDir);
    let child = started.child;
    let url = started.url;
    let origin = started.base;
    let root = started.root;
    // Counted per video, so cuts to different films never collide on the same render filename.
    const cutsByVideo = new Map<string, number>();

    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(origin + path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
      return json;
    };
    const addCut = async (note?: string, video = "Hero") => {
      needsH264(browserName);
      const slug = video.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      const n = (cutsByVideo.get(slug) ?? 0) + 1;
      cutsByVideo.set(slug, n);
      const file = `renders/${slug}_v${n}.mp4`;
      await copyFile(CLIP, join(root, file));
      return api("POST", "/api/versions", { video, file, note });
    };
    const addVerticalCut = async (note?: string) => {
      needsH264(browserName);
      const n = (cutsByVideo.get("hero") ?? 0) + 1;
      cutsByVideo.set("hero", n);
      const file = `renders/hero_v${n}.mp4`;
      await copyFile(VERTICAL, join(root, file));
      return api("POST", "/api/versions", { video: "Hero", file, note });
    };
    const addProResCut = async (opts: ProResOptions = {}, note?: string) => {
      // Its proxy is H.264, and every proxy test plays or offers to play one.
      needsH264(browserName);
      const n = (cutsByVideo.get("hero") ?? 0) + 1;
      cutsByVideo.set("hero", n);
      const file = `renders/hero_v${n}.${opts.codec === "h264" ? "mp4" : "mov"}`;
      const out = join(root, file);
      const tone = opts.audio
        ? ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${opts.seconds ?? 6}`, "-c:a", "aac", "-b:a", "64k", "-shortest"]
        : [];
      if (opts.codec === "h264") {
        await ffmpeg([
          "-f", "lavfi", "-i", `testsrc=size=${opts.width ?? 640}x${opts.height ?? 360}:rate=30:duration=${opts.seconds ?? 6}`,
          ...tone,
          "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-pix_fmt", "yuv420p", out,
        ]);
      } else if (opts.long) {
        const one = join(root, "renders", `.hero_v${n}_one.mov`);
        await ffmpeg([
          "-f", "lavfi", "-i", `testsrc=size=${opts.width ?? 160}x${opts.height ?? 90}:rate=30:duration=1`,
          "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
          "-ac", "2", "-c:v", "prores_ks", "-profile:v", "0", "-c:a", "aac", "-b:a", "32k", "-shortest", one,
        ]);
        await ffmpeg(["-stream_loop", String((opts.seconds ?? 300) - 1), "-i", one, "-c", "copy", out]);
        await rm(one, { force: true });
      } else {
        await ffmpeg([
          "-f", "lavfi", "-i", `testsrc=size=${opts.width ?? 640}x${opts.height ?? 360}:rate=30:duration=${opts.seconds ?? 6}`,
          ...tone,
          "-c:v", "prores_ks", "-profile:v", "0", out,
        ]);
      }
      return api("POST", "/api/versions", { video: "Hero", file, note });
    };
    const render = async (slug: string, n: number, s: FormatSize, tag: string, audio = false) => {
      const mpeg2 = s.codec === "mpeg2";
      const file = `renders/${slug}_v${n}_${s.width}x${s.height}${tag}.${mpeg2 ? "mkv" : "mp4"}`;
      const seconds = s.seconds ?? 4;
      const tone = audio ? ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`, "-c:a", "aac", "-b:a", "64k", "-shortest"] : [];
      const codec = mpeg2 ? ["-c:v", "mpeg2video", "-q:v", "5"] : ["-c:v", "libx264", "-preset", "ultrafast", "-g", "30"];
      await ffmpeg([
        "-f", "lavfi", "-i", `testsrc=size=${s.width}x${s.height}:rate=30:duration=${seconds}`,
        ...tone,
        ...codec, "-pix_fmt", "yuv420p", join(root, file),
      ]);
      return file;
    };
    const slugOf = (video: string) => video.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const addFormatsCut = async (sizes: FormatSize[], opts: { video?: string; note?: string; audio?: boolean } = {}) => {
      needsH264(browserName);
      const video = opts.video ?? "Hero";
      const slug = slugOf(video);
      const n = (cutsByVideo.get(slug) ?? 0) + 1;
      cutsByVideo.set(slug, n);
      const files = await Promise.all(sizes.map((s, i) => render(slug, n, s, "", opts.audio && i === 0)));
      return api("POST", "/api/versions", { video, file: files[0], note: opts.note, formats: files.slice(1).map((file) => ({ file })) });
    };
    const addFormatFile = async (size: FormatSize, opts: { video?: string; version?: string } = {}) => {
      needsH264(browserName);
      const video = opts.video ?? "Hero";
      const slug = slugOf(video);
      const file = await render(slug, cutsByVideo.get(slug) ?? 1, size, "_extra");
      return api("POST", "/api/formats", { file, video, ...(opts.version ? { version: opts.version } : {}) });
    };
    let wavs = 0;
    const addVariant = async (stage: "voice" | "music" | "sfx", name: string, opts: VariantOptions) => {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      const file = `audio/${stage}-${++wavs}-${slug}.wav`;
      await mkdir(join(root, "audio"), { recursive: true });
      await writeFile(join(root, file), makeWav({ seconds: opts.seconds, freq: opts.freq }));
      return api("POST", "/api/variants", { stage, name, file, lane: opts.lane, round: opts.round, meta: opts.meta, cues: opts.cues });
    };
    const writeFiles = async (files: TreeFile[]) => {
      for (const f of files) {
        const abs = join(root, ...f.path.split("/"));
        await mkdir(dirname(abs), { recursive: true });
        if (f.video) await copyFile(CLIP, abs);
        else if (f.text !== undefined) await writeFile(abs, f.text);
        else await writeFile(abs, makeWav({ seconds: f.seconds ?? 2, freq: f.freq ?? 330 }));
      }
    };
    const scan = async () => {
      // A scan asked for while another's first pass is running joins it, and a walk that began before
      // the test wrote its files (the one at start-up, slow on a busy machine) has not seen them. Let
      // any walk already running finish first, so the scan asked for here is a fresh look.
      for (let i = 0; i < 400; i++) {
        const { found } = await api("GET", "/api/state");
        if (!found.scanning) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const result = await api("POST", "/api/found/scan", { wait: true });
      // The first pass and the adoption are done; the other lengths arrive in the background.
      if (!noFfmpeg && hasFfmpeg) {
        const deadline = Date.now() + 10_000;
        for (;;) {
          const { files } = await api("GET", "/api/found");
          const unknown = files.filter((f: { duration: number | null }) => f.duration === null).map((f: { path: string }) => f.path);
          if (unknown.length === 0) break;
          // Never carry on with lengths missing: a test that reads them would flake. Say which, loudly.
          if (Date.now() > deadline) throw new Error(`scan(): ffprobe had not given a length for ${unknown.length} file(s) after 10 s: ${unknown.slice(0, 5).join(", ")}`);
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      return result;
    };
    const swapProject = async () => {
      const port = Number(new URL(url).port);
      await stop(child);
      const next = await startOnPort(port, noFfmpeg);
      tmpDirs.push(next.tmpDir);
      child = next.child;
      url = next.url;
      origin = next.base;
      root = next.root;
      cutsByVideo.clear();
    };

    await use({
      get url() { return url; },
      testUrl: (extra = "") => `${url}?test=1${extra ? `&${extra}` : ""}`,
      get base() { return origin; },
      get root() { return root; },
      api,
      addCut,
      addVerticalCut,
      addProResCut,
      addFormatsCut,
      addFormatFile,
      addVariant,
      writeFiles,
      scan,
      swapProject,
    });

    await stop(child);
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  },
});

/** Wait until the player has loaded the cut's metadata, so seeking works. */
export async function videoReady(page: Page): Promise<void> {
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
}

export { expect };
