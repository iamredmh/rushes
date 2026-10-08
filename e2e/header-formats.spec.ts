// Plan 6 (formats, §21) meets Plan 7 (the Change Log, §22) in Picture's header: the format toggle
// beside the version control on a long project, the one-format popover above the drawer and the
// version list, and Alt+←/→ while either is open.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test, versionButton, videoReady, type FormatSize } from "./fixture.js";

const logButton = (page: Page) => page.getByRole("button", { name: /^Change Log/ });
const drawer = (page: Page) => page.getByRole("complementary", { name: "Change Log" });
const toggle = (page: Page) => page.getByRole("radiogroup", { name: "Format" });
const radio = (page: Page, label: string) => toggle(page).getByRole("radio", { name: new RegExp(`^${label}(,|$)`) });

const WIDE: FormatSize = { width: 640, height: 360 };
const TALL: FormatSize = { width: 360, height: 640 };
const SQUARE: FormatSize = { width: 480, height: 480 };
const FOUR_FIVE: FormatSize = { width: 384, height: 480 };
const LONG_LABEL = "Tighter middle 35, logo lands on the first beat!"; // 48 characters

/**
 * Task 7's long project, with formats: a long project name, two films with long names, 59 found
 * files, a locked cut with a 48-character label and four shapes, and eight open notes on it.
 */
async function longProject(rushes: any) {
  await rushes.addCut("Opening titles: the logo lands on the first beat", "Lumen teaser");
  await rushes.addFormatsCut([WIDE, TALL, SQUARE], { video: "Lumen launch film", note: "First pass; rough timing" });
  await rushes.addFormatsCut([WIDE, TALL, SQUARE, FOUR_FIVE], { video: "Lumen launch film", label: LONG_LABEL, note: "Trimmed the opening two seconds" });
  await rushes.api("PUT", "/api/videos/lumen-launch-film/lock", { version: "v2" });
  for (let i = 1; i <= 8; i++) await rushes.api("POST", "/api/notes", { stage: "picture", video: "lumen-launch-film", version: "v2", scope: "point", t: i * 0.3, text: `Note ${i}: hold the end card longer` });
  await rushes.writeFiles(Array.from({ length: 59 }, (_, i) => ({ path: `auditions/try-${String(i + 1).padStart(2, "0")}.wav`, seconds: 0.5 + (i % 5) * 0.25, freq: 200 + i * 5 })));
  await rushes.scan();
  const file = join(rushes.root, ".rushes", "project.json");
  const p = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...p, name: "Lumen launch film" }, null, 2));
}

/** The header's visible children, with their boxes. */
const headerRow = (page: Page) =>
  page.locator("header.head").evaluate((h) =>
    [...h.children].filter((c) => (c as HTMLElement).offsetParent !== null && c.getBoundingClientRect().width > 0).map((c) => {
      const r = c.getBoundingClientRect();
      return { name: `${c.tagName.toLowerCase()}.${c.className}`.slice(0, 40), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), mid: Math.round((r.top + r.bottom) / 2) };
    }));

/** Each chip's label and count are whole: nothing in the toggle is cut short or squeezed. */
const toggleWhole = (page: Page) =>
  toggle(page).evaluate((g) => {
    const out: string[] = [];
    if (g.scrollWidth > g.clientWidth + 1) out.push(`group ${g.scrollWidth} > ${g.clientWidth}`);
    for (const c of g.querySelectorAll<HTMLElement>("[role=radio]")) {
      if (c.scrollWidth > c.clientWidth + 1) out.push(`chip ${c.dataset.format} ${c.scrollWidth} > ${c.clientWidth}`);
      if (c.getBoundingClientRect().height > 40) out.push(`chip ${c.dataset.format} wrapped`);
      for (const part of c.querySelectorAll<HTMLElement>(".lbl, .n:not(.none)")) if (part.scrollWidth > part.clientWidth + 1) out.push(`${c.dataset.format} ${part.className}`);
    }
    return out;
  });

for (const width of [1440, 1280, 1150, 1101]) {
  test(`at ${width} px a long project's header stays one row with the format toggle beside the version control (merge)`, async ({ page, rushes }) => {
    test.setTimeout(90_000);
    await longProject(rushes);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(rushes.url);
    await videoReady(page);
    await expect(page.locator(".foundchip")).toContainText("59");
    const films = page.getByRole("navigation", { name: "Films" }).getByRole("button");
    await expect(films).toHaveCount(2);
    await films.nth(1).click(); // the launch film, locked at its long-labelled cut
    await videoReady(page);
    await expect(versionButton(page)).toContainText("Tighter middle");
    await expect(toggle(page).getByRole("radio")).toHaveCount(4);
    await expect(page.getByRole("button", { name: /^Send to agent/ })).toContainText("8");
    const row = await headerRow(page);
    console.log(width, JSON.stringify(row));
    const mids = row.map((c) => c.mid);
    expect(Math.max(...mids) - Math.min(...mids), JSON.stringify(row)).toBeLessThanOrEqual(2);
    const head = (await page.locator("header.head").boundingBox())!;
    expect(head.height, `header ${head.height} px`).toBeLessThan(80);
    expect(await page.locator("header.head").evaluate((h) => h.scrollWidth <= h.clientWidth)).toBe(true);
    // The toggle sits beside the version control (after it and the lock, before the buttons on the right) and keeps its natural size.
    const at = (cls: string) => row.findIndex((c) => c.name.includes(cls));
    expect(at("fmtwrap")).toBeGreaterThan(at("vwrap"));
    expect(at("fmtwrap")).toBeLessThan(at("btn ghost ib")); // the shortcuts button, first after the spacer
    expect(await toggleWhole(page)).toEqual([]);
    for (const label of ["16:9", "9:16", "1:1", "4:5"]) await expect(radio(page, label)).toBeVisible();
    // Every chip shows the count of the eight all-format notes.
    await expect(toggle(page).locator(".n:not(.none)")).toHaveCount(4);
    // Names truncate on one line before anything wraps; nothing spills out of its own box.
    const spills = await page.locator("header.head").evaluate((h) =>
      [...h.querySelectorAll(".vwrap > .vbtn, .vbtn > *, .pack > .pill, .pill > *, .crumb > *")]
        .filter((c) => c.getBoundingClientRect().right > c.parentElement!.getBoundingClientRect().right + 1)
        .map((c) => `${c.parentElement!.className} > ${c.className || c.tagName}`));
    expect(spills).toEqual([]);
    const wrapped = await page.locator("header.head").evaluate((h) =>
      [...h.querySelectorAll(".crumb > span, .pill .pname, .vbtn .vlbl")].filter((el) => el.getBoundingClientRect().height > 26).map((el) => el.textContent));
    expect(wrapped).toEqual([]);
    // Send to agent and the Change Log share the row, on the right.
    const send = (await page.getByRole("button", { name: /^Send to agent/ }).boundingBox())!;
    const log = (await logButton(page).boundingBox())!;
    expect(Math.abs(send.y - log.y)).toBeLessThanOrEqual(1);
    expect(send.x + send.width).toBeLessThanOrEqual(width - 13);
  });
}

test("from 1101 to 1600 px the long project's header with four formats never wraps (merge)", async ({ page, rushes }) => {
  test.setTimeout(120_000);
  await longProject(rushes);
  await page.goto(rushes.url);
  await videoReady(page);
  await page.getByRole("navigation", { name: "Films" }).getByRole("button").nth(1).click();
  await videoReady(page);
  await expect(toggle(page).getByRole("radio")).toHaveCount(4);
  const tall: string[] = [];
  for (let width = 1101; width <= 1601; width += 20) {
    await page.setViewportSize({ width, height: 900 });
    const h = await page.locator("header.head").evaluate((el) => el.getBoundingClientRect().height);
    if (h >= 80) tall.push(`${width}: ${Math.round(h)} px`);
  }
  expect(tall).toEqual([]);
});

test("the one-format popover is never hidden by the Change Log drawer or the version list (merge)", async ({ page, rushes }) => {
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
  // The version list open as well (it stays open while the pointer moves over the header).
  await versionButton(page).click();
  await expect(page.getByRole("listbox", { name: "Versions" })).toBeVisible();
  await toggle(page).getByRole("radio").hover();
  await expect(pop).toHaveCSS("opacity", "1");
  expect(await onTop(".vmenu")).toBe("popover");
});

test("Alt+←/→ switch formats with the drawer open and focus in it, but not while typing a line; [ and ] still switch films (merge)", async ({ page, rushes }) => {
  await rushes.addCut("teaser cut", "Teaser");
  await rushes.addFormatsCut([WIDE, TALL, SQUARE], { video: "Launch" });
  await page.goto(rushes.url);
  await videoReady(page);
  await page.getByRole("navigation", { name: "Films" }).getByRole("button").nth(1).click();
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
  await expect(page.getByRole("navigation", { name: "Films" }).getByRole("button").nth(0)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("]");
  await expect(page.getByRole("navigation", { name: "Films" }).getByRole("button").nth(1)).toHaveAttribute("aria-pressed", "true");
});

test("Alt+←/→ switch formats with the version list open; the list stays open and keeps its keys (merge)", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL, SQUARE]);
  await rushes.addFormatsCut([WIDE, TALL]);
  await page.goto(rushes.url);
  await videoReady(page);
  await versionButton(page).click();
  const list = page.getByRole("listbox", { name: "Versions" });
  await expect(list).toBeVisible();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(radio(page, "9:16")).toHaveAttribute("aria-checked", "true");
  await expect(list).toBeVisible();
  // The list's own keys still work: down to v1 and Enter picks it; the format on screen carries over when v1 has it.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(versionButton(page)).toHaveAttribute("data-version", "v1");
  await expect(radio(page, "9:16")).toHaveAttribute("aria-checked", "true");
});

test("Assets › Cuts: the cut's row carries its short label, its format sub-rows carry none (merge)", async ({ page, rushes }) => {
  await rushes.addFormatsCut([WIDE, TALL, SQUARE], { label: "logo hold", note: "v1: held the logo 0.5 s longer; the detail" });
  await page.goto(rushes.url);
  await page.getByRole("tab", { name: /Assets/ }).click();
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
