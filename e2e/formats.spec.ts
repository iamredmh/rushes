import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, hasFfmpeg, test, videoReady } from "./fixture.js";

test.skip(!hasFfmpeg, "formats are generated with ffmpeg and measured with ffprobe");

const WIDE = { width: 320, height: 180 };
const TALL = { width: 180, height: 320 };
const SQUARE = { width: 240, height: 240 };
const PORTRAIT = { width: 192, height: 240 };
const FOUR = [WIDE, TALL, SQUARE, PORTRAIT];

/** A chip of the format toggle, by its ratio. */
const radio = (page: Page, label: string) => page.getByRole("radiogroup", { name: "Format" }).getByRole("radio", { name: new RegExp(`^${label}(,|$)`) });

async function drawBox(page: Page) {
  await page.keyboard.press("b");
  const o = (await page.locator(".overlay").boundingBox())!;
  await page.mouse.move(o.x + o.width * 0.3, o.y + o.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(o.x + o.width * 0.6, o.y + o.height * 0.6, { steps: 4 });
  await page.mouse.up();
}

/** Every API request the page makes that names a format: `?format=` in its URL, or a non-null `format` in its JSON body. */
function watchFormatRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (!url.pathname.includes("/api/")) return;
    if (url.searchParams.has("format")) seen.push(`${r.method()} ${url.pathname}${url.search}`);
    let body: unknown = null;
    try {
      body = r.postDataJSON();
    } catch {
      body = null;
    }
    if (body && typeof body === "object" && (body as { format?: unknown }).format != null) seen.push(`${r.method()} ${url.pathname} body.format`);
  });
  return seen;
}

test("four formats: the chips keep their fixed order, and switching keeps the time and the play state", async ({ page, rushes }) => {
  await rushes.addFormatsCut(FOUR);
  await page.goto(rushes.url);
  await videoReady(page);
  const chips = page.getByRole("radiogroup", { name: "Format" }).getByRole("radio");
  await expect(chips).toHaveText([/^9:16/, /^4:5/, /^1:1/, /^16:9/]);
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true"); // the primary first
  const xs = async () => Promise.all(["9:16", "4:5", "1:1", "16:9"].map(async (l) => (await radio(page, l).boundingBox())!.x));
  const ascending = (a: number[]) => a.every((x, i) => i === 0 || x > a[i - 1]);
  expect(ascending(await xs())).toBe(true);
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Timecode")).toContainText("0:01.00");
  await page.keyboard.press(" ");
  const video = page.locator("video");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 1.2)).toBe(true);
  const at = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await radio(page, "9:16").click();
  await expect(video).toHaveAttribute("src", /_180x320\.mp4/);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && !v.paused && v.currentTime >= 1.2)).toBe(true);
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThanOrEqual(at - 0.05);
  // The frame takes the new shape once its 160 ms reshape has run.
  await expect.poll(async () => {
    const frame = (await page.locator(".frame").boundingBox())!;
    return frame.width / frame.height;
  }).toBeCloseTo(180 / 320, 1);
  expect(ascending(await xs())).toBe(true);
  await page.keyboard.press(" ");
});

test("switching while paused keeps the time and stays paused", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await page.goto(rushes.url);
  await videoReady(page);
  for (let i = 0; i < 45; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Timecode")).toContainText("0:01.50");
  const video = page.locator("video");
  await radio(page, "9:16").click();
  await expect(video).toHaveAttribute("src", /_180x320\.mp4/);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 1 && Math.abs(v.currentTime - 1.5) < 0.02)).toBe(true);
  await expect(page.getByLabel("Timecode")).toContainText("0:01.50");
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});

test("one format: the chip is greyed and out of the tab order, and the copy prompt is reachable by keyboard (R5)", async ({ page, rushes, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  const chip = page.getByRole("radiogroup", { name: "Format" }).getByRole("radio");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText(/^16:9/);
  await expect(chip).toHaveAttribute("aria-disabled", "true");
  await expect(chip).toHaveAttribute("tabindex", "-1");
  await expect(page.locator(".fmtpop")).toHaveCSS("opacity", "0");
  await chip.hover();
  await expect(page.locator(".fmtpop")).toHaveCSS("opacity", "1");
  await expect(page.locator(".fmtpop")).toContainText("One format. Your agent can add more with rushes_add_format.");
  await page.mouse.move(2, 2);
  await expect(page.locator(".fmtpop")).toHaveCSS("opacity", "0");
  await page.getByRole("button", { name: "Copy a prompt for your agent" }).focus();
  await expect(page.locator(".fmtpop")).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(page.locator(".toast")).toHaveText(/Prompt copied|Couldn't reach the clipboard/);
  if (browserName === "chromium") {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('register the other shapes of "Hero" v1');
  }
});

test("a newer cut without a format keeps its chip, greyed: Not in v2", async ({ page, rushes }) => {
  await rushes.addFormatsCut(FOUR);
  await rushes.addFormatsCut([WIDE, TALL, SQUARE]);
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v2");
  const chip = radio(page, "4:5");
  await expect(chip).toHaveAttribute("aria-disabled", "true");
  await expect(chip).toHaveAttribute("data-tip", "Not in v2");
  await expect(chip).toHaveAccessibleName("4:5, not in v2");
  await chip.click({ force: true });
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  // Picking v1 by hand, which has all four, makes 4:5 a chip like any other.
  await page.getByRole("combobox", { name: "Version" }).selectOption("v1");
  await expect(radio(page, "4:5")).not.toHaveAttribute("aria-disabled", "true");
});

test("Alt+← and Alt+→ step through the formats; the group takes arrows, Home and End; nothing fires while typing (R1)", async ({ page, rushes }) => {
  await rushes.addFormatsCut(FOUR);
  await page.goto(rushes.url);
  await videoReady(page);
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(radio(page, "1:1")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("[");
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await radio(page, "16:9").focus();
  await page.keyboard.press("Home");
  await expect(radio(page, "9:16")).toHaveAttribute("aria-checked", "true");
  await expect(radio(page, "9:16")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(radio(page, "4:5")).toHaveAttribute("aria-checked", "true");
  await expect(radio(page, "4:5")).toHaveAttribute("tabindex", "0");
  await expect(radio(page, "9:16")).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("End");
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("Timecode")).toContainText("0:00.00");
  await page.keyboard.press("n");
  await page.keyboard.type("Crop is tight");
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("textbox", { name: "New note" })).toHaveValue("Crop is tight");
});

test("each film remembers its format for the session; a fresh load shows the primary", async ({ page, rushes }) => {
  await rushes.addFormatsCut(FOUR);
  await rushes.addFormatsCut([WIDE, TALL], { video: "Teaser" });
  await page.goto(rushes.url);
  await videoReady(page);
  await radio(page, "9:16").click();
  await page.getByRole("navigation", { name: "Films" }).getByRole("button", { name: /Teaser/ }).click();
  await videoReady(page);
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await page.getByRole("navigation", { name: "Films" }).getByRole("button", { name: /Hero/ }).click();
  await videoReady(page);
  await expect(radio(page, "9:16")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("video")).toHaveAttribute("src", /_180x320\.mp4/);
  await page.reload();
  await videoReady(page);
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
});

test("the frame reshapes over 160 ms, and at once under reduced motion", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await page.goto(rushes.testUrl());
  await videoReady(page);
  // The reshape is held mid-way, as a quick second switch would find it: that switch must stop it,
  // or the frame would keep the first switch's size. Clicked and paused in one go, so it can't end first.
  const running = await page.evaluate(async () => {
    document.querySelector<HTMLElement>('[data-format="9x16"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    const anims = document.querySelector(".frame")!.getAnimations();
    // Nearly at 9:16, so a reshape left running would plainly not be the 16:9 shape asked for next.
    anims.forEach((a) => {
      a.pause();
      a.currentTime = 150;
    });
    return anims.length;
  });
  expect(running).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).__rushesLastReshape)).toEqual({ animated: true, ms: 160 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await radio(page, "16:9").click();
  await expect.poll(() => page.evaluate(() => (window as any).__rushesLastReshape)).toEqual({ animated: false, ms: 0 });
  const frame = (await page.locator(".frame").boundingBox())!;
  expect(frame.width / frame.height).toBeCloseTo(320 / 180, 1);
});

// Review Focus 5.
test("a format whose file has gone warns on its chip and says File not found; a length mismatch warns with both lengths", async ({ page, rushes }) => {
  const r = await rushes.addFormatsCut([WIDE, TALL, { ...SQUARE, seconds: 4.5 }]);
  await rm(join(rushes.root, r.version.formats.find((f) => f.id === "9x16")!.file));
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(radio(page, "9:16")).toHaveAccessibleName(/File not found/);
  await expect(radio(page, "1:1")).toHaveAttribute("data-tip", "1:1 is 4.5 s; the cut is 4.0 s");
  await radio(page, "9:16").click();
  await expect(page.locator(".frame .msg")).toHaveText("File not found");
  await expect(page.locator(".proxybar")).toHaveCount(0);
  // R9: the timeline stays the cut's length on the longer render.
  await radio(page, "1:1").click();
  await videoReady(page);
  await expect(page.locator(".ends span").last()).toHaveText("0:04.00");
});

test("the Proxy/Original switch belongs to the primary: it hides while another format shows", async ({ page, rushes }) => {
  await rushes.addProResCut({ seconds: 2 });
  await rushes.api("POST", "/api/videos/hero/versions/v1/proxy", {});
  await expect.poll(async () => (await rushes.api("GET", "/api/state")).project.videos[0].versions[0].proxy !== null, { timeout: 20_000 }).toBe(true);
  await rushes.addFormatFile({ width: 360, height: 640, seconds: 2 });
  await page.goto(rushes.url);
  await expect(page.getByRole("button", { name: "Proxy", exact: true })).toBeVisible();
  await radio(page, "9:16").click();
  await expect(page.getByRole("button", { name: "Proxy", exact: true })).toHaveCount(0);
  await radio(page, "16:9").click();
  await expect(page.getByRole("button", { name: "Proxy", exact: true })).toBeVisible();
});

test("at 1440×900 a 9:16 format keeps the timeline and note box on screen; the shot strip, length and waveform stay the cut's", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL], { audio: true });
  await rushes.api("PUT", "/api/videos/hero/shots", { shots: [{ name: "Open", start: 0 }, { name: "Logo", start: 2 }] });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(page.locator(".track canvas")).toBeVisible({ timeout: 15_000 });
  await radio(page, "9:16").click();
  await expect(page.locator(".shots .shot")).toHaveCount(2);
  await expect(page.locator(".ends span").last()).toHaveText("0:04.00");
  await expect(page.locator(".track canvas")).toBeVisible();
  const vp = page.viewportSize()!;
  for (const sel of [".track", ".comp textarea"]) {
    const b = (await page.locator(sel).boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(vp.height);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

// Review Focus 3.
test("with a box drawn, switching format is refused; a half-typed note and an In point carry over", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await page.goto(rushes.url);
  await videoReady(page);
  await drawBox(page);
  await radio(page, "9:16").click();
  await expect(page.locator(".toast")).toHaveText("Add or clear your box on 16:9 first");
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Remove box" }).click();
  await page.keyboard.press("i");
  await page.keyboard.press("n");
  await page.keyboard.type("Half a thought");
  await radio(page, "9:16").click();
  await expect(radio(page, "9:16")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("textbox", { name: "New note" })).toHaveValue("Half a thought");
  await expect(page.locator(".bar .chipx")).toContainText("0:00.00 →");
});

test("switching keeps the selected note (R6)", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 2, text: "Hold the last row." });
  await page.goto(rushes.url);
  await videoReady(page);
  await page.locator(".note", { hasText: "Hold the last row." }).locator(".t").click();
  await expect(page.locator('.note[aria-current="true"]')).toHaveText(/Hold the last row\./);
  await radio(page, "9:16").click();
  await expect(page.locator('.note[aria-current="true"]')).toHaveText(/Hold the last row\./);
});

// The carried ruling (Task 2 review, M4): a one-format cut leaves `format` out of every request,
// since ?format=<the primary's id> is a 404 on an older cut with no stored size.
test("a one-format cut names no format in any request: loading, a note, a grab", async ({ page, rushes }) => {
  const seen = watchFormatRequests(page);
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(page.getByRole("radiogroup", { name: "Format" }).getByRole("radio")).toHaveCount(1);
  await page.keyboard.press("g");
  await expect(page.locator(".toast")).toContainText("Saved to");
  await page.keyboard.press("n");
  await page.keyboard.type("Tighter crop on the logo");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note", { hasText: "Tighter crop on the logo" })).toBeVisible();
  expect(seen).toEqual([]);
});

test.describe("an older cut with no stored size (no ffprobe on the server)", () => {
  test.use({ noFfmpeg: true });

  test("the single chip takes the player's measured shape (R2), and no request names a format", async ({ page, rushes }) => {
    const seen = watchFormatRequests(page);
    await rushes.addCut();
    const state = await rushes.api("GET", "/api/state");
    expect(state.project.videos[0].versions[0].width).toBeNull();
    await page.goto(rushes.url);
    await videoReady(page);
    const chip = page.getByRole("radiogroup", { name: "Format" }).getByRole("radio");
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveText(/^16:9/);
    await expect(chip).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("g");
    await expect(page.locator(".toast")).toContainText("Saved to");
    await page.keyboard.press("n");
    await page.keyboard.type("Hold the title longer");
    await page.keyboard.press("Enter");
    await expect(page.locator(".note", { hasText: "Hold the title longer" })).toBeVisible();
    expect(seen).toEqual([]);
  });
});

// ---- Task 4 review, fix round 1 ----

/** Every chip's left edge and width, in chip order. */
const chipBoxes = (page: Page) =>
  page.getByRole("radiogroup", { name: "Format" }).getByRole("radio").evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, w: r.width };
  }));

// I1, §21.8 (3): a chip's position never changes.
test("the chips never move: not when a count appears or reaches two digits, nor when the selection changes", async ({ page, rushes }) => {
  await rushes.addFormatsCut(FOUR);
  await page.goto(rushes.url);
  await videoReady(page);
  await page.mouse.move(1400, 880);
  const start = await chipBoxes(page);
  const note = (text: string) => rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text });
  await note("Drop this first sound.");
  await expect(radio(page, "9:16")).toHaveAccessibleName("9:16, 1 open note");
  expect(await chipBoxes(page)).toEqual(start);
  for (let i = 2; i <= 10; i++) await note(`Note ${i}`);
  await expect(radio(page, "9:16")).toHaveAccessibleName("9:16, 10 open notes");
  expect(await chipBoxes(page)).toEqual(start);
  for (const label of ["1:1", "9:16", "4:5"]) {
    await radio(page, label).click();
    await expect(radio(page, label)).toHaveAttribute("aria-checked", "true");
    await page.mouse.move(1400, 880);
    expect(await chipBoxes(page)).toEqual(start);
  }
});

// M3.
test("the one-format popover opens only for its own chip, never over a Not in v2 tooltip, and closes on Esc and after a click", async ({ page, rushes, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await rushes.addFormatsCut(FOUR);
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  const pop = page.locator(".fmtpop");
  await radio(page, "9:16").hover();
  await expect(radio(page, "9:16")).toHaveAttribute("data-tip", "Not in v2");
  await page.waitForTimeout(200);
  await expect(pop).toHaveCSS("opacity", "0");
  await radio(page, "16:9").hover();
  await expect(pop).toHaveCSS("opacity", "1");
  // Into the popover and click Copy: it stays while the pointer is over it, and lets go after.
  const copy = page.getByRole("button", { name: "Copy a prompt for your agent" });
  await copy.hover();
  await copy.click();
  await expect(page.locator(".toast")).toHaveText(/Prompt copied|Couldn't reach the clipboard/);
  await expect(copy).not.toBeFocused();
  await expect(pop).toHaveCSS("opacity", "1");
  await page.mouse.move(1400, 880);
  await expect(pop).toHaveCSS("opacity", "0");
  // From the keyboard: focus opens it, Esc closes it.
  await copy.focus();
  await expect(pop).toHaveCSS("opacity", "1");
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCSS("opacity", "0");
  // Hovering the chip again after Esc opens it again.
  await radio(page, "16:9").hover();
  await expect(pop).toHaveCSS("opacity", "1");
  // With the popover open from the keyboard, a Not in v2 chip's tooltip still shows uncovered.
  await page.mouse.move(1400, 880);
  await copy.focus();
  await expect(pop).toHaveCSS("opacity", "1");
  await radio(page, "4:5").hover();
  await expect(pop).toHaveCSS("opacity", "0");
});

// M7.
test("focus follows the selection under Alt+arrows, and the warning mark on a selected chip reads at 4.5:1 or more", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL, { ...SQUARE, seconds: 4.5 }]);
  await page.goto(rushes.url);
  await videoReady(page);
  await radio(page, "16:9").focus();
  await page.keyboard.press("Home");
  await expect(radio(page, "9:16")).toBeFocused();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(radio(page, "1:1")).toHaveAttribute("aria-checked", "true");
  await expect(radio(page, "1:1")).toBeFocused();
  await expect(radio(page, "1:1")).toHaveAttribute("tabindex", "0");
  const contrast = await radio(page, "1:1").evaluate((chip) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const fg = lum(rgb(getComputedStyle(chip.querySelector(".warn")!).color));
    const bg = lum(rgb(getComputedStyle(chip).backgroundColor));
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
});
