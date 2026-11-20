import { test as base, expect, type ElementHandle, type Locator, type Page } from "@playwright/test";
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
  cues?: { name: string; t: number; file?: string }[];
  /** Lane id; defaults to the round, slugged, else the stage's own lane. */
  lane?: string;
  /** Voice only: the round's name, e.g. "Round 2 · Gerald, tone" (§18.2). */
  round?: string;
  /** The film it is for (id or name), or several; left out, it is on no film once there is more than one. */
  video?: string | string[];
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
  addFormatsCut(sizes: FormatSize[], opts?: { video?: string; note?: string; label?: string; audio?: boolean }): Promise<{ version: { id: string; formats: { id: string; label: string; file: string }[] } }>;
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

/**
 * Start `rushes serve` on a fresh project folder (with a space in its path) and wait for its dashboard URL. `env` is added
 * to the server's environment (the fake agent's RUSHES_TEST_AGENT, e2e/agentFixture.ts).
 */
async function start(port = 0, noFfmpeg = false, env: Record<string, string> = {}): Promise<Started> {
  const tmpDir = await mkdtemp(join(tmpdir(), "rushes e2e "));
  const root = join(tmpDir, "My Film");
  await mkdir(join(root, "renders"), { recursive: true });
  // RUSHES_NO_REVEAL stops the dashboard's "Show in Finder" (added in Plan 2c) from ever
  // actually opening Finder/Explorer during a test run.
  // --idle-minutes: a server whose test run was killed (a cancelled CI job, a Ctrl-C, a crashed
  // worker) never gets its SIGTERM and would run for ever, holding the project and its code open.
  // Idle means no open connection and no request, so a live test, which has its page open, never is.
  const idleMinutes = process.env.RUSHES_E2E_IDLE_MINUTES ?? "5";
  const child = spawn(process.execPath, [CLI, "serve", root, "--port", String(port), "--idle-minutes", idleMinutes], {
    stdio: ["ignore", "pipe", "pipe"],
    // §29: auto-balance off, so a pick never moves a fader under a test; the Balance test turns it on by its env.
    // §32: the user's own Send to AI files (agent-rules/, agent-defaults.json) go in the test's own config folder, never
    // the real ~/.config, so a default set on this Mac can't turn Send to AI on under a test. The fake agent's tests
    // pass their own (e2e/agentFixture.ts).
    env: { ...process.env, RUSHES_NO_REVEAL: "1", RUSHES_AUTO_BALANCE: "0", XDG_CONFIG_HOME: join(tmpDir, "config"), ...(noFfmpeg ? { PATH: pathWithoutFfmpeg() } : {}), ...env },
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
  // §28: the first Send in a fresh project asks who gets the notes. Projects these tests open have answered it with Send
  // to AI off, so Send is as it always was (batch filed, copy dialog). e2e/agentFixture.ts (the fake agent) starts fresh.
  if (!env.RUSHES_TEST_AGENT) {
    const res = await fetch(`${u.origin}/api/agent/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: false }) });
    if (!res.ok) throw new Error(`answering the first-Send sheet failed: ${res.status} ${await res.text()}`);
  }
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
async function startOnPort(port: number, noFfmpeg = false, env: Record<string, string> = {}): Promise<Started> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const attempt = await start(port, noFfmpeg, env);
    if (attempt.port === port) return attempt;
    await stop(attempt.child);
    await rm(attempt.tmpDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
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

export interface OpenOptions {
  noFfmpeg: boolean;
  browserName: string;
  /** Start on exactly this port (0, the default: any free one). */
  port?: number;
  /** Added to the server's environment. */
  env?: Record<string, string>;
}

export interface OpenRushes {
  rushes: Rushes;
  /** Stops the server and removes its project folders. */
  close(): Promise<void>;
}

/** Starts a server on a fresh project and gives the test's handle on it: the `rushes` fixture, and e2e/agentFixture.ts. */
export async function openRushes({ noFfmpeg, browserName, port = 0, env = {} }: OpenOptions): Promise<OpenRushes> {
  const tmpDirs: string[] = [];
  const started = port === 0 ? await start(0, noFfmpeg, env) : await startOnPort(port, noFfmpeg, env);
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
  const addFormatsCut = async (sizes: FormatSize[], opts: { video?: string; note?: string; label?: string; audio?: boolean } = {}) => {
    needsH264(browserName);
    const video = opts.video ?? "Hero";
    const slug = slugOf(video);
    const n = (cutsByVideo.get(slug) ?? 0) + 1;
    cutsByVideo.set(slug, n);
    const files = await Promise.all(sizes.map((s, i) => render(slug, n, s, "", opts.audio && i === 0)));
    return api("POST", "/api/versions", { video, file: files[0], note: opts.note, label: opts.label, formats: files.slice(1).map((file) => ({ file })) });
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
    return api("POST", "/api/variants", { stage, name, file, lane: opts.lane, round: opts.round, meta: opts.meta, cues: opts.cues, video: opts.video });
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
    const next = await startOnPort(port, noFfmpeg, env);
    tmpDirs.push(next.tmpDir);
    child = next.child;
    url = next.url;
    origin = next.base;
    root = next.root;
    cutsByVideo.clear();
  };

  const rushes: Rushes = {
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
  };

  return {
    rushes,
    async close() {
      await stop(child);
      for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); // Windows: EBUSY while a just-stopped process still holds the folder
    },
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
    const opened = await openRushes({ noFfmpeg, browserName });
    await use(opened.rushes);
    await opened.close();
  },
});

/** Wait until the player has loaded the cut's metadata, so seeking works. */
export async function videoReady(page: Page): Promise<void> {
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
}

// ---- the desk's places (§27): workspaces, Review's tabs, the film and the cut ----

export type WorkspaceName = "Plan" | "Review" | "Visuals" | "Assets";
export type ReviewTabName = "Timeline" | "Voice" | "Music" | "Effects";

/** A workspace's tab in the top bar (Plan's opens the Plan page last used). */
export function workspaceTab(page: Page, name: WorkspaceName): Locator {
  return page.getByRole("tablist", { name: "Workspaces" }).getByRole("tab", { name: new RegExp(`^${name}`) });
}

export type PlanPageName = "Brief" | "Script" | "Storyboard";

/** The three-part switch at the top of the Plan workspace: Brief, Script, Storyboard. */
export function planSwitch(page: Page): Locator {
  return page.getByRole("tablist", { name: "Plan" });
}

/** One page's tab on the Plan switch; it carries "Approved" when that page is approved. */
export function planTab(page: Page, name: PlanPageName): Locator {
  return planSwitch(page).getByRole("tab", { name: new RegExp(`^${name}`) });
}

/** Opens a Plan page the way a person would: the Plan workspace first when another is up, then the page on the switch. */
export async function openPlanPage(page: Page, name: PlanPageName): Promise<void> {
  const plan = workspaceTab(page, "Plan");
  await expect(plan).toBeVisible();
  if ((await plan.getAttribute("aria-selected")) !== "true") await openWorkspace(page, "Plan");
  const tab = planTab(page, name);
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

/** A Plan page's row (a brief section, a script line or a storyboard shot) is marked "Edited by you" when your wording differs from its baseline. */
export function editedMark(row: Locator): Locator {
  return row.locator(".edited");
}

/** The baseline wording struck through beneath an edited row: the agent's version, which Revert goes back to. */
export function baselineText(row: Locator): Locator {
  return editedMark(row).locator("del");
}

/** The line at the foot of a Plan page that counts what is approved and what is edited. */
export function planStatus(page: Page): Locator {
  return page.locator(".pstatus");
}

/** One of Review's tabs: the timeline and each sound. They show while Review is the workspace. */
export function reviewTab(page: Page, name: ReviewTabName): Locator {
  return page.getByRole("tablist", { name: "Review" }).getByRole("tab", { name: new RegExp(`^${name}`) });
}

/** Opens a workspace the way a person would (Plan opens on the Plan page last used). */
export async function openWorkspace(page: Page, name: WorkspaceName): Promise<void> {
  const tab = workspaceTab(page, name);
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

/**
 * Opens one of Review's unlocked tabs by clicking it (opening Review first when another workspace is up), and waits until
 * it is selected. Focus is then let go, as a number key would leave it, so Space and the arrows reach the page rather than the tab.
 */
export async function openReviewTab(page: Page, name: ReviewTabName): Promise<void> {
  const review = workspaceTab(page, "Review");
  await expect(review).toBeVisible();
  if ((await review.getAttribute("aria-selected")) !== "true") await openWorkspace(page, "Review");
  const tab = reviewTab(page, name);
  // A locked tab opens its "nothing here yet" page: a test that means to open one says so by clicking it itself.
  await expect(tab).not.toHaveAttribute("data-locked", "true");
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** The Film button in the top bar (a menu button once there is more than one film to choose from). */
export function filmButton(page: Page): Locator {
  return page.getByRole("button", { name: /^Film:/ });
}

/** The film on screen, as the top bar names it. */
export function currentFilm(page: Page): Locator {
  return page.locator("header.top .filmsel .filmname");
}

/** Switches to a film by its name from the Film menu. `expectSwitch: false` asks without waiting for it (a switch that is refused). */
export async function pickFilm(page: Page, name: string, expectSwitch = true): Promise<void> {
  const named = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  await filmButton(page).click();
  await page.getByRole("menu", { name: "Films" }).getByRole("menuitem", { name: named }).first().click();
  if (expectSwitch) await expect(currentFilm(page)).toHaveText(name);
}

/** §27, 5.2: the Cut menu's button, carrying the cut on screen as `data-version`. */
export function cutButton(page: Page): Locator {
  return page.getByRole("button", { name: /^Cut:/ });
}

/** §27, 5.3: the count of files found on the Assets workspace's tab, shown until Found has been looked at. */
export function foundBadge(page: Page): Locator {
  return workspaceTab(page, "Assets").locator(".wcount");
}

/** Opens the More menu, at the right of the top bar (Shelve, Appearance, the shortcuts and the rest). */
export async function openMore(page: Page): Promise<void> {
  await page.getByRole("button", { name: "More", exact: true }).click();
}

/**
 * §27, 5.9: the status bar's shape, a button on a cut with one format (no switch on the monitor): it opens the popover with
 * the prompt that asks your agent for the other shapes.
 */
export function shapeButton(page: Page): Locator {
  return page.locator("footer.status").getByRole("button", { name: / · other shapes$/ });
}

/** The More menu's setting that makes proxies of new cuts automatically (§19.5): a checkbox item. Open the menu first. */
export function autoProxySetting(page: Page): Locator {
  return page.getByRole("menuitemcheckbox", { name: "Make lighter copies of new cuts automatically" });
}

/** Picks a version from the version list, the way a person would, and waits until it's on screen. */
export async function pickVersion(page: Page, id: string): Promise<void> {
  const button = cutButton(page);
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  await page.getByRole("listbox", { name: "Versions" }).locator(`[role="option"][data-version="${id}"]`).click();
  await expect(button).toHaveAttribute("data-version", id);
}

// ---- the Timeline tab (§27, 5.4 to 5.6): the monitor and its tool strip, the transport, the ruler and the Picture track ----

export type ToolName = "Select" | "Note" | "Range" | "Box" | "Grab";
/** Each tool's tooltip, which is also its accessible name. */
export const TOOL_TIPS: Record<ToolName, string> = {
  Select: "Select · V",
  Note: "Note at the playhead · N",
  Range: "Mark a range · I and O",
  Box: "Box on the picture · B",
  Grab: "Grab this frame · G",
};

/** The monitor: the tool strip and the picture. It is what goes full screen. */
export function monitor(page: Page): Locator {
  return page.locator(".monitor");
}

/** The tool strip down the monitor's left. */
export function toolStrip(page: Page): Locator {
  return page.getByRole("toolbar", { name: "Tools" });
}

/** One tool on the strip; `aria-pressed` says which is active. */
export function toolButton(page: Page, name: ToolName): Locator {
  return toolStrip(page).getByRole("button", { name: TOOL_TIPS[name], exact: true });
}

/** The row under the monitor: the timecode, play and the frame steps, volume and full screen. */
export function transport(page: Page): Locator {
  return page.getByRole("group", { name: "Transport" });
}

/** The cut's length, beside the timecode. */
export function cutLength(page: Page): Locator {
  return page.getByLabel("Timecode").locator(".dur");
}

/** The In/Out being marked, with its Clear button, in the transport. */
export function rangeChip(page: Page): Locator {
  return transport(page).locator(".chipx");
}

/** The ruler: time ticks, the playhead and a marker per note. Clicking or dragging on it seeks. */
export function ruler(page: Page): Locator {
  return page.getByRole("slider", { name: "Timeline" });
}

/** The notes' markers on the ruler. */
export function rulerMarkers(page: Page): Locator {
  return ruler(page).locator(".mk");
}

/** The Picture track: a block per shot. */
export function pictureTrack(page: Page): Locator {
  return page.getByRole("group", { name: "Picture track" });
}

/** The Picture track's blocks; the one under the playhead has `aria-current`. */
export function shotBlocks(page: Page): Locator {
  return pictureTrack(page).getByRole("button");
}

// ---- sound on the timeline (§27, 5.6) ----

/** A sound row's name on the Timeline tab; "Cut sound" is the cut file's own audio. */
export type SoundName = "Voice" | "Music" | "Effects" | "Cut sound";

/** A sound row under the Picture track: its head (swatch, name, take count, M, S, level) and its block. */
export function soundTrack(page: Page, name: SoundName): Locator {
  return page.getByRole("group", { name: `${name} track`, exact: true });
}

/** The one block on a sound row: the take in use with its waveform, or the dashed empty one. */
export function soundBlock(page: Page, name: SoundName): Locator {
  return soundTrack(page, name).locator(".sblock");
}

/** A sound row's label: the take's name, or the state in its place ("Not started", "Nothing chosen yet", "File not found"). */
export function soundLabel(page: Page, name: SoundName): Locator {
  return soundBlock(page, name).locator(".slbl");
}

/** The timeline panel under the transport: the ruler, the Picture track and the sound or take rows. */
export function timelinePanel(page: Page): Locator {
  return page.locator(".tlpanel");
}

/**
 * A state shown as a label on a row is only shown if a person can read it: the label's box lies inside its row's
 * box, it is at least `minHeight` px tall, its text is not cut off, and no box between it and the row clips it.
 * `toHaveText` alone reads the DOM, where a 2 px box thrown out of its row still "has" its text (final review I1).
 */
export async function expectReadableInRow(label: Locator, row: Locator, minHeight = 12): Promise<void> {
  await expect(label).toBeVisible();
  await expect.poll(async () => {
    const rowEl = (await row.elementHandle()) as ElementHandle<Element> | null;
    if (!rowEl) return "no row";
    return label.evaluate((el, { rowEl, minHeight }) => {
      const b = el.getBoundingClientRect();
      const inside = (r: DOMRect) => b.left >= r.left - 0.5 && b.top >= r.top - 0.5 && b.right <= r.right + 0.5 && b.bottom <= r.bottom + 0.5;
      const problems: string[] = [];
      if (!inside(rowEl.getBoundingClientRect())) problems.push(`label at y ${Math.round(b.top)}, h ${Math.round(b.height)} is outside its row`);
      if (b.height < minHeight) problems.push(`label is ${Math.round(b.height)} px tall`);
      if (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight) problems.push("its text is cut off");
      for (let p = el.parentElement; p && p !== rowEl; p = p.parentElement) {
        const s = getComputedStyle(p);
        if ((s.overflowX !== "visible" || s.overflowY !== "visible") && !inside(p.getBoundingClientRect())) problems.push(`clipped by .${p.className}`);
      }
      return problems.join("; ") || "ok";
    }, { rowEl, minHeight });
  }, { message: "the label is readable inside its row" }).toBe("ok");
}

/** A sound row's M or S. */
export function soundButton(page: Page, name: SoundName, kind: "Mute" | "Solo"): Locator {
  return soundTrack(page, name).getByRole("button", { name: `${kind} ${name}`, exact: true });
}

/** A sound row's level slider, in dB. */
export function soundLevel(page: Page, name: Exclude<SoundName, "Cut sound">): Locator {
  return soundTrack(page, name).getByRole("slider", { name: `${name} level`, exact: true });
}


/** The lane of the Cut sound row, where the picture's own waveform is drawn. */
export const CUT_SOUND_LANE = '[role="group"][aria-label="Cut sound track"] .tlane';
/** The picture's own waveform, on the Cut sound row. */
export const CUT_SOUND_WAVE = `${CUT_SOUND_LANE} canvas.pwave`;

/** The loudness readout, in the transport while a take is in use. */
export function loudness(page: Page): Locator {
  return transport(page).getByRole("group", { name: "Loudness" });
}

/** The transport's Play (Pause while playing). */
export function playButton(page: Page): Locator {
  return transport(page).getByRole("button", { name: /^(Play|Pause) · Space$/ });
}

// ---- a sound's tab (§27, 5.8): Voice, Music and Effects list every take: new, in use, earlier, put away ----

/** The takes list under the ruler and the Picture row: one radio group, a circle per take. */
export function takesList(page: Page): Locator {
  return page.locator(".takes");
}

/** The list's group headings, in order: "New · Round 3", "In use · Round 2", "Earlier · Round 1", "Archived · 2". */
export function takeHeadings(page: Page): Locator {
  return takesList(page).getByRole("heading");
}

/** One take's row (named as shown: Blind names it "Bed 1"): its circle, name, tag, Put away and its block. */
export function takeRow(page: Page, name: string): Locator {
  return takesList(page).getByRole("group", { name, exact: true });
}

/** Every take row in the list, in order. */
export function takeRows(page: Page): Locator {
  return takesList(page).locator(".take:not(.loose)");
}

/** A row's circle: a radio, checked on the take in use ("In use: <name>"), else "Use this one: <name>". */
export function takeCircle(page: Page, name: string): Locator {
  return takeRow(page, name).getByRole("radio");
}

/** A row's name: a click selects the take and auditions it. */
export function takeName(page: Page, name: string): Locator {
  return takeRow(page, name).getByRole("button", { name, exact: true });
}

/** The tag with the cut a take was made for ("v1"), amber (`.stale`) when the film has moved on. */
export function takeTag(page: Page, name: string): Locator {
  return takeRow(page, name).locator(".ktag");
}

/** A row's block: its waveform, its cues and its notes, under the shared time scale. A click there selects a point. */
export function takeBlock(page: Page, name: string): Locator {
  return takeRow(page, name).locator(".tlane");
}

/** A row's details button (round 1), beside its name: it opens the take's details as a line of its own under the row. */
export function takeDetailsButton(page: Page, name: string): Locator {
  return takeRow(page, name).getByRole("button", { name: `Details for ${name}`, exact: true });
}

/** The details line a row's details button opens: the element right after the row, when it is one. */
export function takeDetailsLine(page: Page, name: string): Locator {
  return takeRow(page, name).locator("xpath=following-sibling::*[1][contains(concat(' ', normalize-space(@class), ' '), ' kdetail ')]");
}

/** A box on the page, or a failure naming what had none (hidden, or not in the page). */
export async function boxOf(el: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await el.boundingBox();
  if (!b) throw new Error(`no box for ${el}`);
  return b;
}

/** `inner`'s box lies inside `outer`'s (half a pixel's slack for rounding). */
export async function expectInside(inner: Locator, outer: Locator): Promise<void> {
  const [i, o] = [await boxOf(inner), await boxOf(outer)];
  expect(i.x, "left edge").toBeGreaterThanOrEqual(o.x - 0.5);
  expect(i.y, "top edge").toBeGreaterThanOrEqual(o.y - 0.5);
  expect(i.x + i.width, "right edge").toBeLessThanOrEqual(o.x + o.width + 0.5);
  expect(i.y + i.height, "bottom edge").toBeLessThanOrEqual(o.y + o.height + 0.5);
}

/**
 * Round 1: no words over a take's waveform. Every piece of text a person can see in the row (its name, tag, buttons,
 * an effects pass's cue names), measured as drawn (each text run's own boxes, not its element's), stays clear of the
 * row's waveform canvas. Returns what overlaps, "ok" when nothing does, or "no waveform" when the row draws none.
 */
export async function textOverWaveform(row: Locator): Promise<string> {
  return row.evaluate((rowEl) => {
    const wave = rowEl.querySelector("canvas.wave");
    if (!wave) return "no waveform";
    const w = wave.getBoundingClientRect();
    const hits: string[] = [];
    const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const parent = node.parentElement;
      if (!text || !parent) continue;
      const style = getComputedStyle(parent);
      if (style.visibility === "hidden" || (typeof parent.checkVisibility === "function" && !parent.checkVisibility({ opacityProperty: true }))) continue;
      // Visually hidden text (a 1 px box clipped away) is for screen readers, not drawn.
      const pb = parent.getBoundingClientRect();
      if (pb.width <= 1 && pb.height <= 1) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        if (r.width === 0 || r.height === 0) continue;
        if (r.left < w.right && r.right > w.left && r.top < w.bottom && r.bottom > w.top) hits.push(`"${text}" at y ${Math.round(r.top)}-${Math.round(r.bottom)} over the waveform at y ${Math.round(w.top)}-${Math.round(w.bottom)}`);
      }
    }
    return hits.join("; ") || "ok";
  });
}

/**
 * A row's slot button: Archive, Restore on an archived take, or Unpick on the take in use. It shows on the row under the
 * pointer or with focus inside it (pressRowButton hovers the row first).
 */
export function putAwayButton(page: Page, name: string, kind: "Archive" | "Restore" | "Unpick" = "Archive"): Locator {
  return takeRow(page, name).getByRole("button", { name: kind, exact: true });
}

/** Presses a row's Put away, Bring back or Unpick the way a mouse would: the row hovered, so the button shows, then clicked. */
export async function pressRowButton(page: Page, name: string, kind: "Archive" | "Restore" | "Unpick" = "Archive"): Promise<void> {
  await takeRow(page, name).hover();
  await putAwayButton(page, name, kind).click();
}

/** Show / Hide on a folded group's line: "Archived" or "Not on this film". */
export function foldToggle(page: Page, group: "Archived" | "Not on this film"): Locator {
  return takesList(page).locator(`.kfold[data-fold="${group === "Archived" ? "away" : "loose"}"]`).getByRole("button");
}

/** Clicks a take's block `t` seconds in (on the list's time scale): the take is selected at that point, and the playhead goes there. */
export async function clickTakeAt(page: Page, name: string, t: number, length: number): Promise<void> {
  const r = (await takeBlock(page, name).boundingBox())!;
  await page.mouse.click(r.x + (r.width * t) / length, r.y + r.height / 2);
}

// ---- the notes panel (§27, 5.7): Notes and Activity, the note box's target line, and Send ----

/** The notes panel: the right-hand column of Review and Plan (a drawer under 1100 px). */
export function notesPanel(page: Page): Locator {
  return page.getByRole("complementary", { name: "Notes panel" });
}

/** One of the panel's two tabs: Notes (with its count) or Activity (with a dot for entries not yet seen). */
export function panelTab(page: Page, name: "Notes" | "Activity"): Locator {
  return notesPanel(page).getByRole("tab", { name: new RegExp(`^${name}`) });
}

/** The Activity tab's list: the Change Log, with its "add a line" box. Open the tab first (openActivity). */
export function activity(page: Page): Locator {
  return page.getByRole("tabpanel", { name: "Activity" });
}

/** Opens the panel's Activity tab. */
export async function openActivity(page: Page): Promise<void> {
  await panelTab(page, "Activity").click();
  await expect(activity(page)).toBeVisible();
}

/** The line above the note box that names what the next note is about. */
export function noteTargetLine(page: Page): Locator {
  return notesPanel(page).getByRole("group", { name: "Note target" });
}

/** The target line's words alone, read as one label ("00:00:01:00 · Music · Pulse"), without its menu's options: the time
 *  on the first line and the name on the second (noteTargetWhen, noteTargetName). */
export function noteTargetLabel(page: Page): Locator {
  return noteTargetLine(page).locator("[data-target]");
}

/**
 * The target line's menu: with nothing selected on the Timeline tab, "This frame" or "The whole mix"; on a sound's tab,
 * "This moment" (or "This cue") or the whole take ("The whole bed").
 */
/** The target line's second line: what the note is on, by name (the shot, the take with its sound, the script line). */
export function noteTargetName(page: Page): Locator {
  return noteTargetLine(page).locator(".ntname");
}

/** The time on the target line's first line, beside the menu ("00:00:01:00"), when the target has one. */
export function noteTargetWhen(page: Page): Locator {
  return noteTargetLine(page).locator(".ntwhen");
}

export function noteTargetMenu(page: Page): Locator {
  return noteTargetLine(page).getByRole("combobox", { name: "Aim the note at" });
}

/** Lets go of the selection (a take picked on its row), back to the default target. */
export function clearTarget(page: Page): Locator {
  return noteTargetLine(page).getByRole("button", { name: "Clear the selection · Esc" });
}

/** The panel's Send, "Send 3", shown while something waits to be sent (and plain "Send" on a Brief or Storyboard page). */
export function sendButton(page: Page): Locator {
  return notesPanel(page).getByRole("button", { name: /^Send( \d+)?$/ });
}

/** What Send opens: the batch's prompt, with Copy. */
export function sentDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: "Sent to agent" });
}

/** The top bar's button that hides and shows the panel (opens and closes the drawer under 1100 px). */
export function panelToggle(page: Page): Locator {
  return page.locator("header.top").getByRole("button", { name: /the notes panel · \\$/ });
}

/**
 * The status bar's "Send N notes" ("Send N changes" when anything waiting is an edit rather than a note), shown only on a
 * page with no notes panel (Visuals, Assets): it opens the notes panel with Send in view.
 */
export function statusSend(page: Page): Locator {
  return page.locator("footer.status").getByRole("button", { name: /^Send \d+ (notes?|changes?)$/ });
}

/** Presses Send wherever the person is: in the panel, or by way of the status bar from a workspace with no panel. */
export async function sendNotes(page: Page): Promise<void> {
  if (!(await sendButton(page).isVisible())) await statusSend(page).click();
  await sendButton(page).click();
}

// ---- fixtures shared by more than one spec ----

/**
 * Eleven long film names for the width tests: episodes of an invented documentary series. Seven carry a colon and three
 * parentheses, as the names they replaced did, and each is within two characters of its old length, because the tests
 * measure how these names fit and fold. The first's id is "salt-the-marsh-keeps-its-own-tide".
 */
export const ELEVEN_FILMS = [
  "Salt: the marsh keeps its own tide", "Herons: the birds that don't leave the estuary", "Ferry: the crossing runs every hour on the hour",
  "Mud: what the low tide leaves us", "Night fishing: the boats out past the light", "Lantern: the keeper who stayed on the island",
  "Flood year: the town, the river, and the wall", "Seals on the sandbar", "Oyster beds (the old ways)", "Harbour (one winter week)", "Storms (the longest night)",
];
/** The long project name that goes with them (33 characters, as before). */
export const ELEVEN_FILMS_PROJECT = "2026-10-12-tidewater-rough-review";

export { expect };
