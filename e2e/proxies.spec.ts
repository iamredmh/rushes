// §36: proxies you can choose and switch on. The Proxies tab next to Activity, the toolbar's Proxies button, "No proxy
// for this cut", the stall hint, and the old per-film switch gone.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, hasFfmpeg, openProxiesTab, proxiesButton, test, turnProxiesOn, videoReady } from "./fixture.js";

test.describe("proxies you can choose and switch on (§36)", () => {
  test.skip(!hasFfmpeg, "needs ffmpeg and ffprobe");

  test("the Proxies tab sits after Activity, with the four presets, 1080p Low chosen", async ({ page, rushes }) => {
    await rushes.addCut();
    await page.goto(rushes.url);
    const tabs = page.getByRole("tablist", { name: "Notes panel" }).getByRole("tab");
    await expect(tabs).toHaveText(["Notes", "Activity", "Proxies"]);
    const panel = await openProxiesTab(page);
    const presets = panel.getByRole("radiogroup", { name: "Quality" }).getByRole("radio");
    await expect(presets).toHaveCount(4);
    await expect(panel.getByRole("radio", { name: /1080p Low/ })).toBeChecked();
    await expect(panel.getByText("Sharp picture, plays on a slow connection (≈5 Mbps)")).toBeVisible();
    await expect(panel.getByRole("switch", { name: "Always make proxies for this project" })).toHaveAttribute("aria-checked", "false");
    await expect(panel.getByRole("button", { name: /Make proxies now/ })).toContainText("1");
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
    await expect(panel.getByRole("radio", { name: /720p Low/ })).toBeVisible();
  });

  test("picking a preset and pressing Make produces a proxy at it, with progress, then shows it ready", async ({ page, rushes }) => {
    await rushes.addProResCut({ long: true });
    await page.goto(rushes.url);
    const panel = await openProxiesTab(page);
    await panel.getByRole("radio", { name: /720p Low/ }).check();
    await expect.poll(async () => (await rushes.api("GET", "/api/state")).project.proxyPreset).toBe("720l");
    const row = panel.locator(".proxrow", { hasText: "Hero · v1" });
    await expect(row).toContainText("No proxy");
    await row.getByRole("button", { name: "Make the proxy for Hero · v1" }).click();
    await expect(row.getByRole("progressbar")).toBeVisible();
    await expect(row).toContainText(/Making 720p Low · \d+%/);
    await expect(row).toContainText(/720p Low · [\d.]+ (KB|MB)/, { timeout: 30_000 });
    const v = (await rushes.api("GET", "/api/state")).project.videos[0].versions[0];
    expect(v.proxy).toMatchObject({ file: "proxies/hero_v1_proxy-720l.mp4", preset: "720l" });
    await expect(panel.locator(".proxtotal")).toHaveText(/Proxies use [\d.]+ (KB|MB)/);

    // Changing the preset deletes nothing: the proxy shows older quality, and offers a remake.
    await panel.getByRole("radio", { name: /1080p High/ }).check();
    await expect(row).toContainText("Older quality (720p Low");
    await expect(row.getByRole("button", { name: "Remake the proxy for Hero · v1" })).toBeVisible();
    expect((await rushes.api("GET", "/api/state")).project.videos[0].versions[0].proxy.preset).toBe("720l");
  });

  test("Delete all proxies asks once more, then removes them; the original stays", async ({ page, rushes }) => {
    await rushes.addProResCut();
    await rushes.api("POST", "/api/videos/hero/versions/v1/proxy", {});
    await expect.poll(async () => (await rushes.api("GET", "/api/state")).project.videos[0].versions[0].proxy !== null, { timeout: 20_000 }).toBe(true);
    await page.goto(rushes.url);
    const panel = await openProxiesTab(page);
    await panel.getByRole("button", { name: "Delete all proxies" }).click();
    await panel.getByRole("button", { name: "Delete all", exact: true }).click();
    await expect(panel.locator(".proxtotal")).toHaveText("No proxies on disk");
    expect((await rushes.api("GET", "/api/state")).project.videos[0].versions[0].proxy).toBeNull();
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
    await expect(b).toHaveAttribute("data-tip", "Proxies on · playing 1080p Low · P");
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
    await expect.poll(async () => (await rushes.api("GET", "/api/state")).project.videos[0].versions[0].proxy !== null, { timeout: 20_000 }).toBe(true);
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
    await expect.poll(async () => (await rushes.api("GET", "/api/state")).project.videos[0].versions[0].proxy?.preset ?? null, { timeout: 20_000 }).toBe("1080l");
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
    await expect.poll(async () => (await rushes.api("GET", "/api/state")).project.videos[0].versions[0].proxy?.preset ?? null, { timeout: 20_000 }).toBe("1080l");
    await expect(page.locator("video")).toHaveAttribute("src", /proxies%2F/);
    await expect(bar).not.toContainText("Playback is stalling");
  });

  test("after a proxy made here has said it's ready and folded away, the stall hint can still show", async ({ page, rushes }) => {
    await rushes.addCut();
    await page.goto(rushes.url);
    await videoReady(page);
    const panel = await openProxiesTab(page);
    await panel.locator(".proxrow", { hasText: "Hero · v1" }).getByRole("button", { name: "Make the proxy for Hero · v1" }).click();
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

  test("Grab Frame with Proxies on still reads the original", async ({ page, rushes }) => {
    await rushes.addProResCut({ width: 2400, height: 1350, seconds: 1 });
    await rushes.api("POST", "/api/videos/hero/versions/v1/proxy", {});
    await expect.poll(async () => (await rushes.api("GET", "/api/state")).project.videos[0].versions[0].proxy !== null, { timeout: 20_000 }).toBe(true);
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
