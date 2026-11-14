#!/usr/bin/env node
// Retakes the README's screens (docs/assets/screens/*.jpg) on the demo project, in one command:
//
//   npm run build && node scripts/readme-screens.mjs [--out docs/assets/screens] [--keep]
//
// It builds a fresh demo project in a temporary folder (`rushes demo --no-browser`, which needs ffmpeg), serves it on a
// free port, makes the few changes a person would make on the way (a take in use for each sound, a box and a note on
// the first cut, the agent's replies, two rewritten script lines), and photographs the desk in headless Chromium at
// 1280 css px wide, 1.375x, dark: 1760 x 1100 pixels (the Script page 1760 x 1271), shown 880 wide in the README.
// The server is stopped and the folder deleted at the end (--keep leaves the folder and prints where it is).
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const CLI = join(ROOT, "dist/cli/index.js");
const args = process.argv.slice(2);
const OUT = resolve(ROOT, args.includes("--out") ? args[args.indexOf("--out") + 1] : "docs/assets/screens");
const KEEP = args.includes("--keep");

const WIDTH = 1280;
const SCALE = 1760 / WIDTH; // 1.375
const HEIGHT = 1100 / SCALE; // 800
const TALL = 1271 / SCALE; // the Script page, as tall as before

const dir = await mkdtemp(join(tmpdir(), "rushes-screens-"));
const demo = join(dir, "demo");
const made = spawnSync(process.execPath, [CLI, "demo", demo, "--no-browser"], { stdio: "inherit" });
if (made.status !== 0) throw new Error("rushes demo failed (it needs ffmpeg)");

const server = spawn(process.execPath, [CLI, "serve", demo, "--port", "0", "--idle-minutes", "10"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, RUSHES_NO_REVEAL: "1" },
});
const url = await new Promise((ok, fail) => {
  let out = "";
  const timer = setTimeout(() => fail(new Error(`rushes serve didn't start:\n${out}`)), 15_000);
  const read = (d) => {
    out += d;
    const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/p\/[a-z0-9]+\//);
    if (m) {
      clearTimeout(timer);
      ok(m[0]);
    }
  };
  server.stdout.on("data", read);
  server.stderr.on("data", read);
});
const origin = new URL(url).origin;
const api = async (method, path, body) => {
  const res = await fetch(origin + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
};

const FILM = "lumen-launch";
const browser = await chromium.launch();
try {
  // ---- what a person does on the way ----
  // A take in use for each sound on the film, and the bed a little under the voice.
  await api("PUT", "/api/picks", { video: FILM, lanes: { "round-2-voice-a-pace": "voice-a-slower", music: "warm-pad", sfx: "pass-a" }, levels: { music: -12 } });
  // Notes on the first cut: one with a box drawn round the checker block.
  const { note: boxed } = await api("POST", "/api/notes", {
    stage: "picture", video: FILM, version: "v1", scope: "point", t: 3, frame: 75,
    box: { x: 0.6, y: 0.62, w: 0.26, h: 0.3 }, text: "The checker block clashes with the bars behind it. Try a hue pass.",
  });
  await api("POST", "/api/notes", { stage: "picture", video: FILM, version: "v1", scope: "range", t: 18, tOut: 21, text: "The sweep runs a beat long here. Trim it to land on the cut." });
  await api("POST", "/api/notes", { stage: "music", video: FILM, on: "music/pulse", scope: "point", t: 2, text: "Pulse comes in late. Bring the first hit forward." });

  const page = await browser.newPage({ viewport: { width: WIDTH, height: Math.ceil(TALL) }, deviceScaleFactor: SCALE, colorScheme: "dark" });
  const settle = async () => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
  };
  const shoot = async (name, height = HEIGHT) => {
    await settle();
    await page.mouse.move(0, height + 50);
    await page.screenshot({ path: join(OUT, name), type: "jpeg", quality: 90, clip: { x: 0, y: 0, width: WIDTH, height } });
    console.log(`  ${name}`);
  };
  const short = () => page.setViewportSize({ width: WIDTH, height: Math.ceil(HEIGHT) });
  const ready = () => page.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 2);
  const pickCut = async (id) => {
    await page.getByRole("button", { name: /^Cut:/ }).click();
    await page.getByRole("listbox", { name: "Versions" }).locator(`[role="option"][data-version="${id}"]`).click();
    await ready();
  };
  const reviewTab = (name) => page.getByRole("tablist", { name: "Review" }).getByRole("tab", { name: new RegExp(`^${name}`) });

  await short();
  await page.goto(url);
  await ready();

  // 1. The Timeline on the first cut: the box on the frame, the notes beside it.
  await pickCut("v1");
  await page.locator(".note", { hasText: "checker block" }).locator(".t").first().click();
  await page.waitForFunction(() => Math.abs((document.querySelector("video")?.currentTime ?? 0) - 3) < 0.1);
  await shoot("picture-review.jpg");

  // 2. The agent's answer: a note fixed in v2, with its reply.
  await api("POST", "/api/replies", {
    replies: [
      { id: boxed.id, status: "done", reply: "v2 is a hue pass: the block and the bars shift together now.", fixT: 3, fixVersion: "v2" },
    ],
  });
  await pickCut("v2");
  await page.locator(".note", { hasText: "checker block" }).locator(".t").first().click();
  await shoot("picture-fixed.jpg");

  // 3. The Script page with two lines rewritten, each with a direction.
  await api("PATCH", "/api/script/s2", { proposed: "Drop in a folder of clips. Lumen finds the best takes.", direction: "Two short sentences. Easier to say." });
  await api("PATCH", "/api/script/s3", { direction: "Slow down on 'travel with the project'." });
  await page.setViewportSize({ width: WIDTH, height: Math.ceil(TALL) });
  await page.keyboard.press("1");
  await page.getByRole("tablist", { name: "Plan" }).getByRole("tab", { name: /^Script/ }).click();
  await page.getByRole("heading", { name: "Script", exact: true }).waitFor();
  await shoot("script-review.jpg", TALL);

  // 4. Voice: round 2 in use, round 1 below it, and the agent's reply on the note that asked for it.
  const voiceNote = (await api("GET", "/api/notes?stage=voice")).notes[0];
  await api("POST", "/api/replies", { replies: [{ id: voiceNote.id, status: "done", reply: "Round 2 is Voice A at a slower pace." }] });
  await short();
  await page.keyboard.press("3");
  await reviewTab("Voice").waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".takes .take").length >= 3);
  await shoot("voiceover.jpg");

  // 5. Music: two beds with their waveforms, Warm pad in use, a note marked on each.
  await page.keyboard.press("4");
  await page.waitForFunction(() => document.querySelectorAll(".takes .take").length >= 2);
  await shoot("music.jpg");

  // 6. Effects: the pass open into its layers.
  await page.keyboard.press("5");
  await page.waitForFunction(() => document.querySelectorAll(".takes .take").length >= 1);
  await page.getByRole("button", { name: /layers/i }).first().click();
  await shoot("sound-effects.jpg");

  // 7. The Timeline's sound: a row per sound with M, S and its level, and the loudness readout in the transport.
  await page.keyboard.press("2");
  await ready();
  await page.locator('[role="group"][aria-label="Loudness"] [data-cell="integrated"] [data-value]').filter({ hasText: /\d/ }).waitFor({ timeout: 30_000 });
  await shoot("timeline-sound.jpg");

  // 8. The notes panel's Activity tab: what happened, newest first.
  await page.getByRole("complementary", { name: "Notes panel" }).getByRole("tab", { name: /^Activity/ }).click();
  await page.getByRole("tabpanel", { name: "Activity" }).locator(".lrow").first().waitFor();
  await shoot("activity.jpg");
} finally {
  await browser.close();
  server.kill("SIGTERM");
  await new Promise((ok) => server.once("exit", ok));
  if (KEEP) console.log(`Kept ${demo}`);
  else await rm(dir, { recursive: true, force: true });
}
