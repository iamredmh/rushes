// Audio tab tests. The engine's own logic is unit-tested (test/web/timeline.test.ts and
// engine.test.ts); the full in-browser engine checks arrive with the Music tab (Task 3).
import type { Page } from "@playwright/test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { makeWav } from "./fixtures/wav.js";
import { expect, type Rushes, test } from "./fixture.js";

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
      draws(): number;
      liveContexts(): number;
      heard(): { id: string; lane: string; path: string; offset: number }[];
    };
  }
}

type Snapshot = { playing: boolean; time: number; length: number; sources: number; gains: Record<string, number>; lanes: Record<string, number>; media: string[]; streamed: string[] };

const inspect = (page: Page) => page.evaluate(() => window.__rushesAudio!.inspect() as unknown as Snapshot);

/** Wait until the tab's engine holds `n` files. */
async function loaded(page: Page, n: number) {
  await expect.poll(async () => (await inspect(page))?.media.length ?? 0, { timeout: 10_000 }).toBe(n);
}

/**
 * The computed `overflow` of an element and every ancestor up to (and including) its `.lane`: a
 * `[data-tip]` mark's tooltip (an `::after`) is clipped if any box between it and the lane hides
 * overflow, so every link in the chain must stay `visible`.
 */
function overflowChain(mark: ReturnType<Page["locator"]>) {
  return mark.evaluate((el) => {
    const chain: string[] = [];
    let node: HTMLElement | null = el as HTMLElement;
    while (node) {
      chain.push(getComputedStyle(node).overflow);
      if (node.classList.contains("lane")) break;
      node = node.parentElement;
    }
    return chain;
  });
}

/** Open an audio tab once it has unlocked. */
async function openTab(page: Page, name: RegExp, key: string) {
  const tab = page.getByRole("tab", { name });
  await expect(tab).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press(key);
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

/** Two beds on Music, loaded, nothing picked. */
async function twoBeds(page: Page, rushes: Rushes) {
  await rushes.addVariant("music", "A · Deep house", { seconds: 4, freq: 220, meta: { bpm: 120, key: "A minor" } });
  await rushes.addVariant("music", "B · Warm keys", { seconds: 4, freq: 330, meta: { description: "Soft keys, no drums" } });
  await page.goto(rushes.testUrl());
  await openTab(page, /Music/, "4");
  await expect(page.locator(".lane")).toHaveCount(2);
  await loaded(page, 2);
}

test("Music shows a card per bed, and Use persists the pick", async ({ page, rushes }) => {
  await twoBeds(page, rushes);
  const lanes = page.locator(".lane");
  await expect(lanes.nth(0).locator("[data-name]")).toHaveText("A · Deep house");
  await expect(lanes.nth(0).locator("[data-meta]")).toHaveText("120 BPM · A minor");
  await expect(lanes.nth(1).locator("[data-name]")).toHaveText("B · Warm keys");
  await expect(lanes.nth(1).locator("[data-meta]")).toHaveText("Soft keys, no drums");
  const useB = page.getByRole("button", { name: "Use B · Warm keys" });
  await expect(useB).toHaveAttribute("aria-pressed", "false");
  await expect(useB).toHaveText("Use");
  await useB.click();
  await expect(useB).toHaveAttribute("aria-pressed", "true");
  await expect(useB).toHaveText("In use");
  const picks = await rushes.api("GET", "/api/picks");
  expect(picks.lanes).toEqual({ music: "b-warm-keys" });
  // The picked bed is what plays when nothing's selected.
  expect((await inspect(page)).gains).toMatchObject({ "music/a-deep-house": 0, "music/b-warm-keys": 1 });
  await page.reload();
  await expect(page.getByRole("button", { name: "Use B · Warm keys" })).toHaveAttribute("aria-pressed", "true");
});

test("switching beds mid-play doesn't move the playhead", async ({ page, rushes }) => {
  await twoBeds(page, rushes);
  await page.getByRole("button", { name: "A · Deep house", exact: true }).click();
  await page.getByRole("button", { name: "Play" }).click();
  await expect.poll(async () => (await inspect(page)).time).toBeGreaterThan(0.5);
  const r = await page.evaluate(() => {
    const e = window.__rushesAudio!.engine!;
    const before = e.inspect();
    const p0 = performance.now();
    (document.querySelector('.lane[data-row="music/b-warm-keys"] .nm') as HTMLButtonElement).click();
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
  await expect(page.locator('.lane[data-row="music/b-warm-keys"]')).toHaveAttribute("aria-current", "true");
  // Auditioning doesn't change the pick.
  expect((await rushes.api("GET", "/api/picks")).lanes).toEqual({});
  // The On menu follows the lane you clicked.
  await expect(page.getByRole("combobox", { name: "Note on" }).locator("option:checked")).toHaveText("B · Warm keys");
});

test("a range note with Fall and Quieter 3 dB saves its marks and draws on its lane", async ({ page, rushes }) => {
  await twoBeds(page, rushes);
  await page.getByRole("button", { name: "B · Warm keys", exact: true }).click();
  for (let i = 0; i < 15; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("i");
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("o");
  await expect(page.locator(".bar .chipx")).toContainText("0:00.50–0:01.50");
  await expect(page.getByRole("group", { name: "Scope" }).getByRole("button", { name: "Range" })).toHaveAttribute("aria-pressed", "true");
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
  await expect(page.locator(`.lane[data-row="music/b-warm-keys"] .span[data-note="${notes[0].id}"]`)).toHaveCount(1);
  await expect(page.locator(`.lane[data-row="music/a-deep-house"] [data-note]`)).toHaveCount(0);
  // The composer is back to a point note with no marks showing.
  await expect(page.getByRole("group", { name: "Marks" })).toHaveCount(0);
});

test("a whole note sends no time and is listed but not drawn", async ({ page, rushes }) => {
  await twoBeds(page, rushes);
  await page.getByRole("group", { name: "Scope" }).getByRole("button", { name: "Whole" }).click();
  await page.getByRole("button", { name: "Tempo" }).click();
  await expect(page.getByRole("textbox", { name: "New note" })).toHaveValue("Tempo: ");
  await page.keyboard.type("110 BPM, keep the bassline.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note .t")).toHaveText("Whole");
  const { notes } = await rushes.api("GET", "/api/notes?stage=music");
  expect(notes[0]).toMatchObject({ scope: "whole", t: null, tOut: null, on: "music/a-deep-house", text: "Tempo: 110 BPM, keep the bassline.", marks: [] });
  await expect(page.locator(".lane [data-note]")).toHaveCount(0);
});

test("Blind hides the names and reveals them again", async ({ page, rushes }) => {
  await twoBeds(page, rushes);
  const blind = page.getByRole("button", { name: "Blind" });
  await blind.click();
  await expect(blind).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".lane [data-name]")).toHaveText(["Bed 1", "Bed 2"]);
  await expect(page.locator(".astage")).not.toContainText("Deep house");
  await expect(page.locator(".astage")).not.toContainText("Warm keys");
  await expect(page.locator(".astage")).not.toContainText("120 BPM");
  await blind.click();
  await expect(blind).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".lane [data-name]")).toHaveText(["A · Deep house", "B · Warm keys"]);
  await expect(page.locator(".lane").nth(0).locator("[data-meta]")).toHaveText("120 BPM · A minor");
});

test("Sound effects labels cues, and a note on a cue saves the cue and its time", async ({ page, rushes }) => {
  await rushes.addVariant("sfx", "Pass A", { seconds: 3, freq: 880, meta: { description: "Subtle" }, cues: [{ name: "Whoosh", t: 0.4 }, { name: "Swipe", t: 1.5 }] });
  await rushes.addVariant("sfx", "Pass B", { seconds: 3, freq: 660 });
  await page.goto(rushes.testUrl());
  await openTab(page, /Sound effects/, "5");
  await expect(page.locator(".lane")).toHaveCount(2);
  await loaded(page, 2);
  await expect(page.locator('.lane[data-row="sfx/pass-a"] .cue')).toHaveText(["Whoosh", "Swipe"]);
  await expect(page.locator('.lane[data-row="sfx/pass-a"] [data-meta]')).toHaveText("Subtle · 2 cues");
  await page.getByRole("combobox", { name: "Note on" }).selectOption({ label: "Cue · Swipe" });
  await page.keyboard.press("n");
  await page.keyboard.type("Lands three frames late.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note .on")).toHaveText("Cue · Swipe");
  const { notes } = await rushes.api("GET", "/api/notes?stage=sfx");
  // §17.4: a cue note names its lane and pass, `<lane id>/<pass id>:<cue id>`.
  expect(notes[0]).toMatchObject({ stage: "sfx", on: "sfx/pass-a:swipe", scope: "point", t: 1.5, tOut: null });
  await expect(page.locator(`.lane[data-row="sfx/pass-a"] .mk[data-note="${notes[0].id}"]`)).toHaveCount(1);
  // Use works as on Music.
  await page.getByRole("button", { name: "Use Pass B" }).click();
  await expect(page.getByRole("button", { name: "Use Pass B" })).toHaveAttribute("aria-pressed", "true");
  expect((await rushes.api("GET", "/api/picks")).lanes).toEqual({ sfx: "pass-b" });
});

test("the preview follows the audio clock", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.addVariant("music", "Bed", { seconds: 4, freq: 220 });
  await page.goto(rushes.testUrl());
  await openTab(page, /Music/, "4");
  await loaded(page, 1);
  const pv = page.locator(".pv video");
  await expect.poll(() => pv.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
  expect(await pv.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  await page.evaluate(() => window.__rushesAudio!.engine!.seek(2));
  await expect.poll(() => pv.evaluate((v: HTMLVideoElement) => Math.abs(v.currentTime - 2))).toBeLessThanOrEqual(1 / 30);
  await expect(page.getByLabel("Timecode")).toContainText("0:02.00");
});

test("with no cut the preview is a quiet empty frame", async ({ page, rushes }) => {
  await rushes.addVariant("music", "Bed", { seconds: 2, freq: 220 });
  await page.goto(rushes.testUrl());
  await openTab(page, /Music/, "4");
  await expect(page.locator(".pv .pvempty")).toBeVisible();
  await expect(page.locator(".pv video")).toHaveCount(0);
});

test("leaving the tab stops playback, and coming back doesn't double the sources", async ({ page, rushes }) => {
  await twoBeds(page, rushes);
  await page.keyboard.press(" ");
  await expect.poll(async () => (await inspect(page)).playing).toBe(true);
  await page.evaluate(() => { (window as unknown as { __old: unknown }).__old = window.__rushesAudio!.engine; });
  await page.keyboard.press("7");
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
  await page.keyboard.press("7");
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
  await page.keyboard.press("7");
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

test("a file over the stream threshold plays through the streamed fallback", async ({ page, rushes }) => {
  await rushes.addVariant("music", "A · Long", { seconds: 3, freq: 220 });
  await rushes.addVariant("music", "B · Long", { seconds: 3, freq: 330 });
  await page.goto(rushes.testUrl("streamOver=1"));
  await openTab(page, /Music/, "4");
  await loaded(page, 2);
  expect((await inspect(page)).streamed.length).toBe(2);
  const streamedMark = page.locator(".lane .smk").first();
  await expect(streamedMark).toHaveAttribute("data-tip", /switching isn't sample-exact/);
  // The Task 3 lane-mark tooltip sits in the meta line, which used to clip it with overflow:
  // hidden (fixed by the same route as the Voiceover stale/missing marks below).
  const streamedChain = await overflowChain(streamedMark);
  expect(streamedChain.length).toBeGreaterThan(1);
  expect(streamedChain.every((o) => o === "visible")).toBe(true);
  await page.keyboard.press(" ");
  await expect.poll(async () => (await inspect(page)).time, { timeout: 5000 }).toBeGreaterThan(0.6);
  await page.getByRole("button", { name: "B · Long", exact: true }).click();
  const s = await inspect(page);
  expect(s.playing).toBe(true);
  expect(s.gains).toMatchObject({ "music/a-long": 0, "music/b-long": 1 });
  await page.keyboard.press(" ");
  await expect.poll(async () => (await inspect(page)).playing).toBe(false);
});

test("the engine is never exposed without ?test=1", async ({ page, rushes }) => {
  await rushes.addVariant("music", "Bed", { seconds: 2, freq: 220 });
  await page.goto(rushes.url);
  await openTab(page, /Music/, "4");
  await expect(page.locator(".lane")).toHaveCount(1);
  expect(await page.evaluate(() => "__rushesAudio" in window)).toBe(false);
});

// ---- Fix round 1 ----

test("a note on a cue two passes share names its pass, and an old bare cue id still draws", async ({ page, rushes }) => {
  await rushes.addVariant("sfx", "Pass A", { seconds: 3, freq: 880, cues: [{ name: "Swipe", t: 1.5 }] });
  await rushes.addVariant("sfx", "Pass B", { seconds: 3, freq: 660, cues: [{ name: "Swipe", t: 2.2 }] });
  // A note from before the amendment: a bare cue id, drawn on the first pass holding it.
  const old = (await rushes.api("POST", "/api/notes", { stage: "sfx", on: "swipe", scope: "point", t: 1.5, text: "Old style." })).note;
  await page.goto(rushes.testUrl());
  await openTab(page, /Sound effects/, "5");
  await loaded(page, 2);
  await expect(page.locator(`.lane[data-row="sfx/pass-a"] .mk[data-note="${old.id}"]`)).toHaveCount(1);
  await page.getByRole("combobox", { name: "Note on" }).selectOption({ label: "Cue · Swipe · Pass B" });
  await page.keyboard.press("n");
  await page.keyboard.type("Too bright on B.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(2);
  const { notes } = await rushes.api("GET", "/api/notes?stage=sfx");
  const added = notes.find((n: { text: string }) => n.text === "Too bright on B.");
  expect(added).toMatchObject({ on: "sfx/pass-b:swipe", scope: "point", t: 2.2 });
  await expect(page.locator(`.lane[data-row="sfx/pass-b"] .mk[data-note="${added.id}"]`)).toHaveCount(1);
  await expect(page.locator(`.lane[data-row="sfx/pass-a"] .mk[data-note="${added.id}"]`)).toHaveCount(0);
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
  await openTab(page, /Music/, "4");
  await expect(page.locator(".note")).toHaveCount(3);
  const comp = page.locator(".comp");
  const pointHeight = (await comp.boundingBox())!.height;
  // Range swaps the chips for the marks: the composer doesn't grow.
  await page.getByRole("group", { name: "Scope" }).getByRole("button", { name: "Range" }).click();
  await expect(page.getByRole("group", { name: "Marks" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Start a note" })).toHaveCount(0);
  expect(Math.abs((await comp.boundingBox())!.height - pointHeight)).toBeLessThanOrEqual(1);
  const list = (await page.locator(".side .list").boundingBox())!;
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
  await openTab(page, /Music/, "4");
  await loaded(page, 4);
  const gains = async () => (await inspect(page)).gains;
  const before = await gains();
  expect(before).toEqual({ "music/a-one": 1, "music/b-two": 0, "music/c-three": 0, "music/d-four": 0 });
  await page.getByRole("button", { name: "Blind" }).click();
  await expect(page.locator(".lane [data-name]").first()).toHaveText("Bed 1");
  expect(await gains()).toEqual(before);
  await page.getByRole("button", { name: "Blind" }).click();
  await expect(page.locator(".lane [data-name]").first()).toHaveText("A · One");
  expect(await gains()).toEqual(before);
});

test("a half-typed music note holds the film", async ({ page, rushes }) => {
  await rushes.addCut("hero", "Hero");
  await rushes.addCut("cutdown", "Cutdown");
  await rushes.addVariant("music", "Bed", { seconds: 2, freq: 220 });
  await page.goto(rushes.testUrl());
  await openTab(page, /Music/, "4");
  await loaded(page, 1);
  const films = page.getByRole("navigation", { name: "Films" });
  await expect(films.getByRole("button", { name: /Hero/ })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("n");
  await page.keyboard.type("Half a thought");
  await page.keyboard.press("Escape");
  await page.keyboard.press("]");
  await expect(page.getByRole("status")).toHaveText("Add or clear your note on Hero first");
  await expect(films.getByRole("button", { name: /Hero/ })).toHaveAttribute("aria-pressed", "true");
  await films.getByRole("button", { name: /Cutdown/ }).click();
  await expect(films.getByRole("button", { name: /Hero/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "New note" })).toHaveValue("Half a thought");
  // A range alone holds it too; clearing both lets the film go.
  await page.getByRole("textbox", { name: "New note" }).fill("");
  await page.getByRole("textbox", { name: "New note" }).blur();
  await page.keyboard.press("i");
  await page.keyboard.press("]");
  await expect(films.getByRole("button", { name: /Hero/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Clear range" }).click();
  await page.keyboard.press("]");
  await expect(films.getByRole("button", { name: /Cutdown/ })).toHaveAttribute("aria-pressed", "true");
});

test("an audio note never says it came from another cut", async ({ page, rushes }) => {
  await rushes.addCut();
  const bed = await rushes.addVariant("music", "Bed", { seconds: 4, freq: 220 });
  await rushes.api("POST", "/api/notes", { stage: "music", video: "hero", version: "v1", on: bed.variant.id, scope: "point", t: 1.25, text: "On v1." });
  await rushes.addCut();
  await page.goto(rushes.testUrl());
  await openTab(page, /Music/, "4");
  await expect(page.locator(".note .t")).toHaveText("0:01.25");
  await expect(page.locator(".note .from")).toHaveCount(0);
});

test("the preview keeps up during playback without repeated seeking", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.addVariant("music", "Bed", { seconds: 4, freq: 220 });
  await page.goto(rushes.testUrl());
  await openTab(page, /Music/, "4");
  await loaded(page, 1);
  const pv = page.locator(".pv video");
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
  expect(r.seeks).toBeLessThanOrEqual(2);
});

// ---- Voiceover (Task 4) ----

/** What the tab hears now, by clip id, in timeline order. */
const heard = (page: Page) =>
  page.evaluate(() => window.__rushesAudio!.heard().sort((a, b) => a.offset - b.offset).map((c) => `${c.id}@${c.offset}`));

/**
 * A four-section script (S1 0–3 s, S2 3–6 s, S3 6–9 s, S4 9–12 s). S1 and S4 have a take each,
 * S2 has three and S3 none. No cut, so the timeline is the audio's own length.
 */
async function voScript(rushes: Rushes, picks: Record<string, string> = {}) {
  await rushes.api("PUT", "/api/script", {
    replace: true,
    sections: [
      { id: "s1", start: 0, end: 3, current: "Line one." },
      { id: "s2", start: 3, end: 6, current: "Line two." },
      { id: "s3", start: 6, end: 9, current: "Line three." },
      { id: "s4", start: 9, end: 12, current: "Line four." },
    ],
  });
  await rushes.addTake("s1", { seconds: 2, freq: 220 });
  for (const freq of [330, 392, 440]) await rushes.addTake("s2", { seconds: 2, freq });
  await rushes.addTake("s4", { seconds: 2, freq: 262 });
  if (Object.keys(picks).length > 0) await rushes.api("PUT", "/api/picks", { sections: picks });
}

async function openVoice(page: Page, rushes: Rushes, files = 5) {
  await page.goto(rushes.testUrl());
  await openTab(page, /Voiceover/, "3");
  await loaded(page, files);
}

const section = (page: Page, label: string) => page.getByRole("group", { name: "Section" }).getByRole("button", { name: label, exact: true });
const onMenu = (page: Page) => page.getByRole("combobox", { name: "Note on" }).locator("option:checked");

test("the assembled read places each section's picked take at its start, with a gap where there's none", async ({ page, rushes }) => {
  await voScript(rushes, { s2: "t2" });
  await openVoice(page, rushes);
  expect(await heard(page)).toEqual(["s1:t1@0", "s2:t2@3", "s4:t1@9"]);
  const read = page.locator('.lane[data-row="vo"]');
  await expect(read.locator("[data-name]")).toHaveText("Assembled read");
  // S3 has no take, but keeps its label.
  await expect(read.locator(".secmk")).toHaveText(["S1", "S2", "S3", "S4"]);
  // The switch starts on the section under the playhead; its takes are the sub-lanes.
  await expect(section(page, "S1")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".lane.sub [data-name]")).toHaveText(["S1 · Take 1"]);
  // Until you choose one, it follows the playhead.
  await page.evaluate(() => window.__rushesAudio!.engine!.seek(9.5));
  await expect(section(page, "S4")).toHaveAttribute("aria-pressed", "true");
  await section(page, "S2").click();
  await page.evaluate(() => window.__rushesAudio!.engine!.seek(1));
  await expect(section(page, "S2")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".lane.sub [data-name]")).toHaveText(["S2 · Take 1", "S2 · Take 2", "S2 · Take 3"]);
  await expect(page.getByRole("button", { name: "Use S2 · Take 2" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Use S2 · Take 3" })).toHaveAttribute("aria-pressed", "false");
  // Changing section points the On menu at it.
  await expect(onMenu(page)).toHaveText("S2");
  await expect(page.locator(".lane.sub").first().locator(".track")).toHaveCSS("height", "52px");
});

test("auditioning a take and Use swap the section's segment without moving the playhead", async ({ page, rushes }) => {
  await voScript(rushes);
  await openVoice(page, rushes);
  await section(page, "S2").click();
  // No pick: the newest take is in the read.
  expect(await heard(page)).toEqual(["s1:t1@0", "s2:t3@3", "s4:t1@9"]);
  await expect(page.getByRole("button", { name: "Use S2 · Take 3" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Play" }).click();
  await expect.poll(async () => (await inspect(page)).time).toBeGreaterThan(0.5);

  // Clicking a take auditions it in its section's place: a gain swap in the click, the same sources.
  const r = await page.evaluate(() => {
    const e = window.__rushesAudio!.engine!;
    const before = e.inspect();
    const p0 = performance.now();
    (document.querySelector('.lane[data-row="take:s2:t1"] .nm') as HTMLButtonElement).click();
    const after = e.inspect();
    return { before, after, wall: (performance.now() - p0) / 1000, heard: window.__rushesAudio!.heard().map((c) => c.id).sort() };
  });
  expect(r.after.playing).toBe(true);
  expect(r.after.time - r.before.time - r.wall).toBeLessThan(0.05);
  expect(r.after.time).toBeGreaterThanOrEqual(r.before.time);
  expect(r.after.sources).toBe(r.before.sources);
  expect(r.heard).toEqual(["s1:t1", "s2:t1", "s4:t1"]);
  await expect(page.locator('.lane[data-row="take:s2:t1"]')).toHaveAttribute("aria-current", "true");
  await expect(onMenu(page)).toHaveText("S2 · Take 1");
  // Auditioning isn't picking.
  expect((await rushes.api("GET", "/api/picks")).sections).toEqual({});

  // Clicking the read goes back to the picks.
  await page.getByRole("button", { name: "Assembled read", exact: true }).click();
  expect(await heard(page)).toEqual(["s1:t1@0", "s2:t3@3", "s4:t1@9"]);

  // Use on Take 2: the pick is saved and the read swaps it in, on the same clock.
  const t0 = await page.evaluate(() => ({ t: window.__rushesAudio!.engine!.time, wall: performance.now() / 1000, sources: window.__rushesAudio!.inspect()!.sources }));
  await page.getByRole("button", { name: "Use S2 · Take 2" }).click();
  await expect(page.getByRole("button", { name: "Use S2 · Take 2" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Use S2 · Take 3" })).toHaveAttribute("aria-pressed", "false");
  expect((await rushes.api("GET", "/api/picks")).sections).toEqual({ s2: "t2" });
  await expect.poll(() => heard(page)).toEqual(["s1:t1@0", "s2:t2@3", "s4:t1@9"]);
  const t1 = await page.evaluate(() => ({ t: window.__rushesAudio!.engine!.time, wall: performance.now() / 1000, playing: window.__rushesAudio!.engine!.playing, sources: window.__rushesAudio!.inspect()!.sources }));
  expect(t1.playing).toBe(true);
  expect(Math.abs(t1.t - t0.t - (t1.wall - t0.wall))).toBeLessThan(0.1);
  expect(t1.sources).toBe(t0.sources);
});

test("a take shows the stale mark once the agent changes its line", async ({ page, rushes }) => {
  await voScript(rushes);
  await openVoice(page, rushes);
  await section(page, "S2").click();
  await expect(page.locator(".lane.sub")).toHaveCount(3);
  await expect(page.locator(".lane [data-stale]")).toHaveCount(0);
  // The agent rewrites S2's line (a merge, so the other sections stay).
  await rushes.api("PUT", "/api/script", { sections: [{ id: "s2", start: 3, end: 6, current: "A new line two." }] });
  await expect(page.locator(".lane.sub [data-stale]")).toHaveCount(3);
  await expect(page.locator(".lane.sub [data-stale]").first()).toHaveAttribute("data-tip", "The line changed after this take");
  // A take read from the new line isn't stale.
  await rushes.addTake("s2", { seconds: 2, freq: 494 });
  await expect(page.locator(".lane.sub")).toHaveCount(4);
  await expect(page.locator('.lane[data-row="take:s2:t4"] [data-stale]')).toHaveCount(0);
  await expect(page.locator(".lane.sub [data-stale]")).toHaveCount(3);
});

test("the stale mark's tooltip isn't clipped by the name column's ellipsis", async ({ page, rushes }) => {
  await voScript(rushes);
  await openVoice(page, rushes);
  await section(page, "S2").click();
  await rushes.api("PUT", "/api/script", { sections: [{ id: "s2", start: 3, end: 6, current: "A new line two." }] });
  const mark = page.locator(".lane.sub [data-stale]").first();
  await expect(mark).toHaveCSS("overflow", "visible");
  // Every box between the mark and its lane must stay unclipped too, or the tooltip is cut off
  // even though the mark itself is fine.
  const chain = await overflowChain(mark);
  expect(chain.length).toBeGreaterThan(1);
  expect(chain.every((o) => o === "visible")).toBe(true);
  // Hovering actually shows the tooltip (opacity: 1 once the 0.12s transition settles), and its
  // content isn't suppressed.
  await mark.hover();
  await expect
    .poll(() => mark.evaluate((el) => Number(getComputedStyle(el, "::after").opacity)))
    .toBe(1);
  const content = await mark.evaluate((el) => getComputedStyle(el, "::after").content);
  expect(content).not.toBe("none");
});

test("New take starts a whole note on the section asking for another take", async ({ page, rushes }) => {
  await voScript(rushes);
  await openVoice(page, rushes);
  await section(page, "S2").click();
  await page.getByRole("button", { name: "New take" }).click();
  const box = page.getByRole("textbox", { name: "New note" });
  await expect(box).toHaveValue("Another take of S2: ");
  await expect(box).toBeFocused();
  expect(await box.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([20, 20]);
  await expect(onMenu(page)).toHaveText("S2");
  await expect(page.getByRole("group", { name: "Scope" }).getByRole("button", { name: "Whole" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.type("slower, and warmer on the last word.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(1);
  const { notes } = await rushes.api("GET", "/api/notes?stage=voice");
  expect(notes[0]).toMatchObject({ stage: "voice", on: "s2", scope: "whole", t: null, tOut: null, text: "Another take of S2: slower, and warmer on the last word." });
  await expect(page.locator(".note .on")).toHaveText("S2");
  await expect(page.locator(".note .t")).toHaveText("Whole");
});

test("New take refuses to drop a pending note, and shows a toast instead", async ({ page, rushes }) => {
  await voScript(rushes);
  await openVoice(page, rushes);
  await section(page, "S2").click();
  await page.keyboard.press("n");
  await page.keyboard.type("Half a thought");
  const scopePoint = page.getByRole("group", { name: "Scope" }).getByRole("button", { name: "Point" });
  await expect(scopePoint).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "New take" }).click();
  await expect(page.getByRole("status")).toHaveText("Finish or clear the note you're writing first.");
  // Nothing about the pending note moved: the text, and the scope, are exactly as they were.
  await expect(page.getByRole("textbox", { name: "New note" })).toHaveValue("Half a thought");
  await expect(scopePoint).toHaveAttribute("aria-pressed", "true");
  const { notes } = await rushes.api("GET", "/api/notes?stage=voice");
  expect(notes).toHaveLength(0);
});

test("a range note on a section with Louder 2 dB saves and draws on the read", async ({ page, rushes }) => {
  await voScript(rushes);
  await openVoice(page, rushes);
  await section(page, "S2").click();
  await page.evaluate(() => window.__rushesAudio!.engine!.seek(3.5));
  await page.keyboard.press("i");
  await page.evaluate(() => window.__rushesAudio!.engine!.seek(5));
  await page.keyboard.press("o");
  await expect(page.locator(".bar .chipx")).toContainText("0:03.50–0:05.00");
  const marks = page.getByRole("group", { name: "Marks" });
  await marks.getByRole("button", { name: "Louder" }).click();
  await marks.getByRole("combobox", { name: "Louder by" }).selectOption("2");
  await expect(onMenu(page)).toHaveText("S2");
  await page.keyboard.press("n");
  await page.keyboard.type("It gets lost under the music here.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(1);
  const { notes } = await rushes.api("GET", "/api/notes?stage=voice");
  expect(notes[0]).toMatchObject({ stage: "voice", on: "s2", scope: "range", t: 3.5, tOut: 5, marks: [{ kind: "louder", db: 2 }] });
  await expect(page.locator(".note .nmarks")).toHaveText("Louder 2 dB");
  await expect(page.locator(".note .on")).toHaveText("S2");
  await expect(page.locator(`.lane[data-row="vo"] .span[data-note="${notes[0].id}"]`)).toHaveCount(1);
  await expect(page.locator(".lane.sub [data-note]")).toHaveCount(0);
});

test("a take note draws on the read and on its own sub-lane while its section is shown", async ({ page, rushes }) => {
  await voScript(rushes);
  const { note } = await rushes.api("POST", "/api/notes", { stage: "voice", on: "s2:t1", scope: "point", t: 3.6, text: "Dip the second word." });
  await openVoice(page, rushes);
  await expect(page.locator(`.lane[data-row="vo"] .mk[data-note="${note.id}"]`)).toHaveCount(1);
  await expect(page.locator(".lane.sub [data-note]")).toHaveCount(0);
  await section(page, "S2").click();
  await expect(page.locator(`.lane[data-row="take:s2:t1"] .mk[data-note="${note.id}"]`)).toHaveCount(1);
  await expect(page.locator(`.lane[data-row="take:s2:t2"] [data-note]`)).toHaveCount(0);
  await expect(page.locator(".note .on")).toHaveText("S2 · Take 1");
});

test("a picked voice variant replaces the read, until the read or a take is clicked", async ({ page, rushes }) => {
  await voScript(rushes);
  const alt = await rushes.addVariant("voice", "Warm read", { seconds: 11, freq: 196 });
  const key = `${alt.lane.id}/${alt.variant.id}`;
  await openVoice(page, rushes, 6);
  // Not picked: the read plays, and the variant is a lane of its own with Use.
  expect(await heard(page)).toEqual(["s1:t1@0", "s2:t3@3", "s4:t1@9"]);
  await page.getByRole("button", { name: "Use Warm read" }).click();
  await expect(page.getByRole("button", { name: "Use Warm read" })).toHaveAttribute("aria-pressed", "true");
  expect((await rushes.api("GET", "/api/picks")).lanes).toEqual({ [alt.lane.id]: alt.variant.id });
  await expect.poll(() => heard(page)).toEqual([`${key}@0`]);
  await page.getByRole("button", { name: "Assembled read", exact: true }).click();
  expect(await heard(page)).toEqual(["s1:t1@0", "s2:t3@3", "s4:t1@9"]);
  await page.getByRole("button", { name: "Warm read", exact: true }).click();
  expect(await heard(page)).toEqual([`${key}@0`]);
  await page.getByRole("button", { name: "S1 · Take 1", exact: true }).click();
  expect(await heard(page)).toEqual(["s1:t1@0", "s2:t3@3", "s4:t1@9"]);
});

test("a take whose file is missing shows the missing mark and leaves a gap", async ({ page, rushes }) => {
  await voScript(rushes);
  const { script } = await rushes.api("GET", "/api/script");
  const s2 = script.sections.find((s: { id: string }) => s.id === "s2");
  await rm(join(rushes.root, s2.takes[2].file));
  await openVoice(page, rushes, 4);
  // Take 3 is S2's newest, so it's what the read uses: the section is silent rather than another take.
  expect(await heard(page)).toEqual(["s1:t1@0", "s4:t1@9"]);
  await section(page, "S2").click();
  await expect(page.locator('.lane[data-row="take:s2:t3"] .amiss')).toHaveCount(1);
  await expect(page.locator('.lane[data-row="take:s2:t1"] .amiss')).toHaveCount(0);
  expect((await inspect(page)).media.some((k) => k.includes(s2.takes[2].file))).toBe(false);
});

// ---- Picks can be cleared (Task 5) ----

test("Unpick clears a pick: In use goes back to Use, and the pick is gone from disk", async ({ page, rushes }) => {
  await twoBeds(page, rushes);
  const useB = page.getByRole("button", { name: "Use B · Warm keys" });
  // Nothing picked: no Unpick anywhere.
  await expect(page.getByRole("button", { name: /^Unpick/ })).toHaveCount(0);
  await useB.click();
  await expect(useB).toHaveAttribute("aria-pressed", "true");
  const unpick = page.getByRole("button", { name: "Unpick B · Warm keys" });
  await expect(unpick).toHaveAttribute("data-tip", "Unpick");
  await unpick.click();
  await expect(useB).toHaveAttribute("aria-pressed", "false");
  await expect(useB).toHaveText("Use");
  await expect(unpick).toHaveCount(0);
  expect((await rushes.api("GET", "/api/picks")).lanes).toEqual({});
  // With no pick, the first bed in manifest order plays again.
  await expect.poll(async () => (await inspect(page)).gains).toMatchObject({ "music/a-deep-house": 1, "music/b-warm-keys": 0 });
});

test("a take in use only because it's the newest has no Unpick; an explicit pick does", async ({ page, rushes }) => {
  await voScript(rushes, { s2: "t1" });
  await openVoice(page, rushes);
  await section(page, "S2").click();
  await expect(page.getByRole("button", { name: "Use S2 · Take 1" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Unpick S2 · Take 1" }).click();
  // Back to the newest take, which is in use but not picked.
  await expect(page.getByRole("button", { name: "Use S2 · Take 3" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /^Unpick/ })).toHaveCount(0);
  expect((await rushes.api("GET", "/api/picks")).sections).toEqual({});
  await expect.poll(() => heard(page)).toEqual(["s1:t1@0", "s2:t3@3", "s4:t1@9"]);
});

// ---- One definition of pending (Task 5) ----

test("marks ticked without a range hold the film, as text and a range do", async ({ page, rushes }) => {
  await rushes.addCut("hero", "Hero");
  await rushes.addCut("cutdown", "Cutdown");
  await rushes.addVariant("music", "Bed", { seconds: 2, freq: 220 });
  await page.goto(rushes.testUrl());
  await openTab(page, /Music/, "4");
  await loaded(page, 1);
  const films = page.getByRole("navigation", { name: "Films" });
  await page.getByRole("group", { name: "Scope" }).getByRole("button", { name: "Range" }).click();
  await page.getByRole("group", { name: "Marks" }).getByRole("button", { name: "Fall" }).click();
  await expect(page.locator(".bar .chipx")).toHaveCount(0);
  await page.keyboard.press("]");
  await expect(page.getByRole("status")).toHaveText("Add or clear your note on Hero first");
  await expect(films.getByRole("button", { name: /Hero/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "Marks" }).getByRole("button", { name: "Fall" })).toHaveAttribute("aria-pressed", "true");
  // Untick it and the film can go.
  await page.getByRole("group", { name: "Marks" }).getByRole("button", { name: "Fall" }).click();
  await page.keyboard.press("]");
  await expect(films.getByRole("button", { name: /Cutdown/ })).toHaveAttribute("aria-pressed", "true");
});

test("switching tab, by 1–7 or by a click, refuses to drop a pending audio note", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.addVariant("music", "Bed", { seconds: 2, freq: 220 });
  await page.goto(rushes.testUrl());
  await openTab(page, /Music/, "4");
  await loaded(page, 1);
  const tab = (name: RegExp) => page.getByRole("tab", { name });
  // Nothing pending: the tabs switch freely.
  await openTab(page, /Picture/, "2");
  await openTab(page, /Music/, "4");
  await loaded(page, 1);

  // An In point is pending: the key is refused, and so is a click on a tab, Assets included.
  await page.keyboard.press("i");
  await expect(page.locator(".bar .chipx")).toHaveCount(1);
  await page.keyboard.press("2");
  await expect(page.getByRole("status")).toHaveText("Add or clear your note first");
  await expect(tab(/Music/)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("7");
  await expect(tab(/Music/)).toHaveAttribute("aria-selected", "true");
  await tab(/Mix/).click();
  await expect(tab(/Music/)).toHaveAttribute("aria-selected", "true");
  await tab(/Assets/).click();
  await expect(tab(/Music/)).toHaveAttribute("aria-selected", "true");

  // Marks and half-typed text survive the refused switch, exactly as they were.
  await page.getByRole("group", { name: "Scope" }).getByRole("button", { name: "Range" }).click();
  await page.getByRole("group", { name: "Marks" }).getByRole("button", { name: "Fall" }).click();
  await page.keyboard.press("n");
  await page.keyboard.type("Half a thought");
  await tab(/Picture/).click();
  await expect(page.getByRole("status")).toHaveText("Add or clear your note first");
  await expect(tab(/Music/)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: "New note" })).toHaveValue("Half a thought");
  await expect(page.locator(".bar .chipx")).toHaveCount(1);
  await expect(page.getByRole("group", { name: "Marks" }).getByRole("button", { name: "Fall" })).toHaveAttribute("aria-pressed", "true");

  // Clear the note (text, mark and range), and the tab can go.
  await page.getByRole("textbox", { name: "New note" }).fill("");
  await page.getByRole("group", { name: "Marks" }).getByRole("button", { name: "Fall" }).click();
  await page.getByRole("button", { name: "Clear range" }).click();
  await tab(/Picture/).click();
  await expect(tab(/Picture/)).toHaveAttribute("aria-selected", "true");
});

// ---- Mix (Task 5) ----

/**
 * A cut, a two-section script with a take each, a music bed and an SFX pass, both picked unless
 * `pick` is false. Opens Mix with every file loaded.
 */
async function mixProject(page: Page, rushes: Rushes, opts: { pick?: { music?: boolean; sfx?: boolean } } = {}) {
  await rushes.addCut();
  await rushes.api("PUT", "/api/script", {
    replace: true,
    sections: [
      { id: "s1", start: 0, end: 2, current: "Line one." },
      { id: "s2", start: 2, end: 4, current: "Line two." },
    ],
  });
  await rushes.addTake("s1", { seconds: 1.5, freq: 220 });
  await rushes.addTake("s2", { seconds: 1.5, freq: 247 });
  const bed = await rushes.addVariant("music", "Warm keys", { seconds: 4, freq: 330 });
  const pass = await rushes.addVariant("sfx", "Pass A", { seconds: 4, freq: 880, cues: [{ name: "Swipe", t: 1 }] });
  const lanes: Record<string, string> = {};
  if (opts.pick?.music !== false) lanes[bed.lane.id] = bed.variant.id;
  if (opts.pick?.sfx !== false) lanes[pass.lane.id] = pass.variant.id;
  await rushes.api("PUT", "/api/picks", { lanes });
  return { bed, pass };
}

async function openMix(page: Page, rushes: Rushes, files: number) {
  // Every loudness request the page makes, in order.
  const asked: string[][] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/mix/loudness") && r.method() === "POST") asked.push(r.postDataJSON().lanes);
  });
  await page.goto(rushes.testUrl());
  await openTab(page, /Mix/, "6");
  await expect(page.locator(".lane")).toHaveCount(3);
  await loaded(page, files);
  return asked;
}

const laneGainsOf = async (page: Page) => (await inspect(page)).lanes;

test("Mix shows three lanes; mute and solo change the lane gains, and solo wins", async ({ page, rushes }) => {
  await mixProject(page, rushes);
  const asked = await openMix(page, rushes, 4);
  await expect(page.locator(".lane [data-name]")).toHaveText(["Voiceover", "Music", "Sound effects"]);
  await expect(page.locator('.lane[data-row="vo"] [data-meta]')).toHaveText("Assembled read");
  await expect(page.locator('.lane[data-row="music"] [data-meta]')).toHaveText("Warm keys");
  await expect(page.locator('.lane[data-row="sfx"] [data-meta]')).toHaveText("Pass A");
  await expect(page.locator('.lane[data-row="vo"] .secmk')).toHaveText(["S1", "S2"]);
  await expect(page.locator('.lane[data-row="sfx"] .cue')).toHaveText(["Swipe"]);
  await expect.poll(() => laneGainsOf(page)).toEqual({ vo: 1, music: 1, sfx: 1 });
  expect(await heard(page)).toEqual(["s1:t1@0", "music/warm-keys@0", "sfx/pass-a@0", "s2:t1@2"]);
  await expect.poll(() => asked.at(-1)).toEqual(["voice", "music", "sfx"]);

  const button = (name: string) => page.getByRole("button", { name, exact: true });
  await button("Mute Music").click();
  await expect(button("Mute Music")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => laneGainsOf(page)).toEqual({ vo: 1, music: 0, sfx: 1 });
  await expect.poll(() => asked.at(-1)).toEqual(["voice", "sfx"]);

  // Solo wins: only the soloed lane plays, even when it's also muted.
  await button("Solo Voiceover").click();
  await expect.poll(() => laneGainsOf(page)).toEqual({ vo: 1, music: 0, sfx: 0 });
  await button("Mute Voiceover").click();
  await expect.poll(() => laneGainsOf(page)).toEqual({ vo: 1, music: 0, sfx: 0 });
  expect(await heard(page)).toEqual(["s1:t1@0", "s2:t1@2"]);
  await expect.poll(() => asked.at(-1)).toEqual(["voice"]);
  await button("Solo Sound effects").click();
  await expect.poll(() => laneGainsOf(page)).toEqual({ vo: 1, music: 0, sfx: 1 });
  // With no solo left, mute applies again.
  await button("Solo Voiceover").click();
  await button("Solo Sound effects").click();
  await expect.poll(() => laneGainsOf(page)).toEqual({ vo: 0, music: 0, sfx: 1 });

  // View state only: nothing is saved, and leaving the tab resets it.
  const picks = await rushes.api("GET", "/api/picks");
  expect(Object.keys(picks).sort()).toEqual(["lanes", "rev", "schema", "sections"]);
  await page.keyboard.press("4");
  await openTab(page, /Mix/, "6");
  await loaded(page, 4);
  await expect(page.locator('.ms[aria-pressed="true"]')).toHaveCount(0);
  await expect.poll(() => laneGainsOf(page)).toEqual({ vo: 1, music: 1, sfx: 1 });
});

test("the loudness readout shows the three values (or — without ffmpeg), and a quiet mark while measuring", async ({ page, rushes }) => {
  await mixProject(page, rushes);
  // The same request the readout makes, so the test knows whether this server has ffmpeg.
  const direct = await rushes.api("POST", "/api/mix/loudness", { lanes: ["voice", "music", "sfx"] });
  await openMix(page, rushes, 4);
  const values = page.locator(".meter [data-value]");
  await expect(page.locator(".meter span:not([data-measuring])")).toHaveText(["LUFS integrated", "dBTP true peak", "Music under VO"]);
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
  await page.getByRole("button", { name: "Mute Music", exact: true }).click();
  await expect(page.locator("[data-measuring]")).toBeVisible();
  await expect(page.locator("[data-measuring]")).toHaveAttribute("data-tip", "Measuring");
  await expect(page.locator("[data-measuring]")).toHaveCount(0, { timeout: 15_000 });
  if (direct.available) {
    // No music in the mix: nothing to compare the VO with.
    await expect(values.nth(2)).toHaveText("—");
    await expect(values.nth(2)).toHaveAttribute("data-tip", "Needs Voiceover and Music both playing");
  }
  // With every lane muted there's nothing to measure, whether or not there's ffmpeg.
  await page.getByRole("button", { name: "Mute Voiceover", exact: true }).click();
  await page.getByRole("button", { name: "Mute Sound effects", exact: true }).click();
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
  await openMix(page, rushes, 4);
  const meter = page.getByRole("group", { name: "Loudness" });
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
  await openMix(page, rushes, 4);
  await expect(page.getByRole("group", { name: "Loudness" }).locator("[data-value]").first()).toHaveText("−16.2");
  const start = seen.count;
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  // Four changes, well inside the 500 ms window.
  await page.evaluate(() => {
    for (const name of ["Mute Music", "Solo Sound effects", "Mute Music", "Solo Sound effects", "Mute Voiceover"]) {
      document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!.click();
    }
  });
  await expect(button("Mute Voiceover")).toHaveAttribute("aria-pressed", "true");
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
  await openMix(page, rushes, 4);
  const values = page.getByRole("group", { name: "Loudness" }).locator("[data-value]");
  await expect(values.first()).toHaveText("−16.2");
  for (const lane of ["Voiceover", "Music", "Sound effects"]) await page.getByRole("button", { name: `Mute ${lane}`, exact: true }).click();
  await expect(values.first()).toHaveAttribute("data-tip", "Nothing to measure");
  // Hold the next reading back: until it lands, the readout must not still claim there's nothing to measure.
  held = new Promise((ok) => (release = ok));
  await page.getByRole("button", { name: "Mute Music", exact: true }).click();
  await expect(values.first()).not.toHaveAttribute("data-tip", "Nothing to measure");
  await expect(page.locator("[data-measuring]")).toBeVisible();
  release();
  await expect(values.first()).toHaveText("−16.2");
});

test("a lane with nothing picked, or a missing file, is empty and left out of the loudness request", async ({ page, rushes }) => {
  const { pass } = await mixProject(page, rushes, { pick: { music: false } });
  await rm(join(rushes.root, (await rushes.api("GET", "/api/state")).project.lanes.find((l: { id: string }) => l.id === pass.lane.id).variants[0].file));
  const asked = await openMix(page, rushes, 2);
  await expect(page.locator('.lane[data-row="music"] .amiss')).toHaveAttribute("data-tip", "Nothing picked");
  await expect(page.locator('.lane[data-row="sfx"] .amiss')).toHaveAttribute("data-tip", "Missing");
  await expect(page.locator('.lane[data-row="vo"] .amiss')).toHaveCount(0);
  expect(await heard(page)).toEqual(["s1:t1@0", "s2:t1@2"]);
  await expect.poll(() => asked.at(-1)).toEqual(["voice"]);
  // Soloing an empty lane leaves nothing to measure.
  await page.getByRole("button", { name: "Solo Music", exact: true }).click();
  await expect(page.locator(".meter [data-value]").first()).toHaveAttribute("data-tip", "Nothing to measure");
});

test("Mix's VO lane plays a picked voice variant instead of the read, as Voiceover does", async ({ page, rushes }) => {
  await mixProject(page, rushes);
  const alt = await rushes.addVariant("voice", "Warm read", { seconds: 4, freq: 196 });
  await rushes.api("PUT", "/api/picks", { lanes: { [alt.lane.id]: alt.variant.id } });
  await openMix(page, rushes, 3);
  await expect(page.locator('.lane[data-row="vo"] [data-meta]')).toHaveText("Warm read");
  expect(await heard(page)).toEqual([`${alt.lane.id}/${alt.variant.id}@0`, "music/warm-keys@0", "sfx/pass-a@0"]);
});

test("Mix notes: a range on Music saves the variant and marks, a whole-mix note saves no lane", async ({ page, rushes }) => {
  const { bed } = await mixProject(page, rushes);
  await openMix(page, rushes, 4);
  const onMenuMix = page.getByRole("combobox", { name: "Note on" });
  await expect(onMenuMix.locator("option:checked")).toHaveText("Whole mix");
  await expect(onMenuMix.locator("option")).toHaveText(["Whole mix", "Voiceover", "Music · Warm keys", "Sound effects · Pass A"]);
  await page.getByRole("button", { name: "Music", exact: true }).click();
  await expect(onMenuMix.locator("option:checked")).toHaveText("Music · Warm keys");
  await page.evaluate(() => window.__rushesAudio!.engine!.seek(1));
  await page.keyboard.press("i");
  await page.evaluate(() => window.__rushesAudio!.engine!.seek(2));
  await page.keyboard.press("o");
  await page.getByRole("group", { name: "Marks" }).getByRole("button", { name: "Quieter" }).click();
  await page.keyboard.press("n");
  await page.keyboard.type("Music creeps up under the line.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(1);
  let { notes } = await rushes.api("GET", "/api/notes?stage=mix");
  expect(notes[0]).toMatchObject({ stage: "mix", on: `${bed.lane.id}/${bed.variant.id}`, scope: "range", t: 1, tOut: 2, marks: [{ kind: "quieter", db: 3 }] });
  await expect(page.locator(`.lane[data-row="music"] .span[data-note="${notes[0].id}"]`)).toHaveCount(1);
  await expect(page.locator(`.lane[data-row="vo"] [data-note="${notes[0].id}"]`)).toHaveCount(0);
  await expect(page.locator(".note .on")).toHaveText("Music · Warm keys");

  await onMenuMix.selectOption({ label: "Whole mix" });
  await page.getByRole("textbox", { name: "New note" }).click();
  await page.keyboard.type("A touch quiet overall.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(2);
  ({ notes } = await rushes.api("GET", "/api/notes?stage=mix"));
  const whole = notes.find((n: { text: string }) => n.text === "A touch quiet overall.");
  expect(whole).toMatchObject({ on: null, scope: "point", marks: [] });
  // A point on the whole mix is drawn on every lane.
  await expect(page.locator(`.lane .mk[data-note="${whole.id}"]`)).toHaveCount(3);
});

test("a Mix note on an SFX pass named like the music bed lands on Sound effects, and an old bare id still draws where it did", async ({ page, rushes }) => {
  await rushes.addCut();
  const bed = await rushes.addVariant("music", "Option A", { seconds: 4, freq: 330 });
  const pass = await rushes.addVariant("sfx", "Option A", { seconds: 4, freq: 880 });
  expect(bed.variant.id).toBe(pass.variant.id); // the clash: both "option-a"
  await rushes.api("PUT", "/api/picks", { lanes: { [bed.lane.id]: bed.variant.id, [pass.lane.id]: pass.variant.id } });
  // A note saved before `on` was lane-qualified: drawn on Music, the first lane heard with that id.
  const old = (await rushes.api("POST", "/api/notes", { stage: "mix", on: "option-a", scope: "point", t: 1, text: "Old style." })).note;
  await page.goto(rushes.testUrl());
  await openTab(page, /Mix/, "6");
  await loaded(page, 2);
  await expect(page.locator(`.lane[data-row="music"] .mk[data-note="${old.id}"]`)).toHaveCount(1);
  await expect(page.locator(`.lane[data-row="sfx"] .mk[data-note="${old.id}"]`)).toHaveCount(0);

  await page.getByRole("combobox", { name: "Note on" }).selectOption({ label: "Sound effects · Option A" });
  await page.evaluate(() => window.__rushesAudio!.engine!.seek(2));
  await page.getByRole("textbox", { name: "New note" }).click();
  await page.keyboard.type("Too loud here.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(2);
  const { notes } = await rushes.api("GET", "/api/notes?stage=mix");
  const added = notes.find((n: { text: string }) => n.text === "Too loud here.");
  expect(added).toMatchObject({ on: "sfx/option-a", scope: "point", t: 2 });
  await expect(page.locator(`.lane[data-row="sfx"] .mk[data-note="${added.id}"]`)).toHaveCount(1);
  await expect(page.locator(`.lane[data-row="music"] .mk[data-note="${added.id}"]`)).toHaveCount(0);
  await expect(page.locator(`.note[data-note="${added.id}"] .on`)).toHaveText("Sound effects · Option A");
});

test("leaving Mix stops playback and releases its engine", async ({ page, rushes }) => {
  await mixProject(page, rushes);
  await openMix(page, rushes, 4);
  await page.keyboard.press(" ");
  await expect.poll(async () => (await inspect(page)).playing).toBe(true);
  await page.evaluate(() => { (window as unknown as { __old: unknown }).__old = window.__rushesAudio!.engine; });
  await page.keyboard.press("4");
  await expect(page.getByRole("tab", { name: /Music/ })).toHaveAttribute("aria-selected", "true");
  await loaded(page, 1);
  const old = await page.evaluate(() => {
    const e = (window as unknown as { __old: { playing: boolean; inspect(): Snapshot } }).__old;
    return { playing: e.playing, sources: e.inspect().sources, live: window.__rushesAudio!.liveContexts() };
  });
  expect(old).toEqual({ playing: false, sources: 0, live: 1 });
  expect(await page.evaluate(() => window.__rushesAudio!.engine!.playing)).toBe(false);
});
