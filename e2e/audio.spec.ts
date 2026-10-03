// Audio tab tests. The engine's own logic is unit-tested (test/web/timeline.test.ts and
// engine.test.ts); the full in-browser engine checks arrive with the Music tab (Task 3).
import type { Page } from "@playwright/test";
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
    };
  }
}

type Snapshot = { playing: boolean; time: number; length: number; sources: number; gains: Record<string, number>; media: string[]; streamed: string[] };

const inspect = (page: Page) => page.evaluate(() => window.__rushesAudio!.inspect() as unknown as Snapshot);

/** Wait until the tab's engine holds `n` files. */
async function loaded(page: Page, n: number) {
  await expect.poll(async () => (await inspect(page))?.media.length ?? 0, { timeout: 10_000 }).toBe(n);
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
  expect(notes[0]).toMatchObject({ stage: "music", on: "b-warm-keys", scope: "range", t: 0.5, tOut: 1.5, marks: [{ kind: "fall" }, { kind: "quieter", db: 3 }] });
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
  expect(notes[0]).toMatchObject({ scope: "whole", t: null, tOut: null, on: "a-deep-house", text: "Tempo: 110 BPM, keep the bassline.", marks: [] });
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
  // §17.4 (amended): a cue note names its pass, `<pass id>:<cue id>`.
  expect(notes[0]).toMatchObject({ stage: "sfx", on: "pass-a:swipe", scope: "point", t: 1.5, tOut: null });
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
  await expect(page.locator(".lane .smk").first()).toHaveAttribute("data-tip", /switching isn't sample-exact/);
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
  expect(added).toMatchObject({ on: "pass-b:swipe", scope: "point", t: 2.2 });
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
