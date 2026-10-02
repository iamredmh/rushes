import { test as base, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const CLIP = fileURLToPath(new URL("./fixtures/clip.mp4", import.meta.url));
const VERTICAL = fileURLToPath(new URL("./fixtures/vertical.mp4", import.meta.url));

export interface Rushes {
  url: string;
  root: string;
  /** Call the server's API the way an agent would. */
  api<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  /** Register the 4-second test clip as a new cut of "Hero". */
  addCut(note?: string): Promise<{ version: { id: string } }>;
  /** Register the 9:16 test clip (360x640, 2 s) as a new cut of "Hero". */
  addVerticalCut(note?: string): Promise<{ version: { id: string } }>;
}

/** Start `rushes serve` on a fresh project folder (with a space in its path) and wait for its URL. */
async function start(): Promise<{ child: ChildProcess; url: string; root: string; base: string }> {
  const base = await mkdtemp(join(tmpdir(), "rushes e2e "));
  const root = join(base, "My Film");
  await mkdir(join(root, "renders"), { recursive: true });
  const child = spawn(process.execPath, [CLI, "serve", root, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  const url = await new Promise<string>((ok, fail) => {
    let out = "";
    const timer = setTimeout(() => fail(new Error(`rushes serve didn't start:\n${out}`)), 10_000);
    child.stdout!.on("data", (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) {
        clearTimeout(timer);
        ok(m[0]);
      }
    });
    child.stderr!.on("data", (d) => (out += d));
    child.on("exit", (code) => fail(new Error(`rushes serve exited (${code}):\n${out}`)));
  });
  return { child, url, root, base };
}

export const test = base.extend<{ rushes: Rushes }>({
  rushes: async ({}, use) => {
    const { child, url, root, base } = await start();
    let cuts = 0;
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(url + path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
      return json;
    };
    const addCut = async (note?: string) => {
      cuts++;
      const file = `renders/hero_v${cuts}.mp4`;
      await copyFile(CLIP, join(root, file));
      return api("POST", "/api/versions", { video: "Hero", file, note });
    };
    const addVerticalCut = async (note?: string) => {
      cuts++;
      const file = `renders/hero_v${cuts}.mp4`;
      await copyFile(VERTICAL, join(root, file));
      return api("POST", "/api/versions", { video: "Hero", file, note });
    };
    await use({ url, root, api, addCut, addVerticalCut });
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    await rm(base, { recursive: true, force: true });
  },
});

/** Wait until the player has loaded the cut's metadata, so seeking works. */
export async function videoReady(page: Page): Promise<void> {
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
}

export { expect };
