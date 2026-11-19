// Audio tab tests. The engine's own logic is unit-tested (test/web/timeline.test.ts and
// engine.test.ts); the full in-browser engine checks arrive with the Music tab (Task 3).
import type { Locator, Page } from "@playwright/test";
import { readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeWav } from "./fixtures/wav.js";
import {
  expect, type Rushes, test, openReviewTab, reviewTab, workspaceTab, currentFilm, pickFilm, videoReady, loudness, rangeChip, notesPanel, panelToggle, noteTargetLine, noteTargetLabel, noteTargetName, noteTargetMenu, clearTarget, rulerMarkers, soundBlock, soundButton, soundTrack,
  monitor, playButton, toolButton, takesList, takeHeadings, takeRow, takeRows, takeCircle, takeName, takeBlock, pressRowButton, foldToggle, clickTakeAt, expectReadableInRow,
  takeDetailsButton, takeDetailsLine, textOverWaveform, transport,
} from "./fixture.js";

test("the generated WAV fixture decodes in Chromium to the tone it describes", async ({ page }) => {
  const wav = makeWav({ seconds: 1.5, freq: 440 }).toString("base64");
  const decoded = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const ctx = new OfflineAudioContext(1, 22050, 22050);
    const buf = await ctx.decodeAudioData(bytes.buffer);
    const data = buf.getChannelData(0);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    return { duration: buf.duration, channels: buf.numberOfChannels, sampleRate: buf.sampleRate, peak };
  }, wav);
  expect(decoded.duration).toBeCloseTo(1.5, 2);
  expect(decoded.channels).toBe(1);
  expect(decoded.sampleRate).toBe(22050);
  expect(decoded.peak).toBeGreaterThan(0.49);
  expect(decoded.peak).toBeLessThanOrEqual(0.51);
});

// ---- Music and Sound effects (Task 3) ----
// Every page goes to `rushes.testUrl()` (`?test=1`), which exposes the engine on
// window.__rushesAudio. Normal use never has it.

declare global {
  interface Window {
    // The test hook (web/src/ui/AudioStage.tsx), typed loosely here: the e2e build never imports web code.
    __rushesAudio?: {
      engine: { time: number; playing: boolean; seek(t: number): void; inspect(): Snapshot } | null;
      inspect(): Snapshot | null;
      renders: number;
      panelRenders: number;
      draws(): number;
      liveContexts(): number;
      heard(): { id: string; lane: string; path: string; offset: number }[];
    };
  }
}

type Snapshot = { playing: boolean; time: number; length: number; sources: number; gains: Record<string, number>; lanes: Record<string, number>; media: string[]; streamed: string[];
  idle: string[]; voices: Record<string, number> };

const inspect = (page: Page) => page.evaluate(() => window.__rushesAudio!.inspect() as unknown as Snapshot);

/** Wait until the tab's engine holds `n` files. */
async function loaded(page: Page, n: number) {
  await expect.poll(async () => (await inspect(page))?.media.length ?? 0, { timeout: 10_000 }).toBe(n);
}

/**
 * The computed `overflow` of an element and every ancestor up to (and including) its take's row: a
 * `[data-tip]` mark's tooltip (an `::after`) is clipped if any box between it and the row hides
 * overflow, so every link in the chain must stay `visible`.
 */
function overflowChain(mark: ReturnType<Page["locator"]>) {
  return mark.evaluate((el) => {
    const chain: string[] = [];
    let node: HTMLElement | null = el as HTMLElement;
    while (node) {
      chain.push(getComputedStyle(node).overflow);
      if (node.classList.contains("take")) break;
      node = node.parentElement;
    }
    return chain;
  });
}

/** Two beds on Music, loaded, nothing picked. */
async function twoBeds(page: Page, rushes: Rushes) {
  await rushes.addVariant("music", "A · Deep house", { seconds: 4, freq: 220, meta: { bpm: 120, key: "A minor" } });
  await rushes.addVariant("music", "B · Warm keys", { seconds: 4, freq: 330, meta: { description: "Soft keys, no drums" } });
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Music");
  await expect(takeRows(page)).toHaveCount(2);
  await loaded(page, 2);
}

/** A take's row by its key ("<lane>/<variant>"), for the tests that name a take by the `on` its notes save. */
const rowOf = (page: Page, key: string) => takesList(page).locator(`.take[data-take="${key}"]`);

test("Music shows a row per bed, and its circle persists the pick", async ({ page, rushes }) => {
  await twoBeds(page, rushes);
  const rows = takeRows(page);
  await expect(rows.nth(0).locator("[data-name]")).toHaveText("A · Deep house");
  // Round 1: a bed's details are on its name (a tooltip, read out as its description), never over its waveform.
  await expect(takeName(page, "A · Deep house")).toHaveAttribute("data-tip", "120 BPM · A minor");
  await expect(takeName(page, "A · Deep house")).toHaveAttribute("aria-description", "120 BPM · A minor");
  await expect(rows.nth(1).locator("[data-name]")).toHaveText("B · Warm keys");
  await expect(takeName(page, "B · Warm keys")).toHaveAttribute("data-tip", "Soft keys, no drums");
  await expect(takesList(page).locator(".tlane").filter({ hasText: /BPM|Soft keys/ })).toHaveCount(0);
  const useB = takeCircle(page, "B · Warm keys");
  await expect(useB).toHaveAttribute("aria-checked", "false");
  await expect(useB).toHaveAccessibleName("Use this one: B · Warm keys");
  await useB.click();
  await expect(useB).toHaveAttribute("aria-checked", "true");
  await expect(useB).toHaveAccessibleName("In use: B · Warm keys");
  const picks = await rushes.api("GET", "/api/picks");
  expect(picks.lanes).toEqual({ music: "b-warm-keys" });
  // The picked bed is what plays when nothing's selected.
  expect((await inspect(page)).gains).toMatchObject({ "music/a-deep-house": 0, "music/b-warm-keys": 1 });
  await page.reload();
  await expect(takeCircle(page, "B · Warm keys")).toHaveAttribute("aria-checked", "true");
});

test("only one bed is in use at a time, across rounds, and the timeline plays that one (§27.6)", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.addVariant("music", "Pulse", { seconds: 4, freq: 220, round: "Round 1" });
  await rushes.addVariant("music", "Drift", { seconds: 4, freq: 330, round: "Round 2" });
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Music");
  await expect(takeRows(page)).toHaveCount(2);
  const pulse = takeCircle(page, "Pulse");
  const drift = takeCircle(page, "Drift");
  await pulse.click();
  await expect(pulse).toHaveAttribute("aria-checked", "true");
  await drift.click();
  await expect(drift).toHaveAttribute("aria-checked", "true");
  // Round 1 still remembers Pulse as its own pick, but one bed is in use for the film.
  await expect(pulse).toHaveAttribute("aria-checked", "false");
  expect((await rushes.api("GET", "/api/picks?video=hero")).lanes).toEqual({ "round-1": "pulse", "round-2": "drift" });
  // The earlier bed can be brought back, though its round is not the newest.
  await pulse.click();
  await expect(pulse).toHaveAttribute("aria-checked", "true");
  await expect(drift).toHaveAttribute("aria-checked", "false");
  expect((await rushes.api("GET", "/api/picks?video=hero")).use.music).toMatchObject({ lane: "round-1", variant: "pulse" });
  await page.reload();
  await openReviewTab(page, "Music");
  await expect(takeCircle(page, "Pulse")).toHaveAttribute("aria-checked", "true");
  await openReviewTab(page, "Timeline");
  await expect(soundBlock(page, "Music")).toHaveAccessibleName(/ · Pulse$/);
  await expect(soundTrack(page, "Music")).not.toContainText("Drift");
});

// Regression guard for AudioStage's per-tab notes (Plan 3b Task 2; §27, 5.7: the selection decides, not a switch): Music
// takes a note on a whole bed, a point on it and a range on it, keeps its In/Out buttons and its Range marks.
test("Music takes notes on a whole bed, a point and a range, with In/Out and Range marks", async ({ page, rushes }) => {
  await twoBeds(page, rushes);
  await takeName(page, "B · Warm keys").click();
  await expect(noteTargetLabel(page)).toHaveText("Music · B · Warm keys");
  await clickLaneAt(page, "B · Warm keys", 1);
  await expect(noteTargetLabel(page)).toContainText(/^00:00:01:00 · Music · B · Warm keys/);
  // In and Out: the Range tool, and I and O.
  await expect(toolButton(page, "Range")).toBeVisible();
  await page.keyboard.press("i");
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("o");
  await expect(noteTargetLabel(page)).toContainText("–");
  await expect(page.getByRole("group", { name: "Marks" })).toBeVisible();
});

test("switching beds mid-play doesn't move the playhead", async ({ page, rushes }) => {
  await twoBeds(page, rushes);
  await takeName(page, "A · Deep house").click();
  await playButton(page).click();
  await expect.poll(async () => (await inspect(page)).time).toBeGreaterThan(0.5);
  const r = await page.evaluate(() => {
    const e = window.__rushesAudio!.engine!;
    const before = e.inspect();
    const p0 = performance.now();
    (document.querySelector('.take[data-take="music/b-warm-keys"] .knm') as HTMLButtonElement).click();
    const after = e.inspect();
    return { before, after, wall: (performance.now() - p0) / 1000 };
  });
  expect(r.after.playing).toBe(true);
  expect(r.after.time).toBeGreaterThanOrEqual(r.before.time);
  expect(r.after.time - r.before.time - r.wall).toBeLessThan(0.05);
  // Same sources, just a gain ramp: nothing restarted.
  expect(r.after.sources).toBe(r.before.sources);
  expect(r.after.sources).toBe(2);
  expect(r.before.gains).toMatchObject({ "music/a-deep-house": 1, "music/b-warm-keys": 0 });
  expect(r.after.gains).toMatchObject({ "music/a-deep-house": 0, "music/b-warm-keys": 1 });
  await expect(rowOf(page, "music/b-warm-keys")).toHaveAttribute("aria-current", "true");
  // Auditioning doesn't change the pick.
  expect((await rushes.api("GET", "/api/picks")).lanes).toEqual({});
  // The note's target follows the bed you clicked: at the playhead, which has moved on.
  await expect(noteTargetLabel(page)).toHaveText(/^00:00:\d\d:\d\d · Music · B · Warm keys$/);
});

test("a range note with Fall and Quieter 3 dB saves its marks and draws on its take", async ({ page, rushes }) => {
  await twoBeds(page, rushes);
  await takeName(page, "B · Warm keys").click();
  for (let i = 0; i < 15; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("i");
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("o");
  await expect(rangeChip(page)).toContainText("0:00.50–0:01.50");
  await expect(noteTargetLabel(page)).toContainText("– ");
  await expect(noteTargetLabel(page)).toContainText("Music · B · Warm keys");
  const marks = page.getByRole("group", { name: "Marks" });
  await marks.getByRole("button", { name: "Fall" }).click();
  await marks.getByRole("button", { name: "Quieter" }).click();
  await expect(marks.getByRole("combobox", { name: "Quieter by" })).toHaveValue("3");
  // Rise and Fall exclude each other.
  await marks.getByRole("button", { name: "Rise" }).click();
  await expect(marks.getByRole("button", { name: "Fall" })).toHaveAttribute("aria-pressed", "false");
  await marks.getByRole("button", { name: "Fall" }).click();
  await expect(marks.getByRole("button", { name: "Rise" })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("n");
  await page.keyboard.type("Pull it down under the line.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(1);
  const { notes } = await rushes.api("GET", "/api/notes?stage=music");
  expect(notes[0]).toMatchObject({ stage: "music", on: "music/b-warm-keys", scope: "range", t: 0.5, tOut: 1.5, marks: [{ kind: "fall" }, { kind: "quieter", db: 3 }] });
  await expect(page.locator(".note .nmarks")).toHaveText("Fall · Quieter 3 dB");
  await expect(page.locator(".note .on")).toHaveText("B · Warm keys");
  await expect(rowOf(page, "music/b-warm-keys").locator(`.span[data-note="${notes[0].id}"]`)).toHaveCount(1);
  await expect(rowOf(page, "music/a-deep-house").locator("[data-note]")).toHaveCount(0);
  // The range is used up: the composer is back on the bed (at the playhead, a point), with no marks showing.
  await expect(page.getByRole("group", { name: "Marks" })).toHaveCount(0);
  await expect(noteTargetLabel(page)).toHaveText("00:00:01:15 · Music · B · Warm keys");
});

test("a whole note sends no time and is listed but not drawn", async ({ page, rushes }) => {
  await twoBeds(page, rushes);
  // Nothing clicked: the note is on the first bed, whole.
  await expect(noteTargetLabel(page)).toHaveText("Music · A · Deep house");
  // Red, round 2: no quick-start chips; what the note is about is said in it.
  await expect(page.getByRole("group", { name: "Start a note" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "New note" }).fill("Tempo: 110 BPM, keep the bassline.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note .t")).toHaveText("Whole");
  const { notes } = await rushes.api("GET", "/api/notes?stage=music");
  expect(notes[0]).toMatchObject({ scope: "whole", t: null, tOut: null, on: "music/a-deep-house", text: "Tempo: 110 BPM, keep the bassline.", marks: [] });
  await expect(takesList(page).locator("[data-note]")).toHaveCount(0);
});

test("Blind hides the names and reveals them again", async ({ page, rushes }) => {
  await twoBeds(page, rushes);
  const blind = page.getByRole("button", { name: "Blind" });
  await blind.click();
  await expect(blind).toHaveAttribute("aria-pressed", "true");
  await expect(takeRows(page).locator("[data-name]")).toHaveText(["Bed 1", "Bed 2"]);
  await expect(page.locator(".split")).not.toContainText("Deep house");
  await expect(page.locator(".split")).not.toContainText("Warm keys");
  await expect(page.locator(".split")).not.toContainText("120 BPM");
  // Blind hides the details too: no tooltip on a name, no details button to open them.
  await expect(takeRows(page).locator(".knm[data-tip]")).toHaveCount(0);
  await expect(takeRows(page).locator(".kinfo")).toHaveCount(0);
  await blind.click();
  await expect(blind).toHaveAttribute("aria-pressed", "false");
  await expect(takeRows(page).locator("[data-name]")).toHaveText(["A · Deep house", "B · Warm keys"]);
  await expect(takeName(page, "A · Deep house")).toHaveAttribute("data-tip", "120 BPM · A minor");
});

test("cue labels close together never overlap, even in a narrow window", async ({ page, rushes }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await rushes.addVariant("sfx", "Pass A", { seconds: 10, freq: 880, cues: [{ name: "Callout", t: 3 }, { name: "Composer", t: 3.6 }, { name: "Order", t: 4.2 }, { name: "Menu", t: 8 }] });
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Effects");
  await loaded(page, 1);
  const cues = takeRow(page, "Pass A").locator(".cue");
  await expect(cues).toHaveText(["Callout", "Composer", "Order", "Menu"]);
  const boxes = await cues.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ l: r.left, r: r.right })));
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].l).toBeGreaterThanOrEqual(boxes[i - 1].r);
  // A label with room keeps its whole name; a squeezed one is cut short, never hidden.
  expect(await cues.nth(3).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  expect(await cues.nth(1).evaluate((e) => e.clientWidth > 0)).toBe(true);
});

test("Sound effects labels cues, and a note on a cue saves the cue and its time", async ({ page, rushes }) => {
  await rushes.addVariant("sfx", "Pass A", { seconds: 3, freq: 880, meta: { description: "Subtle" }, cues: [{ name: "Whoosh", t: 0.4 }, { name: "Swipe", t: 1.5 }] });
  await rushes.addVariant("sfx", "Pass B", { seconds: 3, freq: 660 });
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Effects");
  await expect(takeRows(page)).toHaveCount(2);
  await loaded(page, 2);
  await expect(rowOf(page, "sfx/pass-a").locator(".cue")).toHaveText(["Whoosh", "Swipe"]);
  // The cue count is a detail, on the name, not over the waveform.
  await expect(rowOf(page, "sfx/pass-a").locator(".knm")).toHaveAttribute("data-tip", "Subtle · 2 cues");
  // A cue's label aims the note at that cue, at its time.
  await rowOf(page, "sfx/pass-a").locator(".cue", { hasText: "Swipe" }).click();
  await expect(noteTargetLabel(page)).toHaveText(/^00:00:01:\d\d · Effects · Cue · Swipe$/);
  await page.keyboard.press("n");
  await page.keyboard.type("Lands three frames late.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note .on")).toHaveText("Cue · Swipe");
  const { notes } = await rushes.api("GET", "/api/notes?stage=sfx");
  // §17.4: a cue note names its lane and pass, `<lane id>/<pass id>:<cue id>`.
  expect(notes[0]).toMatchObject({ stage: "sfx", on: "sfx/pass-a:swipe", scope: "point", t: 1.5, tOut: null });
  await expect(rowOf(page, "sfx/pass-a").locator(`.mk[data-note="${notes[0].id}"]`)).toHaveCount(1);
  // The circle picks, as on Music.
  await takeCircle(page, "Pass B").click();
  await expect(takeCircle(page, "Pass B")).toHaveAttribute("aria-checked", "true");
  expect((await rushes.api("GET", "/api/picks")).lanes).toEqual({ sfx: "pass-b" });
});

test("the preview follows the audio clock", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.addVariant("music", "Bed", { seconds: 4, freq: 220 });
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Music");
  await loaded(page, 1);
  const pv = monitor(page).locator("video");
  await expect.poll(() => pv.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
  expect(await pv.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  await page.evaluate(() => window.__rushesAudio!.engine!.seek(2));
  await expect.poll(() => pv.evaluate((v: HTMLVideoElement) => Math.abs(v.currentTime - 2))).toBeLessThanOrEqual(1 / 30);
  await expect(page.getByLabel("Timecode")).toContainText("0:02.00");
});

test("with no cut the monitor shows the no-cut slate, and the takes still play with the engine as the clock", async ({ page, rushes }) => {
  await rushes.addVariant("music", "Bed", { seconds: 2, freq: 220 });
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Music");
  await expect(monitor(page).getByLabel("No cut yet")).toBeVisible();
  await expect(monitor(page).getByRole("button", { name: "Copy prompt for your agent" })).toBeVisible();
  await expect(monitor(page).locator("video")).toHaveCount(0);
  await loaded(page, 1);
  await page.keyboard.press(" ");
  await expect.poll(async () => (await inspect(page)).time).toBeGreaterThan(0.2);
});

test("leaving the tab stops playback, and coming back doesn't double the sources", async ({ page, rushes }) => {
  await twoBeds(page, rushes);
  await page.keyboard.press(" ");
  await expect.poll(async () => (await inspect(page)).playing).toBe(true);
  await page.evaluate(() => { (window as unknown as { __old: unknown }).__old = window.__rushesAudio!.engine; });
  await page.keyboard.press("8");
  await expect(page.locator(".aheader h2")).toContainText("Music");
  const old = await page.evaluate(() => {
    const e = (window as unknown as { __old: { playing: boolean; inspect(): Snapshot } }).__old;
    return { playing: e.playing, sources: e.inspect().sources, live: window.__rushesAudio!.liveContexts(), engine: window.__rushesAudio!.engine };
  });
  expect(old).toEqual({ playing: false, sources: 0, live: 0, engine: null });
  await page.keyboard.press("4");
  await loaded(page, 2);
  await page.keyboard.press(" ");
  await expect.poll(async () => (await inspect(page)).playing).toBe(true);
  expect((await inspect(page)).sources).toBe(2);
  expect(await page.evaluate(() => window.__rushesAudio!.liveContexts())).toBe(1);
});

test("the Assets player and Music never play together", async ({ page, rushes }) => {
  await twoBeds(page, rushes);
  await page.keyboard.press("8");
  await page.locator(".arow").nth(0).getByRole("button", { name: /^Play / }).click();
  await expect.poll(() => page.locator("audio").evaluate((el) => (el as HTMLAudioElement).paused)).toBe(false);
  // Music starts: the Assets player has stopped.
  await page.keyboard.press("4");
  await loaded(page, 2);
  await expect(page.locator("audio")).toHaveCount(0);
  await page.keyboard.press(" ");
  await expect.poll(async () => (await inspect(page)).playing).toBe(true);
  await page.evaluate(() => { (window as unknown as { __old: unknown }).__old = window.__rushesAudio!.engine; });
  // And the reverse: the Assets player starts, Music has stopped.
  await page.keyboard.press("8");
  await page.locator(".arow").nth(0).getByRole("button", { name: /^Play / }).click();
  await expect.poll(() => page.locator("audio").evaluate((el) => (el as HTMLAudioElement).paused)).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { __old: { playing: boolean } }).__old.playing)).toBe(false);
});

test("playback never re-renders the stage per frame or redraws the waveforms", async ({ page, rushes }) => {
  await twoBeds(page, rushes);
  // Let the waveforms settle after the loads.
  await expect.poll(() => page.evaluate(() => window.__rushesAudio!.draws())).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => ({ renders: window.__rushesAudio!.renders, draws: window.__rushesAudio!.draws() }));
  await page.keyboard.press(" ");
  await expect.poll(async () => (await inspect(page)).playing).toBe(true);
  await page.waitForTimeout(1000);
  const after = await page.evaluate(() => ({ renders: window.__rushesAudio!.renders, draws: window.__rushesAudio!.draws(), t: window.__rushesAudio!.engine!.time }));
  expect(after.t).toBeGreaterThan(0.5);
  expect(after.renders - before.renders).toBeLessThan(10);
  expect(after.draws).toBe(before.draws);
  // The playhead and timecode still moved.
  await expect(page.getByLabel("Timecode")).not.toContainText("0:00.00/");
});

test("playing, a sound's notes panel re-renders only when its target line changes, not on every frame", async ({ page, rushes }) => {
  await twoBeds(page, rushes);
  // A take chosen whole: its target line has no time in it, so nothing it shows moves with the clock.
  await takeName(page, "B · Warm keys").click();
  await noteTargetMenu(page).selectOption("whole");
  await expect(noteTargetLabel(page)).toContainText("Warm keys");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => window.__rushesAudio!.panelRenders);
  await page.keyboard.press(" ");
  await expect.poll(async () => (await inspect(page)).playing).toBe(true);
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.__rushesAudio!.engine!.time)).toBeGreaterThan(0.5);
  expect((await page.evaluate(() => window.__rushesAudio!.panelRenders)) - before).toBeLessThan(10);
});

test("a file over the stream threshold plays through the streamed fallback", async ({ page, rushes }) => {
  await rushes.addVariant("music", "A · Long", { seconds: 3, freq: 220 });
  await rushes.addVariant("music", "B · Long", { seconds: 3, freq: 330 });
  await page.goto(rushes.testUrl("streamOver=1"));
  await openReviewTab(page, "Music");
  await loaded(page, 2);
  expect((await inspect(page)).streamed.length).toBe(2);
  const streamedMark = takesList(page).locator(".smk").first();
  await expect(streamedMark).toHaveAttribute("data-tip", /switching isn't sample-exact/);
  // The long-file mark's tooltip sits in the take's meta line on its block, which must not clip it.
  const streamedChain = await overflowChain(streamedMark);
  expect(streamedChain.length).toBeGreaterThan(1);
  expect(streamedChain.every((o) => o === "visible")).toBe(true);
  await page.keyboard.press(" ");
  await expect.poll(async () => (await inspect(page)).time, { timeout: 5000 }).toBeGreaterThan(0.6);
  await takeName(page, "B · Long").click();
  const s = await inspect(page);
  expect(s.playing).toBe(true);
  expect(s.gains).toMatchObject({ "music/a-long": 0, "music/b-long": 1 });
  await page.keyboard.press(" ");
  await expect.poll(async () => (await inspect(page)).playing).toBe(false);
});

test("the engine is never exposed without ?test=1", async ({ page, rushes }) => {
  await rushes.addVariant("music", "Bed", { seconds: 2, freq: 220 });
  await page.goto(rushes.url);
  await openReviewTab(page, "Music");
  await expect(takeRows(page)).toHaveCount(1);
  expect(await page.evaluate(() => "__rushesAudio" in window)).toBe(false);
});

// ---- Fix round 1 ----

test("a note on a cue two passes share names its pass, and an old bare cue id still draws", async ({ page, rushes }) => {
  await rushes.addVariant("sfx", "Pass A", { seconds: 3, freq: 880, cues: [{ name: "Swipe", t: 1.5 }] });
  await rushes.addVariant("sfx", "Pass B", { seconds: 3, freq: 660, cues: [{ name: "Swipe", t: 2.2 }] });
  // A note from before the amendment: a bare cue id, drawn on the first pass holding it.
  const old = (await rushes.api("POST", "/api/notes", { stage: "sfx", on: "swipe", scope: "point", t: 1.5, text: "Old style." })).note;
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Effects");
  await loaded(page, 2);
  await expect(rowOf(page, "sfx/pass-a").locator(`.mk[data-note="${old.id}"]`)).toHaveCount(1);
  await rowOf(page, "sfx/pass-b").locator(".cue", { hasText: "Swipe" }).click();
  await expect(noteTargetLabel(page)).toContainText("Effects · Cue · Swipe · Pass B");
  await page.keyboard.press("n");
  await page.keyboard.type("Too bright on B.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(2);
  const { notes } = await rushes.api("GET", "/api/notes?stage=sfx");
  const added = notes.find((n: { text: string }) => n.text === "Too bright on B.");
  expect(added).toMatchObject({ on: "sfx/pass-b:swipe", scope: "point", t: 2.2 });
  await expect(rowOf(page, "sfx/pass-b").locator(`.mk[data-note="${added.id}"]`)).toHaveCount(1);
  await expect(rowOf(page, "sfx/pass-a").locator(`.mk[data-note="${added.id}"]`)).toHaveCount(0);
  await expect(page.locator(`.note[data-note="${added.id}"] .on`)).toHaveText("Cue · Swipe · Pass B");
  await expect(page.locator(`.note[data-note="${old.id}"] .on`)).toHaveText("Cue · Swipe");
});

test("the notes column shows three marked notes in full above the composer, at 1440×900", async ({ page, rushes }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await rushes.addCut();
  const a = await rushes.addVariant("music", "A · Deep house", { seconds: 4, freq: 220, meta: { bpm: 120, key: "A minor" } });
  await rushes.addVariant("music", "B · Warm keys", { seconds: 4, freq: 330 });
  const marks = [[{ kind: "fall" }, { kind: "quieter", db: 3 }], [{ kind: "rise" }], [{ kind: "louder", db: 6 }]];
  for (const [i, m] of marks.entries()) {
    await rushes.api("POST", "/api/notes", {
      stage: "music", on: a.variant.id, scope: "range", t: i, tOut: i + 0.5, marks: m,
      text: ["Drop the arp under the line.", "Swell into the logo.", "Lift the bass a touch."][i],
    });
  }
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Music");
  await expect(page.locator(".note")).toHaveCount(3);
  const comp = page.locator(".comp");
  const pointHeight = (await comp.boundingBox())!.height;
  // A range brings the marks row (there are no chips now for it to replace, Red round 2): the composer grows by that row
  // and no more, and the three notes still show in full.
  await page.keyboard.press("i");
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("o");
  await expect(page.getByRole("group", { name: "Marks" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Start a note" })).toHaveCount(0);
  const marksRow = (await page.getByRole("group", { name: "Marks" }).boundingBox())!.height;
  expect((await comp.boundingBox())!.height - pointHeight).toBeLessThanOrEqual(marksRow + 12); // the row, its 8 px gap, a pixel or two of rounding
  const list = (await notesPanel(page).locator(".list").boundingBox())!;
  const compTop = (await comp.boundingBox())!.y;
  for (let i = 0; i < 3; i++) {
    const box = (await page.locator(".note").nth(i).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(list.y - 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(list.y + list.height + 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(compTop + 0.5);
    await expect(page.locator(".note").nth(i).locator(".nmarks")).toBeVisible();
  }
  // And the column ends inside the window.
  expect(compTop + (await comp.boundingBox())!.height).toBeLessThanOrEqual(900);
});

test("Blind never changes the bed being heard", async ({ page, rushes }) => {
  for (const [i, name] of ["A · One", "B · Two", "C · Three", "D · Four"].entries()) {
    await rushes.addVariant("music", name, { seconds: 2, freq: 200 + i * 50 });
  }
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Music");
  await loaded(page, 4);
  const gains = async () => (await inspect(page)).gains;
  const before = await gains();
  expect(before).toEqual({ "music/a-one": 1, "music/b-two": 0, "music/c-three": 0, "music/d-four": 0 });
  await page.getByRole("button", { name: "Blind" }).click();
  await expect(takeRows(page).locator("[data-name]").first()).toHaveText("Bed 1");
  expect(await gains()).toEqual(before);
  await page.getByRole("button", { name: "Blind" }).click();
  await expect(takeRows(page).locator("[data-name]").first()).toHaveText("A · One");
  expect(await gains()).toEqual(before);
});

test("a half-typed music note holds the film", async ({ page, rushes }) => {
  await rushes.addCut("hero", "Hero");
  await rushes.addCut("cutdown", "Cutdown");
  await rushes.addVariant("music", "Bed", { seconds: 2, freq: 220, video: ["Hero", "Cutdown"] });
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Music");
  await loaded(page, 1);
  await expect(currentFilm(page)).toHaveText("Hero");
  await page.keyboard.press("n");
  await page.keyboard.type("Half a thought");
  await page.keyboard.press("Escape");
  await page.keyboard.press("]");
  await expect(page.getByRole("status")).toHaveText("Add or clear your note on Hero first");
  await expect(currentFilm(page)).toHaveText("Hero");
  await pickFilm(page, "Cutdown", false);
  await expect(currentFilm(page)).toHaveText("Hero");
  await expect(page.getByRole("textbox", { name: "New note" })).toHaveValue("Half a thought");
  // A range alone holds it too; clearing both lets the film go.
  await page.getByRole("textbox", { name: "New note" }).fill("");
  await page.getByRole("textbox", { name: "New note" }).blur();
  await page.keyboard.press("i");
  await page.keyboard.press("]");
  await expect(currentFilm(page)).toHaveText("Hero");
  await page.getByRole("button", { name: "Clear range" }).click();
  await page.keyboard.press("]");
  await expect(currentFilm(page)).toHaveText("Cutdown");
});

test("an audio note never says it came from another cut", async ({ page, rushes }) => {
  await rushes.addCut();
  const bed = await rushes.addVariant("music", "Bed", { seconds: 4, freq: 220 });
  await rushes.api("POST", "/api/notes", { stage: "music", video: "hero", version: "v1", on: bed.variant.id, scope: "point", t: 1.25, text: "On v1." });
  await rushes.addCut();
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Music");
  await expect(page.locator(".note .t")).toHaveText("0:01.25");
  await expect(page.locator(".note .from")).toHaveCount(0);
});

test("the preview keeps up during playback without repeated seeking", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.addVariant("music", "Bed", { seconds: 4, freq: 220 });
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Music");
  await loaded(page, 1);
  const pv = monitor(page).locator("video");
  await expect.poll(() => pv.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await pv.evaluate((v: HTMLVideoElement) => {
    (window as unknown as { __seeks: number }).__seeks = 0;
    v.addEventListener("seeking", () => (window as unknown as { __seeks: number }).__seeks++);
  });
  await page.keyboard.press(" ");
  await expect.poll(async () => (await inspect(page)).playing).toBe(true);
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({ seeks: (window as unknown as { __seeks: number }).__seeks, t: window.__rushesAudio!.engine!.time }));
  expect(r.t).toBeGreaterThan(1);
  // A seek loop would show dozens in 1.5 s (one per frame). A paused-then-playing video can seek a few
  // times as it settles, and WebKit on the CI Macs does so about one run in twenty (measured on main
  // too: 2 in 40 at a limit of 2, always 3-5), so the limit is a loop detector, not a count of zero.
  expect(r.seeks).toBeLessThanOrEqual(8);
});

// ---- Voiceover (§18): rounds of whole reads ----

/** What the tab hears now, by clip id, in timeline order. */
const heard = (page: Page) =>
  page.evaluate(() => window.__rushesAudio!.heard().sort((a, b) => a.offset - b.offset).map((c) => `${c.id}@${c.offset}`));

const R1 = "Round 1 · Voices";
const R2 = "Round 2 · Gerald, tone";
/** Round 2's lane id: its name, slugged. */
const R2_ID = "round-2-gerald-tone";
/** 90 characters: far wider than the name column. */
const LONG = "Based on more sombre, with a slower intro and longer pauses between each of three reasons.";

/**
 * Two rounds, no cut. Round 1 · Voices: Jane, Louise and Gerald, with Gerald picked. Round 2 ·
 * Gerald, tone: more excited and more sombre, nothing picked (with `steadier`, a third read, steadier
 * pace, whose description is LONG).
 */
async function twoRounds(rushes: Rushes, opts: { steadier?: boolean; video?: string[] } = {}) {
  const video = opts.video;
  const jane = await rushes.addVariant("voice", "Jane", { round: R1, video, seconds: 4, freq: 220, meta: { description: "Warm, conversational" } });
  await rushes.addVariant("voice", "Louise", { round: R1, video, seconds: 4, freq: 247, meta: { description: "Bright, upbeat" } });
  const gerald = await rushes.addVariant("voice", "Gerald", { round: R1, video, seconds: 4, freq: 262, meta: { description: "Low, measured" } });
  await rushes.api("PUT", "/api/picks", { lanes: { [gerald.lane.id]: gerald.variant.id } });
  const excited = await rushes.addVariant("voice", "more excited", { round: R2, video, seconds: 4, freq: 294, meta: { description: "Brighter, quicker" } });
  const sombre = await rushes.addVariant("voice", "more sombre", { round: R2, video, seconds: 4, freq: 330, meta: { description: "Slower, lower" } });
  if (opts.steadier) await rushes.addVariant("voice", "steadier pace", { round: R2, video, seconds: 4, freq: 349, meta: { description: LONG } });
  return { jane, gerald, excited, sombre };
}

/** Open Voiceover once its `files` have decoded: every read listed (a folded Put away isn't, §19.8). */
async function openVoice(page: Page, rushes: Rushes, files: number) {
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Voice");
  await loaded(page, files);
}

/** §27, 5.7: a click on a take's block at `t` seconds: the take becomes the note's target, at that point. */
async function clickLaneAt(page: Page, name: string, t: number) {
  const length = await page.evaluate(() => window.__rushesAudio!.engine!.length);
  await clickTakeAt(page, name, t, length);
}

test("Voiceover lists every round's reads open: New, In use and Earlier, each under its round", async ({ page, rushes }) => {
  await twoRounds(rushes);
  await openVoice(page, rushes, 5);
  // Gerald was picked before Round 2 arrived: Round 2's reads wait as new, Round 1's others are earlier.
  await expect(takeHeadings(page)).toHaveText([`New · ${R2}`, `In use · ${R1}`, `Earlier · ${R1}`]);
  await expect(takeRows(page)).toHaveCount(5);
  await expect(takeRows(page).locator("[data-name]")).toHaveText(["more excited", "more sombre", "Gerald", "Jane", "Louise"]);
  expect(await takeRows(page).locator(".knm").evaluateAll((els) => els.map((e) => e.getAttribute("data-tip")))).toEqual(["Brighter, quicker", "Slower, lower", "Low, measured", "Warm, conversational", "Bright, upbeat"]);
  await expect(takeCircle(page, "Gerald")).toHaveAttribute("aria-checked", "true");
  // Nothing folds by itself.
  await expect(takesList(page).locator(".kfold")).toHaveCount(0);

  // A read heard that is then put away (and so leaves the list) stops being heard: the read in use takes over.
  await takeName(page, "Jane").click();
  await expect.poll(() => heard(page)).toEqual(["round-1-voices/jane@0"]);
  await pressRowButton(page, "Jane");
  await expect(takeRow(page, "Jane")).toHaveCount(0);
  await expect.poll(() => heard(page)).toEqual(["round-1-voices/gerald@0"]);
  await expect(noteTargetLabel(page)).toHaveText(`Voice · ${R1} · Gerald`);
});

test("Voiceover decodes only what you can reach; folding Put away mid-play never restarts the heard read (§19.8)", async ({ page, rushes }) => {
  // Reads long enough to outlast every wait below.
  const jane = await rushes.addVariant("voice", "Jane", { round: R1, seconds: 30, freq: 220 });
  await rushes.addVariant("voice", "Gerald", { round: R1, seconds: 30, freq: 262 });
  await rushes.addVariant("voice", "more excited", { round: R2, seconds: 30, freq: 294 });
  await rushes.addVariant("voice", "more sombre", { round: R2, seconds: 30, freq: 330 });
  // Jane is put away: folded under Put away, she isn't decoded.
  await rushes.api("PUT", `/api/variants/${jane.lane.id}/${jane.variant.id}/put-away`, { away: true });
  const JANE = "audio/voice-1-jane.wav";
  const janeFetches = () => fetched.filter((p) => p === JANE).length;
  const fetched: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).searchParams.get("path");
    if (path) fetched.push(path);
  });
  // Jane's file is held back until released, so her row can be seen loading.
  let release!: () => void;
  const held = new Promise<void>((ok) => (release = ok));
  await page.route((url) => url.searchParams.get("path") === JANE, async (route) => {
    await held;
    await route.continue();
  });

  // Only the reads listed are decoded; the folded one isn't fetched at all.
  await openVoice(page, rushes, 3);
  expect((await inspect(page)).media.some((k) => k.startsWith(JANE))).toBe(false);
  expect(janeFetches()).toBe(0);

  // Nothing in use: the first read waiting plays, the newest round's first.
  const HEARD = `${R2_ID}/more-excited`;
  await playButton(page).click();
  await expect.poll(async () => (await inspect(page)).time).toBeGreaterThan(0.3);
  const heardSource = (await inspect(page)).voices[HEARD];
  expect(heardSource).toBeGreaterThan(0);

  // Showing Put away decodes it: its row shows at once, and the held file loads late.
  const fold = foldToggle(page, "Archived");
  await fold.click();
  await expect(takeRows(page)).toHaveCount(4);
  await loaded(page, 3);
  release();
  await loaded(page, 4);
  expect((await inspect(page)).sources).toBe(4);
  expect((await inspect(page)).voices[HEARD]).toBe(heardSource);

  // Folded again, its file leaves play (idle, for a quick return); the heard read runs on untouched.
  await fold.click();
  await expect(takeRows(page)).toHaveCount(3);
  await loaded(page, 3);
  let s = await inspect(page);
  expect(s.idle.filter((k) => k.startsWith(JANE))).toHaveLength(1);
  expect(s.sources).toBe(3);
  expect(s.voices[HEARD]).toBe(heardSource);
  expect(s.playing).toBe(true);

  // Shown again, it comes straight back from idle: nothing is fetched twice.
  const before = janeFetches();
  await fold.click();
  await loaded(page, 4);
  expect(janeFetches()).toBe(before);

  // Listening to Jane, then folding Put away: the default read takes over, on the source it has had since Play.
  await takeName(page, "Jane").click();
  await expect.poll(() => heard(page)).toEqual(["round-1-voices/jane@0"]);
  await fold.click();
  await expect.poll(() => heard(page)).toEqual([`${HEARD}@0`]);
  await loaded(page, 3);
  s = await inspect(page);
  expect(s.voices[HEARD]).toBe(heardSource);
  expect(s.playing).toBe(true);
});

test("every round is open on every film, and Show on Put away holds for the session across films", async ({ page, rushes }) => {
  await rushes.addCut("hero", "Hero");
  await rushes.addCut("cutdown", "Cutdown");
  const { jane } = await twoRounds(rushes, { video: ["Hero", "Cutdown"] });
  await rushes.api("PUT", `/api/variants/${jane.lane.id}/${jane.variant.id}/put-away`, { away: true });
  await openVoice(page, rushes, 4);
  await expect(takeRows(page)).toHaveCount(4);
  const fold = foldToggle(page, "Archived");
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(takeRows(page)).toHaveCount(5);
  await page.keyboard.press("]");
  await expect(currentFilm(page)).toHaveText("Cutdown");
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(takeRows(page)).toHaveCount(5);
  await page.keyboard.press("[");
  await expect(currentFilm(page)).toHaveText("Hero");
  await expect(takeRows(page)).toHaveCount(5);
});

test("Put away shows a dot while one of its reads has an open note; an older round's read is listed by its round", async ({ page, rushes }) => {
  const { jane } = await twoRounds(rushes);
  const key = `${jane.lane.id}/${jane.variant.id}`;
  const { note } = await rushes.api("POST", "/api/notes", { stage: "voice", on: key, scope: "point", t: 1, text: "Lovely warmth here." });
  await openVoice(page, rushes, 5);
  // Listed by its round and read, since Round 1 isn't the newest round; drawn on Jane's block.
  await expect(page.locator(`.note[data-note="${note.id}"] .on`)).toHaveText("Round 1 · Voices · Jane");
  await expect(rowOf(page, key).locator(`.mk[data-note="${note.id}"]`)).toHaveCount(1);
  // Put away, Jane's open note shows as a dot on the folded line.
  await pressRowButton(page, "Jane");
  await expect(takesList(page).locator('.kfold[data-fold="away"] .fdot')).toHaveCount(1);
  await page.locator(`.note[data-note="${note.id}"] .chk`).click();
  await expect(takesList(page).locator('.kfold[data-fold="away"] .fdot')).toHaveCount(0);
  // Shown, the point note is drawn on her block again.
  await foldToggle(page, "Archived").click();
  await expect(rowOf(page, key).locator(`.mk[data-note="${note.id}"]`)).toHaveCount(1);
});

test("six reads over two rounds fit in the takes list without scrolling at 1440×900", async ({ page, rushes }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await rushes.addCut();
  await twoRounds(rushes, { steadier: true });
  await openVoice(page, rushes, 6);
  await expect(takeRows(page)).toHaveCount(6);
  const panel = (await page.locator(".takespanel").boundingBox())!;
  const bottom = await takeRows(page).last().evaluate((el) => el.getBoundingClientRect().bottom);
  expect(bottom).toBeLessThanOrEqual(panel.y + panel.height + 0.5);
  expect(bottom).toBeLessThanOrEqual(900);
});

test("Voiceover plays one read at a time: the read in use, then a clicked read, without moving the playhead", async ({ page, rushes }) => {
  await twoRounds(rushes);
  await openVoice(page, rushes, 5);
  // Nothing selected: the read in use, from whichever round, not the newest round's first.
  await expect.poll(() => heard(page)).toEqual(["round-1-voices/gerald@0"]);
  await playButton(page).click();
  await expect.poll(async () => (await inspect(page)).time).toBeGreaterThan(0.5);

  // Clicking a read switches to it in the click: a gain swap, the same sources, the playhead running on.
  const r = await page.evaluate((row) => {
    const e = window.__rushesAudio!.engine!;
    const before = e.inspect();
    const p0 = performance.now();
    (document.querySelector(`.take[data-take="${row}"] .knm`) as HTMLButtonElement).click();
    const after = e.inspect();
    return { before, after, wall: (performance.now() - p0) / 1000, heard: window.__rushesAudio!.heard().map((c) => c.id) };
  }, `${R2_ID}/more-sombre`);
  expect(r.after.playing).toBe(true);
  expect(r.after.time - r.before.time - r.wall).toBeLessThan(0.05);
  expect(r.after.time).toBeGreaterThanOrEqual(r.before.time);
  expect(r.after.sources).toBe(r.before.sources);
  expect(r.heard).toEqual([`${R2_ID}/more-sombre`]);
  await expect(rowOf(page, `${R2_ID}/more-sombre`)).toHaveAttribute("aria-current", "true");
  // Auditioning isn't picking.
  expect((await rushes.api("GET", "/api/picks")).lanes[R2_ID]).toBeUndefined();

  // The circle picks the read, on the same clock.
  const t0 = await page.evaluate(() => ({ t: window.__rushesAudio!.engine!.time, wall: performance.now() / 1000 }));
  await takeCircle(page, "more sombre").click();
  await expect(takeCircle(page, "more sombre")).toHaveAttribute("aria-checked", "true");
  await expect.poll(async () => (await rushes.api("GET", "/api/picks")).lanes[R2_ID]).toBe("more-sombre");
  const t1 = await page.evaluate(() => ({ t: window.__rushesAudio!.engine!.time, wall: performance.now() / 1000, playing: window.__rushesAudio!.engine!.playing }));
  expect(t1.playing).toBe(true);
  expect(Math.abs(t1.t - t0.t - (t1.wall - t0.wall))).toBeLessThan(0.1);
  expect(await heard(page)).toEqual([`${R2_ID}/more-sombre@0`]);
});

test("Voiceover notes are on a whole read, a point or a range of it (round 1), whole first, with no chips and no marks", async ({ page, rushes }) => {
  await twoRounds(rushes);
  await openVoice(page, rushes, 5);
  // Nothing clicked, the playhead at the start: the whole of the read in use.
  await expect(noteTargetLabel(page)).toHaveText(`Voice · ${R1} · Gerald`);
  // Red, round 2: no quick-start chips on any of them.
  const chips = page.getByRole("group", { name: "Start a note" });
  await expect(chips).toHaveCount(0);
  // A point at the playhead.
  await page.evaluate(() => window.__rushesAudio!.engine!.seek(1));
  await expect(noteTargetLabel(page)).toHaveText(`00:00:01:00 · Voice · ${R1} · Gerald`);
  await expect(chips).toHaveCount(0);
  // Round 1: the Range tool is on the strip, and I and O mark a range, live on the ruler and every read's block.
  await expect(toolButton(page, "Range")).toBeVisible();
  await page.keyboard.press("i");
  await expect(toolButton(page, "Range")).toHaveAttribute("aria-pressed", "true");
  await expect(rangeChip(page)).toContainText("0:01.00");
  await page.evaluate(() => window.__rushesAudio!.engine!.seek(2.5));
  await page.keyboard.press("o");
  await expect(rangeChip(page)).toContainText("0:01.00");
  await expect(rangeChip(page)).toContainText("0:02.50");
  await expect(takesList(page).locator(".span.live")).toHaveCount(5);
  await expect(page.getByRole("slider", { name: "Timeline" }).locator(".span")).toHaveCount(1);
  await expect(noteTargetLabel(page)).toContainText("–");
  await expect(noteTargetLabel(page)).toContainText(`Voice · ${R1} · Gerald`);
  // A range has no chips and no marks: a read is replaced, not levelled.
  await expect(chips).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Marks" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "New note" }).fill("Fix this: re-record this phrase.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(1);
  const { notes } = await rushes.api("GET", "/api/notes?stage=voice");
  expect(notes[0]).toMatchObject({ stage: "voice", scope: "range", on: "round-1-voices/gerald", t: 1, tOut: 2.5, marks: [] });
  // Saved, the range is drawn as a span on its read, and the live range is gone.
  await expect(rowOf(page, "round-1-voices/gerald").locator(`.span[data-note="${notes[0].id}"]`)).toHaveCount(1);
  await expect(takesList(page).locator(".span.live")).toHaveCount(0);
  // Clear range lets go of a range without a note.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("i");
  await expect(rangeChip(page)).toBeVisible();
  await rangeChip(page).getByRole("button").click();
  await expect(rangeChip(page)).toHaveCount(0);
  // A click on another read's block: a point on it.
  await clickLaneAt(page, "more excited", 1);
  await expect(noteTargetLabel(page)).toContainText(/^00:00:01:00 · Voice/);
  await expect(chips).toHaveCount(0);
});

test("a point note draws on its read's block only; a whole note is listed and not drawn", async ({ page, rushes }) => {
  await twoRounds(rushes);
  await openVoice(page, rushes, 5);
  await clickLaneAt(page, "more excited", 1.5);
  await expect(noteTargetLabel(page)).toContainText("Voice");
  await page.keyboard.press("n");
  await page.keyboard.type("Clipped word here.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(1);
  let { notes } = await rushes.api("GET", "/api/notes?stage=voice");
  expect(notes[0]).toMatchObject({ stage: "voice", scope: "point", on: `${R2_ID}/more-excited` });
  expect(notes[0].t).toBeCloseTo(1.5, 1);
  await expect(rowOf(page, `${R2_ID}/more-excited`).locator(`.mk[data-note="${notes[0].id}"]`)).toHaveCount(1);
  await expect(takesList(page).locator(`[data-note="${notes[0].id}"]`)).toHaveCount(1);
  await expect(page.locator(`.note[data-note="${notes[0].id}"] .on`)).toHaveText("more excited");
  // Its name clicked, and The whole read chosen (the playhead has moved), a read is the target whole.
  await takeName(page, "more sombre").click();
  await noteTargetMenu(page).selectOption({ label: "The whole read" });
  await expect(noteTargetLabel(page)).toHaveText(`Voice · ${R2} · more sombre`);
  await page.keyboard.press("n");
  await page.keyboard.type("A touch slow overall.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(2);
  ({ notes } = await rushes.api("GET", "/api/notes?stage=voice"));
  const whole = notes.find((n: { text: string }) => n.text === "A touch slow overall.");
  expect(whole).toMatchObject({ scope: "whole", t: null, on: `${R2_ID}/more-sombre` });
  await expect(takesList(page).locator(`[data-note="${whole.id}"]`)).toHaveCount(0);
  await expect(page.locator(`.note[data-note="${whole.id}"] .on`)).toHaveText("more sombre");
});

test("Blind on Voiceover names every read Read 1…n, the one in use too, and never shows a real name", async ({ page, rushes }) => {
  await twoRounds(rushes);
  await openVoice(page, rushes, 5);
  await page.getByRole("button", { name: "Blind" }).click();
  await expect(takeRows(page).locator("[data-name]")).toHaveText(["Read 1", "Read 2", "Read 3", "Read 4", "Read 5"]);
  // Blind hides every read's details: no tooltip on a name, no details button.
  await expect(takeRows(page).locator(".knm[data-tip]")).toHaveCount(0);
  await expect(takeRows(page).locator(".kinfo")).toHaveCount(0);
  for (const name of ["Jane", "Louise", "excited", "sombre", "Low, measured"]) await expect(takesList(page)).not.toContainText(name);
  // The read in use is a "Read n" too.
  await expect(takesList(page).locator('.take:has([aria-checked="true"]) [data-name]')).toHaveText(/^Read \d$/);
  // The note's target names a read's round, so two "Read 1"s are never confused, and never its real name.
  await expect(noteTargetLabel(page)).toHaveText(new RegExp(`^Voice · ${R1} · Read \\d$`));
  await expect(noteTargetLabel(page)).not.toContainText("Gerald ");
  // An older round's read is blind too, and named by its round.
  await takeRows(page).nth(4).locator(".knm").click();
  await expect(noteTargetLabel(page)).toHaveText(`Voice · ${R1} · Read 5`);
  await expect(noteTargetLabel(page)).not.toContainText("Jane");
  await expect(noteTargetLabel(page)).not.toContainText("Louise");
  await page.getByRole("button", { name: "Blind" }).click();
  await expect(takeCircle(page, "Gerald")).toHaveAttribute("aria-checked", "true");
});

test("two rounds that both hold a Gerald are told apart by the note's target, each by its own round", async ({ page, rushes }) => {
  const R3 = "Round 3 · Gerald, fixes";
  await rushes.addVariant("voice", "Jane", { round: R1, seconds: 4, freq: 220 });
  await rushes.addVariant("voice", "Gerald", { round: R1, seconds: 4, freq: 262 });
  await rushes.addVariant("voice", "Gerald", { round: R3, seconds: 4, freq: 294 });
  await openVoice(page, rushes, 3);
  await expect(noteTargetLabel(page)).toHaveText(`Voice · ${R3} · Gerald`);
  // The older round's Gerald, picked by his row, files the note on that round's read.
  await rowOf(page, "round-1-voices/gerald").locator(".knm").click();
  await expect(noteTargetLabel(page)).toHaveText(`Voice · ${R1} · Gerald`);
  await page.keyboard.press("n");
  await page.keyboard.type("Warmer.");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await rushes.api("GET", "/api/notes?stage=voice")).notes.length).toBe(1);
  expect((await rushes.api("GET", "/api/notes?stage=voice")).notes[0]).toMatchObject({ on: "round-1-voices/gerald", scope: "whole" });
});

test("a read's description is in its name's tooltip, and the note's target names the round", async ({ page, rushes }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await twoRounds(rushes, { steadier: true });
  await openVoice(page, rushes, 6);
  // Round 1: the description is never on the block, cut short or not: it is the name's tooltip, in full.
  await expect(rowOf(page, `${R2_ID}/steadier-pace`).locator(".knm")).toHaveAttribute("data-tip", LONG);
  await expect(rowOf(page, `${R2_ID}/steadier-pace`).locator(".tlane")).not.toContainText("slower intro");
  await expect(rowOf(page, `${R2_ID}/more-sombre`).locator(".knm")).toHaveAttribute("data-tip", "Slower, lower");
  await takeName(page, "more sombre").click();
  // Under 1100 px the notes panel is a drawer: opened, its target names the round.
  await panelToggle(page).click();
  await expect(noteTargetLabel(page)).toHaveText(`Voice · ${R2} · more sombre`);
});

test("a read's details tooltip isn't clipped, and wraps its lines", async ({ page, rushes }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await twoRounds(rushes, { steadier: true });
  await openVoice(page, rushes, 6);
  const name = rowOf(page, `${R2_ID}/steadier-pace`).locator(".knm");
  await expect(name).toHaveAttribute("data-tip", LONG);
  // Every box between the tooltip's element and its row must stay unclipped, or the tooltip is cut off.
  const chain = await overflowChain(name);
  expect(chain.length).toBeGreaterThan(1);
  expect(chain.every((o) => o === "visible")).toBe(true);
  // Hovering actually shows the tooltip (opacity: 1 once the 0.12s transition settles), with the full text.
  await name.hover();
  await expect.poll(() => name.evaluate((el) => Number(getComputedStyle(el, "::after").opacity))).toBe(1);
  expect(await name.evaluate((el) => getComputedStyle(el, "::after").content)).toBe(JSON.stringify(LONG));
  expect(await name.evaluate((el) => getComputedStyle(el, "::after").whiteSpace)).toBe("pre-line");
});

test("a range note on a read draws on Voiceover as a span from its In to its Out (round 1); a point note stays a point", async ({ page, rushes }) => {
  await twoRounds(rushes);
  const { note } = await rushes.api("POST", "/api/notes", { stage: "voice", on: `${R2_ID}/more-sombre`, scope: "range", t: 1, tOut: 3, text: "Replace this stretch." });
  const { note: point } = await rushes.api("POST", "/api/notes", { stage: "voice", on: `${R2_ID}/more-sombre`, scope: "point", t: 2, text: "A clipped word." });
  await openVoice(page, rushes, 5);
  const row = rowOf(page, `${R2_ID}/more-sombre`);
  await expect(row.locator(`.mk[data-note="${note.id}"]`)).toHaveCount(1);
  const span = row.locator(`.span[data-note="${note.id}"]`);
  await expect(span).toHaveCount(1);
  // From 1 s to 3 s of the 4 s scale: half the lane's width, starting a quarter in.
  const lane = (await row.locator(".tlane").boundingBox())!;
  const box = (await span.boundingBox())!;
  expect(Math.abs(box.x - (lane.x + lane.width / 4))).toBeLessThanOrEqual(2);
  expect(Math.abs(box.width - lane.width / 2)).toBeLessThanOrEqual(2);
  await expect(row.locator(`.mk[data-note="${point.id}"]`)).toHaveCount(1);
  await expect(row.locator(`.span[data-note="${point.id}"]`)).toHaveCount(0);
  // The notes panel lists it by its range.
  await expect(page.locator(`.note[data-note="${note.id}"]`)).toContainText("0:01.00");
  await expect(page.locator(`.note[data-note="${note.id}"]`)).toContainText("0:03.00");
});

test("a cut-off round heading and the note's target show in full as tooltips, inside the window", async ({ page, rushes }) => {
  // A narrow window, and long round names (64 characters: a lane id, the name slugged, holds no more). Under 1100 px the
  // notes panel is a drawer, so the list has the window's width: 480 px cuts the headings short.
  await page.setViewportSize({ width: 480, height: 900 });
  const OLD = `Round 1 · ${"WARM, MELLOW, MOODY MALE VOICES ".repeat(2)}`.slice(0, 64).trim();
  const NEW = `Round 2 · ${"WOMEN'S VOICES, WARMER, SLOWER, MORE WONDER ".repeat(2)}`.slice(0, 64).trim();
  await rushes.addVariant("voice", "Gerald", { round: OLD, seconds: 4, freq: 262 });
  await rushes.addVariant("voice", "more sombre", { round: NEW, seconds: 4, freq: 330 });
  await openVoice(page, rushes, 2);
  const heads = takeHeadings(page);
  await expect(heads).toHaveText([`New · ${NEW}`, `New · ${OLD}`]);
  for (const [i, name] of [NEW, OLD].entries()) {
    const head = heads.nth(i);
    expect(await head.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(head).toHaveAttribute("data-tip", `New · ${name}`);
    await head.hover();
    await expect.poll(() => head.evaluate((e) => Number(getComputedStyle(e, "::after").opacity))).toBe(1);
    expect(await head.evaluate((e) => getComputedStyle(e, "::after").whiteSpace)).toBe("normal");
  }
  await takeName(page, "more sombre").click();
  await panelToggle(page).click();
  // The tooltip is on the target's name, its own line under the menu (final review I6).
  const on = noteTargetName(page);
  await expect(on).toHaveAttribute("data-tip", `Voice · ${NEW} · more sombre`);
  await on.hover();
  // The target's tooltip wraps and stays inside the window rather than running off its right edge.
  const box = await on.evaluate((e) => {
    const after = getComputedStyle(e, "::after");
    return { left: e.getBoundingClientRect().left, width: parseFloat(after.width), ws: after.whiteSpace, vw: window.innerWidth };
  });
  expect(box.ws).toBe("normal");
  expect(box.left + box.width).toBeLessThanOrEqual(box.vw);
});

test("a long file's mark sits beside the read's name, not over its waveform", async ({ page, rushes }) => {
  await rushes.addVariant("voice", "Probe", { round: R1, seconds: 3, freq: 220, meta: { description: "Steady" } });
  await page.goto(rushes.testUrl("streamOver=1"));
  await openReviewTab(page, "Voice");
  await loaded(page, 1);
  const row = takeRow(page, "Probe");
  await expect(row.locator(".khead .smk")).toHaveCount(1);
  await expect(row.locator(".tlane .smk")).toHaveCount(0);
  await expect(row.locator(".knm")).toHaveAttribute("data-tip", "Steady");
  expect(await textOverWaveform(row)).toBe("ok");
});

test("a read added with no round shows under the day it arrived, and older notes are listed, not drawn", async ({ page, rushes }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const read = await rushes.addVariant("voice", "A · Current", { seconds: 4, freq: 196 });
  await rushes.api("PUT", "/api/script", { replace: true, sections: [{ id: "s1", start: 0, end: 4, current: "Line one." }] });
  // One take on s1 that still exists, from before rounds.
  await rushes.api("POST", "/api/script/s1/takes", { file: (read.variant as unknown as { file: string }).file });
  await rushes.api("POST", "/api/notes", { stage: "voice", on: "s1:t1", scope: "point", t: 1, text: "Dip the second word." });
  await rushes.api("POST", "/api/notes", { stage: "voice", on: "vo", scope: "whole", text: "The read as a whole." });
  const { note: noOn } = await rushes.api("POST", "/api/notes", { stage: "voice", on: null, scope: "whole", text: "No on at all." });
  const { note: gone } = await rushes.api("POST", "/api/notes", { stage: "voice", on: "s1:t9", scope: "point", t: 2, text: "A take that's gone." });
  await openVoice(page, rushes, 1);
  // A read with no round is shown under the day it arrived (§27, 5.8).
  const today = await page.evaluate(() => new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" }));
  await expect(takeHeadings(page)).toHaveText([`New · ${today}`]);
  await expect(takeRows(page).locator("[data-name]")).toHaveText(["A · Current"]);
  await expect(takesList(page).locator(".kfold")).toHaveCount(0);
  await expect(page.locator(".note")).toHaveCount(4);
  // The same words as export and the CLI: no on is the assembled read, a take that's gone has none.
  await expect(page.locator(`.note[data-note="${noOn.id}"] .on`)).toHaveText("Assembled read");
  await expect(page.locator(`.note[data-note="${gone.id}"] .on`)).toHaveCount(0);
  await expect(page.locator(".note .on")).toHaveText(["Assembled read", "Assembled read", "S1 · Take 1"]);
  await expect(takesList(page).locator("[data-note]")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("another film starts Voiceover's notes on the whole read again", async ({ page, rushes }) => {
  await rushes.addCut("hero", "Hero");
  await rushes.addCut("cutdown", "Cutdown");
  await twoRounds(rushes, { video: ["Hero", "Cutdown"] });
  await openVoice(page, rushes, 5);
  await clickLaneAt(page, "more sombre", 1);
  await expect(noteTargetLabel(page)).toContainText(/^00:00:01:00 · Voice · .* · more sombre$/);
  await page.keyboard.press("]");
  await expect(currentFilm(page)).toHaveText("Cutdown");
  // From the top, nothing selected: the whole of the read that plays by default there (nothing is in use on Cutdown, so
  // the first read waiting).
  expect((await inspect(page)).time).toBe(0);
  await expect(noteTargetLabel(page)).toHaveText(`Voice · ${R2} · more excited`);
});

test("another film starts Voiceover's notes on the whole read again, even when neither film has a cut", async ({ page, rushes }) => {
  await twoRounds(rushes);
  // Two films with no cut yet, as a hand edit of the project file can leave them: the no-cut slate.
  const file = join(rushes.root, ".rushes", "project.json");
  const project = JSON.parse(await readFile(file, "utf8"));
  project.videos = [
    { id: "hero", name: "Hero", versions: [], lockedVersion: null },
    { id: "cutdown", name: "Cutdown", versions: [], lockedVersion: null },
  ];
  // Its reads are on both films.
  for (const l of project.lanes) for (const v of l.variants) v.videos = ["hero", "cutdown"];
  project.rev += 1;
  await writeFile(file, JSON.stringify(project, null, 2));
  await openVoice(page, rushes, 5);
  await expect(currentFilm(page)).toHaveText("Hero");
  await expect(page.getByLabel("No cut yet")).toBeVisible();
  await clickLaneAt(page, "more sombre", 1);
  await expect(noteTargetLabel(page)).toContainText(/^00:00:01:00 · Voice · .* · more sombre$/);
  await page.keyboard.press("]");
  await expect(currentFilm(page)).toHaveText("Cutdown");
  expect((await inspect(page)).time).toBe(0);
  // Nothing in use on Cutdown: the whole of the first read waiting.
  await expect(noteTargetLabel(page)).toHaveText(`Voice · ${R2} · more excited`);
});

test("a round whose reads are all missing shows the missing marks and plays silence", async ({ page, rushes }) => {
  const { excited, sombre } = await twoRounds(rushes);
  const lanes = (await rushes.api("GET", "/api/state")).project.lanes;
  const fileOf = (r: { lane: { id: string }; variant: { id: string } }) =>
    lanes.find((l: { id: string }) => l.id === r.lane.id).variants.find((x: { id: string }) => x.id === r.variant.id).file as string;
  const gone = [fileOf(excited), fileOf(sombre)];
  for (const f of gone) await rm(join(rushes.root, f));
  await openVoice(page, rushes, 3);
  await expect(rowOf(page, `${R2_ID}/more-excited`).locator(".amiss")).toHaveCount(1);
  await expect(rowOf(page, `${R2_ID}/more-sombre`).locator(".amiss")).toHaveCount(1);
  await expect(takeBlock(page, "more sombre")).toContainText("File not found");
  await expectReadableInRow(takeBlock(page, "more sombre").locator(".slbl"), takeRow(page, "more sombre"));
  expect((await inspect(page)).media.some((k) => gone.some((f) => k.includes(f)))).toBe(false);
  // A missing read selected is what plays, and it isn't there: silence, not another read.
  await takeName(page, "more sombre").click();
  expect(await heard(page)).toEqual([]);
  // The tab still works: another round's read plays.
  await takeName(page, "Gerald").click();
  await expect.poll(() => heard(page)).toEqual([`round-1-voices/gerald@0`]);
});

test("when the take in use has lost its file, its tab is silent rather than playing another take in its place", async ({ page, rushes }) => {
  await rushes.addVariant("music", "A · Deep house", { seconds: 4, freq: 220 });
  const b = await rushes.addVariant("music", "B · Warm keys", { seconds: 4, freq: 330 });
  await rushes.api("PUT", "/api/picks", { lanes: { [b.lane.id]: b.variant.id } });
  await rm(join(rushes.root, (b.variant as unknown as { file: string }).file));
  await rushes.scan();
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Music");
  await expect(takeRows(page)).toHaveCount(2);
  await expect(takeCircle(page, "B · Warm keys")).toHaveAttribute("aria-checked", "true");
  await expect(takeRow(page, "B · Warm keys")).toContainText("File not found");
  await expectReadableInRow(takeBlock(page, "B · Warm keys").locator(".slbl"), takeRow(page, "B · Warm keys"));
  await loaded(page, 1);
  await expect.poll(() => heard(page)).toEqual([]);
});

// ---- Picks can be cleared (Task 5) ----

/** Every Unpick in the list, read from the DOM: a hidden one (visibility: hidden in its slot) is counted too. */
const unpickButtons = (page: Page) => takesList(page).locator("button.kput", { hasText: /^Unpick$/ });

test("Unpick clears a pick: In use goes back to Use, and the pick is gone from disk; the circle in use pressed again changes nothing", async ({ page, rushes }) => {
  await twoBeds(page, rushes);
  const useB = takeCircle(page, "B · Warm keys");
  // Nothing picked: no Unpick anywhere.
  await expect(unpickButtons(page)).toHaveCount(0);
  await useB.click();
  await expect(useB).toHaveAttribute("aria-checked", "true");
  await expect(useB).toHaveAccessibleName("In use: B · Warm keys");
  // The circle of the take in use, pressed again by click or by Space, keeps the pick. Reached by Tab (it is the radio
  // group's Tab stop), so Space presses it rather than playing (§19.8): before Unpick had its own button, this unpicked.
  await useB.click();
  await expect(useB).toHaveAttribute("aria-checked", "true");
  await tabTo(page, useB);
  await page.keyboard.press(" ");
  await expect(useB).toHaveAttribute("aria-checked", "true");
  expect((await rushes.api("GET", "/api/picks")).lanes).toEqual({ music: "b-warm-keys" });
  // Unpick is its own button, on the take in use only.
  await expect(unpickButtons(page)).toHaveCount(1);
  await pressRowButton(page, "B · Warm keys", "Unpick");
  await expect(useB).toHaveAttribute("aria-checked", "false");
  await expect(useB).toHaveAccessibleName("Use this one: B · Warm keys");
  await expect(unpickButtons(page)).toHaveCount(0);
  expect((await rushes.api("GET", "/api/picks")).lanes).toEqual({});
  // With no pick, the first bed in manifest order plays again.
  await expect.poll(async () => (await inspect(page)).gains).toMatchObject({ "music/a-deep-house": 1, "music/b-warm-keys": 0 });
});

// ---- One definition of pending (Task 5) ----

test("marks ticked on a range hold the film, as text and the range do", async ({ page, rushes }) => {
  await rushes.addCut("hero", "Hero");
  await rushes.addCut("cutdown", "Cutdown");
  await rushes.addVariant("music", "Bed", { seconds: 2, freq: 220, video: ["Hero", "Cutdown"] });
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Music");
  await loaded(page, 1);
  await page.keyboard.press("i");
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("o");
  await page.getByRole("group", { name: "Marks" }).getByRole("button", { name: "Fall" }).click();
  await page.keyboard.press("]");
  await expect(page.getByRole("status")).toHaveText("Add or clear your note on Hero first");
  await expect(currentFilm(page)).toHaveText("Hero");
  await expect(page.getByRole("group", { name: "Marks" }).getByRole("button", { name: "Fall" })).toHaveAttribute("aria-pressed", "true");
  // Clear the range (its marks go with it) and the film can go.
  await rangeChip(page).getByRole("button", { name: "Clear range" }).click();
  await expect(page.getByRole("group", { name: "Marks" })).toHaveCount(0);
  await page.keyboard.press("]");
  await expect(currentFilm(page)).toHaveText("Cutdown");
});

test("switching tab, by 1–7 or by a click, refuses to drop a pending audio note", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.addVariant("music", "Bed", { seconds: 2, freq: 220 });
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Music");
  await loaded(page, 1);
  // Nothing pending: the tabs switch freely.
  await openReviewTab(page, "Timeline");
  await openReviewTab(page, "Music");
  await loaded(page, 1);

  // An In point is pending: the key is refused, and so is a click on a tab, Assets included.
  await page.keyboard.press("i");
  await expect(rangeChip(page)).toHaveCount(1);
  await page.keyboard.press("2");
  await expect(page.getByRole("status")).toHaveText("Add or clear your note first");
  await expect(reviewTab(page, "Music")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("8");
  await expect(reviewTab(page, "Music")).toHaveAttribute("aria-selected", "true");
  await reviewTab(page, "Effects").click();
  await expect(reviewTab(page, "Music")).toHaveAttribute("aria-selected", "true");
  await workspaceTab(page, "Assets").click();
  await expect(reviewTab(page, "Music")).toHaveAttribute("aria-selected", "true");

  // Marks and half-typed text survive the refused switch, exactly as they were.
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("o");
  await page.getByRole("group", { name: "Marks" }).getByRole("button", { name: "Fall" }).click();
  await page.keyboard.press("n");
  await page.keyboard.type("Half a thought");
  await reviewTab(page, "Timeline").click();
  await expect(page.getByRole("status")).toHaveText("Add or clear your note first");
  await expect(reviewTab(page, "Music")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: "New note" })).toHaveValue("Half a thought");
  await expect(rangeChip(page)).toHaveCount(1);
  await expect(page.getByRole("group", { name: "Marks" }).getByRole("button", { name: "Fall" })).toHaveAttribute("aria-pressed", "true");

  // Clear the note (text, mark and range), and the tab can go.
  await page.getByRole("textbox", { name: "New note" }).fill("");
  await page.getByRole("group", { name: "Marks" }).getByRole("button", { name: "Fall" }).click();
  await page.getByRole("button", { name: "Clear range" }).click();
  await reviewTab(page, "Timeline").click();
  await expect(reviewTab(page, "Timeline")).toHaveAttribute("aria-selected", "true");
});

// ---- The mix, on the timeline (Task 5 of the Mix plan; §27, 5.6: the Mix tab's rows are the Timeline tab's sound rows) ----

/**
 * A cut, two voice rounds (Round 1 · Voices: Gerald, picked; Round 2 · Gerald, tone: more sombre,
 * left unpicked -- the newest round has none, so the mix falls back to Round 1, as the server does), a
 * music bed and an SFX pass, each picked unless `pick` says false. Three files heard by default.
 */
async function mixProject(page: Page, rushes: Rushes, opts: { pick?: { voice?: boolean; music?: boolean; sfx?: boolean } } = {}) {
  await rushes.addCut();
  const read = await rushes.addVariant("voice", "Gerald", { round: "Round 1 · Voices", seconds: 4, freq: 220 });
  const read2 = await rushes.addVariant("voice", "more sombre", { round: "Round 2 · Gerald, tone", seconds: 4, freq: 240 });
  const bed = await rushes.addVariant("music", "Warm keys", { seconds: 4, freq: 330 });
  const pass = await rushes.addVariant("sfx", "Pass A", { seconds: 4, freq: 880, cues: [{ name: "Swipe", t: 1 }] });
  const lanes: Record<string, string> = {};
  if (opts.pick?.voice !== false) lanes[read.lane.id] = read.variant.id;
  if (opts.pick?.music !== false) lanes[bed.lane.id] = bed.variant.id;
  if (opts.pick?.sfx !== false) lanes[pass.lane.id] = pass.variant.id;
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes });
  return { read, read2, bed, pass };
}

/** Gerald's clip id in the mix. */
const VO_READ = "round-1-voices/gerald";
/** "more sombre"'s clip id in the mix, once Round 2 is picked. */
const VO_READ_2 = "round-2-gerald-tone/more-sombre";

/** The sound rows for the takes (not the cut's own sound). */
const soundRows = (page: Page) => page.locator(".strack:not(.csound)");

async function openMix(page: Page, rushes: Rushes, files: number) {
  // Every loudness request the page makes, in order.
  const asked: string[][] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/mix/loudness") && r.method() === "POST") asked.push(r.postDataJSON().lanes);
  });
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Timeline");
  await videoReady(page);
  await expect(soundRows(page)).toHaveCount(3);
  await loaded(page, files);
  return asked;
}

const laneGainsOf = async (page: Page) => (await inspect(page)).lanes;
/** Puts the picture (the clock the mix follows) at `t`. */
const seekPicture = (page: Page, t: number) => page.locator("video").evaluate((v: HTMLVideoElement, to: number) => { v.currentTime = to; }, t);

test("the timeline shows a row per sound; mute and solo change the lane gains, and solo wins", async ({ page, rushes }) => {
  await mixProject(page, rushes);
  const asked = await openMix(page, rushes, 3);
  await expect(soundRows(page).locator(".snm")).toHaveText(["Voice", "Music", "Effects"]);
  await expect(soundBlock(page, "Voice")).toHaveAccessibleName(/ · Gerald$/);
  await expect(soundBlock(page, "Voice")).toHaveAccessibleName("Round 1 · Voices · Gerald");
  await expect(soundBlock(page, "Music")).toHaveAccessibleName(/ · Warm keys$/);
  await expect(soundBlock(page, "Effects")).toHaveAccessibleName(/ · Pass A$/);
  await expect(soundTrack(page, "Effects").locator(".cue")).toHaveText(["Swipe"]);
  await expect.poll(() => laneGainsOf(page)).toEqual({ vo: 1, music: 1, sfx: 1 });
  expect(await heard(page)).toEqual([`${VO_READ}@0`, "music/warm-keys@0", "sfx/pass-a@0"]);
  await expect.poll(() => asked.at(-1)).toEqual(["voice", "music", "sfx"]);

  await soundButton(page, "Music", "Mute").click();
  await expect(soundButton(page, "Music", "Mute")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => laneGainsOf(page)).toEqual({ vo: 1, music: 0, sfx: 1 });
  await expect.poll(() => asked.at(-1)).toEqual(["voice", "sfx"]);

  // Solo wins: only the soloed lane plays, even when it's also muted.
  await soundButton(page, "Voice", "Solo").click();
  await expect.poll(() => laneGainsOf(page)).toEqual({ vo: 1, music: 0, sfx: 0 });
  await soundButton(page, "Voice", "Mute").click();
  await expect.poll(() => laneGainsOf(page)).toEqual({ vo: 1, music: 0, sfx: 0 });
  expect(await heard(page)).toEqual([`${VO_READ}@0`]);
  await expect.poll(() => asked.at(-1)).toEqual(["voice"]);
  await soundButton(page, "Effects", "Solo").click();
  await expect.poll(() => laneGainsOf(page)).toEqual({ vo: 1, music: 0, sfx: 1 });
  // With no solo left, mute applies again.
  await soundButton(page, "Voice", "Solo").click();
  await soundButton(page, "Effects", "Solo").click();
  await expect.poll(() => laneGainsOf(page)).toEqual({ vo: 0, music: 0, sfx: 1 });

  // View state only: nothing is saved. A trip to another Review tab keeps it for the film (final review I3: one
  // timeline, whose tabs are views of it); a fresh page starts with none.
  const picks = await rushes.api("GET", "/api/picks");
  // (`use` is the take in use per sound and `takes` each take's state, §27.6: worked out by the server, not mute or solo.)
  expect(Object.keys(picks).sort()).toEqual(["lanes", "levels", "rev", "schema", "sections", "takes", "use", "videos"]);
  await page.keyboard.press("4");
  await openReviewTab(page, "Timeline");
  await loaded(page, 3);
  await expect(page.locator('.ms[aria-pressed="true"]')).toHaveCount(2);
  await expect.poll(() => laneGainsOf(page)).toEqual({ vo: 0, music: 0, sfx: 1 });
  await page.reload();
  await openReviewTab(page, "Timeline");
  await loaded(page, 3);
  await expect(page.locator('.ms[aria-pressed="true"]')).toHaveCount(0);
  await expect.poll(() => laneGainsOf(page)).toEqual({ vo: 1, music: 1, sfx: 1 });
});

test("the loudness readout shows the three values (or — without ffmpeg), and a quiet mark while measuring", async ({ page, rushes }) => {
  await mixProject(page, rushes);
  // The same request the readout makes, so the test knows whether this server has ffmpeg.
  const direct = await rushes.api("POST", "/api/mix/loudness", { lanes: ["voice", "music", "sfx"] });
  await openMix(page, rushes, 3);
  const values = loudness(page).locator("[data-value]");
  await expect(loudness(page).locator(".lcell > span")).toHaveText(["LUFS", "dBTP", "under VO"]);
  await expect(page.locator("[data-measuring]")).toHaveCount(0, { timeout: 15_000 });
  if (direct.available) {
    // Shape, not numbers: a signed level with one decimal, and music under VO in whole dB.
    await expect(values.nth(0)).toHaveText(/^[−+]?\d+\.\d$/);
    await expect(values.nth(1)).toHaveText(/^[−+]?\d+\.\d$/);
    await expect(values.nth(2)).toHaveText(/^[−+]?\d+ dB$/);
    for (let i = 0; i < 3; i++) await expect(values.nth(i)).not.toHaveAttribute("data-tip");
  } else {
    await expect(values).toHaveText(["—", "—", "—"]);
    for (let i = 0; i < 3; i++) await expect(values.nth(i)).toHaveAttribute("data-tip", "Install ffmpeg for loudness");
  }
  // A change re-measures after the debounce, showing the quiet mark meanwhile.
  await soundButton(page, "Music", "Mute").click();
  await expect(page.locator("[data-measuring]")).toBeVisible();
  await expect(page.locator("[data-measuring]")).toHaveAttribute("data-tip", "Measuring");
  await expect(page.locator("[data-measuring]")).toHaveCount(0, { timeout: 15_000 });
  if (direct.available) {
    // No music in the mix: nothing to compare the VO with.
    await expect(values.nth(2)).toHaveText("—");
    await expect(values.nth(2)).toHaveAttribute("data-tip", "Needs Voiceover and Music both playing");
  }
  // With every lane muted there's nothing to measure, whether or not there's ffmpeg.
  await soundButton(page, "Voice", "Mute").click();
  await soundButton(page, "Effects", "Mute").click();
  await expect(values).toHaveText(["—", "—", "—"]);
  for (let i = 0; i < 3; i++) await expect(values.nth(i)).toHaveAttribute("data-tip", "Nothing to measure");
  await expect(page.locator("[data-measuring]")).toHaveCount(0);
});

/** Answers every loudness request from the page with `reply()`, counting them. Never reaches ffmpeg. */
async function fakeLoudness(page: Page, reply: () => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>) {
  const seen = { count: 0 };
  await page.route("**/api/mix/loudness", async (route) => {
    seen.count++;
    const r = await reply();
    await route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.body) });
  });
  return seen;
}
const READING = { available: true, integrated: -16.2, truePeak: -1.5, musicUnderVo: -18, silent: false };

test("a timed-out reading says so, and a click on the readout measures again", async ({ page, rushes }) => {
  await mixProject(page, rushes);
  let status = 504;
  const seen = await fakeLoudness(page, () =>
    status === 504 ? { status, body: { error: "loudness_timeout", message: "ffmpeg didn't finish" } } : { status, body: READING },
  );
  await openMix(page, rushes, 3);
  const meter = loudness(page);
  const values = meter.locator("[data-value]");
  await expect(values.first()).toHaveAttribute("data-tip", "Measuring took too long · click to retry");
  await expect(values).toHaveText(["—", "—", "—"]);
  const before = seen.count;
  // Nothing changed, but the server never caches a timeout: a click asks again.
  status = 200;
  await meter.getByRole("button", { name: "Measure again" }).click();
  await expect(values).toHaveText(["−16.2", "−1.5", "−18 dB"]);
  expect(seen.count).toBe(before + 1);
  await expect(meter.getByRole("button", { name: "Measure again" })).toHaveCount(0);
});

test("a burst of mute and solo inside the debounce makes exactly one loudness request", async ({ page, rushes }) => {
  await mixProject(page, rushes);
  const seen = await fakeLoudness(page, () => ({ status: 200, body: READING }));
  await openMix(page, rushes, 3);
  await expect(loudness(page).locator("[data-value]").first()).toHaveText("−16.2");
  const start = seen.count;
  // Four changes, well inside the 500 ms window.
  await page.evaluate(() => {
    for (const name of ["Mute Music", "Solo Effects", "Mute Music", "Solo Effects", "Mute Voice"]) {
      document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!.click();
    }
  });
  await expect(soundButton(page, "Voice", "Mute")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-measuring]")).toHaveCount(0, { timeout: 5_000 });
  await page.waitForTimeout(800);
  expect(seen.count - start).toBe(1);
});

test("unmuting after 'Nothing to measure' drops that reason while the new reading is on its way", async ({ page, rushes }) => {
  await mixProject(page, rushes);
  let release!: () => void;
  let held: Promise<void> = Promise.resolve();
  await fakeLoudness(page, async () => {
    await held;
    return { status: 200, body: READING };
  });
  await openMix(page, rushes, 3);
  const values = loudness(page).locator("[data-value]");
  await expect(values.first()).toHaveText("−16.2");
  for (const sound of ["Voice", "Music", "Effects"] as const) await soundButton(page, sound, "Mute").click();
  await expect(values.first()).toHaveAttribute("data-tip", "Nothing to measure");
  // Hold the next reading back: until it lands, the readout must not still claim there's nothing to measure.
  held = new Promise((ok) => (release = ok));
  await soundButton(page, "Music", "Mute").click();
  await expect(values.first()).not.toHaveAttribute("data-tip", "Nothing to measure");
  await expect(page.locator("[data-measuring]")).toBeVisible();
  release();
  await expect(values.first()).toHaveText("−16.2");
});

test("a sound with nothing in use, or a missing file, is empty and left out of the loudness request", async ({ page, rushes }) => {
  const { pass } = await mixProject(page, rushes, { pick: { music: false } });
  await rm(join(rushes.root, (await rushes.api("GET", "/api/state")).project.lanes.find((l: { id: string }) => l.id === pass.lane.id).variants[0].file));
  const asked = await openMix(page, rushes, 1);
  await expect(soundBlock(page, "Music")).toHaveText("Nothing chosen yet");
  await expect(soundBlock(page, "Effects")).toHaveText("File not found");
  for (const name of ["Music", "Effects"] as const) await expectReadableInRow(soundBlock(page, name).locator(".slbl"), soundTrack(page, name));
  await expect(soundBlock(page, "Voice")).toHaveAccessibleName(/ · Gerald$/);
  expect(await heard(page)).toEqual([`${VO_READ}@0`]);
  await expect.poll(() => asked.at(-1)).toEqual(["voice"]);
  // Soloing a sound that plays nothing leaves nothing to measure.
  await soundButton(page, "Effects", "Solo").click();
  await expect(loudness(page).locator("[data-value]").first()).toHaveAttribute("data-tip", "Nothing to measure");
});

test("the Voice row plays the read in use, matching the server (§18.4, §27.6)", async ({ page, rushes }) => {
  const { read, read2 } = await mixProject(page, rushes);
  const asked = await openMix(page, rushes, 3);
  // Round 1 is picked, Round 2 isn't: the mix falls back to the older round, the newest with a pick.
  await expect(soundBlock(page, "Voice")).toHaveAccessibleName("Round 1 · Voices · Gerald");
  expect(await heard(page)).toEqual([`${VO_READ}@0`, "music/warm-keys@0", "sfx/pass-a@0"]);

  // Picking Round 2's "more sombre" makes it the read in use: it takes over, and the mix changed, so the loudness
  // readout asks again.
  const before = asked.length;
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [read2.lane.id]: read2.variant.id } });
  await expect(soundBlock(page, "Voice")).toHaveAccessibleName("Round 2 · Gerald, tone · more sombre");
  await expect.poll(() => heard(page)).toEqual([`${VO_READ_2}@0`, "music/warm-keys@0", "sfx/pass-a@0"]);
  await expect.poll(() => asked.length).toBeGreaterThan(before);

  // With no pick left in either round, the Voice row says nothing is chosen again.
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [read.lane.id]: null, [read2.lane.id]: null } });
  await expect(soundBlock(page, "Voice")).toHaveText("Nothing chosen yet");
  await expect.poll(() => heard(page)).toEqual(["music/warm-keys@0", "sfx/pass-a@0"]);
});

test("Mix notes: one saved on Music with Quieter 3 dB is listed and spans its row; the whole mix is a menu away, and a sound row is never the target (Red, round 2)", async ({ page, rushes }) => {
  const { bed } = await mixProject(page, rushes);
  // One the Mix tab saved on Music, before the desk: still listed with what it is on and its marks, and drawn on its row.
  const old = (await rushes.api("POST", "/api/notes", { stage: "mix", video: "hero", on: `${bed.lane.id}/${bed.variant.id}`, scope: "range", t: 0.5, tOut: 1, marks: [{ kind: "quieter", db: 3 }], text: "Music creeps up under the line." })).note;
  await openMix(page, rushes, 3);
  await expect(page.locator(`.note[data-note="${old.id}"] .on`)).toHaveText("Music · Warm keys");
  await expect(page.locator(`.note[data-note="${old.id}"] .nmarks`)).toHaveText("Quieter 3 dB");
  await expect(soundTrack(page, "Music").locator(`.span[data-note="${old.id}"]`)).toHaveCount(1);

  // The row's name is not a button: a take is noted on its own tab.
  await expect(soundTrack(page, "Music").getByRole("button", { name: /note on the whole take/ })).toHaveCount(0);
  // The menu offers the whole mix, which is saved as a whole-mix note is.
  await noteTargetMenu(page).selectOption({ label: "The whole mix" });
  await page.getByRole("textbox", { name: "New note" }).click();
  await page.keyboard.type("A touch quiet overall.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(2);
  const whole = (await rushes.api("GET", "/api/notes?stage=mix")).notes.find((n: { text: string }) => n.text === "A touch quiet overall.");
  expect(whole).toMatchObject({ on: null, scope: "whole", t: null, marks: [] });
  await expect(page.locator(`.note[data-note="${whole.id}"] .on`)).toHaveText("Whole mix");
  // This frame again: Enter adds a picture note.
  await noteTargetMenu(page).selectOption({ label: "This frame" });
  await page.getByRole("textbox", { name: "New note" }).click();
  await page.keyboard.type("Frame is soft.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(3);
  expect((await rushes.api("GET", "/api/notes?stage=picture")).notes).toHaveLength(1);
  // Each note with a time is a marker on the ruler, with the picture's: the old Mix-tab note and the picture note (the
  // whole-mix note has no time).
  await expect(rulerMarkers(page)).toHaveCount(2);
  await expect(rulerMarkers(page).and(page.locator(`[data-note="${old.id}"]`))).toHaveCount(1);
});

test("a Mix note on an SFX pass named like the music bed is marked on the Effects row, and an old bare id on Music", async ({ page, rushes }) => {
  await rushes.addCut();
  const bed = await rushes.addVariant("music", "Option A", { seconds: 4, freq: 330 });
  const pass = await rushes.addVariant("sfx", "Option A", { seconds: 4, freq: 880 });
  expect(bed.variant.id).toBe(pass.variant.id); // the clash: both "option-a"
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [bed.lane.id]: bed.variant.id, [pass.lane.id]: pass.variant.id } });
  // A note saved before `on` was lane-qualified: on Music, the first lane heard with that id.
  const old = (await rushes.api("POST", "/api/notes", { stage: "mix", on: "option-a", scope: "point", t: 1, text: "Old style." })).note;
  // One the Mix tab saved on the pass, lane-qualified.
  const mixed = (await rushes.api("POST", "/api/notes", { stage: "mix", video: "hero", on: "sfx/option-a", scope: "point", t: 3, text: "Mix tab's note." })).note;
  await page.goto(rushes.testUrl());
  await videoReady(page);
  await loaded(page, 2);
  await expect(page.locator(`.note[data-note="${old.id}"] .on`)).toHaveText("Music · Option A");
  await expect(soundTrack(page, "Music").locator(`.mk[data-note="${old.id}"]`)).toHaveCount(1);
  await expect(page.locator(`.note[data-note="${mixed.id}"] .on`)).toHaveText("Sound effects · Option A");
  await expect(soundTrack(page, "Effects").locator(`.mk[data-note="${mixed.id}"]`)).toHaveCount(1);
  // A note on the pass, written on its own tab (here through the API): marked on the Effects row, not on Music's.
  const added = (await rushes.api("POST", "/api/notes", { stage: "sfx", video: "hero", on: `${pass.lane.id}/${pass.variant.id}`, scope: "point", t: 2, text: "Too loud here." })).note;
  await expect(page.locator(`.note[data-note="${added.id}"] .on`)).toHaveText("Effects · Option A");
  await expect(soundTrack(page, "Effects").locator(`.mk[data-note="${added.id}"]`)).toHaveCount(1);
  await expect(soundTrack(page, "Music").locator(`.mk[data-note="${added.id}"]`)).toHaveCount(0);
});

// ---- Levels (§19.6, Plan 4 Task 2) ----

/** Drags a level slider to `db` by setting its value and firing the same `input` event a real drag fires. */
async function dragLevel(page: Page, label: string, db: number) {
  await page.locator(`input[aria-label="${label}"]`).evaluate((el: HTMLInputElement, v: number) => {
    el.value = String(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, db);
}

/** A sound row's level, as it reads in dB. */
const levelDb = (page: Page, sound: "Voice" | "Music" | "Effects") => soundTrack(page, sound).locator(".db");

test("a level: drags live, saves on reload, resets on double-click, and re-measures loudness", async ({ page, rushes }) => {
  await mixProject(page, rushes);
  const asked = await openMix(page, rushes, 3);
  const musicDb = levelDb(page, "Music");
  await expect(musicDb).toHaveText("0.0 dB");

  // Dragging to −14 is heard immediately through the engine, at roughly 10^(-14/20).
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/picks") && r.request().method() === "PUT" && r.request().postDataJSON()?.levels?.music === -14);
  await dragLevel(page, "Music level", -14);
  await expect(musicDb).toHaveText("−14.0 dB");
  await expect.poll(async () => (await inspect(page)).lanes.music).toBeCloseTo(0.1995, 3);

  // The loudness readout re-measures once the level is saved (debounced), not on every tick.
  const before = asked.length;
  await expect.poll(() => asked.length, { timeout: 10_000 }).toBeGreaterThan(before);

  // It survives a reload: saved with the picks. The reload waits for the debounced save to land,
  // so it tests the saved value rather than racing the 300 ms debounce.
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await openReviewTab(page, "Timeline");
  await loaded(page, 3);
  await expect(levelDb(page, "Music")).toHaveText("−14.0 dB");
  const picks = await rushes.api("GET", "/api/picks?video=hero");
  expect(picks.levels).toEqual({ music: -14 });

  // Double-click resets it to 0, live and saved.
  await page.locator('input[aria-label="Music level"]').dblclick();
  await expect(levelDb(page, "Music")).toHaveText("0.0 dB");
  await expect.poll(async () => (await inspect(page)).lanes.music).toBeCloseTo(1, 3);
  await expect.poll(async () => (await rushes.api("GET", "/api/picks?video=hero")).levels).toEqual({});
});

test("Balance sets music and effects against the voice, and shows pressed until a fader is moved (§29)", async ({ page, rushes }) => {
  await mixProject(page, rushes);
  await openMix(page, rushes, 3);
  const button = loudness(page).getByRole("button", { name: "Balance" });
  await expect(button).toHaveAttribute("aria-pressed", "false");

  const answered = page.waitForResponse((r) => r.url().endsWith("/api/mix/balance"));
  await button.click();
  const reply = await (await answered).json();
  expect(reply.available).toBe(true);
  // What it did is said, and the faders show the levels it set.
  await expect(page.getByText(reply.summary)).toBeVisible();
  const picks = await rushes.api("GET", "/api/picks?video=hero");
  expect(picks.balanced.levels).toEqual(picks.levels);
  const shown = (db: number | undefined) => `${(db ?? 0) < 0 ? "\u2212" : (db ?? 0) > 0 ? "+" : ""}${Math.abs(db ?? 0).toFixed(1)} dB`;
  await expect(levelDb(page, "Music")).toHaveText(shown(reply.levels.music));
  await expect(button).toHaveAttribute("aria-pressed", "true");

  // Moving a fader by hand makes the levels yours: the button lets go.
  await dragLevel(page, "Music level", -14);
  await expect.poll(async () => (await rushes.api("GET", "/api/picks?video=hero")).levels.music).toBe(-14);
  await expect(button).toHaveAttribute("aria-pressed", "false");
});

for (const how of ["hidden", "pagehide"] as const) {
  test(`a level changed and the page ${how === "hidden" ? "hidden" : "left"} within 300 ms is still saved, once`, async ({ page, rushes }) => {
    await mixProject(page, rushes);
    await openMix(page, rushes, 3);
    await expect(levelDb(page, "Music")).toHaveText("0.0 dB");
    const puts: unknown[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/picks") && r.method() === "PUT") puts.push(r.postDataJSON());
    });
    // The drag and the page going away happen in one step, well inside the 300 ms debounce, and
    // the page is closed straight after: only a save sent at that moment can reach the server.
    await page.locator('input[aria-label="Music level"]').evaluate((el: HTMLInputElement, h: string) => {
      el.value = "-9";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      if (h === "hidden") {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      } else {
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
      }
    }, how);
    await page.close();
    await expect.poll(async () => (await rushes.api("GET", "/api/picks?video=hero")).levels, { timeout: 5_000 }).toEqual({ music: -9 });
    // Sent once: the hide took the pending save, so no timer or unmount sent it again.
    expect(puts).toEqual([{ video: "hero", levels: { music: -9 } }]);
  });
}

test("a refresh from elsewhere never snaps a slider you're mid-drag on (regression)", async ({ page, rushes }) => {
  await mixProject(page, rushes);
  await openMix(page, rushes, 3);
  const musicDb = levelDb(page, "Music");
  const sfxDb = levelDb(page, "Effects");
  await expect(musicDb).toHaveText("0.0 dB");
  await expect(sfxDb).toHaveText("0.0 dB");

  // Hold music's own debounced save back (it would otherwise land and self-correct any wrong
  // resync within the same 300 ms window this test needs to inspect), so the race is deterministic.
  let releaseMusicSave!: () => void;
  const held = new Promise<void>((ok) => (releaseMusicSave = ok));
  await page.route("**/api/picks", async (route) => {
    const req = route.request();
    let body: { levels?: { music?: unknown } } | null = null;
    try {
      body = req.method() === "PUT" ? req.postDataJSON() : null;
    } catch {
      body = null;
    }
    if (body?.levels?.music !== undefined) await held;
    await route.continue();
  });

  // Start dragging music -- its save is debounced 300 ms, and now held back besides.
  await dragLevel(page, "Music level", -14);
  await expect(musicDb).toHaveText("−14.0 dB");

  // Meanwhile, sfx's level changes from elsewhere (another tab, or the agent) -- a direct server
  // call, bypassing the held route above. The server emits a change event, and this tab's own SSE
  // listener refreshes state while music's save is still held pending.
  await rushes.api("PUT", "/api/picks", { video: "hero", levels: { sfx: -6 } });
  await expect(sfxDb).toHaveText("−6.0 dB");

  // Music's own in-progress drag must survive that refresh, not snap back to the stale server value.
  await expect(musicDb).toHaveText("−14.0 dB");

  // Release the held save: it lands with the dragged value, alongside sfx's.
  releaseMusicSave();
  await expect.poll(async () => (await rushes.api("GET", "/api/picks?video=hero")).levels).toEqual({ sfx: -6, music: -14 });
});

test("a burst of dragging inside the debounce window saves once, at the last value", async ({ page, rushes }) => {
  await mixProject(page, rushes);
  await openMix(page, rushes, 3);
  const calls: unknown[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/picks") && r.method() === "PUT") calls.push(r.postDataJSON());
  });
  // Four changes, well inside the 300 ms debounce window (one evaluate, so nothing can land between them).
  await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>('input[aria-label="Music level"]')!;
    for (const v of [-2, -6, -10, -14]) {
      el.value = String(v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await expect(levelDb(page, "Music")).toHaveText("−14.0 dB");
  await page.waitForTimeout(600);
  const levelCalls = calls.filter((c): c is { levels?: { music?: number } } => !!(c as { levels?: unknown }).levels);
  expect(levelCalls).toEqual([{ video: "hero", levels: { music: -14 } }]);
});

test("a level dragged just before leaving the timeline is still saved (Minor 6)", async ({ page, rushes }) => {
  await mixProject(page, rushes);
  await openMix(page, rushes, 3);
  // Drag, then press 1 (Planning, which opens Script) straight away, inside the 300 ms debounce: leaving the tab unmounts it.
  await dragLevel(page, "Music level", -14);
  await page.keyboard.press("1");
  await expect(workspaceTab(page, "Plan")).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await rushes.api("GET", "/api/picks?video=hero")).levels).toEqual({ music: -14 });
  await openReviewTab(page, "Timeline");
  await expect(levelDb(page, "Music")).toHaveText("−14.0 dB");
});

test("a level slider tells a screen reader its value in dB (Minor 7)", async ({ page, rushes }) => {
  await mixProject(page, rushes);
  await openMix(page, rushes, 3);
  const slider = page.locator('input[aria-label="Music level"]');
  await expect(slider).toHaveAttribute("aria-valuetext", "0.0 dB");
  await dragLevel(page, "Music level", -14);
  await expect(slider).toHaveAttribute("aria-valuetext", "−14.0 dB");
});

test("leaving the timeline stops the mix and releases its engine", async ({ page, rushes }) => {
  await mixProject(page, rushes);
  await openMix(page, rushes, 3);
  await page.keyboard.press(" ");
  await expect.poll(async () => (await inspect(page)).playing).toBe(true);
  await page.evaluate(() => { (window as unknown as { __old: unknown }).__old = window.__rushesAudio!.engine; });
  await page.keyboard.press("4");
  await expect(reviewTab(page, "Music")).toHaveAttribute("aria-selected", "true");
  // The Music tab plays the bed alone (round 1: a sound's tab is that sound only): one file.
  await loaded(page, 1);
  const old = await page.evaluate(() => {
    const e = (window as unknown as { __old: { playing: boolean; inspect(): Snapshot } }).__old;
    return { playing: e.playing, sources: e.inspect().sources, live: window.__rushesAudio!.liveContexts() };
  });
  expect(old).toEqual({ playing: false, sources: 0, live: 1 });
  expect(await page.evaluate(() => window.__rushesAudio!.engine!.playing)).toBe(false);
});

// ---- Follow-ups (§19.8) ----

/** Move focus by keyboard, Tab by Tab, until `target` has it. WebKit, like Safari, skips buttons
 *  on Tab unless Option is held. */
async function tabTo(page: Page, target: ReturnType<Page["locator"]>) {
  const key = test.info().project.name === "webkit" ? "Alt+Tab" : "Tab";
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press(key);
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error("Tab never reached the button");
}

/** Space toggles playback: it plays when paused and pauses when playing. */
async function spaceToggles(page: Page) {
  const was = (await inspect(page)).playing;
  await page.keyboard.press(" ");
  await expect.poll(async () => (await inspect(page)).playing).toBe(!was);
}

test("re-rendering the only clip mid-play keeps playing: its lane rejoins on the clock once decoded (§19.8)", async ({ page, rushes }) => {
  const bed = await rushes.addVariant("music", "A · Deep house", { seconds: 30, freq: 220 });
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Music");
  await loaded(page, 1);
  const [first] = (await inspect(page)).media;
  // Counts every time the engine stops from here on.
  await page.evaluate(() => {
    const e = window.__rushesAudio!.engine as unknown as { playing: boolean; onChange(cb: () => void): void };
    const w = window as unknown as { __stops: number };
    w.__stops = 0;
    e.onChange(() => { if (!e.playing) w.__stops++; });
  });
  await page.keyboard.press(" ");
  await expect.poll(async () => (await inspect(page)).time).toBeGreaterThan(0.5);
  const before = await inspect(page);
  const [id] = Object.keys(before.voices);
  // The engine's time and the audio context's own clock, read together, with the wall clock beside them.
  const clock = () =>
    page.evaluate(() => {
      const engine = window.__rushesAudio!.engine as unknown as { time: number; ctx: { currentTime: number } };
      return { t: engine.time, ctx: engine.ctx.currentTime, wall: performance.now() / 1000 };
    });
  const t0 = await clock();

  // The agent renders the file again in place: a new sound and a newer modified time. The next
  // thing it writes tells the page, whose assets come back with the new revision.
  const abs = join(rushes.root, (bed.variant as unknown as { file: string }).file);
  await writeFile(abs, makeWav({ seconds: 30, freq: 440 }));
  const later = new Date(Date.now() + 5000);
  await utimes(abs, later, later);
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [bed.lane.id]: bed.variant.id } });
  await expect.poll(async () => { const m = (await inspect(page)).media; return m.length === 1 && m[0] !== first; }, { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await inspect(page)).sources).toBe(1);

  const after = await inspect(page);
  expect(after.playing).toBe(true);
  expect(after.voices[id]).toBeGreaterThan(before.voices[id]);
  expect(await page.evaluate(() => (window as unknown as { __stops: number }).__stops)).toBe(0);
  // The clock ran on through the swap, so the new file joined where the old one would have been.
  // The engine's time is startOffset + (ctx.currentTime - startedAt), so across the swap it moves
  // exactly with the context's own clock unless the swap reset its origin (a stop, then a restart
  // from where it stood when the decode began). Held against the wall clock instead, this only
  // measured how far the audio clock drifts from it on a busy runner: 0.173 s once, in WebKit on CI.
  const t1 = await clock();
  expect(Math.abs(t1.t - t0.t - (t1.ctx - t0.ctx))).toBeLessThan(0.02);
  // And it is running, not stalled: against the wall clock that only needs to be roughly in step.
  expect(t1.t - t0.t).toBeGreaterThan(0.5 * (t1.wall - t0.wall));
});

test("Space on a focused button presses it instead of playing: Measure again on the timeline (§19.8)", async ({ page, rushes }) => {
  await mixProject(page, rushes);
  let status = 504;
  const seen = await fakeLoudness(page, () =>
    status === 504 ? { status, body: { error: "loudness_timeout", message: "ffmpeg didn't finish" } } : { status, body: READING },
  );
  await openMix(page, rushes, 3);
  const meter = loudness(page);
  const values = meter.locator("[data-value]");
  await expect(values.first()).toHaveAttribute("data-tip", "Measuring took too long · click to retry");
  const again = meter.getByRole("button", { name: "Measure again" });
  await expect(again).toBeVisible();
  const before = seen.count;
  status = 200;
  // Reached by keyboard, the button owns Space.
  await tabTo(page, again);
  await page.keyboard.press(" ");
  await expect(values).toHaveText(["−16.2", "−1.5", "−18 dB"]);
  expect(seen.count).toBe(before + 1);
  expect((await inspect(page)).playing).toBe(false);

  // A sound row's control is part of the player: with M clicked, Space still plays. So it does from the page.
  await soundButton(page, "Music", "Mute").click();
  await page.keyboard.press(" ");
  await expect.poll(async () => (await inspect(page)).playing).toBe(true);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(" ");
  await expect.poll(async () => (await inspect(page)).playing).toBe(false);
});

test("Space on a focused button presses it on Voiceover too: Blind, not Play (§19.8)", async ({ page, rushes }) => {
  await twoRounds(rushes);
  await openVoice(page, rushes, 5);
  const blind = page.getByRole("button", { name: "Blind" });
  await tabTo(page, blind);
  await page.keyboard.press(" ");
  await expect(blind).toHaveAttribute("aria-pressed", "true");
  expect((await inspect(page)).playing).toBe(false);
});

test("Space plays after a mouse click on a tab, M, S, Blind or a scope chip (§19.8)", async ({ page, rushes }) => {
  await mixProject(page, rushes);
  await page.goto(rushes.testUrl());
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  await openReviewTab(page, "Timeline");
  await loaded(page, 3);
  await spaceToggles(page);
  await spaceToggles(page);
  await button("Mute Music").click();
  await spaceToggles(page);
  await button("Solo Voice").click();
  await spaceToggles(page);

  await openReviewTab(page, "Music");
  // The bed alone (round 1: a sound's tab is that sound only).
  await loaded(page, 1);
  await spaceToggles(page);
  await button("Blind").click();
  await expect(button("Blind")).toHaveAttribute("aria-pressed", "true");
  await spaceToggles(page);
  // A take picked as the note's target, then let go of by the target line's own button.
  await takeRows(page).first().locator(".knm").click();
  await clearTarget(page).click();
  await spaceToggles(page);
});

test("a take on another film whose name is cut off shows it in full as a tooltip, as does its fold line", async ({ page, rushes }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await rushes.addCut("f2a", "F2A");
  await rushes.addCut("f3a", "F3A");
  const LONG_READ = "Gerald, slower and warmer, with the long pause kept";
  await rushes.addVariant("voice", LONG_READ, { seconds: 4, freq: 300, round: "Round 1", video: "F2A" });
  await rushes.addVariant("voice", "F3A read", { seconds: 4, freq: 320, round: "Round 2", video: "F3A" });
  await page.goto(rushes.url);
  await pickFilm(page, "F3A");
  await openReviewTab(page, "Voice");
  const fold = takesList(page).locator('.kfold[data-fold="loose"] .khd');
  await expect(fold).toContainText("Not on this film · 1 read");
  if (await fold.evaluate((el) => el.scrollWidth > el.clientWidth)) await expect(fold).toHaveAttribute("data-tip", /^Not on this film · 1 read/);
  await foldToggle(page, "Not on this film").click();
  const name = takesList(page).locator(".take.loose .knm");
  await expect(name).toHaveCount(1);
  expect(await name.locator("[data-name]").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await expect(name).toHaveAttribute("data-tip", `Round 1 · ${LONG_READ}`);
});

test("Sound effects and Music list only the film you are on, with its own notes", async ({ page, rushes }) => {
  await rushes.addCut("f2a", "F2A");
  await rushes.addCut("f3a", "F3A");
  await rushes.addVariant("sfx", "F2A pass", { seconds: 4, freq: 330, video: "F2A" });
  await rushes.addVariant("sfx", "F3A pass 1", { seconds: 4, freq: 440, video: "F3A" });
  await rushes.addVariant("sfx", "F3A pass 2", { seconds: 4, freq: 550, video: "F3A" });
  await rushes.addVariant("music", "F2A bed", { seconds: 4, freq: 220, video: "F2A" });
  await rushes.addVariant("music", "Any film bed", { seconds: 4, freq: 260, video: ["F2A", "F3A"] });
  await rushes.addVariant("voice", "F2A read", { seconds: 4, freq: 300, round: "Round 1", video: "F2A" });
  await rushes.api("POST", "/api/notes", { stage: "sfx", video: "f2a", scope: "whole", text: "F2A taps are too loud." });
  await page.goto(rushes.url);
  const names = takeRows(page).locator("[data-name]");
  await openReviewTab(page, "Effects");
  await pickFilm(page, "F3A");
  await expect(currentFilm(page)).toHaveText("F3A");
  await expect(names).toHaveText(["F3A pass 1", "F3A pass 2"]);
  await expect(page.locator(".note", { hasText: "F2A taps are too loud." })).toHaveCount(0);
  await pickFilm(page, "F2A");
  await expect(names).toHaveText(["F2A pass"]);
  await expect(page.locator(".note", { hasText: "F2A taps are too loud." })).toHaveCount(1);
  // A bed on both films is listed on each.
  await openReviewTab(page, "Music");
  await expect(names).toHaveText(["F2A bed", "Any film bed"]);
  await pickFilm(page, "F3A");
  await expect(names).toHaveText(["Any film bed"]);
  // §31.5: F2A's read is all there is, and it is F2A's: on F3A the Voice tab stays locked (each film's tabs unlock on
  // its own material), and on F2A it lists the read.
  await expect(reviewTab(page, "Voice")).toHaveAttribute("data-locked", "true");
  await pickFilm(page, "F2A");
  await expect(reviewTab(page, "Voice")).not.toHaveAttribute("data-locked", "true");
  await openReviewTab(page, "Voice");
  await expect(names).toHaveText(["F2A read"]);
});

// ---- Red's round 1 (the sound tabs): the picture is a small preview above the notes panel, the takes area has the rest
// of the column, no words over a waveform (the details are on the name and a details line), and Voice takes a range. ----

/** A cut, a read with a description, a bed with BPM and key, and an effects pass with cues: one of each sound. */
async function oneOfEach(rushes: Rushes) {
  await rushes.addCut();
  await rushes.addVariant("voice", "Alice · natural", { round: "Round 1", seconds: 4, freq: 220, meta: { description: "Warm, conversational, a touch slower in the middle" } });
  await rushes.addVariant("voice", "Gerald · bright", { round: "Round 1", seconds: 4, freq: 262, meta: { description: "Bright, upbeat" } });
  await rushes.addVariant("music", "Warm pad", { seconds: 4, freq: 330, meta: { description: "Soft keys, no drums", bpm: 96, key: "D major" } });
  await rushes.addVariant("sfx", "Pass A", { seconds: 4, freq: 440, meta: { description: "Subtle" }, cues: [{ name: "Swipe", t: 1 }, { name: "Tap", t: 2.5 }] });
}

const column = (page: Page) => page.locator(".soundtab");
const takesPanel = (page: Page) => page.locator(".soundtab .takespanel");
const rightColumn = (page: Page) => page.locator(".soundside");

for (const tab of ["Voice", "Music", "Effects"] as const) {
  test(`${tab}: the preview sits in the right column above the notes panel, and the takes area has the rest of the left column`, async ({ page, rushes }) => {
    await oneOfEach(rushes);
    await page.goto(rushes.testUrl());
    await openReviewTab(page, tab);
    await loaded(page, tab === "Voice" ? 2 : 1);
    const preview = monitor(page);
    await expect(preview.locator("video")).toBeVisible();
    // The preview is inside the right column, above the notes panel, and as wide as it.
    const pv = (await preview.boundingBox())!;
    const side = (await rightColumn(page).boundingBox())!;
    const panel = (await notesPanel(page).boundingBox())!;
    expect(pv.x).toBeGreaterThanOrEqual(side.x - 0.5);
    expect(pv.x + pv.width).toBeLessThanOrEqual(side.x + side.width + 0.5);
    expect(pv.y).toBeGreaterThanOrEqual(side.y - 0.5);
    expect(pv.y + pv.height).toBeLessThanOrEqual(panel.y + 0.5);
    expect(Math.abs(pv.x + pv.width - (panel.x + panel.width))).toBeLessThanOrEqual(1);
    // At the cut's own shape (16:9), full width of the column.
    expect(Math.abs(pv.width / pv.height - 16 / 9)).toBeLessThan(0.03);
    // Nothing of the picture is left in the left column: the transport is at its top, then the tool strip beside the
    // takes area, which runs to the column's foot. No divider to drag.
    const col = (await column(page).boundingBox())!;
    expect(pv.x).toBeGreaterThanOrEqual(col.x + col.width);
    const tr = (await transport(page).boundingBox())!;
    expect(tr.y - col.y).toBeLessThanOrEqual(2);
    const takes = (await takesPanel(page).boundingBox())!;
    const strip = (await page.getByRole("toolbar", { name: "Tools" }).boundingBox())!;
    expect(takes.y).toBeGreaterThanOrEqual(tr.y + tr.height - 1);
    expect(col.y + col.height - (takes.y + takes.height)).toBeLessThanOrEqual(2);
    expect(Math.abs(strip.y - takes.y)).toBeLessThanOrEqual(1);
    expect(strip.x + strip.width).toBeLessThanOrEqual(takes.x + 0.5);
    expect(strip.x - col.x).toBeLessThanOrEqual(2);
    // Taller than before: the timeline panel was capped at 55% of the column under the monitor.
    expect(takes.height).toBeGreaterThan(col.height * 0.8);
    await expect(page.getByRole("separator", { name: "Resize the timeline" })).toHaveCount(0);
    // The full-screen button is on the preview, with its frame and shot readout.
    await expect(preview.getByRole("button", { name: "Full screen · F" })).toBeVisible();
    await expect(preview.locator(".tcover")).toHaveText(/^f0/);
    await expect(transport(page).getByRole("button", { name: "Full screen · F" })).toHaveCount(0);
  });
}

test("hiding the notes panel leaves the preview alone in the right column, at the same width; a click on it plays", async ({ page, rushes }) => {
  await oneOfEach(rushes);
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Music");
  await loaded(page, 1);
  const before = (await monitor(page).boundingBox())!;
  const takesBefore = (await takesPanel(page).boundingBox())!;
  await panelToggle(page).click();
  await expect(notesPanel(page)).toBeHidden();
  const after = (await monitor(page).boundingBox())!;
  expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  expect(Math.abs((await takesPanel(page).boundingBox())!.width - takesBefore.width)).toBeLessThanOrEqual(1);
  // A click on the preview plays and pauses, on the one clock.
  await monitor(page).locator("video").click();
  await expect.poll(async () => (await inspect(page)).playing).toBe(true);
  await monitor(page).locator("video").click();
  await expect.poll(async () => (await inspect(page)).playing).toBe(false);
  await panelToggle(page).click();
  await expect(notesPanel(page)).toBeVisible();
});

// ---- The preview's divider: dragging the line under the preview makes the picture bigger or smaller. The right column
// widens to keep the cut's shape (up to half the window), the notes panel takes what is left, and the size is remembered
// per browser across the three sound tabs. The notes panel's own width and the Timeline's divider are left alone. ----

const previewDivider = (page: Page) => page.getByRole("separator", { name: "Resize the preview" });

async function dragBy(page: Page, handle: Locator, dy: number) {
  const d = (await handle.boundingBox())!;
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
  await page.mouse.down();
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2 + dy, { steps: 6 });
  await page.mouse.up();
}

test("the preview's divider drags it bigger and smaller, keeps its shape, and the size is remembered across the sound tabs", async ({ page, rushes }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await oneOfEach(rushes);
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Voice");
  await loaded(page, 2);
  const divider = previewDivider(page);
  await expect(divider).toBeVisible();
  const before = (await monitor(page).boundingBox())!;
  const sideBefore = (await rightColumn(page).boundingBox())!;
  const takesBefore = (await takesPanel(page).boundingBox())!;
  // The divider sits between the preview and the notes panel.
  const d = (await divider.boundingBox())!;
  expect(d.y).toBeGreaterThanOrEqual(before.y + before.height - 0.5);
  expect(d.y + d.height).toBeLessThanOrEqual((await notesPanel(page).boundingBox())!.y + 0.5);

  // Down: a bigger picture, still 16:9, so the right column widens and the takes area gives up the width.
  await dragBy(page, divider, 160);
  const big = (await monitor(page).boundingBox())!;
  expect(big.height).toBeGreaterThan(before.height + 100);
  expect(Math.abs(big.width / big.height - 16 / 9)).toBeLessThan(0.03);
  expect((await rightColumn(page).boundingBox())!.width).toBeGreaterThan(sideBefore.width + 150);
  expect((await takesPanel(page).boundingBox())!.width).toBeLessThan(takesBefore.width - 150);
  // Still above the notes panel, which keeps the rest of the column.
  const panel = (await notesPanel(page).boundingBox())!;
  expect(big.y + big.height).toBeLessThanOrEqual(panel.y + 0.5);
  expect(panel.height).toBeGreaterThan(200);
  expect(await page.evaluate(() => localStorage.getItem("rushes:preview"))).not.toBeNull();

  // Remembered after a reload, and the same on Music.
  await page.reload();
  await openReviewTab(page, "Voice");
  await loaded(page, 2);
  expect(Math.abs((await monitor(page).boundingBox())!.height - big.height)).toBeLessThanOrEqual(3);
  await openReviewTab(page, "Music");
  await loaded(page, 1);
  expect(Math.abs((await monitor(page).boundingBox())!.height - big.height)).toBeLessThanOrEqual(3);

  // Up: smaller than it started, at the column's width (the notes panel keeps its own width; the picture is centred).
  await dragBy(page, previewDivider(page), -(big.height - before.height) - 70);
  const small = (await monitor(page).boundingBox())!;
  expect(small.height).toBeLessThan(before.height - 40);
  expect(Math.abs((await rightColumn(page).boundingBox())!.width - sideBefore.width)).toBeLessThanOrEqual(1);
  const frame = (await monitor(page).locator("video").boundingBox())!;
  expect(Math.abs(frame.width / frame.height - 16 / 9)).toBeLessThan(0.03);
  expect(Math.abs(frame.x + frame.width / 2 - (small.x + small.width / 2))).toBeLessThanOrEqual(1.5);

  // A double-click puts it back as it was.
  await previewDivider(page).dblclick();
  const reset = (await monitor(page).boundingBox())!;
  expect(Math.abs(reset.height - before.height)).toBeLessThanOrEqual(2);
  expect(Math.abs(reset.width - before.width)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => localStorage.getItem("rushes:preview"))).toBeNull();

  // The notes panel's width and the Timeline's divider were never touched.
  expect(await page.evaluate(() => [localStorage.getItem("rushes:notes-width"), localStorage.getItem("rushes:split")])).toEqual([null, null]);
});

test("the preview grows no wider than half the window and leaves the notes panel room; the arrow keys move it too", async ({ page, rushes }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await oneOfEach(rushes);
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Effects");
  await loaded(page, 1);
  await dragBy(page, previewDivider(page), 700);
  const side = (await rightColumn(page).boundingBox())!;
  expect(side.width).toBeLessThanOrEqual(1440 / 2 + 1);
  const pv = (await monitor(page).boundingBox())!;
  expect(pv.y + pv.height).toBeLessThanOrEqual((await notesPanel(page).boundingBox())!.y + 0.5);
  expect((await notesPanel(page).boundingBox())!.height).toBeGreaterThanOrEqual(side.height * 0.2);
  const frame = (await monitor(page).locator("video").boundingBox())!;
  expect(Math.abs(frame.width / frame.height - 16 / 9)).toBeLessThan(0.03);
  // The takes area keeps the rest of the width.
  expect((await takesPanel(page).boundingBox())!.width).toBeGreaterThan(500);

  await previewDivider(page).dblclick();
  const start = (await monitor(page).boundingBox())!.height;
  await previewDivider(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const down = (await monitor(page).boundingBox())!.height;
  expect(down).toBeGreaterThan(start + 20);
  await expect(previewDivider(page)).toHaveAttribute("aria-valuenow", /^\d+$/);
  await page.keyboard.press("ArrowUp");
  expect((await monitor(page).boundingBox())!.height).toBeLessThan(down - 10);
  // The arrows moved the divider, not the playhead or the takes.
  expect((await inspect(page)).playing).toBe(false);
});

test("with no cut, the no-cut slate takes the preview's place above the notes panel", async ({ page, rushes }) => {
  await rushes.addVariant("music", "Bed", { seconds: 4, freq: 220 });
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Music");
  await loaded(page, 1);
  const slate = monitor(page).getByLabel("No cut yet");
  await expect(slate).toBeVisible();
  const s = (await monitor(page).boundingBox())!;
  const side = (await rightColumn(page).boundingBox())!;
  const panel = (await notesPanel(page).boundingBox())!;
  expect(s.x).toBeGreaterThanOrEqual(side.x - 0.5);
  expect(s.y + s.height).toBeLessThanOrEqual(panel.y + 0.5);
  await expect(monitor(page).getByRole("button", { name: "Copy prompt for your agent" })).toBeInViewport({ ratio: 1 });
  await expect(monitor(page).getByRole("button", { name: "Full screen · F" })).toHaveCount(0);
  // Nothing to resize until there is a picture.
  await expect(previewDivider(page)).toHaveCount(0);
});

test("under the stacking width the preview sits below the takes area, and the notes are the drawer", async ({ page, rushes }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await oneOfEach(rushes);
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Voice");
  await loaded(page, 2);
  const col = (await column(page).boundingBox())!;
  const pv = (await monitor(page).boundingBox())!;
  expect(pv.y).toBeGreaterThanOrEqual(col.y + col.height - 0.5);
  expect(pv.width).toBeLessThanOrEqual(521);
  expect(pv.height).toBeLessThanOrEqual(450);
  await panelToggle(page).click();
  await expect(notesPanel(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("no words over any take's waveform on Voice, Music and Effects; the details are on the name", async ({ page, rushes }) => {
  await oneOfEach(rushes);
  await page.goto(rushes.testUrl());
  for (const [tab, files] of [["Voice", 2], ["Music", 1], ["Effects", 1]] as const) {
    await openReviewTab(page, tab);
    await loaded(page, files);
    const rows = takeRows(page);
    for (let i = 0; i < (await rows.count()); i++) {
      const row = rows.nth(i);
      // Hovered, so Put away shows too.
      await row.hover();
      await expect.poll(() => textOverWaveform(row), { message: `${tab} row ${i}` }).toBe("ok");
    }
  }
  // An effects pass keeps its cue names (above its waveform, not on it) and its layers toggle; its cue count is a detail.
  await expect(takeRow(page, "Pass A").locator(".cue")).toHaveText(["Swipe", "Tap"]);
  await expect(takeRow(page, "Pass A").getByRole("button", { name: "Layers for Pass A" })).toBeVisible();
  await expect(takeName(page, "Pass A")).toHaveAttribute("data-tip", "Subtle · 2 cues");
  await openReviewTab(page, "Music");
  await expect(takeName(page, "Warm pad")).toHaveAttribute("data-tip", "Soft keys, no drums · 96 BPM · D major");
  await expect(takeName(page, "Warm pad")).toHaveAttribute("aria-description", "Soft keys, no drums · 96 BPM · D major");
  // Hovered, the name shows its details.
  await takeName(page, "Warm pad").hover();
  await expect.poll(() => takeName(page, "Warm pad").evaluate((el) => Number(getComputedStyle(el, "::after").opacity))).toBe(1);
});

test("a take's details button opens its details as a line under its row, pushing the rows below down; several can be open", async ({ page, rushes, browserName }) => {
  await oneOfEach(rushes);
  await page.goto(rushes.testUrl());
  await openReviewTab(page, "Voice");
  await loaded(page, 2);
  const alice = takeDetailsButton(page, "Alice · natural");
  const gerald = takeDetailsButton(page, "Gerald · bright");
  await expect(alice).toHaveAttribute("aria-expanded", "false");
  await expect(alice).toHaveAttribute("data-tip", "Details");
  await expect(takeDetailsLine(page, "Alice · natural")).toHaveCount(0);
  const geraldRowBefore = (await takeRow(page, "Gerald · bright").boundingBox())!;
  await alice.click();
  await expect(alice).toHaveAttribute("aria-expanded", "true");
  const line = takeDetailsLine(page, "Alice · natural");
  await expect(line).toHaveText("Warm, conversational, a touch slower in the middle");
  await expect(alice).toHaveAttribute("aria-controls", (await line.getAttribute("id"))!);
  // A line of its own: under its row, inside the takes panel, and the row below moves down by its height.
  const row = (await takeRow(page, "Alice · natural").boundingBox())!;
  const box = (await line.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(row.y + row.height - 0.5);
  await expectReadableInRow(line, takesPanel(page));
  const geraldRow = (await takeRow(page, "Gerald · bright").boundingBox())!;
  expect(geraldRow.y).toBeGreaterThanOrEqual(geraldRowBefore.y + box.height - 1);
  expect(geraldRow.y).toBeGreaterThanOrEqual(box.y + box.height - 0.5);
  // It covers no waveform: its box and every row's waveform box are apart.
  for (const name of ["Alice · natural", "Gerald · bright"]) {
    const wave = (await takeRow(page, name).locator("canvas.wave").boundingBox())!;
    expect(box.y + box.height <= wave.y + 0.5 || box.y >= wave.y + wave.height - 0.5).toBe(true);
  }
  // Several can be open, and the keyboard reaches each: Tab from Gerald's name to Archive, which shows with focus in the
  // row just before the details (in the order they are on screen), then to his details button; Enter opens it.
  // (WebKit's Tab skips buttons unless the system's "every control" setting is on, so there it is focused directly.)
  await takeName(page, "Gerald · bright").focus();
  if (browserName === "webkit") await gerald.focus();
  else {
    await page.keyboard.press("Tab");
    await expect(takeRow(page, "Gerald · bright").getByRole("button", { name: "Archive", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
  }
  await expect(gerald).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(gerald).toHaveAttribute("aria-expanded", "true");
  await expect(takeDetailsLine(page, "Gerald · bright")).toHaveText("Bright, upbeat");
  await expect(line).toBeVisible();
  // Pressed again, it closes.
  await alice.click();
  await expect(alice).toHaveAttribute("aria-expanded", "false");
  await expect(takeDetailsLine(page, "Alice · natural")).toHaveCount(0);
  await expect(takeDetailsLine(page, "Gerald · bright")).toBeVisible();
  // Blind hides the details: the button goes, and with it the open line.
  await page.getByRole("button", { name: "Blind" }).click();
  await expect(takesList(page).locator(".kinfo")).toHaveCount(0);
  await expect(takesList(page).locator(".kdetail")).toHaveCount(0);
  await expect(takesList(page)).not.toContainText("Bright, upbeat");
  await page.getByRole("button", { name: "Blind" }).click();
});
