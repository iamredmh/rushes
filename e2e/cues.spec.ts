// §23: sound-effects cue layers -- the hover card, the chevron's layers by sound, the keyboard and
// a cue's own sample. Every page goes to `rushes.testUrl()` (`?test=1`), which exposes the engine.
import type { Page } from "@playwright/test";
import { expect, type Rushes, test } from "./fixture.js";

type Hook = {
  inspect(): { playing: boolean; time: number; media: string[] } | null;
  renders: number;
  sample(): { path: string | null; playing: boolean };
};

/** The engine's state, the stage's render count and the sample player's state, read in one go. */
const hook = (page: Page) =>
  page.evaluate(() => {
    const h = (window as unknown as { __rushesAudio: Hook }).__rushesAudio;
    const s = h.inspect();
    return { playing: s?.playing ?? false, time: s?.time ?? 0, media: s?.media.length ?? 0, renders: h.renders, sample: h.sample() };
  });

/** Open Sound effects once it has unlocked, and wait until its engine holds `files` files. */
async function openSfx(page: Page, rushes: Rushes, files: number) {
  await page.goto(rushes.testUrl());
  const tab = page.getByRole("tab", { name: /Sound effects/ });
  await expect(tab).not.toHaveAttribute("data-locked");
  await page.keyboard.press("5");
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await hook(page)).media, { timeout: 10_000 }).toBe(files);
}

const PASS = "sfx/effects-for-lumen";
const THUD = "audio/sfx/samples/thud_low_03.wav";
const WHOOSH = "audio/sfx/samples/whoosh_long_01.wav";
const lane = (page: Page) => page.locator(`.lane[data-row="${PASS}"]`);
const layers = (page: Page) => page.locator(`.clayers[id="cl-${PASS}"]`);
const card = (page: Page) => page.getByRole("tooltip");
const chevron = (page: Page, name = "Effects for Lumen") => page.getByRole("button", { name: `Layers for ${name}`, exact: true });

/**
 * A 6 s pass with five cues, sent out of time order: thud ×3 and whoosh with their samples (thud's
 * is 4 s, long enough to watch), and one long name with no file; plus a pass with no cues.
 * In time: whoosh 0.5 (1), thud 1.5 (2), power-down · offline 2.1 (3), thud 3.0 (4), thud 4.5 (5).
 */
async function lumen(page: Page, rushes: Rushes, opts: { music?: boolean } = {}) {
  await rushes.writeFiles([{ path: THUD, seconds: 4, freq: 110 }, { path: WHOOSH, seconds: 0.6, freq: 660 }]);
  await rushes.addVariant("sfx", "Effects for Lumen", {
    seconds: 6,
    freq: 880,
    cues: [
      { name: "thud", t: 3, file: THUD },
      { name: "whoosh", t: 0.5, file: WHOOSH },
      { name: "thud", t: 1.5, file: THUD },
      { name: "power-down · offline", t: 2.1 },
      { name: "thud", t: 4.5, file: THUD },
    ],
  });
  await rushes.addVariant("sfx", "Effects, levelled", { seconds: 6, freq: 660 });
  if (opts.music) await rushes.addVariant("music", "Night drive", { seconds: 2, freq: 220 });
  await openSfx(page, rushes, 2);
}

test("hovering a cut-short cue label or its tick shows the full name, the time, its place and its sample", async ({ page, rushes }) => {
  await lumen(page, rushes);
  await expect(lane(page).locator(".cue")).toHaveText(["whoosh", "thud", "power-down · offline", "thud", "thud"]);
  const long = lane(page).locator('.cue[data-cue="power-down-offline"]');
  expect(await long.locator("span").evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  await long.hover();
  await expect(card(page).locator("b")).toHaveText("power-down · offline");
  await expect(card(page).locator(".m")).toHaveText("0:02.10 · cue 3 of 5");
  // No file was sent: the card says nothing about one.
  await expect(card(page).locator(".f")).toHaveCount(0);
  await expect(card(page)).not.toContainText("file");
  await expect(long).toHaveAttribute("aria-describedby", "cue-card");
  // The tick of the cue at 3 s (sent first, fourth in time) has its own card, with its sample.
  await lane(page).locator(".cue-tick").nth(3).hover();
  await expect(card(page).locator("b")).toHaveText("thud");
  await expect(card(page).locator(".m")).toHaveText("0:03.00 · cue 4 of 5");
  await expect(card(page).locator(".f")).toHaveText(THUD);
  const box = (await card(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(16);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width - 16);
  await page.mouse.move(5, 5);
  await expect(card(page)).toHaveCount(0);
});

test("the cue labels are one Tab stop; ←/→ walk them in time without stepping frames; Enter moves the playhead and aims the note; Esc hides the card", async ({ page, rushes }) => {
  await lumen(page, rushes);
  const cue = (name: string) => lane(page).getByRole("button", { name, exact: true });
  await expect(lane(page).locator('.cue[tabindex="0"]')).toHaveCount(1);
  await expect(cue("whoosh at 0:00.50")).toHaveAttribute("tabindex", "0");
  await cue("whoosh at 0:00.50").focus();
  await expect(card(page).locator("b")).toHaveText("whoosh");
  await page.keyboard.press("ArrowRight");
  await expect(cue("thud at 0:01.50")).toBeFocused();
  await expect(card(page).locator(".m")).toHaveText("0:01.50 · cue 2 of 5");
  await page.keyboard.press("End");
  await expect(cue("thud at 0:04.50")).toBeFocused();
  // The last cue: nowhere further to go, and no frame step either.
  await page.keyboard.press("ArrowRight");
  await expect(cue("thud at 0:04.50")).toBeFocused();
  expect((await hook(page)).time).toBe(0);
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  await expect(cue("thud at 0:04.50")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await hook(page)).time).toBeCloseTo(4.5, 3);
  expect((await hook(page)).playing).toBe(false);
  await expect(page.getByRole("combobox", { name: "Note on" })).toHaveValue(`c:${PASS}:thud-3`);
  await expect(lane(page)).toHaveAttribute("aria-current", "true");
  await expect(cue("thud at 0:04.50")).toHaveAttribute("tabindex", "0");
  await expect(lane(page).locator('.cue[tabindex="0"]')).toHaveCount(1);
});

test("the chevron opens one layer per sound, in order of first appearance, with counts; repeats share a layer; a tick moves the playhead", async ({ page, rushes }) => {
  await lumen(page, rushes);
  const chev = chevron(page);
  await expect(chev).toHaveAttribute("aria-expanded", "false");
  await expect(layers(page)).toHaveCount(0);
  await chev.click();
  await expect(chev).toHaveAttribute("aria-expanded", "true");
  await expect(chev).toHaveAttribute("aria-controls", `cl-${PASS}`);
  await expect(layers(page)).toHaveAttribute("aria-label", "Layers for Effects for Lumen");
  await expect(layers(page).locator(".clname span")).toHaveText(["whoosh", "thud", "power-down · offline"]);
  await expect(layers(page).locator(".clname em")).toHaveText(["×1", "×3", "×1"]);
  await expect(layers(page).locator('.clayer[data-layer="thud"] .ltick')).toHaveCount(3);
  // A pass with no cues has nothing to open.
  await expect(chevron(page, "Effects, levelled")).toBeDisabled();
  await expect(chevron(page, "Effects, levelled")).toHaveAccessibleDescription("No cues in this pass");
  // Each layer's track lines up with the pass's own.
  const lt = (await layers(page).locator(".cltrack").first().boundingBox())!;
  const tr = (await lane(page).locator(".track").boundingBox())!;
  expect(Math.abs(lt.x - tr.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(lt.width - tr.width)).toBeLessThanOrEqual(1);
  // Hover a tick for its card; click it to move the playhead there, without playing.
  const tick = layers(page).getByRole("button", { name: "thud at 0:03.00", exact: true });
  await tick.hover();
  await expect(card(page).locator(".m")).toHaveText("0:03.00 · cue 4 of 5");
  await tick.click();
  await expect.poll(async () => (await hook(page)).time).toBeCloseTo(3, 3);
  expect((await hook(page)).playing).toBe(false);
  await expect(lane(page)).toHaveAttribute("aria-current", "true");
  await chev.click();
  await expect(layers(page)).toHaveCount(0);
  await expect(card(page)).toHaveCount(0);
});

test("in a layer, ←/→ move between its ticks without stepping frames, Enter moves the playhead, the card shows on focus and Esc hides it", async ({ page, rushes }) => {
  await lumen(page, rushes);
  await chevron(page).click();
  for (const name of ["whoosh", "thud", "power-down · offline"]) {
    await expect(layers(page).locator(`.clayer[data-layer="${name}"] .ltick[tabindex="0"]`)).toHaveCount(1);
  }
  const tick = (name: string) => layers(page).getByRole("button", { name, exact: true });
  await tick("thud at 0:01.50").focus();
  await expect(card(page).locator(".m")).toHaveText("0:01.50 · cue 2 of 5");
  await expect(tick("thud at 0:01.50")).toHaveAttribute("aria-describedby", "cue-card");
  await page.keyboard.press("ArrowRight");
  await expect(tick("thud at 0:03.00")).toBeFocused();
  await expect(card(page).locator(".m")).toHaveText("0:03.00 · cue 4 of 5");
  // A step right from 0 would show as a frame; ← from 0 below can't, so check it here too.
  expect((await hook(page)).time).toBe(0);
  await page.keyboard.press("End");
  await expect(tick("thud at 0:04.50")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tick("thud at 0:01.50")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tick("thud at 0:01.50")).toBeFocused();
  expect((await hook(page)).time).toBe(0);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  await expect(tick("thud at 0:03.00")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await hook(page)).time).toBeCloseTo(3, 3);
  await expect(page.getByRole("combobox", { name: "Note on" })).toHaveValue(`c:${PASS}:thud`);
  await expect(layers(page).locator('.clayer[data-layer="thud"] .ltick[tabindex="0"]')).toHaveAccessibleName("thud at 0:03.00");
});

test("layers opened mid-play have playheads that move with the lane's, and nothing re-renders per frame", async ({ page, rushes }) => {
  await lumen(page, rushes);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await hook(page)).time).toBeGreaterThan(0.3);
  // Opened while playing, so only the toggle's own re-render can hand these playheads to paint().
  await chevron(page).click();
  await expect(layers(page).locator(".playhead")).toHaveCount(3);
  const before = (await hook(page)).renders;
  await page.waitForTimeout(600);
  const lefts = await page.locator(".astage .playhead").evaluateAll((els) => els.map((e) => (e as HTMLElement).style.left));
  expect(lefts).toHaveLength(5); // two passes, three layers
  expect(new Set(lefts).size).toBe(1);
  expect(lefts[0]).not.toBe("0%");
  expect((await hook(page)).renders - before).toBeLessThan(10);
});

test("a pass's layers stay open for the session, across tabs, and start shut after a reload", async ({ page, rushes }) => {
  await lumen(page, rushes, { music: true });
  await chevron(page).click();
  await page.keyboard.press("4");
  await expect(page.getByRole("tab", { name: /Music/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("5");
  await expect(chevron(page)).toHaveAttribute("aria-expanded", "true");
  await expect(layers(page).locator(".clayer")).toHaveCount(3);
  await expect(chevron(page, "Effects, levelled")).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(page.getByRole("tab", { name: /Sound effects/ })).toBeVisible();
  await page.keyboard.press("5");
  await expect(chevron(page)).toHaveAttribute("aria-expanded", "false");
  await expect(layers(page)).toHaveCount(0);
});

test("a layer's file button plays its sample on the one-player bus: it stops the tab, Play stops it, and closing the layers stops it", async ({ page, rushes }) => {
  await lumen(page, rushes);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await hook(page)).playing).toBe(true);
  await chevron(page).click();
  const thud = layers(page).getByRole("button", { name: `Play ${THUD}`, exact: true });
  await expect(thud).toHaveText("thud_low_03.wav");
  await expect(layers(page).locator('.clayer[data-layer="power-down · offline"] .clfile button')).toHaveCount(0);
  await thud.click();
  await expect(thud).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await hook(page)).sample).toEqual({ path: THUD, playing: true });
  expect((await hook(page)).playing).toBe(false);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await hook(page)).sample.playing).toBe(false);
  await expect(thud).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await hook(page)).playing).toBe(true);
  // Played again, then the layers close under it: the sample stops too.
  await thud.click();
  await expect.poll(async () => (await hook(page)).sample.playing).toBe(true);
  await chevron(page).click();
  await expect.poll(async () => (await hook(page)).sample.playing).toBe(false);
});

test("a sample that isn't there says so, and nothing is left playing", async ({ page, rushes }) => {
  await rushes.addVariant("sfx", "Effects for Lumen", { seconds: 4, freq: 880, cues: [{ name: "boom", t: 1, file: "audio/sfx/samples/gone.wav" }] });
  await openSfx(page, rushes, 1);
  await chevron(page).click();
  const boom = layers(page).getByRole("button", { name: "Play audio/sfx/samples/gone.wav", exact: true });
  await boom.click();
  await expect(page.getByRole("status")).toContainText("Couldn't play gone.wav");
  await expect(boom).toHaveAttribute("aria-pressed", "false");
  expect((await hook(page)).sample.playing).toBe(false);
});

test("Mix's Sound effects lane shows the card and walks its cues; it has no layers", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles([{ path: THUD, seconds: 0.4, freq: 110 }]);
  const pass = await rushes.addVariant("sfx", "Effects for Lumen", { seconds: 4, freq: 880, cues: [{ name: "whoosh", t: 0.5 }, { name: "thud", t: 2, file: THUD }] });
  await rushes.api("PUT", "/api/picks", { lanes: { [pass.lane.id]: pass.variant.id } });
  await page.goto(rushes.testUrl());
  const tab = page.getByRole("tab", { name: /Mix/ });
  await expect(tab).not.toHaveAttribute("data-locked");
  await page.keyboard.press("6");
  await expect(page.locator(".lane")).toHaveCount(3);
  const sfx = page.locator('.lane[data-row="sfx"]');
  await expect(sfx.locator(".cue")).toHaveCount(2);
  await expect(sfx.locator(".chev")).toHaveCount(0);
  await sfx.locator('.cue[data-cue="thud"]').hover();
  await expect(card(page).locator("b")).toHaveText("thud");
  await expect(card(page).locator(".m")).toHaveText("0:02.00 · cue 2 of 2");
  await expect(card(page).locator(".f")).toHaveText(THUD);
  await sfx.getByRole("button", { name: "whoosh at 0:00.50", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(sfx.getByRole("button", { name: "thud at 0:02.00", exact: true })).toBeFocused();
});

test("the card stays 16 px inside a narrow window when ← and → walk onto a cue with a long file path", async ({ page, rushes }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  const LONG = `audio/sfx/samples/${"impact_sub_heavy_".repeat(5)}01.wav`;
  await rushes.addVariant("sfx", "Effects for Lumen", {
    seconds: 6,
    freq: 880,
    cues: [{ name: "pop", t: 5.2 }, { name: "boom", t: 5.9, file: LONG }],
  });
  await openSfx(page, rushes, 1);
  await lane(page).getByRole("button", { name: "pop at 0:05.20", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(card(page).locator(".f")).toHaveText(LONG);
  const box = (await card(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(16);
  expect(box.x + box.width).toBeLessThanOrEqual(1000 - 16);
  // Its size is its content's, wherever it sits: it doesn't shrink to the room beside the window's edge.
  expect(box.width).toBeGreaterThan(300);
});

test("the first, last and after-the-end ticks of a layer show whole, inside the track", async ({ page, rushes }) => {
  await rushes.addVariant("sfx", "Effects for Lumen", {
    seconds: 4,
    freq: 880,
    cues: [{ name: "hit", t: 0 }, { name: "hit", t: 2 }, { name: "hit", t: 4 }, { name: "late", t: 5 }],
  });
  await openSfx(page, rushes, 1);
  await chevron(page).click();
  const track = (await layers(page).locator(".cltrack").first().boundingBox())!;
  const ticks = layers(page).locator(".ltick");
  await expect(ticks).toHaveCount(4);
  for (const b of await ticks.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as { x: number; right: number }))) {
    expect(b.x).toBeGreaterThanOrEqual(track.x);
    expect(b.right).toBeLessThanOrEqual(track.x + track.width);
  }
});

test("Assets › Found keeps its plain turning chevrons: the pass row's boxed chevron style doesn't reach them", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles([
    { path: "vo/take-one.wav", seconds: 8, freq: 220 },
    { path: "bed/loop-low.wav", seconds: 10, freq: 131 },
  ]);
  await rushes.scan();
  await page.goto(rushes.url);
  await page.getByRole("tab", { name: /Assets/ }).click();
  await page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: /^Found/ }).click();
  await expect(page.getByRole("heading", { name: "Found" })).toBeVisible();
  const chev = page.locator(".fgroup > .gh svg.chev").first();
  await expect(chev).toBeVisible();
  const style = await chev.evaluate((e) => {
    const c = getComputedStyle(e);
    return { border: c.borderTopWidth, radius: c.borderTopLeftRadius, background: c.backgroundColor };
  });
  expect(style).toEqual({ border: "0px", radius: "0px", background: "rgba(0, 0, 0, 0)" });
});
