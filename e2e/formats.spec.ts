import { readFile, rm, writeFile } from "node:fs/promises";
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
  // Kept, but hidden: no proxy is offered for another format's file (review M4).
  await expect(page.locator(".proxybar")).toBeHidden();
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
  const floor = () => page.locator(".stack").evaluate((el) => parseFloat((el as HTMLElement).style.getPropertyValue("--player-floor")));
  await expect.poll(floor).toBeGreaterThan(0);
  const onPrimary = await floor();
  await radio(page, "9:16").click();
  await expect(page.locator(".proxybar")).toBeHidden();
  // The hidden proxy bar takes no room, so the column's floor shrinks by its height, never grows (review M4).
  expect(await page.locator(".proxybar").evaluate((el) => { el.hidden = false; const h = el.getBoundingClientRect().height; el.hidden = true; return h; })).toBeGreaterThan(0);
  await expect.poll(floor).toBeLessThan(onPrimary);
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

// M1.
test("a remembered format whose file has gone keeps its shape after a film switch and after a version change", async ({ page, rushes }) => {
  const v1 = await rushes.addFormatsCut([WIDE, TALL]);
  const v2 = await rushes.addFormatsCut([WIDE, TALL]);
  await rushes.addCut(undefined, "Teaser");
  await rm(join(rushes.root, v2.version.formats[0].file));
  await page.goto(rushes.url);
  await videoReady(page);
  const ratio = async () => {
    const b = (await page.locator(".frame").boundingBox())!;
    return b.width / b.height;
  };
  await radio(page, "9:16").click();
  await expect(page.locator(".frame .msg")).toHaveText("File not found");
  await expect.poll(ratio).toBeCloseTo(180 / 320, 1);
  // Away and back: Picture mounts afresh on 9:16, whose file never loads.
  const films = page.getByRole("navigation", { name: "Films" });
  await films.getByRole("button", { name: /Teaser/ }).click();
  await videoReady(page);
  // The very first frame painted after the remount is already 9:16, not 16:9 corrected later.
  const first = await page.evaluate(async () => {
    const hero = [...document.querySelectorAll<HTMLButtonElement>('nav[aria-label="Films"] button')].find((b) => /Hero/.test(b.textContent ?? ""))!;
    hero.click();
    await new Promise((r) => requestAnimationFrame(r));
    const b = document.querySelector(".frame")!.getBoundingClientRect();
    return b.width / b.height;
  });
  expect(first).toBeCloseTo(180 / 320, 1);
  await expect(radio(page, "9:16")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".frame .msg")).toHaveText("File not found");
  await expect.poll(ratio).toBeCloseTo(180 / 320, 1);
  // v1's 9:16 plays; back on v2 the missing one keeps the shape too.
  await page.getByRole("combobox", { name: "Version" }).selectOption(v1.version.id);
  await expect(page.locator("video")).toHaveAttribute("src", /hero_v1_180x320\.mp4/);
  await videoReady(page);
  await page.getByRole("combobox", { name: "Version" }).selectOption(v2.version.id);
  await expect(page.locator(".frame .msg")).toHaveText("File not found");
  await page.waitForTimeout(300);
  expect(await ratio()).toBeCloseTo(180 / 320, 1);
});

// M2, R2.
test("a cut stored with no size, playing its proxy, still gets its single chip and the Copy prompt", async ({ page, rushes }) => {
  await rushes.addProResCut({ seconds: 2 });
  await rushes.api("POST", "/api/videos/hero/versions/v1/proxy", {});
  await expect.poll(async () => (await rushes.api("GET", "/api/state")).project.videos[0].versions[0].proxy !== null, { timeout: 20_000 }).toBe(true);
  // As a 0.2.x file has it: no stored size.
  const file = join(rushes.root, ".rushes", "project.json");
  const project = JSON.parse(await readFile(file, "utf8"));
  delete project.videos[0].versions[0].width;
  delete project.videos[0].versions[0].height;
  project.rev += 1;
  await writeFile(file, JSON.stringify(project, null, 2));
  await expect.poll(async () => (await rushes.api("GET", "/api/state")).project.videos[0].versions[0].width, { timeout: 10_000 }).toBeNull();
  await page.goto(rushes.url);
  await expect(page.getByRole("button", { name: "Proxy", exact: true })).toHaveAttribute("aria-pressed", "true");
  const chip = page.getByRole("radiogroup", { name: "Format" }).getByRole("radio");
  await expect(chip).toHaveText(/^16:9/);
  await expect(chip).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("button", { name: "Copy a prompt for your agent" })).toHaveCount(1);
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

// M4.
test("leaving the primary and coming back keeps the proxy bar itself, never a new one", async ({ page, rushes }) => {
  await rushes.addProResCut({ seconds: 2 });
  await rushes.addFormatFile({ width: 360, height: 640, seconds: 2 });
  await page.goto(rushes.url);
  const bar = page.locator(".proxybar");
  await expect(bar).toBeVisible();
  await bar.evaluate((el) => { (el as HTMLElement).dataset.kept = "yes"; });
  await radio(page, "9:16").click();
  await expect(bar).toBeHidden();
  await radio(page, "16:9").click();
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("data-kept", "yes");
});

// M5.
test("leaving a render that won't play never shows its message on the next one, even for a frame", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await rushes.addFormatsCut([WIDE, { ...TALL, codec: "mpeg2" }]);
  await page.goto(rushes.url);
  await videoReady(page);
  await radio(page, "9:16").click();
  await expect(page.locator(".frame .msg")).toHaveText("This file won't play in a browser. Ask your agent for an H.264 MP4 of this format.");
  // To v1's 9:16, which plays: the same shape, so nothing else re-renders the player first.
  // Sampled before each of the next frames is painted, starting with the first after the change.
  const frames = await page.evaluate(async () => {
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Version"]')!;
    select.value = "v1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      seen.push(document.querySelector(".frame .msg")?.textContent ?? "");
    }
    return seen;
  });
  expect(frames).toEqual(new Array(12).fill(""));
  await expect(page.locator("video")).toHaveAttribute("src", /hero_v1_180x320\.mp4/);
  // And back on v2 the broken one still says so.
  await page.getByRole("combobox", { name: "Version" }).selectOption("v2");
  await expect(page.locator(".frame .msg")).toHaveText(/won't play/);
});

// M6.
test("a format longer than the cut stops at the cut's end, and the playhead never runs past the timeline", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, { ...SQUARE, seconds: 4.5 }]);
  await page.goto(rushes.url);
  await videoReady(page);
  await radio(page, "1:1").click();
  await videoReady(page);
  const track = (await page.locator(".track").boundingBox())!;
  await page.mouse.click(track.x + track.width * 0.9, track.y + track.height / 2);
  await expect(page.getByLabel("Timecode")).toContainText("0:03.6");
  await page.keyboard.press(" ");
  const video = page.locator("video");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused && v.currentTime > 3.9), { timeout: 5_000 }).toBe(true);
  await page.waitForTimeout(300);
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused && v.currentTime <= 4.0 + 1e-3)).toBe(true);
  await expect(page.getByLabel("Timecode")).toContainText("0:04.00");
  const left = await page.locator(".playhead").evaluate((el) => parseFloat((el as HTMLElement).style.left));
  expect(left).toBeLessThanOrEqual(100);
  // Play again from the end starts from the top, as the cut itself does.
  await page.keyboard.press(" ");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime < 1)).toBe(true);
  await page.keyboard.press(" ");
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

// M9.
test("Alt+arrows do nothing off the Picture tab, and the radio group never wraps them (R1)", async ({ page, rushes }) => {
  await rushes.addFormatsCut(FOUR);
  await page.goto(rushes.url);
  await videoReady(page);
  await page.keyboard.press("7");
  await expect(page.getByRole("tab", { name: /Assets/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.press("2");
  await videoReady(page);
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  // Focus on the last chip: Alt+→ stays there, where the group's own → would wrap to 9:16.
  await radio(page, "16:9").focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Home");
  await expect(radio(page, "9:16")).toBeFocused();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(radio(page, "9:16")).toHaveAttribute("aria-checked", "true");
});

// M7: chips are keyed, so a format registered mid-review never moves focus onto another chip.
test("a format arriving while a chip has focus leaves focus on that chip", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await page.goto(rushes.url);
  await videoReady(page);
  await radio(page, "16:9").focus();
  await rushes.addFormatFile(PORTRAIT);
  await expect(page.getByRole("radiogroup", { name: "Format" }).getByRole("radio")).toHaveText([/^9:16/, /^4:5/, /^16:9/]);
  await expect(radio(page, "16:9")).toBeFocused();
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
});

// ---- Task 5: notes per format (§21.2 (4)–(6), §21.5 Notes) ----

const notesOf = async (rushes: { api: (m: string, p: string) => Promise<any> }) => (await rushes.api("GET", "/api/notes?stage=picture")).notes as any[];
const BOX_REASON = "A drawn box belongs to one frame, so this note stays on this format.";

test("a note written on 9:16 stays on 9:16; an all-format note shows on every format; markers and counts follow", async ({ page, rushes }) => {
  await rushes.addFormatsCut(FOUR);
  await page.goto(rushes.url);
  await videoReady(page);
  const scope = page.getByRole("radiogroup", { name: "This note applies to" });
  await expect(scope.getByRole("radio", { name: "This format, 16:9" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".fhint")).toHaveText("Shows only while you're viewing 16:9.");
  await radio(page, "9:16").click();
  await expect(scope.getByRole("radio", { name: "This format, 9:16" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("n");
  await page.keyboard.type("Logo sits too close to the top edge.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".list > .note .ftag")).toHaveText(["9:16"]);
  await scope.getByRole("radio", { name: "All formats" }).click();
  await expect(page.locator(".fhint")).toHaveText("Shows on every format.");
  await page.keyboard.press("n");
  await page.keyboard.type("Drop the first sound.");
  await page.keyboard.press("Enter");
  // Every new note starts on This format again: nothing is remembered between notes.
  await expect(page.locator(".list > .note")).toHaveCount(2);
  await expect(scope.getByRole("radio", { name: /^This format/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".fhint")).toHaveText("Shows only while you're viewing 9:16.");
  expect((await notesOf(rushes)).map((n) => [n.text, n.format]).sort()).toEqual([["Drop the first sound.", null], ["Logo sits too close to the top edge.", "9x16"]]);
  // A chip counts its own notes and the all-format ones.
  await expect(radio(page, "9:16")).toHaveAccessibleName("9:16, 2 open notes");
  await expect(radio(page, "16:9")).toHaveAccessibleName("16:9, 1 open note");
  await expect(radio(page, "4:5")).toHaveAccessibleName("4:5, 1 open note");
  await expect(page.locator(".track .mk")).toHaveCount(2);
  await expect(page.locator(".track .mk.ring")).toHaveCount(1);
  await expect(page.locator(".track .mk.ring")).toHaveAttribute("title", "All · Drop the first sound.");
  await expect(page.locator(".track .mk:not(.ring)")).toHaveAttribute("title", "9:16 · Logo sits too close to the top edge.");
  // Type is 15 px or larger: the switch, the hint and the tags.
  const sizes = await page.locator(".fscope [role=radio], .fhint, .list .ftag").evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
  expect(sizes.length).toBeGreaterThanOrEqual(5);
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(15);
  await radio(page, "16:9").click();
  await expect(page.locator(".list > .note .nx")).toHaveText(["Drop the first sound."]);
  await expect(page.locator(".list > .note .ftag.all")).toHaveText("All");
  await expect(page.locator(".track .mk")).toHaveCount(1);
  await expect(page.locator(".track .mk.ring")).toHaveCount(1);
  await radio(page, "9:16").click();
  await expect(page.locator(".track .mk")).toHaveCount(2);
  await expect(page.locator(".track .mk.ring")).toHaveCount(1);
});

test("one format: no switch in the composer, notes save for the whole cut, and nothing new shows", async ({ page, rushes }) => {
  // The carried ruling: no request on a one-format cut carries `format` at all, not even null.
  const bodies: Record<string, unknown>[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/notes") bodies.push(r.postDataJSON());
  });
  const seen = watchFormatRequests(page);
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(page.getByRole("radiogroup", { name: "This note applies to" })).toHaveCount(0);
  await expect(page.locator(".fhint")).toHaveCount(0);
  await drawBox(page);
  await page.keyboard.press("n");
  await page.keyboard.type("Hold longer.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(1);
  await expect(page.locator(".note .ftag")).toHaveCount(0);
  await expect(page.locator(".track .mk.ring")).toHaveCount(0);
  await expect(page.locator(".track .mk")).toHaveAttribute("title", "Hold longer.");
  await expect(page.locator(".otherrow")).toHaveCount(0);
  await page.locator(".note .t").click();
  await expect(page.locator(".note .fscope")).toHaveCount(0);
  await expect(page.locator(".frame .bx.saved")).toHaveCount(1);
  const [saved] = await notesOf(rushes);
  expect(saved.format).toBeNull();
  expect(saved.box).not.toBeNull();
  expect(bodies).toHaveLength(1);
  expect("format" in bodies[0]).toBe(false);
  expect(seen).toEqual([]);
});

test("a boxed note stays on its format: the composer locks to This format and the card can't widen it; others widen and narrow", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await page.goto(rushes.url);
  await videoReady(page);
  const scope = page.getByRole("radiogroup", { name: "This note applies to" });
  await scope.getByRole("radio", { name: "All formats" }).click();
  await drawBox(page);
  // Drawing a box puts the note back on This format, and All formats says why it can't be chosen.
  await expect(scope.getByRole("radio", { name: /^This format/ })).toHaveAttribute("aria-checked", "true");
  await expect(scope.getByRole("radio", { name: "All formats" })).toHaveAttribute("aria-disabled", "true");
  await expect(scope.getByRole("radio", { name: "All formats" })).toHaveAccessibleDescription(BOX_REASON);
  await expect(page.locator(".fhint")).toHaveText("A drawn box fixes this note to 16:9.");
  await scope.getByRole("radio", { name: "All formats" }).click({ force: true });
  await expect(scope.getByRole("radio", { name: /^This format/ })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("n");
  await page.keyboard.type("Title safe.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".list > .note")).toHaveCount(1);
  await scope.getByRole("radio", { name: "All formats" }).click();
  await page.keyboard.press("n");
  await page.keyboard.type("Hold longer.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".list > .note")).toHaveCount(2);
  const byText = async (t: string) => (await notesOf(rushes)).find((n) => n.text === t);
  expect(await byText("Title safe.")).toMatchObject({ format: "16x9", box: expect.any(Object) });
  expect((await byText("Hold longer.")).format).toBeNull();
  const card = page.locator(".list > .note", { hasText: "Hold longer." });
  await expect(card.locator(".fscope")).toHaveCount(0); // only the selected card has the switch
  await card.locator(".t").click();
  const cardScope = card.getByRole("radiogroup", { name: "Note applies to" });
  await expect(cardScope.getByRole("radio", { name: "All formats" })).toHaveAttribute("aria-checked", "true");
  await cardScope.getByRole("radio", { name: /^This format/ }).click();
  await expect.poll(async () => (await byText("Hold longer.")).format).toBe("16x9");
  await expect(card.locator(".ftag")).toHaveText("16:9");
  await expect(page.locator(".track .mk.ring")).toHaveCount(0);
  await cardScope.getByRole("radio", { name: "All formats" }).click();
  await expect.poll(async () => (await byText("Hold longer.")).format).toBeNull();
  await expect(card.locator(".ftag.all")).toHaveText("All");
  const boxed = page.locator(".list > .note", { hasText: "Title safe." });
  await boxed.locator(".t").click();
  await expect(page.locator(".frame .bx.saved")).toHaveCount(1);
  const all = boxed.getByRole("radiogroup", { name: "Note applies to" }).getByRole("radio", { name: "All formats" });
  await expect(all).toHaveAttribute("aria-disabled", "true");
  await expect(all).toHaveAttribute("data-tip", BOX_REASON);
  await expect(all).toHaveAccessibleDescription(BOX_REASON);
  await all.click({ force: true });
  await expect(all).toHaveAttribute("aria-checked", "false");
  expect((await byText("Title safe.")).format).toBe("16x9");
  // The server refuses it too.
  const res = await fetch(`${rushes.base}/api/notes/${(await byText("Title safe.")).id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: null }) });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("box_needs_format");
});

test("notes of other formats wait in a quiet row, read only, with a button that switches to their format", async ({ page, rushes }) => {
  await rushes.addFormatsCut(FOUR);
  const add = (t: number, text: string, format: string) => rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t, text, format });
  await add(1, "Logo sits too close to the top edge.", "9x16");
  await add(2, "Rows land late against the beat.", "9x16");
  await add(3, "End card cropped at the bottom.", "4x5");
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(page.locator(".list .none")).toHaveText("None on this format.");
  const row = page.getByRole("button", { name: "Other formats (3)" });
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".otherfmts .note")).toHaveCount(0);
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  const ro = page.locator(".otherfmts .note");
  await expect(ro).toHaveCount(3);
  await expect(ro.locator(".chk")).toHaveCount(0);
  await expect(ro.locator("button.t")).toHaveCount(0);
  await expect(ro.locator(".ftag")).toHaveText(["9:16", "9:16", "4:5"]);
  const sizes = await page.locator(".otherrow, .otherfmts .t, .otherfmts .ftag, .otherfmts .nx, .otherfmts .flink").evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
  expect(sizes.length).toBeGreaterThanOrEqual(13);
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(15);
  // Review I1: a read-only time doesn't look like the list's clickable one.
  const colour = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).color);
  expect(await colour(".otherfmts .t")).toBe("rgb(163, 166, 173)");
  // Read only: the time doesn't seek, and nothing there selects.
  await ro.filter({ hasText: "Rows land late" }).locator(".t").click();
  await expect(page.getByLabel("Timecode")).toContainText("0:00.00");
  await expect(page.locator(".track .mk")).toHaveCount(0);
  await ro.filter({ hasText: "End card cropped" }).getByRole("button", { name: "Show on 4:5" }).click();
  await expect(radio(page, "4:5")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".list > .note .nx")).toHaveText(["End card cropped at the bottom."]);
  await expect(page.locator(".otherrow")).toContainText("Other formats (2)");
  await expect(page.locator(".track .mk")).toHaveCount(1);
  await page.getByRole("button", { name: "Other formats (2)" }).click();
  await expect(page.locator(".otherfmts .note")).toHaveCount(0);
});

test("switching lets go of a selected note that doesn't show on the new format (R6)", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Logo edge.", format: "9x16" });
  await page.goto(rushes.url);
  await videoReady(page);
  await radio(page, "9:16").click();
  await page.locator(".list > .note", { hasText: "Logo edge." }).locator(".t").click();
  await expect(page.locator('.note[aria-current="true"]')).toHaveCount(1);
  await radio(page, "16:9").click();
  await radio(page, "9:16").click();
  await expect(page.locator(".list > .note", { hasText: "Logo edge." })).toHaveCount(1);
  await expect(page.locator('.note[aria-current="true"]')).toHaveCount(0);
  await expect(page.locator(".list .fscope")).toHaveCount(0);
});

// Review Focus 1.
test("a boxed note from before formats keeps showing everywhere, but draws its box on the primary only", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Old boxed note.", box: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } });
  await rushes.addFormatFile(TALL);
  await page.goto(rushes.url);
  await videoReady(page);
  const card = page.locator(".list > .note", { hasText: "Old boxed note." });
  await expect(card.locator(".ftag.all")).toHaveText("All");
  await card.locator(".t").click();
  await expect(page.locator(".frame .bx.saved")).toHaveCount(1);
  await radio(page, "9:16").click();
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".frame .bx.saved")).toHaveCount(0);
  // Its box was drawn on 16:9, so narrowing it to 9:16 is refused, in plain words.
  await card.getByRole("radiogroup", { name: "Note applies to" }).getByRole("radio", { name: /^This format/ }).click();
  await expect(page.locator(".toast")).toHaveText("Couldn't change that note: A drawn box belongs to the frame it was drawn on (16:9), so this note stays there.");
  expect((await notesOf(rushes))[0].format).toBeNull();
});

test("the server's refusal of a narrowed note shows as a plain message, and the note is unchanged", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "From the first cut." });
  await rushes.addFormatsCut([WIDE, TALL]);
  await page.goto(rushes.url);
  await videoReady(page);
  await radio(page, "9:16").click();
  const card = page.locator(".list > .note", { hasText: "From the first cut." });
  await expect(card.locator(".from")).toHaveText(/^from v1/);
  await card.locator(".t").click();
  await card.getByRole("radiogroup", { name: "Note applies to" }).getByRole("radio", { name: /^This format/ }).click();
  await expect(page.locator(".toast")).toHaveText("Couldn't change that note: v1 has no 9:16 format.");
  await expect(card.getByRole("radiogroup", { name: "Note applies to" }).getByRole("radio", { name: "All formats" })).toHaveAttribute("aria-checked", "true");
  expect((await notesOf(rushes))[0].format).toBeNull();
});

// Review Focus 3, §21.8 (3).
test("a half-typed note, its All formats choice and a drawn box all survive a format switch; the box keeps its format", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Logo edge.", format: "9x16" });
  await page.goto(rushes.url);
  await videoReady(page);
  const scope = page.getByRole("radiogroup", { name: "This note applies to" });
  const textbox = page.getByRole("textbox", { name: "New note" });
  await scope.getByRole("radio", { name: "All formats" }).click();
  await page.keyboard.press("n");
  await page.keyboard.type("Half a thought");
  await page.getByRole("button", { name: "Other formats (1)" }).click();
  await page.getByRole("button", { name: "Show on 9:16" }).click();
  await expect(radio(page, "9:16")).toHaveAttribute("aria-checked", "true");
  await expect(textbox).toHaveValue("Half a thought");
  await expect(scope.getByRole("radio", { name: "All formats" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".fhint")).toHaveText("Shows on every format.");
  // A box drawn on 9:16 belongs to 9:16: no switch moves it to another shape.
  await textbox.press("Escape");
  await drawBox(page);
  await expect(page.locator(".fhint")).toHaveText("A drawn box fixes this note to 9:16.");
  await radio(page, "16:9").click();
  await expect(page.locator(".toast")).toHaveText("Add or clear your box on 9:16 first");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(radio(page, "9:16")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".frame .bx:not(.saved)")).toHaveCount(1);
  await expect(textbox).toHaveValue("Half a thought");
  await textbox.click();
  await page.keyboard.press("Enter");
  await expect(page.locator(".list > .note")).toHaveCount(2);
  const saved = (await notesOf(rushes)).find((n) => n.text === "Half a thought");
  expect(saved).toMatchObject({ format: "9x16", box: expect.any(Object) });
});

test("the composer's and the card's switches work from the keyboard, and their keys never reach the player", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await page.goto(rushes.url);
  await videoReady(page);
  const scope = page.getByRole("radiogroup", { name: "This note applies to" });
  const thisR = scope.getByRole("radio", { name: /^This format/ });
  const allR = scope.getByRole("radio", { name: "All formats" });
  await expect(thisR).toHaveAttribute("tabindex", "0");
  await expect(allR).toHaveAttribute("tabindex", "-1");
  await thisR.focus();
  await page.keyboard.press("ArrowRight");
  await expect(allR).toHaveAttribute("aria-checked", "true");
  await expect(allR).toBeFocused();
  await expect(allR).toHaveAttribute("tabindex", "0");
  await expect(page.getByLabel("Timecode")).toContainText("0:00.00"); // no frame step
  await page.keyboard.press("Home");
  await expect(thisR).toHaveAttribute("aria-checked", "true");
  await expect(thisR).toBeFocused();
  await page.keyboard.press("End");
  await expect(allR).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(thisR).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowDown");
  await expect(allR).toHaveAttribute("aria-checked", "true");
  // Neither the frame step nor Alt-free arrows on the format toggle saw any of that.
  await expect(page.getByLabel("Timecode")).toContainText("0:00.00");
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("n");
  await page.keyboard.type("Everywhere.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".list > .note")).toHaveCount(1);
  expect((await notesOf(rushes))[0].format).toBeNull();
  // Drawing a box puts the note on This format; the arrows can't reach All formats, and removing
  // the box leaves This format chosen.
  await page.keyboard.press("Escape");
  await allR.click();
  await expect(allR).toHaveAttribute("aria-checked", "true");
  await drawBox(page);
  await thisR.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("End");
  await expect(thisR).toHaveAttribute("aria-checked", "true");
  await expect(thisR).toBeFocused();
  await page.getByRole("button", { name: "Remove box" }).click();
  await expect(thisR).toHaveAttribute("aria-checked", "true");
  await expect(allR).not.toHaveAttribute("aria-disabled", "true");
  // The card's switch: narrow, then widen, by keys alone.
  await page.locator(".list > .note .t").click();
  const card = page.locator(".list > .note").getByRole("radiogroup", { name: "Note applies to" });
  await card.getByRole("radio", { name: "All formats" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await notesOf(rushes))[0].format).toBe("16x9");
  await expect(card.getByRole("radio", { name: /^This format/ })).toBeFocused();
  await page.keyboard.press("End");
  await expect.poll(async () => (await notesOf(rushes))[0].format).toBeNull();
  await expect(page.getByLabel("Timecode")).toContainText("0:00.00");
});

test("a new cut starts its composer on This format again", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await page.goto(rushes.url);
  await videoReady(page);
  const scope = page.getByRole("radiogroup", { name: "This note applies to" });
  await scope.getByRole("radio", { name: "All formats" }).click();
  await expect(scope.getByRole("radio", { name: "All formats" })).toHaveAttribute("aria-checked", "true");
  await rushes.addFormatsCut([WIDE, TALL]);
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v2");
  await expect(scope.getByRole("radio", { name: /^This format/ })).toHaveAttribute("aria-checked", "true");
});

// ---- Task 5 review, fix round 1 ----

const filmProject = (rushes: { root: string }) => join(rushes.root, ".rushes", "project.json");

// I2, R17: a note whose format has gone from its own cut can be restored to every format.
test("a note whose format has gone from its cut offers Restore to all formats, and then shows as All", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL, SQUARE]);
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Square crop is tight.", format: "1x1" });
  // A hand edit takes 1:1 off the cut.
  const file = filmProject(rushes);
  const project = JSON.parse(await readFile(file, "utf8"));
  project.videos[0].versions[0].formats = project.videos[0].versions[0].formats.filter((f: { id: string }) => f.id !== "1x1");
  project.rev += 1;
  await writeFile(file, JSON.stringify(project, null, 2));
  await expect.poll(async () => (await rushes.api("GET", "/api/state")).project.videos[0].versions[0].formats.length, { timeout: 10_000 }).toBe(1);
  await page.goto(rushes.url);
  await videoReady(page);
  await page.getByRole("button", { name: "Other formats (1)" }).click();
  const row = page.locator(".otherfmts .note", { hasText: "Square crop is tight." });
  await expect(row.getByRole("button")).toHaveText(["Restore to all formats"]);
  await row.getByRole("button", { name: "Restore to all formats" }).click();
  await expect.poll(async () => (await notesOf(rushes))[0].format).toBeNull();
  const card = page.locator(".list > .note", { hasText: "Square crop is tight." });
  await expect(card.locator(".ftag.all")).toHaveText("All");
  await expect(page.locator(".otherrow")).toHaveCount(0);
  // M3: focus lands on the note, not the page.
  await expect(card.locator(".t")).toBeFocused();
});

// I2, R17: a v1 9:16 note on a v2 without 9:16 is read only: its format is still its own cut's.
test("an older cut's note for a format the newer cut lacks is read only, with nothing to press", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Logo edge on the tall one.", format: "9x16" });
  await rushes.addFormatsCut([WIDE, SQUARE]);
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v2");
  await page.getByRole("button", { name: "Other formats (1)" }).click();
  const row = page.locator(".otherfmts .note", { hasText: "Logo edge on the tall one." });
  await expect(row.locator(".ftag")).toHaveText("9:16");
  await expect(row.getByRole("button")).toHaveCount(0);
  expect((await notesOf(rushes))[0].format).toBe("9x16");
});

// M2: a ring and a dot at the same moment can both be pointed at.
test("an all-format note and a format note at the same moment are both reachable on the timeline", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  const add = (text: string, format: string | null) => rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 2, text, format });
  await add("Everywhere at two.", null);
  await add("Tall at two.", "9x16");
  await page.goto(rushes.url);
  await videoReady(page);
  await radio(page, "9:16").click();
  await expect(page.locator(".track .mk")).toHaveCount(2);
  const hits = await page.evaluate(() => {
    const ring = document.querySelector(".track .mk.ring")!.getBoundingClientRect();
    const dot = document.querySelector(".track .mk:not(.ring)")!.getBoundingClientRect();
    const at = (x: number, y: number) => (document.elementFromPoint(x, y) as HTMLElement | null)?.title ?? null;
    return { centre: at(dot.x + dot.width / 2, dot.y + dot.height / 2), band: at(ring.x + ring.width / 2 + 6, ring.y + ring.height / 2), ringSize: ring.width };
  });
  expect(hits.centre).toBe("9:16 · Tall at two.");
  expect(hits.band).toBe("All · Everywhere at two.");
  expect(hits.ringSize).toBe(14);
});

// M3: "Show on 9:16" and Alt+arrows from a card never drop focus to the page.
test("after Show on 9:16, and after Alt+arrows from a card's switch, focus stays with the note", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  const add = (t: number, text: string, format: string | null) => rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t, text, format });
  await add(0.5, "Tall only.", "9x16");
  await add(1, "Everywhere.", null);
  await add(2, "Wide only.", "16x9");
  await page.goto(rushes.url);
  await videoReady(page);
  await page.getByRole("button", { name: "Other formats (1)" }).click();
  await page.getByRole("button", { name: "Show on 9:16" }).click();
  await expect(radio(page, "9:16")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".list > .note", { hasText: "Tall only." }).locator(".t")).toBeFocused();
  // A note that shows on both keeps its switch, and focus, across the switch, though its place in
  // the list changes (second on 9:16, first on 16:9).
  const everywhere = page.locator(".list > .note", { hasText: "Everywhere." });
  await everywhere.locator(".t").click();
  await everywhere.getByRole("radio", { name: "All formats" }).focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await expect(everywhere.getByRole("radio", { name: "All formats" })).toBeFocused();
  // A note that doesn't show on the next format: focus goes to the row it now waits in.
  const wide = page.locator(".list > .note", { hasText: "Wide only." });
  await wide.locator(".t").click();
  await wide.getByRole("radio", { name: /^This format/ }).focus();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(radio(page, "9:16")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".otherrow")).toBeFocused();
});

// M4: an agent narrowing the selected note away lets go of the selection.
test("a selected note narrowed away by an agent is let go, and isn't selected on its new format", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  const { note } = await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Move the logo.", format: null });
  await page.goto(rushes.url);
  await videoReady(page);
  await page.locator(".list > .note", { hasText: "Move the logo." }).locator(".t").click();
  await expect(page.locator('.note[aria-current="true"]')).toHaveCount(1);
  await rushes.api("PATCH", `/api/notes/${note.id}`, { format: "9x16" });
  await expect(page.locator(".list > .note", { hasText: "Move the logo." })).toHaveCount(0);
  await radio(page, "9:16").click();
  await expect(page.locator(".list > .note", { hasText: "Move the logo." })).toHaveCount(1);
  await expect(page.locator('.note[aria-current="true"]')).toHaveCount(0);
});

// M5: the card's switch moves at once, so a second key press never repeats the request.
test("two quick presses on the card's switch send one request", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Everywhere.", format: null });
  const patches: string[] = [];
  // The first request is held until the switch has been seen to move, so nothing here can race it.
  let release: () => void = () => undefined;
  const held = new Promise<void>((ok) => { release = ok; });
  await page.route("**/api/notes/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    patches.push(route.request().postData() ?? "");
    await held;
    await route.continue();
  });
  await page.goto(rushes.url);
  await videoReady(page);
  const card = page.locator(".list > .note", { hasText: "Everywhere." });
  await card.locator(".t").click();
  await card.getByRole("radio", { name: "All formats" }).focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  // It moves at once, before the server has answered.
  await expect(card.getByRole("radio", { name: /^This format/ })).toHaveAttribute("aria-checked", "true");
  expect((await notesOf(rushes))[0].format).toBeNull();
  release();
  await expect.poll(async () => (await notesOf(rushes))[0].format).toBe("16x9");
  await expect(card.locator(".ftag")).toHaveText("16:9");
  expect(patches).toEqual([JSON.stringify({ format: "16x9" })]);
});

// M6: the row counts, and lists, what the active filter would.
test("the Other formats row follows the To do and Done filter", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL]);
  const add = (t: number, text: string) => rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t, text, format: "9x16" });
  await add(1, "Still to do.");
  const { note } = await add(2, "Already done.");
  await rushes.api("PATCH", `/api/notes/${note.id}`, { status: "done" });
  await page.goto(rushes.url);
  await videoReady(page);
  const filter = page.getByRole("group", { name: "Filter notes" });
  await expect(page.locator(".otherrow")).toContainText("Other formats (2)");
  await filter.getByRole("button", { name: /^To do/ }).click();
  await expect(page.locator(".otherrow")).toContainText("Other formats (1)");
  await page.locator(".otherrow").click();
  await expect(page.locator(".otherfmts .note .nx")).toHaveText(["Still to do."]);
  await filter.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".otherrow")).toContainText("Other formats (1)");
  await expect(page.locator(".otherfmts .note .nx")).toHaveText(["Already done."]);
  await rushes.api("PATCH", `/api/notes/${note.id}`, { status: "todo" });
  await expect(page.locator(".otherrow")).toHaveCount(0);
});
