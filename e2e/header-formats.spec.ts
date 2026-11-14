// Plan 6 (formats, §21) meets Plan 7 (the Change Log, §22): the one-format popover above the drawer and the Cut menu,
// and Alt+←/→ while either is open. (§27: the format switch sits in the row under the top bar until it moves to the monitor.)
import type { Page } from "@playwright/test";
import { expect, test, cutButton, videoReady, type FormatSize, openWorkspace, pickFilm, currentFilm } from "./fixture.js";

const logButton = (page: Page) => page.getByRole("button", { name: /^Change Log/ });
const drawer = (page: Page) => page.getByRole("complementary", { name: "Change Log" });
const toggle = (page: Page) => page.getByRole("radiogroup", { name: "Format" });
const radio = (page: Page, label: string) => toggle(page).getByRole("radio", { name: new RegExp(`^${label}(,|$)`) });

const WIDE: FormatSize = { width: 640, height: 360 };
const TALL: FormatSize = { width: 360, height: 640 };
const SQUARE: FormatSize = { width: 480, height: 480 };
// The width checks that lived here (the header one row at 1101 to 1600 px with the format toggle beside the version
// control, every chip whole) are desk.spec's: "at 1100 px / at 1440 px with eleven long-named films the top bar is one
// line and nothing overlaps", and "from 1100 to 1600 px the desk's bars never wrap and the format switch stays whole".

test("the one-format popover is never hidden by the Change Log drawer, and the Cut menu is never hidden by the row under it (merge)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await rushes.addCut("second cut");
  // Narrow enough that the popover, which opens under the toggle, reaches into the drawer.
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(toggle(page).getByRole("radio")).toHaveCount(1);
  const pop = page.locator(".fmtpop");
  /** What is on top at the middle of the popover's overlap with `other`; the overlap must be real. */
  const onTop = async (other: string) =>
    pop.evaluate((p, sel) => {
      const a = p.getBoundingClientRect();
      const b = document.querySelector(sel)!.getBoundingClientRect();
      const x0 = Math.max(a.left, b.left), x1 = Math.min(a.right, b.right), y0 = Math.max(a.top, b.top), y1 = Math.min(a.bottom, b.bottom);
      if (x1 - x0 < 4 || y1 - y0 < 4) return `no overlap with ${sel}`;
      const hit = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2);
      return hit && p.contains(hit) ? "popover" : `${hit?.className}`;
    }, other);
  // The drawer open, the pointer on the single chip.
  await logButton(page).click();
  await expect(drawer(page)).toBeVisible();
  await toggle(page).getByRole("radio").hover();
  await expect(pop).toHaveCSS("opacity", "1");
  expect(await onTop(".drawer")).toBe("popover");
  // §27: the Cut menu drops from the top bar over the row under it, where the format switch sits until it moves to the
  // monitor. Open, the list is on top of the switch, not under it.
  await cutButton(page).click();
  await expect(page.getByRole("listbox", { name: "Versions" })).toBeVisible();
  const over = await page.locator(".vmenu").evaluate((m) => {
    const a = m.getBoundingClientRect();
    const b = document.querySelector(".fmtwrap")!.getBoundingClientRect();
    const x0 = Math.max(a.left, b.left), x1 = Math.min(a.right, b.right), y0 = Math.max(a.top, b.top), y1 = Math.min(a.bottom, b.bottom);
    if (x1 - x0 < 4 || y1 - y0 < 4) return "no overlap with the format switch";
    const hit = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2);
    return hit && m.contains(hit) ? "list" : `${hit?.className}`;
  });
  expect(over).toBe("list");
});

test("Alt+←/→ switch formats with the drawer open and focus in it, but not while typing a line; [ and ] still switch films (merge)", async ({ page, rushes }) => {
  await rushes.addCut("teaser cut", "Teaser");
  await rushes.addFormatsCut([WIDE, TALL, SQUARE], { video: "Launch" });
  await page.goto(rushes.url);
  await videoReady(page);
  await pickFilm(page, "Launch");
  await videoReady(page);
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await logButton(page).click();
  await expect(drawer(page)).toBeVisible();
  // Focus on a drawer control (its Close button), not a text field.
  await drawer(page).getByRole("button", { name: "Close the change log" }).focus();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(radio(page, "1:1")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await expect(drawer(page)).toBeVisible();
  // In the drawer's own text field Alt+arrows are the field's (word jumps on macOS).
  const field = drawer(page).getByRole("textbox");
  await field.fill("held the logo");
  await field.focus();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(radio(page, "16:9")).toHaveAttribute("aria-checked", "true");
  await expect(field).toHaveValue("held the logo");
  // [ and ] are still the films', with the drawer open.
  await drawer(page).getByRole("button", { name: "Close the change log" }).focus();
  await page.keyboard.press("[");
  await expect(currentFilm(page)).toHaveText("Teaser");
  await page.keyboard.press("]");
  await expect(currentFilm(page)).toHaveText("Launch");
});

test("Alt+←/→ switch formats with the version list open; the list stays open and keeps its keys (merge)", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL, SQUARE]);
  await rushes.addFormatsCut([WIDE, TALL]);
  await page.goto(rushes.url);
  await videoReady(page);
  await cutButton(page).click();
  const list = page.getByRole("listbox", { name: "Versions" });
  await expect(list).toBeVisible();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(radio(page, "9:16")).toHaveAttribute("aria-checked", "true");
  await expect(list).toBeVisible();
  // The list's own keys still work: down to v1 and Enter picks it; the format on screen carries over when v1 has it.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(cutButton(page)).toHaveAttribute("data-version", "v1");
  await expect(radio(page, "9:16")).toHaveAttribute("aria-checked", "true");
});

test("Assets › Cuts: the cut's row carries its short label, its format sub-rows carry none (merge)", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL, SQUARE], { label: "logo hold", note: "v1: held the logo 0.5 s longer; the detail" });
  await page.goto(rushes.url);
  await openWorkspace(page, "Assets");
  await page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: /Cuts/ }).click();
  await page.getByRole("button", { name: "List view" }).click();
  const rows = page.locator(".arows .arow");
  await expect(rows.locator(".atitle")).toHaveText(["Hero · v1 · 16:9", "Hero · v1 · 9:16", "Hero · v1 · 1:1"]);
  await expect(rows.nth(0).locator(".asub")).toHaveText("logo hold");
  await expect(rows.nth(1).locator(".asub")).toHaveCount(0);
  await expect(rows.nth(2).locator(".asub")).toHaveCount(0);
  // The grid view says the same.
  await page.getByRole("button", { name: "Grid view" }).click();
  await expect(page.locator(".shot-meta .asub")).toHaveText(["logo hold"]);
});
