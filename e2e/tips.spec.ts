// §37.5: one tooltip layer for the whole page. Every tooltip is fully inside the window (8 px clear of each side),
// never clipped by a panel, above its element unless there's no room (or its context asks for below or beside).
import type { Page } from "@playwright/test";
import { expect, openProxiesTab, shownTip, test, tipLayer, videoReady, type ShownTip } from "./fixture.js";

function inside(tip: ShownTip) {
  expect(tip.left).toBeGreaterThanOrEqual(8);
  expect(tip.right).toBeLessThanOrEqual(tip.vw - 8);
  expect(tip.top).toBeGreaterThanOrEqual(8);
  expect(tip.bottom).toBeLessThanOrEqual(tip.vh - 8);
}

/** A test button with a tooltip, fixed where `style` puts it. */
async function probe(page: Page, style: string, tip: string) {
  await page.evaluate(([css, text]) => {
    const b = document.createElement("button");
    b.id = "tipprobe";
    b.textContent = "probe";
    b.setAttribute("data-tip", text);
    b.setAttribute("style", `position: fixed; z-index: 50; ${css}`);
    document.body.appendChild(b);
  }, [style, tip]);
  return page.locator("#tipprobe");
}

test("the left-most toolbar button's tip sits beside it, inside the window", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  const first = page.getByRole("toolbar", { name: "Tools" }).getByRole("button").first();
  await first.hover();
  const tip = await shownTip(page);
  inside(tip);
  expect(tip.side).toBe("right");
  const b = (await first.boundingBox())!;
  expect(tip.left).toBeGreaterThanOrEqual(b.x + b.width);
});

test("Test connection's tip in a narrow notes panel is whole: not cut off on the left or the right", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(rushes.url);
  await page.getByRole("button", { name: /Show the notes panel/ }).click();
  const panel = await openProxiesTab(page);
  const button = panel.getByRole("button", { name: "Test connection" });
  await button.hover();
  const tip = await shownTip(page, "Times a short download of the cut on screen, from this browser");
  inside(tip);
  // Not clipped by the panel either: the layer is outside it, at the root.
  expect(await tipLayer(page).evaluate((el) => el.parentElement === document.body)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("test-connection-tip-narrow.png") });
});

test("Test connection's tip in the wide panel, by its left edge, stays inside the window", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  const panel = await openProxiesTab(page);
  const button = panel.getByRole("button", { name: "Test connection" });
  await button.hover();
  inside(await shownTip(page, "Times a short download of the cut on screen, from this browser"));
  await page.screenshot({ path: test.info().outputPath("test-connection-tip-wide.png") });
});

test("a tip at the window's right edge moves left to stay inside", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  const b = await probe(page, "right: 0; top: 300px;", "A long tooltip that would run past the right edge of the window");
  await b.hover();
  const tip = await shownTip(page);
  inside(tip);
  expect(tip.side).toBe("above");
  expect(Math.round(tip.right)).toBeGreaterThanOrEqual(tip.vw - 9);
});

test("a tip at the window's left edge moves right to stay inside", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  const b = await probe(page, "left: 0; top: 300px;", "A long tooltip that would run past the left edge of the window");
  await b.hover();
  const tip = await shownTip(page);
  inside(tip);
  expect(Math.round(tip.left)).toBeLessThanOrEqual(9);
});

test("a tip at the top edge flips below its element", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  const b = await probe(page, "left: 50%; top: 0;", "No room above, so it goes below");
  await b.hover();
  const tip = await shownTip(page);
  inside(tip);
  expect(tip.side).toBe("below");
  const box = (await b.boundingBox())!;
  expect(tip.top).toBeGreaterThanOrEqual(box.y + box.height);
});

test("shown on keyboard focus too, hidden by Escape and when the pointer leaves; it never takes the pointer", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  const b = await probe(page, "left: 300px; top: 300px;", "Focus tip");
  await b.focus();
  // A focus from script isn't :focus-visible in every browser; Tab there is.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  if (await b.evaluate((el) => el.matches(":focus-visible") && document.activeElement === el)) {
    await shownTip(page, "Focus tip");
    await page.keyboard.press("Escape");
    await expect(tipLayer(page)).not.toHaveClass(/show/);
  }
  // Hover alone from here on: with keyboard focus on it, the tip rightly stays while the pointer is away.
  await b.evaluate((el) => (el as HTMLElement).blur());
  await b.hover();
  await shownTip(page, "Focus tip");
  expect(await tipLayer(page).evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  await page.keyboard.press("Escape");
  await expect(tipLayer(page)).not.toHaveClass(/show/);
  await page.mouse.move(900, 600);
  await b.hover();
  await shownTip(page, "Focus tip");
  await page.mouse.move(900, 600);
  await expect(tipLayer(page)).not.toHaveClass(/show/);
});
