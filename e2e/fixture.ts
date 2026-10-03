import { test as base, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const CLIP = fileURLToPath(new URL("./fixtures/clip.mp4", import.meta.url));
const VERTICAL = fileURLToPath(new URL("./fixtures/vertical.mp4", import.meta.url));

const DASHBOARD_URL = /http:\/\/127\.0\.0\.1:\d+\/p\/[a-z2-9]{8}\//;

export interface Rushes {
  /** The dashboard URL this tab should be on: `http://127.0.0.1:PORT/p/<id>/`. */
  url: string;
  /** Origin only (no `/p/<id>/`), for calling the API the way an agent would. */
  base: string;
  root: string;
  /** Call the server's API the way an agent would. */
  api<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  /** Register the 4-second test clip as a new cut of `video` (default "Hero"). */
  addCut(note?: string, video?: string): Promise<{ version: { id: string } }>;
  /** Register the 9:16 test clip (360x640, 2 s) as a new cut of "Hero". */
  addVerticalCut(note?: string): Promise<{ version: { id: string } }>;
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
async function start(port = 0): Promise<Started> {
  const tmpDir = await mkdtemp(join(tmpdir(), "rushes e2e "));
  const root = join(tmpDir, "My Film");
  await mkdir(join(root, "renders"), { recursive: true });
  // RUSHES_NO_REVEAL stops the dashboard's "Show in Finder" (added in Plan 2c) from ever
  // actually opening Finder/Explorer during a test run.
  const child = spawn(process.execPath, [CLI, "serve", root, "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RUSHES_NO_REVEAL: "1" },
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
async function startOnPort(port: number): Promise<Started> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const attempt = await start(port);
    if (attempt.port === port) return attempt;
    await stop(attempt.child);
    await rm(attempt.tmpDir, { recursive: true, force: true });
    if (Date.now() > deadline) {
      throw new Error(`rushes serve kept landing on ${attempt.port} instead of ${port} after 5 s`);
    }
  }
}

export const test = base.extend<{ rushes: Rushes }>({
  rushes: async ({}, use) => {
    const tmpDirs: string[] = [];
    let started = await start();
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
      const slug = video.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      const n = (cutsByVideo.get(slug) ?? 0) + 1;
      cutsByVideo.set(slug, n);
      const file = `renders/${slug}_v${n}.mp4`;
      await copyFile(CLIP, join(root, file));
      return api("POST", "/api/versions", { video, file, note });
    };
    const addVerticalCut = async (note?: string) => {
      const n = (cutsByVideo.get("hero") ?? 0) + 1;
      cutsByVideo.set("hero", n);
      const file = `renders/hero_v${n}.mp4`;
      await copyFile(VERTICAL, join(root, file));
      return api("POST", "/api/versions", { video: "Hero", file, note });
    };
    const swapProject = async () => {
      const port = Number(new URL(url).port);
      await stop(child);
      const next = await startOnPort(port);
      tmpDirs.push(next.tmpDir);
      child = next.child;
      url = next.url;
      origin = next.base;
      root = next.root;
      cutsByVideo.clear();
    };

    await use({
      get url() { return url; },
      get base() { return origin; },
      get root() { return root; },
      api,
      addCut,
      addVerticalCut,
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
