import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test, videoReady, cutButton, currentFilm, filmButton, openWorkspace, pickFilm, reviewTab, workspaceTab, type FormatSize, type Rushes } from "./fixture.js";

// §27, 5.1 to 5.3 and 5.9: the desk's frame. A top bar and a status bar that never move, the Film and Cut menus,
// the workspaces with Review's tabs, and the one line that says what to do next.

const topBar = (page: Page) => page.locator("header.top");
const deskBar = (page: Page) => page.locator(".deskbar");
const toggle = (page: Page) => page.getByRole("radiogroup", { name: "Format" });
const statusBar = (page: Page) => page.locator("footer.status");

test("the top bar and status bar never scroll away", async ({ page, rushes }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await rushes.addCut();
  await rushes.api("PUT", "/api/videos/hero/shots", { shots: Array.from({ length: 12 }, (_, i) => ({ name: `Shot ${i + 1}`, start: i * 0.3 })) });
  for (let i = 0; i < 20; i++) await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 0.1 + i * 0.15, text: `Note ${i + 1}: hold this a little longer` });
  await page.goto(rushes.url);
  await videoReady(page);
  // Scroll the work area to its end, by wheel and by hand.
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, 5000);
  await page.locator("main.body").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(topBar(page)).toBeInViewport();
  await expect(statusBar(page)).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight)).toBe(true);
  // The bars sit at the window's edges: the top bar at the top, the status bar at the foot, the work area between.
  expect((await topBar(page).boundingBox())!.y).toBe(0);
  const foot = (await statusBar(page).boundingBox())!;
  expect(Math.round(foot.y + foot.height)).toBe(700);
  expect(await page.locator("main.body").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test("the film menu lists films by full name with their open notes, and switches", async ({ page, rushes }) => {
  const one = "Lumen launch film, the long one with every shot";
  const two = "Lumen cutdown for the fifteen second slot";
  await rushes.addCut("first", one);
  await rushes.addCut("second", two);
  const id = ((await rushes.api("GET", "/api/state")).project.videos as { id: string }[])[1].id;
  await rushes.api("POST", "/api/notes", { stage: "picture", video: id, version: "v1", scope: "point", t: 0.5, text: "Tighter." });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(filmButton(page)).toContainText(one);
  await filmButton(page).click();
  const menu = page.getByRole("menu", { name: "Films" });
  await expect(menu.getByRole("menuitem").nth(0)).toContainText(one);
  await expect(menu.getByRole("menuitem").nth(1)).toContainText(two);
  await expect(menu.getByRole("menuitem").nth(1)).toContainText("1 open");
  await menu.getByRole("menuitem").nth(1).click();
  await expect(menu).toHaveCount(0);
  await expect(filmButton(page)).toContainText(two);
  await expect(currentFilm(page)).toHaveText(two);
});

test("the cut menu locks and unlocks picture", async ({ page, rushes }) => {
  await rushes.addCut("first");
  await rushes.addCut("second");
  await page.goto(rushes.url);
  await videoReady(page);
  await cutButton(page).click();
  await page.getByRole("button", { name: "Lock picture at v2" }).click();
  await expect(statusBar(page)).toContainText("v2 locked");
  await cutButton(page).click();
  await page.getByRole("button", { name: "Unlock picture" }).click();
  await expect(statusBar(page)).not.toContainText("locked");
  await cutButton(page).click();
  await expect(page.getByRole("button", { name: "Lock picture at v2" })).toBeVisible();
});

test("number keys keep their places", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.addVariant("voice", "Read A", { seconds: 2, freq: 220 });
  await rushes.addVariant("music", "Bed A", { seconds: 2, freq: 330 });
  await rushes.addVariant("sfx", "Pass A", { seconds: 2, freq: 440 });
  await page.goto(rushes.url);
  await videoReady(page);
  const selected = async (key: string, tab: ReturnType<typeof reviewTab>) => {
    await page.keyboard.press(key);
    await expect(tab).toHaveAttribute("aria-selected", "true");
  };
  await selected("3", reviewTab(page, "Voice"));
  await selected("4", reviewTab(page, "Music"));
  await selected("5", reviewTab(page, "Effects"));
  await selected("2", reviewTab(page, "Timeline"));
  await selected("5", reviewTab(page, "Effects"));
  await selected("6", reviewTab(page, "Timeline"));
  await selected("8", workspaceTab(page, "Assets"));
  await selected("1", workspaceTab(page, "Plan"));
  await expect(workspaceTab(page, "Review")).toHaveAttribute("aria-selected", "false");
});

test("a sound with new takes says so on its tab", async ({ page, rushes }) => {
  await rushes.addCut();
  const pulse = await rushes.addVariant("music", "Pulse", { seconds: 2, freq: 220, round: "Round 1" });
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [pulse.lane.id]: pulse.variant.id } });
  await rushes.addVariant("music", "Drift", { seconds: 2, freq: 330, round: "Round 2" });
  await rushes.addVariant("music", "Glow", { seconds: 2, freq: 440, round: "Round 2" });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(reviewTab(page, "Music")).toHaveText("Music 2 new");
  await reviewTab(page, "Music").click();
  await page.getByRole("button", { name: "Use Drift" }).click();
  await expect(reviewTab(page, "Music")).toHaveText("Music 3");
});

test("the status bar says what is next and goes there", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(statusBar(page)).toContainText("Next: lock picture");
  const { note } = await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 0.5, text: "Hold the end card." });
  await expect(statusBar(page)).toContainText("Next: send 1 note");
  // Sent, it is open until the agent deals with it.
  await page.getByRole("button", { name: /^Send to agent/ }).click();
  await expect(page.getByRole("dialog", { name: "Sent to agent" })).toBeVisible();
  await expect(statusBar(page)).toContainText("Next: 1 note open");
  await page.keyboard.press("Escape");
  // The note dealt with and picture locked, a read arrives: choosing one is next, and the line goes to Voice.
  await rushes.api("PATCH", `/api/notes/${note.id}`, { status: "done" });
  await rushes.api("PUT", "/api/videos/hero/lock", { version: "v1" });
  await rushes.addVariant("voice", "Read A", { seconds: 2, freq: 220 });
  const next = statusBar(page).getByRole("button", { name: "choose a read" });
  await expect(next).toBeVisible();
  await next.click();
  await expect(reviewTab(page, "Voice")).toHaveAttribute("aria-selected", "true");
});

// The eleven-film project from shelving.spec: long names, four formats on the first, four shelved, a long project name.
const NAMES = [
  "Key: nobody holds your whole key", "Pointer: your assets don't live at one address", "Signed: the network signs every page you open",
  "Pay: you choose what to pay with", "Every network: all your assets in one place", "Unlock: sign in the way you unlock your phone",
  "One chain: see everything, or just one network", "Wrong address caught", "Hide balance (privacy mode)", "Contacts (send to a name)", "Notes (share a note once)",
];
async function elevenFilms(rushes: Rushes) {
  const SIZES = [{ width: 640, height: 360 }, { width: 360, height: 640 }, { width: 480, height: 480 }, { width: 384, height: 480 }];
  const first = await rushes.addFormatsCut(SIZES, { video: NAMES[0] });
  for (const f of first.version.formats) await rushes.api("POST", "/api/notes", { stage: "picture", video: "key-nobody-holds-your-whole-key", version: first.version.id, format: f.id, scope: "point", t: 0.4, text: `Note on ${f.label}` });
  const file = join(rushes.root, ".rushes", "project.json");
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), name: "2026-10-12-lumen-protected-review" }, null, 2));
  for (const name of NAMES.slice(1)) await rushes.addCut(`${name} cut`, name);
  for (const i of [1, 7, 8, 9]) {
    const id = ((await rushes.api("GET", "/api/state")).project.videos as { id: string }[])[i].id;
    await rushes.api("PUT", `/api/videos/${id}/shelve`, { shelved: true });
  }
}

/** The top bar's direct children that show, and any two of them that overlap. */
const overlaps = (page: Page) =>
  topBar(page).evaluate((h) => {
    const boxes = [...h.children]
      .filter((c) => c.getBoundingClientRect().width > 0 && getComputedStyle(c).visibility !== "hidden")
      .map((c) => ({ name: `${c.tagName.toLowerCase()}.${c.className}`.slice(0, 32), r: c.getBoundingClientRect() }));
    const out: string[] = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r, b = boxes[j].r;
        if (Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1 && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1) out.push(`${boxes[i].name} overlaps ${boxes[j].name}`);
      }
    if (h.scrollWidth > h.clientWidth + 1) out.push(`the bar is ${h.scrollWidth} px wide in ${h.clientWidth}`);
    return out;
  });

/** Each format chip's label and count are whole: nothing in the switch is cut short or squeezed. */
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

for (const width of [1100, 1440]) {
  test(`at ${width} px with eleven long-named films the top bar is one line and nothing overlaps`, async ({ page, rushes }) => {
    test.setTimeout(120_000);
    await elevenFilms(rushes);
    await page.setViewportSize({ width, height: 800 });
    await page.goto(rushes.url);
    await videoReady(page);
    await expect(filmButton(page)).toContainText(NAMES[0]);
    expect((await topBar(page).boundingBox())!.height).toBeLessThan(50);
    expect(await overlaps(page)).toEqual([]);
    // The first film's four formats: the switch under the bar is whole, on one line.
    await expect(toggle(page).getByRole("radio")).toHaveCount(4);
    expect(await toggleWhole(page)).toEqual([]);
    expect((await deskBar(page).boundingBox())!.height).toBeLessThan(50);
    // A long name on the film you are in still leaves the workspaces whole and nothing covered.
    await pickFilm(page, NAMES[2]);
    await expect(filmButton(page)).toContainText(NAMES[2]);
    expect((await topBar(page).boundingBox())!.height).toBeLessThan(50);
    expect(await overlaps(page)).toEqual([]);
    // The workspaces sit in the middle of the bar.
    const ws = (await page.getByRole("tablist", { name: "Workspaces" }).boundingBox())!;
    expect(Math.abs(ws.x + ws.width / 2 - width / 2)).toBeLessThanOrEqual(2);
  });
}

const WIDE: FormatSize = { width: 640, height: 360 };
const TALL: FormatSize = { width: 360, height: 640 };
const SQUARE: FormatSize = { width: 480, height: 480 };
const FOUR_FIVE: FormatSize = { width: 384, height: 480 };
const LONG_LABEL = "Tighter middle 35, logo lands on the first beat!"; // 48 characters

/**
 * Task 7's long project, with formats: a long project name, two films with long names, 59 found
 * files, a locked cut with a 48-character label and four shapes, and eight open notes on it.
 */
async function longProject(rushes: Rushes) {
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

test("from 1100 to 1600 px the desk's bars never wrap and the format switch stays whole", async ({ page, rushes }) => {
  test.setTimeout(120_000);
  await longProject(rushes);
  await page.goto(rushes.url);
  await videoReady(page);
  await pickFilm(page, "Lumen launch film");
  await videoReady(page);
  await expect(cutButton(page)).toContainText("Tighter middle");
  await expect(toggle(page).getByRole("radio")).toHaveCount(4);
  await expect(page.getByRole("button", { name: /^Send to agent/ })).toContainText("8");
  const bad: string[] = [];
  for (let width = 1100; width <= 1600; width += 20) {
    await page.setViewportSize({ width, height: 900 });
    const top = (await topBar(page).boundingBox())!.height;
    const bar = (await deskBar(page).boundingBox())!.height;
    if (top >= 50) bad.push(`${width}: top bar ${Math.round(top)} px`);
    if (bar >= 50) bad.push(`${width}: row under it ${Math.round(bar)} px`);
    const whole = await toggleWhole(page);
    if (whole.length) bad.push(`${width}: ${whole.join(", ")}`);
    const over = await overlaps(page);
    if (over.length) bad.push(`${width}: ${over.join(", ")}`);
  }
  expect(bad).toEqual([]);
});

test("a half-typed note is not lost by switching workspace", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  await page.getByLabel("New note").fill("Still deciding");
  await workspaceTab(page, "Assets").click();
  await expect(page.getByRole("status")).toHaveText("Add or clear your note first");
  await expect(workspaceTab(page, "Review")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("New note")).toHaveValue("Still deciding");
});

test("a film with no cut opens on Plan, and Review is the page that asks for cut 1", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: "# Brief: Lumen\n\nStatus: draft\n\n## Purpose\nShow the best takes.\n" }]);
  await page.goto(rushes.url);
  await expect(workspaceTab(page, "Plan")).toHaveAttribute("aria-selected", "true");
  await openWorkspace(page, "Review");
  await expect(page.getByRole("button", { name: "Copy prompt for your agent" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Review" })).toHaveCount(0);
  await expect(page.locator("video")).toHaveCount(0);
  await expect(statusBar(page)).toContainText("Next: approve the plan");
});
