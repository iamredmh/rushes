import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, pickVersion, test, versionButton, videoReady } from "./fixture.js";

const LONG =
  "v2: the button morphs into a node-sized dot and rides the pull-back onto the globe; labels and bubbles drawn as sharp images so text no longer wobbles; the crowd builds to 22 all round the globe. End line B. 34.2 s, silent.";
// A real-world agent note, about 300 characters, and one long unbroken token (a path or a hash).
const HUGE =
  "v3: launch 1.45x slower through the whole opening so each zoomed request has time to type itself out; the crowd sits on a wider oval and the chat bubbles now stagger in three waves rather than all at once; end card holds two seconds longer; music bed swapped to the warmer take; captions moved up 40 px off the safe zone.";
const TOKEN = `v4: ${"9f3c2a7e".repeat(32)}`; // no break opportunity in 256 characters
const option = (page: import("@playwright/test").Page, id: string) => page.locator(`[role="option"][data-version="${id}"]`);

test("Assets › Cuts shows a cut's short label, not its whole note (§22.4)", async ({ page, rushes }) => {
  await rushes.addCut("v1: first pass; each zoomed request types itself out; crowd on a wider oval");
  await page.goto(rushes.url);
  await page.getByRole("tab", { name: /Assets/ }).click();
  await expect(page.locator(".aheader h2")).toContainText("Cuts");
  await expect(page.locator(".shot-meta .asub").first()).toHaveText("first pass");
});

test("the version control shows the cut and its short label, and lists every cut newest first, one line each (§22.8)", async ({ page, rushes }) => {
  await rushes.addCut("v1: first pass; rough timing");
  await rushes.addCut(LONG);
  await rushes.api("PUT", "/api/videos/hero/lock", { version: "v1" });
  await page.goto(rushes.url);
  await videoReady(page);
  const button = versionButton(page);
  // Locked at v1: the film opens on it.
  await expect(button).toHaveAttribute("data-version", "v1");
  await expect(button).toHaveAccessibleName("Version: v1 · first pass");
  await expect(button).toHaveAttribute("aria-haspopup", "listbox");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const list = page.getByRole("listbox", { name: "Versions" });
  const rows = list.getByRole("option");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-version", "v2");
  await expect(rows.nth(0)).toContainText("the button morphs into a node-sized dot and…");
  await expect(rows.nth(1)).toContainText("Locked");
  await expect(rows.nth(1)).toContainText("just now");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "false");
  // The lock mark sits on the locked cut only.
  await expect(rows.nth(1).locator(".vwhen svg")).toHaveCount(1);
  await expect(rows.nth(0).locator(".vwhen svg")).toHaveCount(0);
  // One line per row, however long the note.
  const heights = await rows.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(2);
  expect(heights[0]).toBeLessThan(48);
  // The full note sits beside the list for the row under the pointer, never in a native tooltip.
  await rows.nth(0).hover();
  await expect(page.locator("#vdetail")).toContainText("the crowd builds to 22 all round the globe");
  await expect(page.locator("#vdetail .vmeta")).toContainText("just now");
  await expect(rows.nth(0)).toHaveAttribute("aria-describedby", "vdetail");
  expect(await page.locator(".vwrap [title]").count()).toBe(0);
  // Nothing pushes the page wider (Safari, §22.11).
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await button.boundingBox())!.width).toBeLessThanOrEqual(340);
  // The long label is cut by the row (an ellipsis), not wrapped.
  expect(await rows.nth(0).locator(".vlbl").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // A click elsewhere closes the list without a change.
  await page.locator(".tc").click();
  await expect(list).toHaveCount(0);
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(button).toHaveAttribute("data-version", "v1");
});

test("the version list works from the keyboard: arrows, Home, End, type-ahead, Enter and Esc (§22.8)", async ({ page, rushes }) => {
  for (const note of ["first cut", "second cut", "third cut"]) await rushes.addCut(note);
  await page.goto(rushes.url);
  await videoReady(page);
  const button = versionButton(page);
  await expect(button).toHaveAttribute("data-version", "v3");
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(option(page, "v3")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(option(page, "v2")).toBeFocused();
  await page.keyboard.press("End");
  await expect(option(page, "v1")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(option(page, "v3")).toBeFocused();
  await page.keyboard.press("ArrowUp"); // wraps
  await expect(option(page, "v1")).toBeFocused();
  // Esc closes without a change and gives focus back.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("data-version", "v3");
  // Space opens it too (the button was reached by keyboard), and doesn't play.
  await page.keyboard.press(" ");
  await expect(option(page, "v3")).toBeFocused();
  expect(await page.locator("video").evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(button).toBeFocused();
  // ArrowDown on the button opens it; "1" is v1, never the tab key 1 (Script).
  await page.keyboard.press("ArrowDown");
  await expect(option(page, "v3")).toBeFocused();
  await page.keyboard.press("1");
  await expect(option(page, "v1")).toBeFocused();
  await expect(page.getByRole("tab", { name: /Picture/ })).toHaveAttribute("aria-selected", "true");
  // Other keys stay in the open list too: "?" doesn't open the shortcuts behind it.
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(button).toHaveAttribute("data-version", "v1");
  await expect(button).toBeFocused();
  await videoReady(page);
  // Closed, the arrows step frames again.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Timecode")).toContainText("0:00.03");
  // Tab from an open list closes it and carries on to the next control, the lock.
  await button.focus();
  await page.keyboard.press("ArrowDown");
  await expect(option(page, "v1")).toBeFocused();
  await page.keyboard.press(test.info().project.name === "webkit" ? "Alt+Tab" : "Tab");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Lock picture at v1" })).toBeFocused();
});

test("type-ahead joins digits typed together: 1 then 1 is v11, and a lone 1 later is v1 (§22.8)", async ({ page, rushes }) => {
  for (let n = 1; n <= 11; n++) await rushes.addCut(`cut ${n}`);
  await page.goto(rushes.url);
  await videoReady(page);
  await versionButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(option(page, "v11")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("1");
  await page.keyboard.press("1");
  await expect(option(page, "v11")).toBeFocused();
  await page.waitForTimeout(800); // past the type-ahead window: a new number starts
  await page.keyboard.press("1");
  await expect(option(page, "v1")).toBeFocused();
});

test("the detail beside the list follows the pointer and the keyboard focus (§22.8)", async ({ page, rushes }) => {
  for (const note of ["v1: first cut; rough", "v2: second cut; tighter", "v3: third cut; end card longer"]) await rushes.addCut(note);
  await page.goto(rushes.url);
  await videoReady(page);
  const detail = page.locator("#vdetail");
  await versionButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(detail.locator("h4")).toHaveText("v3");
  await expect(detail.locator("p")).toHaveText("v3: third cut; end card longer");
  await page.keyboard.press("ArrowDown");
  await expect(detail.locator("h4")).toHaveText("v2");
  await expect(option(page, "v2")).toHaveAttribute("aria-describedby", "vdetail");
  await option(page, "v1").hover();
  await expect(detail.locator("h4")).toHaveText("v1");
  await expect(option(page, "v1")).toHaveAttribute("data-on", "true");
  // The keyboard takes the detail back from a pointer resting on another row.
  await page.keyboard.press("ArrowUp");
  await expect(option(page, "v3")).toBeFocused();
  await expect(detail.locator("h4")).toHaveText("v3");
  await expect(option(page, "v1")).toHaveAttribute("data-on", "false");
});

test("picking a cut from the list keeps the page as it was: the film, the tab, the lock and a half-typed note (§22.8)", async ({ page, rushes }) => {
  await rushes.addCut("hero first", "Hero");
  await rushes.addCut("teaser first; rough", "Teaser");
  await rushes.addCut("teaser second; tighter", "Teaser");
  await rushes.api("PUT", "/api/videos/teaser/lock", { version: "v2" });
  await page.goto(rushes.url);
  const films = page.getByRole("navigation", { name: "Films" });
  await films.getByRole("button", { name: /Teaser/ }).click();
  await videoReady(page);
  await expect(versionButton(page)).toHaveAttribute("data-version", "v2");
  await page.getByRole("textbox", { name: "New note" }).fill("a draft about the end card");
  await pickVersion(page, "v1");
  await videoReady(page);
  await expect(versionButton(page)).toHaveAccessibleName("Version: v1 · teaser first");
  await expect(films.getByRole("button", { name: /Teaser/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("tab", { name: /Picture/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Picture locked at v2 · unlock" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "New note" })).toHaveValue("a draft about the end card");
  expect((await rushes.api("GET", "/api/state")).project.videos[1].lockedVersion).toBe("v2");
});

test("long notes never widen the page or the list, at any window width (§22.8, §22.11)", async ({ page, rushes }) => {
  await rushes.addCut("v1: first pass; rough");
  await rushes.addCut("v2: tighter");
  await rushes.addCut(HUGE);
  await rushes.addCut(TOKEN);
  for (const [width, height] of [[1440, 900], [1024, 768], [600, 800]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(rushes.url);
    await videoReady(page);
    const button = versionButton(page);
    await expect(button).toHaveAttribute("data-version", "v4");
    // A narrow window may already scroll sideways for other reasons (the stage tabs): the list adds nothing to it.
    const before = await page.evaluate(() => Math.max(window.innerWidth, document.documentElement.scrollWidth));
    await button.click();
    await option(page, "v3").hover();
    await expect(page.locator("#vdetail p")).toContainText("captions moved up 40 px");
    const m = await page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const rows = [...document.querySelectorAll(".vrow")].map((el) => el.getBoundingClientRect().height);
      return {
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
        // A page that already scrolls sideways may have been scrolled by the hover: measure from its left edge.
        x: window.scrollX,
        menu: r(".vmenu"),
        detail: r("#vdetail"),
        button: r(".vbtn"),
        rows,
      };
    });
    if (width >= 1024) expect(before, `${width}: page width closed`).toBe(width);
    expect(m.scroll, `${width}: page width`).toBeLessThanOrEqual(before);
    expect(m.menu.left + m.x, `${width}: list left edge`).toBeGreaterThanOrEqual(0);
    expect(m.menu.right + m.x, `${width}: list right edge`).toBeLessThanOrEqual(m.inner);
    expect(m.button.width, `${width}: button`).toBeLessThanOrEqual(340);
    expect(Math.max(...m.rows) - Math.min(...m.rows), `${width}: rows one line`).toBeLessThan(2);
    if (width > 640) expect(m.detail.width, `${width}: detail`).toBeLessThanOrEqual(301);
    // The unbroken token wraps inside the panel rather than push it out.
    await option(page, "v4").hover();
    await expect(page.locator("#vdetail h4")).toHaveText("v4");
    const d = await page.locator("#vdetail").evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(d.scroll, `${width}: token`).toBeLessThanOrEqual(d.client);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `${width}: page width with token`).toBeLessThanOrEqual(before);
  }
});

test("opening the list has no motion when the system asks for less (§22.8)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.goto(rushes.url);
  await videoReady(page);
  await versionButton(page).click();
  await expect(page.locator(".vmenu")).toHaveCSS("animation-name", "vmenu-in");
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await versionButton(page).click();
  await expect(page.locator(".vmenu")).toHaveCSS("animation-name", "none");
});

test("the cut's full note sits under the picture, two lines at most, with More (§22.8)", async ({ page, rushes }) => {
  await rushes.addCut(HUGE);
  await page.goto(rushes.url);
  await videoReady(page);
  const note = page.locator(".vnote");
  await expect(note).toContainText("captions moved up 40 px");
  const text = note.locator(".vtext");
  expect(await text.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
  const more = note.getByRole("button", { name: "More" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(note.getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
  expect(await text.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  // A cut with no note has no line.
  await rushes.addCut();
  await expect(versionButton(page)).toHaveAttribute("data-version", "v2");
  await expect(note).toHaveCount(0);
});

test("a short note under the picture has no More (R23)", async ({ page, rushes }) => {
  await rushes.addCut("v1: first pass; rough");
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(page.locator(".vnote")).toHaveText("v1: first pass; rough");
  await expect(page.locator(".vnote").getByRole("button")).toHaveCount(0);
});

test("an agent's label wins over the derived one, and a hand-edited one over 48 is shown cut (§22.4, §22.9)", async ({ page, rushes }) => {
  await rushes.addCut("v1: first pass; rough");
  await rushes.api("POST", "/api/versions", { video: "Hero", file: "renders/hero_v1.mp4", note: "v2: the long detail", label: "Launch slower" });
  await expect(rushes.api("POST", "/api/versions", { video: "Hero", file: "renders/hero_v1.mp4", label: "x".repeat(49) })).rejects.toThrow(/48 characters at most/);
  await page.goto(rushes.url);
  await expect(versionButton(page)).toHaveAccessibleName("Version: v2 · Launch slower");
  const path = join(rushes.root, ".rushes", "project.json");
  const p = JSON.parse(await readFile(path, "utf8"));
  p.videos[0].versions[1].label = "A label somebody typed by hand that runs on far past the limit of the list";
  p.rev += 1;
  await writeFile(path, JSON.stringify(p, null, 2));
  await expect(versionButton(page)).toHaveAccessibleName("Version: v2 · A label somebody typed by hand that runs on far…");
});

test("on a touch screen the first tap shows a cut's note under its row and a second tap picks it (R20)", async ({ page, rushes }) => {
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q: string) =>
      q === "(hover: none)"
        ? ({ matches: true, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false } as unknown as MediaQueryList)
        : real(q);
  });
  await rushes.addCut("v1: first pass; rough timing");
  await rushes.addCut("v2: tighter; the end card holds longer");
  await page.goto(rushes.url);
  await videoReady(page);
  await versionButton(page).click();
  await option(page, "v1").click();
  await expect(option(page, "v1").locator(".vinline")).toContainText("first pass; rough timing");
  await expect(page.locator("#vdetail")).toHaveCount(0);
  await expect(versionButton(page)).toHaveAttribute("data-version", "v2");
  await option(page, "v1").click();
  await expect(versionButton(page)).toHaveAttribute("data-version", "v1");
});

test("pickVersion pins a cut by hand: the lock and the newest cut still don't move it (§14.2)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await rushes.addCut("second cut");
  await rushes.api("PUT", "/api/videos/hero/lock", { version: "v1" });
  await page.goto(rushes.url);
  await videoReady(page);
  await pickVersion(page, "v2");
  await videoReady(page);
  await expect(versionButton(page)).toHaveAttribute("data-version", "v2");
  expect((await rushes.api("GET", "/api/state")).project.videos[0].lockedVersion).toBe("v1");
  await rushes.addCut("third cut");
  await expect(page.getByRole("button", { name: "v3 is ready" })).toBeVisible();
  await expect(versionButton(page)).toHaveAttribute("data-version", "v2");
});
