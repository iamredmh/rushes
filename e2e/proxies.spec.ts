// §36: proxies you can choose and switch on. The Proxies tab next to Activity, the toolbar's Proxies button, "No proxy
// for this cut", the stall hint, and the old per-film switch gone. §37: several qualities, the two Make buttons, the
// ladder that steps down on stalls, the thin row progress line, and a tab that never scrolls sideways.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, hasFfmpeg, openProxiesTab, proxiesButton, shownTip, test, turnProxiesOn, videoReady, type Rushes } from "./fixture.js";

/** The cut's proxies as the server has them. */
const proxiesOf = async (rushes: Rushes, n = 0) => (await rushes.api("GET", "/api/state")).project.videos[0].versions[n].proxies as Record<string, { file: string; preset?: string }>;
/** Waits until the first cut has a proxy at each of `presets`. */
async function proxiesReady(rushes: Rushes, presets: string[]) {
  await expect.poll(async () => Object.keys(await proxiesOf(rushes)).sort().join(","), { timeout: 30_000 }).toBe([...presets].sort().join(","));
}
/** Two waits of over a second each, as a slow link gives them. */
async function stallTwice(page: Page) {
  for (let i = 0; i < 2; i++) {
    await page.locator("video").evaluate((v) => v.dispatchEvent(new Event("waiting")));
    await page.waitForTimeout(1300);
  }
}
/** Whether a button is filled with the desk's accent blue. */
const isAccent = (b: Locator) =>
  b.evaluate((el) => {
    const probe = document.createElement("i");
    probe.style.color = "var(--accent)";
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return getComputedStyle(el).backgroundColor === accent;
  });

test.describe("proxies you can choose and switch on (§36)", () => {
  test.skip(!hasFfmpeg, "needs ffmpeg and ffprobe");

  test("the Proxies tab sits after Activity, with four quality checkboxes, 1080p Low ticked, and the two Make buttons", async ({ page, rushes }) => {
    await rushes.addCut();
    await page.goto(rushes.url);
    const tabs = page.getByRole("tablist", { name: "Notes panel" }).getByRole("tab");
    await expect(tabs).toHaveText(["Notes", "Activity", "Proxies"]);
    const panel = await openProxiesTab(page);
    const presets = panel.getByRole("group", { name: "Quality" }).getByRole("checkbox");
    await expect(presets).toHaveCount(4);
    await expect(panel.getByRole("radio")).toHaveCount(0);
    await expect(panel.getByRole("checkbox", { name: /1080p Low/ })).toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /720p Low/ })).not.toBeChecked();
    await expect(panel.getByText("Sharp picture, plays on a slow connection (≈5 Mbps)")).toBeVisible();
    await expect(panel.getByRole("switch", { name: "Always make proxies for this project" })).toHaveAttribute("aria-checked", "false");
    await expect(panel.getByRole("button", { name: /Make proxies for this cut/ })).toContainText("1");
    await expect(panel.getByRole("button", { name: /Make proxies for all films/ })).toContainText("1");
    // The arrows move across the three tabs.
    await page.getByRole("tab", { name: "Proxies" }).press("ArrowLeft");
    await expect(page.getByRole("tab", { name: /^Activity/ })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: /^Activity/ }).press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Proxies" })).toHaveAttribute("aria-selected", "true");
  });

  test("the Proxies tab works in the narrow drawer too", async ({ page, rushes }) => {
    await rushes.addCut();
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(rushes.url);
    await page.getByRole("button", { name: /Show the notes panel/ }).click();
    const panel = await openProxiesTab(page);
    await expect(page.locator(".npanel.drawer")).toBeVisible();
    await expect(panel.getByRole("checkbox", { name: /720p Low/ })).toBeVisible();
  });

  test("ticking 1080p Low and 720p Low, then Make proxies for this cut, makes both; the row's progress is a 4 px line", async ({ page, rushes }) => {
    await rushes.addProResCut({ long: true });
    await page.goto(rushes.url);
    await videoReady(page);
    const panel = await openProxiesTab(page);
    await panel.getByRole("checkbox", { name: /720p Low/ }).check();
    await expect.poll(async () => (await rushes.api("GET", "/api/state")).project.proxyPresets).toEqual(["1080l", "720l"]);
    const row = panel.locator(".proxrow", { hasText: "Hero · v1" });
    await expect(row).toContainText("No proxy");
    await expect(row.getByRole("button", { name: "Make the 1080p Low proxy for Hero · v1" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Make the 720p Low proxy for Hero · v1" })).toBeVisible();
    const forCut = panel.getByRole("button", { name: /Make proxies for this cut/ });
    await expect(forCut).toContainText("2");
    await forCut.click();
    // While one is made: the row's bar is a thin line across it, and the player's bar is as it was (8 px, in a row).
    const bar = row.getByRole("progressbar");
    await expect(bar).toBeVisible();
    const rowBar = (await bar.boundingBox())!;
    expect(Math.abs(rowBar.height - 4)).toBeLessThanOrEqual(1);
    expect(rowBar.width).toBeGreaterThan(100);
    await page.screenshot({ path: test.info().outputPath("proxies-row-making.png") });
    const playerBar = page.locator(".monitor .proxybar .pbar");
    if (await playerBar.isVisible()) {
      const pb = (await playerBar.boundingBox())!;
      expect(Math.abs(pb.height - 8)).toBeLessThanOrEqual(1);
      expect(pb.width).toBeGreaterThanOrEqual(120);
    }
    await expect(row).toContainText(/Making (1080p|720p) Low · \d+%|Queued · (1080p|720p) Low/);
    await proxiesReady(rushes, ["1080l", "720l"]);
    const proxies = await proxiesOf(rushes);
    expect(proxies["1080l"]).toMatchObject({ file: "proxies/hero_v1_proxy-1080l.mp4", preset: "1080l" });
    expect(proxies["720l"]).toMatchObject({ file: "proxies/hero_v1_proxy-720l.mp4", preset: "720l" });
    // The list: one line per proxy.
    await expect(row.locator(".pline.ready")).toHaveCount(2);
    await expect(row.locator(".pline").nth(0)).toContainText(/1080p Low · [\d.]+ (KB|MB)/);
    await expect(row.locator(".pline").nth(1)).toContainText(/720p Low · [\d.]+ (KB|MB)/);
    await expect(panel.locator(".proxtotal")).toHaveText(/Proxies use [\d.]+ (KB|MB)/);

    // Unticking deletes nothing: the 720p Low proxy says Not in use.
    await panel.getByRole("checkbox", { name: /720p Low/ }).uncheck();
    await expect(row.locator('.pline[data-preset="720l"]')).toContainText("Not in use");
    expect(Object.keys(await proxiesOf(rushes)).sort()).toEqual(["1080l", "720l"]);
  });

  test("the last ticked quality can't be unticked, and says why", async ({ page, rushes }) => {
    await rushes.addCut();
    await page.goto(rushes.url);
    const panel = await openProxiesTab(page);
    const low = panel.getByRole("checkbox", { name: /1080p Low/ });
    await low.click();
    await expect(low).toBeChecked();
    await expect(panel.getByText("Keep at least one quality ticked.")).toBeVisible();
    expect((await rushes.api("GET", "/api/state")).project.proxyPresets).toEqual(["1080l"]);
  });

  test("both Make buttons are filled blue while there's something to make, and disabled, with the reason, when there isn't", async ({ page, rushes }) => {
    await rushes.addCut();
    await page.goto(rushes.url);
    await videoReady(page);
    const panel = await openProxiesTab(page);
    const forCut = panel.getByRole("button", { name: /Make proxies for this cut/ });
    const forAll = panel.getByRole("button", { name: /Make proxies for all films/ });
    await page.mouse.move(700, 10);
    for (const b of [forCut, forAll]) {
      await expect(b).toHaveAttribute("aria-disabled", "false");
      await expect(b).toHaveClass(/primary/);
      expect(await isAccent(b)).toBe(true);
    }
    await page.screenshot({ path: test.info().outputPath("proxies-tab-make-buttons.png") });
    await forCut.click();
    await proxiesReady(rushes, ["1080l"]);
    for (const b of [forCut, forAll]) {
      await expect(b).toHaveAttribute("aria-disabled", "true");
      await expect(b).not.toHaveClass(/primary/);
    }
    await forCut.hover();
    expect((await shownTip(page)).text).toMatch(/has every ticked quality/);
    await forAll.hover();
    expect((await shownTip(page)).text).toMatch(/Every film's latest cut has the ticked qualities/);
  });

  test("the Proxies tab fits its panel: it never scrolls sideways, in the wide panel or the drawer", async ({ page, rushes }) => {
    await rushes.addCut();
    await rushes.addCut();
    await rushes.api("PUT", "/api/project/settings", { proxyPresets: ["1080l", "720l"] });
    for (const v of ["v1", "v2"]) await rushes.api("POST", `/api/videos/hero/versions/${v}/proxy`, {});
    await expect.poll(async () => {
      const vs = (await rushes.api("GET", "/api/state")).project.videos[0].versions;
      return vs.every((v: { proxies: object }) => Object.keys(v.proxies).length === 2);
    }, { timeout: 30_000 }).toBe(true);
    const sideways = (page: Page) => page.locator(".proxtab").evaluate((el) => el.scrollWidth - el.clientWidth);
    for (const width of [1440, 1000]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(rushes.url);
      if (width < 1100) await page.getByRole("button", { name: /Show the notes panel/ }).click();
      const panel = await openProxiesTab(page);
      await expect(panel.locator(".pline.ready")).toHaveCount(4);
      // Hovering the trash buttons (their tooltips used to widen the tab) still leaves nothing to scroll sideways.
      await panel.locator(".pline.ready").first().getByRole("button").hover();
      await shownTip(page, "Delete proxy (the original is kept)");
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    }
  });

  test("Delete all proxies asks once more, then removes them; the original stays", async ({ page, rushes }) => {
    await rushes.addProResCut();
    await rushes.api("POST", "/api/videos/hero/versions/v1/proxy", {});
    await proxiesReady(rushes, ["1080l"]);
    await page.goto(rushes.url);
    const panel = await openProxiesTab(page);
    await panel.getByRole("button", { name: "Delete all proxies" }).click();
    await panel.getByRole("button", { name: "Delete all", exact: true }).click();
    await expect(panel.locator(".proxtotal")).toHaveText("No proxies on disk");
    expect(await proxiesOf(rushes)).toEqual({});
    await readFile(join(rushes.root, "renders", "hero_v1.mov"));
  });

  test("the toolbar button has two looks: inactive outlined, active filled", async ({ page, rushes }) => {
    await rushes.addCut();
    await page.goto(rushes.url);
    const b = proxiesButton(page);
    await expect(b).toHaveAttribute("aria-pressed", "false");
    await expect(b).toHaveAttribute("data-tip", "Proxies off · playing originals · P");
    const off = await b.evaluate((el) => getComputedStyle(el).backgroundColor);
    await b.click();
    await expect(b).toHaveAttribute("aria-pressed", "true");
    // No proxy for this cut yet: the tip says what plays (§37.5).
    await expect(b).toHaveAttribute("data-tip", "Proxies on · no proxy for this cut, playing the original · P");
    // Moved away so :hover doesn't colour either reading.
    await page.mouse.move(700, 10);
    const on = await b.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(on).not.toBe(off);
    // Remembered per browser and project.
    await page.reload();
    await expect(proxiesButton(page)).toHaveAttribute("aria-pressed", "true");
  });

  test("toggling swaps the playing file and keeps the playhead; the old per-film switch is gone", async ({ page, rushes }) => {
    await rushes.addProResCut({ codec: "h264", width: 1280, height: 720, seconds: 6 });
    await rushes.api("POST", "/api/videos/hero/versions/v1/proxy", {});
    await proxiesReady(rushes, ["1080l"]);
    await page.goto(rushes.url);
    const video = page.locator("video");
    await expect(video).toHaveAttribute("src", /renders%2F/);
    await expect(page.getByRole("button", { name: "Original", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Proxy", exact: true })).toHaveCount(0);
    await videoReady(page);
    for (let i = 0; i < 45; i++) await page.keyboard.press("ArrowRight");
    await expect(page.getByLabel("Timecode")).toContainText("0:01.50");
    await page.keyboard.press("p");
    await expect(video).toHaveAttribute("src", /proxies%2Fhero_v1_proxy-1080l\.mp4/);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 1 && Math.abs(v.currentTime - 1.5) < 0.02)).toBe(true);
    await expect(page.getByLabel("Timecode")).toContainText("0:01.50");
    await page.keyboard.press("p");
    await expect(video).toHaveAttribute("src", /renders%2F/);
    await expect(page.getByLabel("Timecode")).toContainText("0:01.50");
  });

  test("with Proxies on, a cut with no proxy plays the original and says so, with Make proxy", async ({ page, rushes }) => {
    await rushes.addCut();
    await page.goto(rushes.url);
    await turnProxiesOn(page);
    const bar = page.locator(".proxybar");
    await expect(bar).toContainText("No proxy for this cut. Playing the original.");
    await expect(page.locator("video")).toHaveAttribute("src", /renders%2F|clip/);
    await bar.getByRole("button", { name: "Make proxy" }).click();
    await expect.poll(async () => (await proxiesOf(rushes))["1080l"]?.preset ?? null, { timeout: 20_000 }).toBe("1080l");
    await expect(page.locator("video")).toHaveAttribute("src", /proxies%2F/);
    await expect(bar).not.toContainText("No proxy for this cut");
  });

  test("the stall hint shows after repeated stalls, once, and its button turns Proxies on and makes a proxy", async ({ page, rushes }) => {
    await rushes.addCut();
    await page.goto(rushes.url);
    await videoReady(page);
    const bar = page.locator(".proxybar");
    // Two waits of over a second, as a slow link gives them.
    for (let i = 0; i < 2; i++) {
      await page.locator("video").evaluate((v) => v.dispatchEvent(new Event("waiting")));
      await page.waitForTimeout(1300);
    }
    await expect(bar).toContainText("Playback is stalling. Turn on proxies?");
    await bar.getByRole("button", { name: "Turn on proxies" }).click();
    await expect(proxiesButton(page)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await proxiesOf(rushes))["1080l"]?.preset ?? null, { timeout: 20_000 }).toBe("1080l");
    await expect(page.locator("video")).toHaveAttribute("src", /proxies%2F/);
    await expect(bar).not.toContainText("Playback is stalling");
  });

  test("after a proxy made here has said it's ready and folded away, the stall hint can still show", async ({ page, rushes }) => {
    await rushes.addCut();
    await page.goto(rushes.url);
    await videoReady(page);
    const panel = await openProxiesTab(page);
    await panel.locator(".proxrow", { hasText: "Hero · v1" }).getByRole("button", { name: "Make the 1080p Low proxy for Hero · v1" }).click();
    const bar = page.locator(".proxybar");
    await expect(bar).toContainText("✓ Proxy ready", { timeout: 20_000 });
    await bar.getByRole("button", { name: "Dismiss" }).click();
    await expect(bar).toBeHidden();
    for (let i = 0; i < 2; i++) {
      await page.locator("video").evaluate((v) => v.dispatchEvent(new Event("waiting")));
      await page.waitForTimeout(1300);
    }
    await expect(bar).toContainText("Playback is stalling. Turn on proxies?");
    await bar.getByRole("button", { name: "Turn on proxies" }).click();
    await expect(proxiesButton(page)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("video")).toHaveAttribute("src", /proxies%2F/);
  });

  test("one stall is not enough, and Rushes never switches by itself", async ({ page, rushes }) => {
    await rushes.addCut();
    await page.goto(rushes.url);
    await videoReady(page);
    await page.locator("video").evaluate((v) => v.dispatchEvent(new Event("waiting")));
    await page.waitForTimeout(1300);
    await expect(page.locator(".proxybar")).not.toContainText("Playback is stalling");
    await expect(proxiesButton(page)).toHaveAttribute("aria-pressed", "false");
  });

  test("each proxy has its own line and Delete; Delete all removes the rest", async ({ page, rushes }) => {
    await rushes.addCut();
    await rushes.api("PUT", "/api/project/settings", { proxyPresets: ["1080l", "720l"] });
    await rushes.api("POST", "/api/videos/hero/versions/v1/proxy", {});
    await proxiesReady(rushes, ["1080l", "720l"]);
    await page.goto(rushes.url);
    const panel = await openProxiesTab(page);
    const row = panel.locator(".proxrow", { hasText: "Hero · v1" });
    await expect(row.locator(".pline.ready")).toHaveCount(2);
    await row.getByRole("button", { name: "Delete the 720p Low proxy for Hero · v1" }).click();
    await expect(row.locator(".pline.ready")).toHaveCount(1);
    expect(Object.keys(await proxiesOf(rushes))).toEqual(["1080l"]);
    // 720p Low is ticked and missing again: its Make button is back.
    await expect(row.getByRole("button", { name: "Make the 720p Low proxy for Hero · v1" })).toBeVisible();
    await panel.getByRole("button", { name: "Delete all proxies" }).click();
    await panel.getByRole("button", { name: "Delete all", exact: true }).click();
    await expect(panel.locator(".proxtotal")).toHaveText("No proxies on disk");
    expect(await proxiesOf(rushes)).toEqual({});
  });

  test("repeated stalls step 1080p Low down to 720p Low, say so, and keep the playhead; Back to best returns", async ({ page, rushes }) => {
    await rushes.addProResCut({ codec: "h264", width: 1280, height: 720, seconds: 6 });
    await rushes.api("PUT", "/api/project/settings", { proxyPresets: ["1080l", "720l"] });
    await rushes.api("POST", "/api/videos/hero/versions/v1/proxy", {});
    await proxiesReady(rushes, ["1080l", "720l"]);
    await page.goto(rushes.url);
    await videoReady(page);
    await turnProxiesOn(page);
    const video = page.locator("video");
    const label = page.locator(".qlabel");
    await expect(video).toHaveAttribute("src", /hero_v1_proxy-1080l\.mp4/);
    await expect(label).toHaveText("1080p Low");
    await expect(proxiesButton(page)).toHaveAttribute("data-tip", "Proxies on · playing 1080p Low · P");
    await videoReady(page);
    for (let i = 0; i < 45; i++) await page.keyboard.press("ArrowRight");
    await expect(page.getByLabel("Timecode")).toContainText("0:01.50");
    // A wait while seeking doesn't count, so the seek is let finish first.
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2)).toBe(true);
    // One stall is not enough.
    await page.locator("video").evaluate((v) => v.dispatchEvent(new Event("waiting")));
    await page.waitForTimeout(1300);
    await expect(video).toHaveAttribute("src", /proxy-1080l/);
    await page.locator("video").evaluate((v) => v.dispatchEvent(new Event("waiting")));
    await page.waitForTimeout(1300);
    await expect(video).toHaveAttribute("src", /hero_v1_proxy-720l\.mp4/);
    await expect(label).toHaveText("720p Low · stepped down");
    await expect(proxiesButton(page)).toHaveAttribute("data-tip", "Proxies on · playing 720p Low (stepped down) · P");
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 1 && Math.abs(v.currentTime - 1.5) < 0.02)).toBe(true);
    await expect(page.getByLabel("Timecode")).toContainText("0:01.50");
    await page.screenshot({ path: test.info().outputPath("player-stepped-down.png") });
    // It never steps back up by itself.
    await page.waitForTimeout(500);
    await expect(video).toHaveAttribute("src", /proxy-720l/);
    // The menu: each ready quality, Original, Back to best.
    await label.click();
    const menu = page.getByRole("menu", { name: "Playing quality" });
    await expect(menu.getByRole("menuitemradio")).toHaveText(["1080p Low", "720p Low", "Original"]);
    await menu.getByRole("menuitem", { name: "Back to best" }).click();
    await expect(video).toHaveAttribute("src", /hero_v1_proxy-1080l\.mp4/);
    await expect(label).toHaveText("1080p Low");
    await expect(page.getByLabel("Timecode")).toContainText("0:01.50");
    // A pick holds: Original plays the original.
    await label.click();
    await menu.getByRole("menuitemradio", { name: "Original" }).click();
    await expect(video).toHaveAttribute("src", /renders%2F/);
    await expect(label).toHaveText("Original");
  });

  test("with one quality ticked there is nothing to step down to", async ({ page, rushes }) => {
    await rushes.addCut();
    await rushes.api("POST", "/api/videos/hero/versions/v1/proxy", {});
    await proxiesReady(rushes, ["1080l"]);
    await page.goto(rushes.url);
    await videoReady(page);
    await turnProxiesOn(page);
    await expect(page.locator("video")).toHaveAttribute("src", /proxy-1080l/);
    await stallTwice(page);
    await expect(page.locator("video")).toHaveAttribute("src", /proxy-1080l/);
    await expect(page.locator(".qlabel")).toHaveText("1080p Low");
  });

  test("Grab Frame with Proxies on still reads the original", async ({ page, rushes }) => {
    await rushes.addProResCut({ width: 2400, height: 1350, seconds: 1 });
    await rushes.api("POST", "/api/videos/hero/versions/v1/proxy", {});
    await proxiesReady(rushes, ["1080l"]);
    await page.goto(rushes.url);
    await turnProxiesOn(page);
    await expect(page.locator("video")).toHaveAttribute("src", /proxies%2F/);
    await videoReady(page);
    for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
    const frame = page.waitForRequest((r) => /\/frame\?t=/.test(r.url()));
    await page.keyboard.press("g");
    expect((await frame).url()).toMatch(/\/api\/videos\/hero\/versions\/v1\/frame\?t=/);
    await expect(page.getByRole("status")).toHaveText(/Saved to screenshots\/hero_v1_/);
  });
});
