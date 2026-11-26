import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test, videoReady, cutButton, pickVersion, currentFilm, filmButton, openWorkspace, pickFilm, reviewTab, workspaceTab, type FormatSize, type Rushes, ELEVEN_FILMS, ELEVEN_FILMS_PROJECT, monitor, pictureTrack, ruler, rulerMarkers, shotBlocks, TOOL_TIPS, toolButton, toolStrip, transport, hasFfmpeg, loudness, playButton, soundBlock, soundButton, soundLabel, soundLevel, soundTrack, expectReadableInRow, timelinePanel, activity, openActivity, notesPanel, noteTargetLine, noteTargetLabel, noteTargetMenu, noteTargetName, noteTargetWhen, panelTab, panelToggle, rangeChip, sendButton, sentDialog, statusSend, openReviewTab, takesList, takeHeadings, takeRow, takeRows, takeCircle, takeName, takeTag, takeBlock, putAwayButton, pressRowButton, foldToggle, shownTip } from "./fixture.js";

// §27, 5.1 to 5.3 and 5.9: the desk's frame. A top bar and a status bar that never move, the Film and Cut menus,
// the workspaces with Review's tabs, and the one line that says what to do next.

const topBar = (page: Page) => page.locator("header.top");
// The row under the top bar: Review's tabs (Send and Activity are in the notes panel now).
const deskBar = (page: Page) => page.locator(".rtabrow");
const toggle = (page: Page) => page.getByRole("radiogroup", { name: "Format" });
const statusBar = (page: Page) => page.locator("footer.status");

test("the top bar and status bar never scroll away", async ({ page, rushes }) => {
  // Short enough that the timeline's column (at least 360 px) is taller than the work area, so the work area scrolls.
  await page.setViewportSize({ width: 1440, height: 440 });
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
  expect(Math.round(foot.y + foot.height)).toBe(440);
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

test("the More menu's arrows step over a disabled row instead of sticking on it", async ({ page, rushes }) => {
  // No film yet: Shelve film is there but disabled.
  await page.goto(rushes.url);
  await page.getByRole("button", { name: "More", exact: true }).click();
  const menu = page.getByRole("menu", { name: "More" });
  await expect(menu.getByRole("menuitem", { name: /Shelve film/ })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: /Bring in new files/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: /Export notes/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  // §36: the old "lighter copies" setting is now Proxies, which opens the Proxies tab.
  await expect(menu.getByRole("menuitem", { name: "Proxies" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitem", { name: /Export notes/ })).toBeFocused();
});

test("Tab from the Cut menu's list on a shelved film skips its disabled lock row and closes the menu", async ({ page, rushes }) => {
  await rushes.addCut("hero cut");
  await rushes.addCut("cutdown cut", "Cutdown");
  await rushes.api("PUT", "/api/videos/cutdown/shelve", { shelved: true });
  await page.goto(rushes.url);
  await videoReady(page);
  await filmButton(page).click();
  await page.getByRole("menu", { name: "Films" }).getByRole("menuitem", { name: "Open Cutdown" }).click();
  await expect(currentFilm(page)).toHaveText("Cutdown");
  await cutButton(page).click();
  const list = page.getByRole("listbox", { name: "Versions" });
  await expect(list).toBeVisible();
  await expect(page.locator(".vfoot .mi")).toBeDisabled();
  await page.keyboard.press("Tab");
  await expect(list).toHaveCount(0);
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
  await takeCircle(page, "Drift").click();
  await expect(reviewTab(page, "Music")).toHaveText("Music 3");
});

test("Red, round 2: the status bar says nothing of what is next; it offers Send only on a page with no notes panel", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(statusBar(page)).not.toContainText("Next");
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 0.5, text: "Hold the end card." });
  await expect(sendButton(page)).toHaveAccessibleName("Send 1");
  // Review has its notes panel, and Send in it: the status bar holds only the cut's details.
  await expect(statusSend(page)).toHaveCount(0);
  await expect(statusBar(page)).not.toContainText("Send");
  await expect(statusBar(page)).toContainText("v1");
  // Assets has no panel: the status bar's Send is the way there.
  await openWorkspace(page, "Assets");
  await expect(statusSend(page)).toHaveText("Send 1 note");
  await statusSend(page).click();
  await expect(sendButton(page)).toBeFocused();
  await expect(statusSend(page)).toHaveCount(0);
});

// The eleven-film project (once shelving.spec's): long names, four formats on the first, four shelved, a long project name.
const NAMES = ELEVEN_FILMS;
async function elevenFilms(rushes: Rushes) {
  const SIZES = [{ width: 640, height: 360 }, { width: 360, height: 640 }, { width: 480, height: 480 }, { width: 384, height: 480 }];
  const first = await rushes.addFormatsCut(SIZES, { video: NAMES[0] });
  for (const f of first.version.formats) await rushes.api("POST", "/api/notes", { stage: "picture", video: "salt-the-marsh-keeps-its-own-tide", version: first.version.id, format: f.id, scope: "point", t: 0.4, text: `Note on ${f.label}` });
  const file = join(rushes.root, ".rushes", "project.json");
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), name: ELEVEN_FILMS_PROJECT }, null, 2));
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
  await expect(sendButton(page)).toContainText("8");
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

test("at 1600 px a 24-character film name is shown whole beside the project and the cut", async ({ page, rushes }) => {
  test.setTimeout(120_000);
  await longProject(rushes);
  const name = "Lumen: the long way home"; // 24 characters
  await rushes.addFormatsCut([WIDE, TALL], { video: name, label: LONG_LABEL, note: "The long way round" });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(rushes.url);
  await videoReady(page);
  await pickFilm(page, name);
  await videoReady(page);
  // Whole to the subpixel: an ellipsis shows as soon as a name loses even a fraction of a pixel.
  const whole = (el: HTMLElement) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return r.getBoundingClientRect().width <= el.getBoundingClientRect().width + 0.01;
  };
  expect(await currentFilm(page).evaluate(whole)).toBe(true);
  // The project's name is not squeezed to make room either, and nothing overlaps.
  expect(await topBar(page).locator(".proj .pname").evaluate(whole)).toBe(true);
  expect(await overlaps(page)).toEqual([]);
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
  await expect(statusBar(page)).not.toContainText("Next");
});

// ---- §27, 5.4 to 5.6: the Timeline tab. The monitor with its tool strip, the transport, the ruler and the Picture track ----

test("the tool strip has five tools, Select first and active, and B makes Box the active one", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  const tools = toolStrip(page).getByRole("button");
  // The five tools, then (§36.7) the Proxies on/off after a gap, where there's ffmpeg to make proxies.
  await expect(tools).toHaveCount(hasFfmpeg ? 6 : 5);
  if (hasFfmpeg) await expect(tools.nth(5)).toHaveAccessibleName("Proxies");
  for (const [i, tip] of Object.values(TOOL_TIPS).entries()) {
    await expect(tools.nth(i)).toHaveAttribute("data-tip", tip);
    await expect(tools.nth(i)).toHaveAttribute("aria-label", tip);
  }
  await expect(toolButton(page, "Select")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("b");
  await expect(toolButton(page, "Box")).toHaveAttribute("aria-pressed", "true");
  await expect(toolButton(page, "Select")).toHaveAttribute("aria-pressed", "false");
  // V goes back to Select, and box mode ends with it.
  await page.keyboard.press("v");
  await expect(toolButton(page, "Select")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".overlay.drawing")).toHaveCount(0);
  // Note is active while the note box has focus; Range while an In waits for its Out.
  await toolButton(page, "Note").click();
  await expect(page.getByLabel("New note")).toBeFocused();
  await expect(toolButton(page, "Note")).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("New note").blur();
  await expect(toolButton(page, "Select")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("i");
  await expect(toolButton(page, "Range")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("o");
  await expect(toolButton(page, "Select")).toHaveAttribute("aria-pressed", "true");
  // The transport keeps play and the frame steps; the marking buttons are the strip's now.
  await expect(transport(page).getByRole("button", { name: "Play" })).toBeVisible();
  await expect(transport(page).getByRole("button", { name: "Back one frame" })).toBeVisible();
  await expect(transport(page).getByRole("button", { name: "Forward one frame" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Set in point" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Grab frame" })).toHaveCount(0);
});

test("the Picture track has a block per shot; the one under the playhead is current while playing, and clicking one seeks", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.api("PUT", "/api/videos/hero/shots", { shots: [{ name: "Open", start: 0 }, { name: "Turn", start: 1 }, { name: "Logo", start: 2.5 }] });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(shotBlocks(page)).toHaveText(["01", "02", "03"]);
  for (const [i, name] of (["01 Open", "02 Turn", "03 Logo"] as const).entries()) await expect(shotBlocks(page).nth(i)).toHaveAccessibleName(name);
  await expect(shotBlocks(page).nth(0)).toHaveAttribute("aria-current", "true");
  // Each block runs from its start to the next shot's.
  const [a, b, c] = await Promise.all([0, 1, 2].map(async (i) => (await shotBlocks(page).nth(i).boundingBox())!));
  expect(b.width).toBeGreaterThan(a.width);
  expect(Math.abs(a.x + a.width - b.x)).toBeLessThanOrEqual(3);
  expect(Math.abs(b.x + b.width - c.x)).toBeLessThanOrEqual(3);
  await page.keyboard.press(" ");
  await expect(shotBlocks(page).nth(1)).toHaveAttribute("aria-current", "true", { timeout: 5000 });
  await page.keyboard.press(" ");
  await shotBlocks(page).nth(2).click();
  await expect(page.getByLabel("Timecode")).toContainText("0:02.50");
  await expect(shotBlocks(page).nth(2)).toHaveAttribute("aria-current", "true");
  await expect(shotBlocks(page).nth(0)).not.toHaveAttribute("aria-current", "true");
});

test("a cut with no shots is one block with the cut's label, and a locked cut shows a padlock", async ({ page, rushes }) => {
  await rushes.addCut("v1: logo hold");
  await rushes.api("PUT", "/api/videos/hero/lock", { version: "v1" });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(shotBlocks(page)).toHaveCount(1);
  await expect(shotBlocks(page)).toHaveText("logo hold");
  await expect(shotBlocks(page)).toHaveAttribute("aria-current", "true");
  await expect(pictureTrack(page).getByLabel("Picture locked")).toBeVisible();
});

test("a note shows as a marker on the ruler, and clicking it selects the note and seeks", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Hold the logo." });
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "range", t: 2, tOut: 3, text: "Tighter here." });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(rulerMarkers(page)).toHaveCount(2);
  // Each marker's tooltip is its name, the note's text; no native title shows a second one beside it.
  for (const [i, text] of ["Hold the logo.", "Tighter here."].entries()) {
    await expect(rulerMarkers(page).nth(i)).toHaveAttribute("aria-label", text);
    await expect(rulerMarkers(page).nth(i)).toHaveAttribute("data-tip", text);
    await expect(rulerMarkers(page).nth(i)).not.toHaveAttribute("title");
  }
  // Shown under the ruler, inside the timeline panel, clear of the marker it names.
  await rulerMarkers(page).nth(0).hover();
  const shown = await shownTip(page, "Hold the logo.");
  const marker = (await rulerMarkers(page).nth(0).boundingBox())!;
  expect(shown.top).toBeGreaterThan(marker.y + marker.height); // below the marker, never over it
  expect(shown.bottom).toBeLessThanOrEqual(shown.vh - 8); // inside the window: nothing clips it
  await rulerMarkers(page).nth(1).click();
  await expect(page.getByLabel("Timecode")).toContainText("0:02.00");
  await expect(page.locator(".list > .note", { hasText: "Tighter here." })).toHaveAttribute("aria-current", "true");
  // Clicking the ruler itself seeks there.
  const r = (await ruler(page).boundingBox())!;
  await page.mouse.click(r.x + r.width * 0.25, r.y + 4);
  await expect(page.getByLabel("Timecode")).toContainText(/0:00\.9|0:01\.0/);
});

test("an all-format note's ring on the ruler answers on its band; its middle lets the pointer through to the ruler", async ({ page, rushes }) => {
  test.skip(!hasFfmpeg, "needs ffmpeg and ffprobe");
  const cut = await rushes.addFormatsCut([WIDE, TALL]);
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: cut.version.id, format: null, scope: "point", t: 1, text: "Drop the first sound." });
  await page.goto(rushes.url);
  await videoReady(page);
  const ring = rulerMarkers(page).and(page.locator(".ring"));
  await expect(ring).toHaveCount(1);
  const r = (await ring.boundingBox())!;
  const at = (x: number, y: number) => page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el?.closest(".mk") ? "ring" : el?.closest(".ruler") ? "ruler" : el?.tagName ?? null;
  }, [x, y]);
  expect(await at(r.x + r.width / 2, r.y + r.height / 2)).toBe("ruler");
  expect(await at(r.x + 1, r.y + r.height / 2)).toBe("ring");
  // Its tooltip is whole on hover: the cut-out never clips it.
  await page.mouse.move(r.x + 1, r.y + r.height / 2);
  await shownTip(page, "All · Drop the first sound.");
  expect(await ring.evaluate((el) => getComputedStyle(el).clipPath)).toBe("none");
});

test("F puts the monitor full screen", async ({ page, rushes, browserName }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(transport(page).getByRole("button", { name: "Full screen · F" })).toBeVisible();
  await page.keyboard.press("f");
  const full = () => page.evaluate(() => document.fullscreenElement?.classList.contains("monitor") ?? false);
  // WebKit's headless runner may refuse full screen outright; Chromium grants it to a key press. The request settles a
  // moment after the key, so WebKit is given until then before the test calls it refused.
  if (browserName === "webkit") {
    const granted = await expect.poll(full, { timeout: 3000 }).toBe(true).then(() => true, () => false);
    if (!granted) test.skip(true, "this WebKit cannot go full screen");
  }
  await expect.poll(full).toBe(true);
  await page.keyboard.press("f");
  await expect.poll(full).toBe(false);
});

test("at 1440 x 700 the monitor, transport and timeline are all on screen and the page does not scroll", async ({ page, rushes }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await rushes.addCut();
  await rushes.api("PUT", "/api/videos/hero/shots", { shots: [{ name: "Open", start: 0 }, { name: "Turn", start: 1 }] });
  await page.goto(rushes.url);
  await videoReady(page);
  for (const part of [monitor(page), transport(page), ruler(page), pictureTrack(page)]) await expect(part).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.locator("main.body").evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
});

test("the timeline's divider drags, and the split is remembered", async ({ page, rushes }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  const divider = page.getByRole("separator", { name: "Resize the timeline" });
  const before = (await monitor(page).boundingBox())!.height;
  const d = (await divider.boundingBox())!;
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
  await page.mouse.down();
  await page.mouse.move(d.x + d.width / 2, d.y - 120, { steps: 5 });
  await page.mouse.up();
  const after = (await monitor(page).boundingBox())!.height;
  expect(after).toBeLessThan(before - 80);
  expect(await page.evaluate(() => localStorage.getItem("rushes:split"))).not.toBeNull();
  await page.reload();
  await videoReady(page);
  expect(Math.abs((await monitor(page).boundingBox())!.height - after)).toBeLessThanOrEqual(3);
});

test("a drag on the timeline's divider that the browser cancels leaves it at rest: a later move does not resize", async ({ page, rushes }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  const divider = page.getByRole("separator", { name: "Resize the timeline" });
  const d = (await divider.boundingBox())!;
  const x = d.x + d.width / 2;
  const y = d.y + d.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 40, { steps: 3 });
  // The browser takes the pointer away (a system gesture, a touch turned into a scroll).
  await divider.dispatchEvent("pointercancel", { pointerId: 1, pointerType: "mouse", clientX: x, clientY: y - 40 });
  const held = (await monitor(page).boundingBox())!.height;
  await divider.dispatchEvent("pointermove", { pointerId: 1, pointerType: "mouse", clientX: x, clientY: y - 200 });
  expect(Math.abs((await monitor(page).boundingBox())!.height - held)).toBeLessThanOrEqual(1);
  await page.mouse.up();
});

test("volume and mute are remembered", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  await transport(page).getByRole("slider", { name: "Volume" }).fill("0.4");
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.volume)).toBeCloseTo(0.4, 2);
  await transport(page).getByRole("button", { name: "Mute" }).click();
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  await page.reload();
  await videoReady(page);
  await expect(transport(page).getByRole("button", { name: "Unmute" })).toBeVisible();
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => [v.muted, Math.round(v.volume * 10)])).toEqual([true, 4]);
  // Moving the level up again unmutes, as players do.
  await transport(page).getByRole("slider", { name: "Volume" }).fill("0.6");
  await expect(transport(page).getByRole("button", { name: "Mute" })).toBeVisible();
});

test("the format switch sits on the monitor for a two-format cut, and not at all for a one-format cut", async ({ page, rushes }) => {
  await rushes.addCut("teaser cut", "Teaser");
  await rushes.addFormatsCut([WIDE, TALL], { video: "Launch" });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(toggle(page)).toHaveCount(0);
  await pickFilm(page, "Launch");
  await videoReady(page);
  await expect(monitor(page).getByRole("radiogroup", { name: "Format" })).toBeVisible();
  await expect(deskBar(page).getByRole("radiogroup", { name: "Format" })).toHaveCount(0);
  // Top right of the monitor.
  const m = (await monitor(page).boundingBox())!;
  const f = (await toggle(page).boundingBox())!;
  expect(m.x + m.width - (f.x + f.width)).toBeLessThan(40);
  expect(f.y - m.y).toBeLessThan(40);
});

test("a 9:16 cut sits whole in the monitor, centred on black", async ({ page, rushes }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await rushes.addVerticalCut();
  await page.goto(rushes.url);
  await videoReady(page);
  await expect.poll(async () => { const f = (await page.locator(".frame").boundingBox())!; return Math.abs(f.width / f.height - 9 / 16) < 0.03; }).toBe(true);
  const f = (await page.locator(".frame").boundingBox())!;
  const box = (await page.locator(".monitor .framebox").boundingBox())!;
  expect(f.y).toBeGreaterThanOrEqual(box.y - 1);
  expect(f.y + f.height).toBeLessThanOrEqual(box.y + box.height + 1);
  expect(Math.abs(f.x + f.width / 2 - (box.x + box.width / 2))).toBeLessThanOrEqual(2);
});

// ---- §27, 5.6: sound on the timeline. The takes in use play in step with the picture; the Mix tab is gone. ----

type Heard = { id: string; lane: string; path: string; offset: number };
type Snapshot = { playing: boolean; time: number; lanes: Record<string, number>; media: string[] };
// The test hook (web/src/ui/AudioStage.tsx, `?test=1`), typed loosely: the e2e build never imports web code.
type AudioHook = { engine: { time: number; playing: boolean } | null; inspect(): Snapshot | null; heard(): Heard[] };
const audio = (page: Page) => page.evaluate(() => (window as unknown as { __rushesAudio: AudioHook }).__rushesAudio.inspect());
const heardNow = (page: Page) => page.evaluate(() => (window as unknown as { __rushesAudio: AudioHook }).__rushesAudio.heard().map((c) => c.id));
const videoMuted = (page: Page) => page.locator("video").evaluate((v: HTMLVideoElement) => v.muted);

/** A cut and a read, a bed and a pass, each in use (4 s tones). */
async function threeInUse(rushes: Rushes) {
  await rushes.addCut();
  const read = await rushes.addVariant("voice", "Gerald", { round: "Round 1 · Voices", seconds: 4, freq: 220 });
  const bed = await rushes.addVariant("music", "Warm keys", { seconds: 4, freq: 330 });
  const pass = await rushes.addVariant("sfx", "Pass A", { seconds: 4, freq: 880 });
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [read.lane.id]: read.variant.id, [bed.lane.id]: bed.variant.id, [pass.lane.id]: pass.variant.id } });
  return { read, bed, pass };
}

/** Opens the Timeline tab with the test hook, once the engine holds `files` files. */
async function openTimeline(page: Page, rushes: Rushes, files: number) {
  await page.goto(rushes.testUrl());
  await videoReady(page);
  await expect.poll(async () => (await audio(page))?.media.length ?? 0, { timeout: 10_000 }).toBe(files);
}

test("with a read, a bed and a pass in use, the timeline shows a row each, named for its take, and plays all three with the picture", async ({ page, rushes }) => {
  await threeInUse(rushes);
  await openTimeline(page, rushes, 3);
  await expect(soundBlock(page, "Voice")).toHaveAccessibleName(/ · Gerald$/);
  await expect(soundBlock(page, "Music")).toHaveAccessibleName(/ · Warm keys$/);
  await expect(soundBlock(page, "Effects")).toHaveAccessibleName(/ · Pass A$/);
  for (const name of ["Voice", "Music", "Effects"] as const) {
    // Red, round 2: the row's head is its name, M, S and level; no take count (what is new is on the sound's tab).
    await expect(soundTrack(page, name).locator(".thead")).toHaveText(new RegExp(`^${name}MS`));
    await expect(soundTrack(page, name).locator(".tcount")).toHaveCount(0);
    await expect(soundTrack(page, name).locator("canvas.wave")).toHaveCount(1);
  }
  // Red, 16 Nov: the ruler, the sounds in this order, the Picture track at the foot, then the zoom bar.
  const rows = await page.locator(".tlpanel .trow").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  expect(rows).toEqual([null, "Voice track", "Music track", "Effects track", "Picture track", null]);
  expect(await heardNow(page)).toEqual(["round-1-voices/gerald", "music/warm-keys", "sfx/pass-a"]);
  // The video is the clock: Play starts it, and the engine follows.
  await transport(page).getByRole("button", { name: "Play · Space" }).click();
  await expect.poll(async () => (await audio(page))!.playing).toBe(true);
  await expect.poll(async () => (await audio(page))!.time).toBeGreaterThan(0.3);
  await transport(page).getByRole("button", { name: "Pause · Space" }).click();
  await expect.poll(async () => (await audio(page))!.playing).toBe(false);
  // A seek while paused moves the engine to the picture.
  await page.locator("video").evaluate((v: HTMLVideoElement) => { v.currentTime = 1.5; });
  await expect.poll(async () => Math.abs((await audio(page))!.time - 1.5)).toBeLessThan(0.06);
});

test("Mute Music silences only music, solo wins, and the level slider saves levels.music", async ({ page, rushes }) => {
  await threeInUse(rushes);
  await openTimeline(page, rushes, 3);
  await expect.poll(async () => (await audio(page))!.lanes).toEqual({ vo: 1, music: 1, sfx: 1 });
  await soundButton(page, "Music", "Mute").click();
  await expect(soundButton(page, "Music", "Mute")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await audio(page))!.lanes).toEqual({ vo: 1, music: 0, sfx: 1 });
  expect(await heardNow(page)).toEqual(["round-1-voices/gerald", "sfx/pass-a"]);
  await soundButton(page, "Voice", "Solo").click();
  await expect.poll(async () => (await audio(page))!.lanes).toEqual({ vo: 1, music: 0, sfx: 0 });
  await soundButton(page, "Voice", "Solo").click();
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/picks") && r.request().method() === "PUT" && r.request().postDataJSON()?.levels?.music === -6);
  await soundLevel(page, "Music").fill("-6");
  await expect(soundTrack(page, "Music").locator(".db")).toHaveText("−6.0 dB");
  expect((await saved).ok()).toBe(true);
  expect((await rushes.api("GET", "/api/picks?video=hero")).levels).toEqual({ music: -6 });
});

test("the loudness readout sits in the transport while a take is in use, and not otherwise", async ({ page, rushes }) => {
  await threeInUse(rushes);
  await page.route("**/api/mix/loudness", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: true, integrated: -16.2, truePeak: -1.5, musicUnderVo: -18, silent: false }) }));
  await openTimeline(page, rushes, 3);
  await expect(loudness(page).locator("[data-value]")).toHaveText(["−16.2", "−1.5", "−18 dB"]);
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { "round-1-voices": null, music: null, sfx: null } });
  await expect(loudness(page)).toHaveCount(0);
});

test("unpicking the bed leaves Music empty and the rest playing; a sound with no takes says Not started", async ({ page, rushes }) => {
  await rushes.addCut();
  const read = await rushes.addVariant("voice", "Gerald", { round: "Round 1 · Voices", seconds: 4, freq: 220 });
  const bed = await rushes.addVariant("music", "Warm keys", { seconds: 4, freq: 330 });
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [read.lane.id]: read.variant.id, [bed.lane.id]: bed.variant.id } });
  await openTimeline(page, rushes, 2);
  await expect(soundBlock(page, "Effects")).toHaveText("Not started");
  await expect(soundBlock(page, "Effects")).toHaveClass(/\bnone\b/);
  // Readable in its row, not only present in the page (final review I1).
  await expectReadableInRow(soundLabel(page, "Effects"), soundTrack(page, "Effects"));
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [bed.lane.id]: null } });
  // The bed is still there, waiting to be chosen again.
  await expect(soundBlock(page, "Music")).toHaveText("Nothing chosen yet");
  await expectReadableInRow(soundLabel(page, "Music"), soundTrack(page, "Music"));
  await expect.poll(() => heardNow(page)).toEqual(["round-1-voices/gerald"]);
  await transport(page).getByRole("button", { name: "Play · Space" }).click();
  await expect.poll(async () => (await audio(page))!.time).toBeGreaterThan(0.3);
});

test("a take whose file is missing says File not found, and the others still play", async ({ page, rushes }) => {
  const { pass } = await threeInUse(rushes);
  const file = (await rushes.api("GET", "/api/state")).project.lanes.find((l: { id: string }) => l.id === pass.lane.id).variants[0].file;
  await rm(join(rushes.root, file));
  await openTimeline(page, rushes, 2);
  await expect(soundBlock(page, "Effects")).toHaveText("File not found");
  await expectReadableInRow(soundLabel(page, "Effects"), soundTrack(page, "Effects"));
  expect(await heardNow(page)).toEqual(["round-1-voices/gerald", "music/warm-keys"]);
  await transport(page).getByRole("button", { name: "Play · Space" }).click();
  await expect.poll(async () => (await audio(page))!.time).toBeGreaterThan(0.3);
});

test("a take made for an older cut has a dashed amber outline", async ({ page, rushes }) => {
  await rushes.addCut();
  const bed = await rushes.addVariant("music", "Warm keys", { seconds: 4, freq: 330 });
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [bed.lane.id]: bed.variant.id } });
  await openTimeline(page, rushes, 1);
  await expect(soundBlock(page, "Music")).not.toHaveClass(/stale/);
  await rushes.addCut();
  await expect(cutButton(page)).toHaveAttribute("data-version", "v2");
  await expect(soundBlock(page, "Music")).toHaveClass(/stale/);
  expect(await soundBlock(page, "Music").evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("dashed");
});

test("a cut with no sound of its own and no takes has no sound to follow and no Cut sound row", async ({ page, rushes }) => {
  await rushes.addCut();
  await openTimeline(page, rushes, 0);
  for (const name of ["Voice", "Music", "Effects"] as const) {
    await expect(soundBlock(page, name)).toHaveText("Not started");
    await expectReadableInRow(soundLabel(page, name), soundTrack(page, name));
  }
  // The rows fit, so the timeline panel does not scroll inside itself.
  expect(await timelinePanel(page).evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await expect(soundTrack(page, "Cut sound")).toHaveCount(0);
  expect(await videoMuted(page)).toBe(false);
});

test("playing, the takes are re-seated on the picture when they drift, and hold while the picture stalls", async ({ page, rushes }) => {
  await threeInUse(rushes);
  await openTimeline(page, rushes, 3);
  type Hooked = { __rushesAudio: { engine: { time: number; playing: boolean; seek(t: number): void } } };
  const engine = () => page.evaluate(() => { const e = (window as unknown as Hooked).__rushesAudio.engine; return { time: e.time, playing: e.playing }; });
  const videoTime = () => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime);
  await playButton(page).click();
  await expect.poll(async () => (await engine()).playing).toBe(true);
  // Knocked a second off the picture, the takes are put back on it by the picture's own timeupdates.
  await page.evaluate(() => { const e = (window as unknown as Hooked).__rushesAudio.engine; e.seek(e.time + 1); });
  await expect.poll(async () => Math.abs((await engine()).time - (await videoTime())), { timeout: 2000 }).toBeLessThan(0.2);
  // The picture stalls, waiting for data: the takes hold where they are until it moves again.
  await page.locator("video").evaluate((v: HTMLVideoElement) => {
    Object.defineProperty(v, "readyState", { configurable: true, get: () => 2 });
    v.dispatchEvent(new Event("waiting"));
  });
  expect((await engine()).playing).toBe(false);
  // While it stalls the takes never run on: they stay stopped, kept on the picture's time.
  await page.waitForTimeout(300);
  expect((await engine()).playing).toBe(false);
  expect((await engine()).time).toBeLessThanOrEqual((await videoTime()) + 0.06);
  await page.locator("video").evaluate((v: HTMLVideoElement) => {
    delete (v as unknown as { readyState?: number }).readyState;
    v.dispatchEvent(new Event("playing"));
  });
  await expect.poll(async () => (await engine()).playing).toBe(true);
});

test("with no take in use, playing the cut never starts the audio engine", async ({ page, rushes }) => {
  await rushes.addCut();
  await openTimeline(page, rushes, 0);
  await playButton(page).click();
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.3);
  expect(await page.evaluate(() => (window as unknown as { __rushesAudio: AudioHook }).__rushesAudio.engine?.playing ?? false)).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { __rushesAudio: { liveContexts(): number } }).__rushesAudio.liveContexts())).toBe(0);
});

test("a solo on a sound whose take goes stops counting, and a take picked again starts unsoloed (fix round 1)", async ({ page, rushes }) => {
  const { bed } = await threeInUse(rushes);
  const asked: string[][] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/mix/loudness") && r.method() === "POST") asked.push(r.postDataJSON().lanes);
  });
  await openTimeline(page, rushes, 3);
  await soundButton(page, "Music", "Solo").click();
  await expect.poll(async () => (await audio(page))!.lanes).toEqual({ vo: 0, music: 1, sfx: 0 });
  // The bed is unpicked from elsewhere (the agent, another tab) while the timeline stays open.
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [bed.lane.id]: null } });
  await expect(soundBlock(page, "Music")).toHaveText("Nothing chosen yet");
  await expect.poll(async () => (await audio(page))!.lanes).toEqual({ vo: 1, music: 1, sfx: 1 });
  expect(await heardNow(page)).toEqual(["round-1-voices/gerald", "sfx/pass-a"]);
  await expect.poll(() => asked.at(-1)).toEqual(["voice", "sfx"]);
  // Picked again, it starts as any take does: not soloed.
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [bed.lane.id]: bed.variant.id } });
  await expect(soundButton(page, "Music", "Solo")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await audio(page))!.lanes).toEqual({ vo: 1, music: 1, sfx: 1 });
});

test("while the cut's own sound can't be worked out, its row is there with an M that unmutes the video (fix round 1)", async ({ page, rushes }) => {
  await rushes.addCut();
  const bed = await rushes.addVariant("music", "Warm keys", { seconds: 4, freq: 330 });
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [bed.lane.id]: bed.variant.id } });
  // The peaks can't be had, and nothing falls back to decoding in the browser.
  await page.route("**/api/videos/*/versions/*/peaks", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "x", message: "x" }) }));
  await openTimeline(page, rushes, 1);
  await expect(soundTrack(page, "Cut sound")).toBeVisible();
  await expect(soundButton(page, "Cut sound", "Mute")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => videoMuted(page)).toBe(true);
  await soundButton(page, "Cut sound", "Mute").click();
  await expect.poll(() => videoMuted(page)).toBe(false);
});

test("a project with takes in use and no cut plays them on the Timeline tab, with notes on the mix (fix round 1)", async ({ page, rushes }) => {
  const read = await rushes.addVariant("voice", "Gerald", { round: "Round 1 · Voices", seconds: 4, freq: 220 });
  const bed = await rushes.addVariant("music", "Warm keys", { seconds: 4, freq: 330 });
  await rushes.api("PUT", "/api/picks", { lanes: { [read.lane.id]: read.variant.id, [bed.lane.id]: bed.variant.id } });
  await page.goto(rushes.testUrl());
  await page.keyboard.press("6");
  await expect(reviewTab(page, "Timeline")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".noslate")).toContainText("No cut yet");
  await expect(soundBlock(page, "Voice")).toHaveAccessibleName(/ · Gerald$/);
  await expect(soundBlock(page, "Music")).toHaveAccessibleName(/ · Warm keys$/);
  await expect.poll(async () => (await audio(page))?.media.length ?? 0, { timeout: 10_000 }).toBe(2);
  expect(await heardNow(page)).toEqual(["round-1-voices/gerald", "music/warm-keys"]);
  await transport(page).getByRole("button", { name: "Play · Space" }).click();
  await expect.poll(async () => (await audio(page))!.time).toBeGreaterThan(0.3);
  await soundButton(page, "Music", "Mute").click();
  await expect.poll(async () => (await audio(page))!.lanes).toEqual({ vo: 1, music: 0, sfx: 1 });
  await transport(page).getByRole("button", { name: "Pause · Space" }).click();
  // With no cut there is no frame: the note is on the mix, at the playhead.
  await expect(noteTargetLine(page)).toContainText("The whole mix");
  await page.getByRole("textbox", { name: "New note" }).fill("Music fights the read.");
  await page.getByRole("textbox", { name: "New note" }).press("Enter");
  await expect(page.locator(".note .nx")).toHaveText(["Music fights the read."]);
  expect((await rushes.api("GET", "/api/notes?stage=mix")).notes).toHaveLength(1);
  // The tab is open by its tab too.
  await reviewTab(page, "Music").click();
  await reviewTab(page, "Timeline").click();
  await expect(page.locator(".noslate")).toBeVisible();
});

test("with no cut and nothing in use, the Timeline tab stays locked (fix round 1)", async ({ page, rushes }) => {
  await rushes.addVariant("music", "Warm keys", { seconds: 4, freq: 330 });
  await page.goto(rushes.testUrl());
  await page.keyboard.press("6");
  await expect(page.locator(".locked")).toBeVisible();
  await expect(page.locator(".strack")).toHaveCount(0);
});

// ---- final review I4: amber to do, blue while the agent has it, green done (spec 5.5, 5.7) ----

/** A colour token as the page computes it ("rgb(76, 141, 255)"), to compare with a computed style. */
const tokenColor = (page: Page, token: string) => page.evaluate((t) => {
  const d = document.createElement("div");
  d.style.color = `var(${t})`;
  document.body.append(d);
  const c = getComputedStyle(d).color;
  d.remove();
  return c;
}, token);
const bg = (l: import("@playwright/test").Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
const ring = (l: import("@playwright/test").Locator) => l.evaluate((el) => getComputedStyle(el).borderTopColor);

test("a note is amber to do, blue once sent, green when done: on the ruler, its sound row, its take row and its dot", async ({ page, rushes }) => {
  await rushes.addCut();
  const bed = await rushes.addVariant("music", "Warm keys", { seconds: 4, freq: 330 });
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [bed.lane.id]: bed.variant.id } });
  const { note: pic } = await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Hold the frame." });
  const { note: mus } = await rushes.api("POST", "/api/notes", { stage: "music", video: "hero", on: `${bed.lane.id}/${bed.variant.id}`, scope: "point", t: 2, text: "Pad in late." });
  await openTimeline(page, rushes, 1);
  const marker = ruler(page).locator(`.mk[data-note="${pic.id}"]`);
  const rowMark = soundTrack(page, "Music").locator(`.mk[data-note="${mus.id}"]`);
  const dot = notesPanel(page).locator(`.note[data-note="${pic.id}"] .chk`);
  const [todo, sent, done] = [await tokenColor(page, "--todo"), await tokenColor(page, "--accent"), await tokenColor(page, "--done")];

  expect(await bg(marker)).toBe(todo);
  expect(await bg(rowMark)).toBe(todo);
  expect(await ring(dot)).toBe(todo);
  await expect(marker).toHaveAccessibleName("Hold the frame.");
  await expect(dot).toHaveAccessibleName("Mark done");

  await sendButton(page).click();
  await sentDialog(page).getByRole("button", { name: "Close" }).click();
  await expect.poll(() => bg(marker)).toBe(sent);
  expect(await bg(rowMark)).toBe(sent);
  expect(await ring(dot)).toBe(sent);
  await expect(marker).toHaveAccessibleName("With your agent · Hold the frame.");
  await expect(marker).toHaveAttribute("data-tip", "With your agent · Hold the frame.");
  await expect(rowMark).toHaveAttribute("title", "With your agent · Pad in late.");
  await expect(dot).toHaveAccessibleName("With your agent · Mark done");
  await expect(dot).toHaveAttribute("data-tip", "With your agent · Mark done");
  // Still to do: the To do filter lists it.
  await notesPanel(page).getByRole("combobox", { name: "Filter notes" }).selectOption({ label: "To do" });
  await expect(notesPanel(page).locator(`.note[data-note="${pic.id}"]`)).toBeVisible();
  await notesPanel(page).getByRole("combobox", { name: "Filter notes" }).selectOption({ label: "All" });
  // The take's own row, on its tab.
  await page.keyboard.press("4");
  const takeMark = takeBlock(page, "Warm keys").locator(`.mk[data-note="${mus.id}"]`);
  expect(await bg(takeMark)).toBe(sent);
  await expect(takeMark).toHaveAttribute("title", "With your agent · Pad in late.");

  await rushes.api("POST", "/api/replies", { replies: [{ id: pic.id, status: "done", reply: "Held." }, { id: mus.id, status: "done", reply: "Earlier." }] });
  await expect.poll(() => bg(takeMark)).toBe(done);
  await page.keyboard.press("2");
  await videoReady(page);
  await expect.poll(() => bg(marker)).toBe(done);
  expect(await bg(rowMark)).toBe(done);
  await expect(dot).toHaveAccessibleName("Reopen");
});

// ---- final review I3: one playhead per film across the Review tabs ----

/** The transport's time, without the length after it: "0:01.50". */
const timecodeNow = async (page: Page) => (await page.getByLabel("Timecode").textContent())!.split("/")[0]!.trim();
/** Where the ruler's playhead is, in seconds. */
const rulerAt = async (page: Page) => Number(await ruler(page).getAttribute("aria-valuenow"));
const videoAt = (page: Page) => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime);

test("one playhead across the Review tabs: Music opens where the Timeline is, the Timeline where Voice is, and the Timeline keeps its mute and solo", async ({ page, rushes }) => {
  await threeInUse(rushes);
  await openTimeline(page, rushes, 3);
  await page.locator("video").evaluate((v: HTMLVideoElement) => { v.currentTime = 1.5; });
  await expect.poll(() => timecodeNow(page)).toBe("0:01.50");
  await soundButton(page, "Music", "Mute").click();
  await soundButton(page, "Voice", "Solo").click();

  await page.keyboard.press("4");
  await expect(reviewTab(page, "Music")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => timecodeNow(page)).toBe("0:01.50");
  await expect.poll(async () => Math.abs((await audio(page))!.time - 1.5)).toBeLessThan(0.01);
  await expect.poll(async () => Math.abs((await rulerAt(page)) - 1.5)).toBeLessThan(0.01);
  await expect.poll(async () => Math.abs((await videoAt(page)) - 1.5)).toBeLessThan(0.05);

  // Moved on Voice, the Timeline opens at the new place.
  await page.keyboard.press("3");
  await expect(reviewTab(page, "Voice")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => timecodeNow(page)).toBe("0:01.50");
  await transport(page).getByRole("button", { name: "Forward one frame · →" }).click();
  await transport(page).getByRole("button", { name: "Forward one frame · →" }).click();
  const there = await timecodeNow(page);
  expect(there).not.toBe("0:01.50");
  const thereT = (await audio(page))!.time;
  await page.keyboard.press("2");
  await expect(reviewTab(page, "Timeline")).toHaveAttribute("aria-selected", "true");
  await videoReady(page);
  await expect.poll(() => timecodeNow(page)).toBe(there);
  await expect.poll(async () => Math.abs((await videoAt(page)) - thereT)).toBeLessThan(0.02);
  await expect.poll(async () => Math.abs((await rulerAt(page)) - thereT)).toBeLessThan(0.02);
  await expect(soundButton(page, "Music", "Mute")).toHaveAttribute("aria-pressed", "true");
  await expect(soundButton(page, "Voice", "Solo")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await audio(page))!.lanes).toEqual({ vo: 1, music: 0, sfx: 0 });
});

test("a film switch restores that film's playhead on the Timeline and on a sound's tab, and clears the Timeline's mute", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.addCut(undefined, "Cutdown");
  // On both films, so Music is open on each (§31.5: a film's tabs unlock on its own material); in use on Hero only.
  const bed = await rushes.addVariant("music", "Warm keys", { seconds: 4, freq: 330, video: ["hero", "cutdown"] });
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [bed.lane.id]: bed.variant.id } });
  await page.goto(rushes.testUrl());
  await videoReady(page);
  await expect(currentFilm(page)).toHaveText("Hero");
  await page.locator("video").evaluate((v: HTMLVideoElement) => { v.currentTime = 1.5; });
  await expect.poll(() => timecodeNow(page)).toBe("0:01.50");
  await soundButton(page, "Music", "Mute").click();
  // Another film starts at its own place (the top), on the Timeline and on Music.
  await page.keyboard.press("]");
  await expect(currentFilm(page)).toHaveText("Cutdown");
  await expect.poll(() => timecodeNow(page)).toBe("0:00.00");
  await page.keyboard.press("4");
  await expect(reviewTab(page, "Music")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => timecodeNow(page)).toBe("0:00.00");
  // Back on Hero, still on Music: Hero's place.
  await page.keyboard.press("[");
  await expect(currentFilm(page)).toHaveText("Hero");
  await expect.poll(() => timecodeNow(page)).toBe("0:01.50");
  await page.keyboard.press("2");
  await videoReady(page);
  await expect.poll(() => timecodeNow(page)).toBe("0:01.50");
  await expect(soundButton(page, "Music", "Mute")).toHaveAttribute("aria-pressed", "false");
});

test("with no cut, the Timeline and the sound tabs share the playhead and the Timeline keeps its mute", async ({ page, rushes }) => {
  const read = await rushes.addVariant("voice", "Gerald", { round: "Round 1 · Voices", seconds: 4, freq: 220 });
  const bed = await rushes.addVariant("music", "Warm keys", { seconds: 4, freq: 330 });
  await rushes.api("PUT", "/api/picks", { lanes: { [read.lane.id]: read.variant.id, [bed.lane.id]: bed.variant.id } });
  await page.goto(rushes.testUrl());
  await page.keyboard.press("6");
  await expect(page.locator(".noslate")).toBeVisible();
  await expect.poll(async () => (await audio(page))?.media.length ?? 0, { timeout: 10_000 }).toBe(2);
  for (let i = 0; i < 6; i++) await transport(page).getByRole("button", { name: "Forward one frame · →" }).click();
  const there = await timecodeNow(page);
  expect(there).not.toBe("0:00.00");
  const thereT = (await audio(page))!.time;
  await soundButton(page, "Music", "Mute").click();
  await page.keyboard.press("4");
  await expect(reviewTab(page, "Music")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => timecodeNow(page)).toBe(there);
  await expect.poll(async () => Math.abs((await audio(page))!.time - thereT)).toBeLessThan(0.01);
  await page.keyboard.press("6");
  await expect(page.locator(".noslate")).toBeVisible();
  await expect.poll(() => timecodeNow(page)).toBe(there);
  await expect.poll(async () => Math.abs(((await audio(page))?.time ?? -1) - thereT)).toBeLessThan(0.01);
  await expect(soundButton(page, "Music", "Mute")).toHaveAttribute("aria-pressed", "true");
});

test.describe("the cut's own sound", () => {
  test.skip(!hasFfmpeg, "needs ffmpeg and ffprobe");

  test("a solo silences the cut's own sound only while its sound has a take (fix round 1)", async ({ page, rushes }) => {
    await rushes.addProResCut({ codec: "h264", seconds: 3, audio: true });
    const bed = await rushes.addVariant("music", "Warm keys", { seconds: 3, freq: 330 });
    await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [bed.lane.id]: bed.variant.id } });
    await openTimeline(page, rushes, 1);
    await soundButton(page, "Cut sound", "Mute").click();
    await expect.poll(() => videoMuted(page)).toBe(false);
    await soundButton(page, "Music", "Solo").click();
    await expect.poll(() => videoMuted(page)).toBe(true);
    await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [bed.lane.id]: null } });
    await expect(soundBlock(page, "Music")).toHaveText("Nothing chosen yet");
    await expect.poll(() => videoMuted(page)).toBe(false);
  });

  test("a Cut sound M pressed before its row goes does not keep the video muted with no M to undo it", async ({ page, rushes }) => {
    await rushes.addProResCut({ codec: "h264", seconds: 3, audio: true });
    await openTimeline(page, rushes, 0);
    const m = soundButton(page, "Cut sound", "Mute");
    await expect(m).toHaveAttribute("aria-pressed", "false");
    await m.click();
    await expect.poll(() => videoMuted(page)).toBe(true);
    // A new cut whose own sound is still being worked out: with nothing in use its row waits for the answer.
    await page.route("**/api/videos/*/versions/v2/peaks", () => undefined);
    await rushes.addProResCut({ codec: "h264", seconds: 3, audio: true });
    await pickVersion(page, "v2");
    await videoReady(page);
    await expect(soundTrack(page, "Cut sound")).toHaveCount(0);
    // The M pressed on v1's row went with it: v2 plays its own sound.
    await expect.poll(() => videoMuted(page)).toBe(false);
  });

  test("a cut with its own sound and no takes plays unmuted and shows a Cut sound row that is not muted", async ({ page, rushes }) => {
    await rushes.addProResCut({ codec: "h264", seconds: 3, audio: true });
    await openTimeline(page, rushes, 0);
    await expect(soundTrack(page, "Cut sound")).toBeVisible();
    await expect(soundButton(page, "Cut sound", "Mute")).toHaveAttribute("aria-pressed", "false");
    expect(await videoMuted(page)).toBe(false);
  });

  test("with a take in use the video is muted, and the Cut sound row's own M lets you hear it", async ({ page, rushes }) => {
    await rushes.addProResCut({ codec: "h264", seconds: 3, audio: true });
    const bed = await rushes.addVariant("music", "Warm keys", { seconds: 3, freq: 330 });
    await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [bed.lane.id]: bed.variant.id } });
    await openTimeline(page, rushes, 1);
    await expect(soundTrack(page, "Cut sound")).toBeVisible();
    await expect(soundButton(page, "Cut sound", "Mute")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => videoMuted(page)).toBe(true);
    await soundButton(page, "Cut sound", "Mute").click();
    await expect(soundButton(page, "Cut sound", "Mute")).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => videoMuted(page)).toBe(false);
  });
});

test("notes on the mix are listed on the Timeline tab, and The whole mix in the target line saves one on the whole mix", async ({ page, rushes }) => {
  await threeInUse(rushes);
  await rushes.api("POST", "/api/notes", { stage: "mix", video: "hero", on: null, scope: "point", t: 1, text: "Music a touch loud." });
  await openTimeline(page, rushes, 3);
  await expect(page.locator(".note .nx")).toHaveText(["Music a touch loud."]);
  await expect(page.locator(".note .on")).toHaveText(["Whole mix"]);
  await noteTargetMenu(page).selectOption({ label: "The whole mix" });
  await page.getByRole("textbox", { name: "New note" }).fill("Voice sits under the bed.");
  await page.getByRole("textbox", { name: "New note" }).press("Enter");
  await expect(page.locator(".note")).toHaveCount(2);
  const { notes } = await rushes.api("GET", "/api/notes?stage=mix");
  expect(notes.find((n: { text: string }) => n.text === "Voice sits under the bed.")).toMatchObject({ stage: "mix", on: null, video: "hero" });
  // The mix tab is gone: Review has the timeline and a tab per sound.
  await expect(page.getByRole("tablist", { name: "Review" }).getByRole("tab")).toHaveText([/^Timeline/, /^Voice/, /^Music/, /^Effects/]);
});

// §27, 5.7: the notes panel. Its note box aims each note from the selection, Send counts what waits, and it hides.
test.describe("the notes panel", () => {
  const box = (page: Page) => notesPanel(page).getByRole("textbox", { name: "New note" });
  const notesOn = async (rushes: Rushes, stage: string) => (await rushes.api("GET", `/api/notes?stage=${stage}`)).notes as { text: string; stage: string; on: string | null; scope: string; t: number | null; tOut: number | null }[];

  test("Red, round 2: a sound row is never the note's target; a click on its block moves the playhead and the note stays on the film", async ({ page, rushes }) => {
    const { pass } = await threeInUse(rushes);
    await openTimeline(page, rushes, 3);
    // The row's name is a label, not a button.
    await expect(soundTrack(page, "Music").locator(".thead").getByRole("button", { name: /note on the whole take/ })).toHaveCount(0);
    const lane = soundTrack(page, "Effects").locator(".tlane");
    const r = (await lane.boundingBox())!;
    await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
    await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.5);
    await expect(noteTargetMenu(page)).toHaveValue("frame");
    await expect(noteTargetLine(page)).not.toContainText("Pass A");
    await expect(notesPanel(page).getByRole("group", { name: "Start a note" })).toHaveCount(0);
    await box(page).fill("The whoosh is late.");
    await box(page).press("Enter");
    await expect.poll(async () => (await notesOn(rushes, "picture")).length).toBe(1);
    expect(await notesOn(rushes, "sfx")).toHaveLength(0);
    // A note on a take, written on its own tab (or by the agent), is still listed here and marked on its row.
    await rushes.api("POST", "/api/notes", { stage: "sfx", video: "hero", on: `${pass.lane.id}/${pass.variant.id}`, scope: "point", t: 1, text: "Swap the whoosh." });
    await expect(soundTrack(page, "Effects").locator(".mk")).toHaveCount(1);
    await expect(soundTrack(page, "Music").locator(".mk")).toHaveCount(0);
  });

  test("with nothing selected a note is on picture at the playhead; choosing The whole mix puts it on the mix", async ({ page, rushes }) => {
    await threeInUse(rushes);
    await openTimeline(page, rushes, 3);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(noteTargetMenu(page)).toHaveValue("frame");
    await expect(noteTargetLine(page)).toContainText("00:00:00:03");
    await box(page).fill("Hold here.");
    await box(page).press("Enter");
    await expect.poll(async () => (await notesOn(rushes, "picture")).length).toBe(1);
    expect((await notesOn(rushes, "picture"))[0]).toMatchObject({ stage: "picture", on: null, scope: "point", t: 0.1 });
    await noteTargetMenu(page).selectOption({ label: "The whole mix" });
    await expect(noteTargetLine(page)).toContainText("The whole mix");
    await box(page).fill("Voice sits under the bed.");
    await box(page).press("Enter");
    await expect.poll(async () => (await notesOn(rushes, "mix")).length).toBe(1);
    expect((await notesOn(rushes, "mix"))[0]).toMatchObject({ stage: "mix", on: null, scope: "whole", t: null });
  });

  test("Escape from a control in the notes panel keeps The whole mix chosen", async ({ page, rushes }) => {
    await threeInUse(rushes);
    await openTimeline(page, rushes, 3);
    await noteTargetMenu(page).selectOption({ label: "The whole mix" });
    await expect(noteTargetMenu(page)).toHaveValue("mix");
    await panelTab(page, "Notes").focus();
    await page.keyboard.press("Escape");
    await expect(noteTargetMenu(page)).toHaveValue("mix");
    // Escape from the desk itself still lets go of it.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Escape");
    await expect(noteTargetMenu(page)).toHaveValue("frame");
  });

  test("a note on the mix uses up the box drawn before it: it does not wait for the next picture note", async ({ page, rushes }) => {
    await threeInUse(rushes);
    await openTimeline(page, rushes, 3);
    await page.keyboard.press("b");
    const o = (await page.locator(".overlay").boundingBox())!;
    await page.mouse.move(o.x + o.width * 0.3, o.y + o.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(o.x + o.width * 0.6, o.y + o.height * 0.6, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByRole("button", { name: "Remove box" })).toBeVisible();
    await noteTargetMenu(page).selectOption({ label: "The whole mix" });
    await box(page).fill("Ending is too abrupt.");
    await box(page).press("Enter");
    await expect.poll(async () => (await notesOn(rushes, "mix")).length).toBe(1);
    await expect(page.getByRole("button", { name: "Remove box" })).toHaveCount(0);
    // The next note, on picture, carries no box.
    await expect(noteTargetMenu(page)).toHaveValue("frame");
    await box(page).fill("Hold here.");
    await box(page).press("Enter");
    await expect.poll(async () => (await notesOn(rushes, "picture")).length).toBe(1);
    expect(((await notesOn(rushes, "picture"))[0] as { box: unknown }).box).toBeNull();
  });

  test("Activity, left open, is not fetched again on every switch of view", async ({ page, rushes }) => {
    await rushes.addCut();
    await rushes.addVariant("voice", "Read A", { seconds: 2, freq: 220 });
    await page.goto(rushes.url);
    await videoReady(page);
    await openActivity(page);
    await expect(activity(page).locator(".lrow").first()).toBeVisible();
    const asks: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/log?")) asks.push(r.url());
    });
    await openReviewTab(page, "Voice");
    await expect(activity(page).locator(".lrow").first()).toBeVisible();
    await openReviewTab(page, "Timeline");
    await expect(activity(page).locator(".lrow").first()).toBeVisible();
    expect(asks).toEqual([]);
    // A new line in the log is fetched as before.
    await rushes.api("POST", "/api/log", { area: "picture", text: "A line from the agent" });
    await expect(activity(page)).toContainText("A line from the agent");
  });

  test("Send shows its count only while something waits, and opens the prompt with Copy", async ({ page, rushes }) => {
    await rushes.addCut();
    await page.goto(rushes.url);
    await videoReady(page);
    await expect(notesPanel(page)).toBeVisible();
    await expect(sendButton(page)).toHaveCount(0);
    await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 0.5, text: "Hold the end card." });
    await expect(sendButton(page)).toHaveText("Send1");
    await expect(sendButton(page)).toHaveAccessibleName("Send 1");
    // Its tooltip says what the count counts: what has not been sent yet.
    await expect(sendButton(page)).toHaveAttribute("data-tip", "Notes and edits on this film not sent yet, from every tab");
    await sendButton(page).click();
    await expect(sentDialog(page)).toContainText("picture");
    await expect(sentDialog(page).getByRole("button", { name: "Copy prompt" })).toBeVisible();
    // Sent, nothing waits: Send goes until the next note.
    await expect(sendButton(page)).toHaveCount(0);
  });

  test("\\ hides and shows the panel, remembered in this browser, and never while typing", async ({ page, rushes }) => {
    await rushes.addCut();
    await page.goto(rushes.url);
    await videoReady(page);
    const monitorWidth = async () => (await monitor(page).boundingBox())!.width;
    const wide = await monitorWidth();
    await box(page).fill("half\\");
    await expect(notesPanel(page)).toBeVisible();
    await box(page).fill("");
    await box(page).blur();
    await page.keyboard.press("\\");
    await expect(notesPanel(page)).toBeHidden();
    expect(await monitorWidth()).toBeGreaterThan(wide + 200);
    await expect(panelToggle(page)).toHaveAttribute("aria-pressed", "false");
    await page.reload();
    await videoReady(page);
    await expect(notesPanel(page)).toBeHidden();
    await panelToggle(page).click();
    await expect(notesPanel(page)).toBeVisible();
    await expect(panelToggle(page)).toHaveAttribute("data-tip", "Hide the notes panel · \\");
    // In the shortcuts sheet.
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toContainText("Hide or show the notes panel");
  });

  test("a half-typed note waits in the hidden panel", async ({ page, rushes }) => {
    await rushes.addCut();
    await page.goto(rushes.url);
    await videoReady(page);
    await box(page).fill("Keep this");
    await panelToggle(page).click();
    await expect(notesPanel(page)).toBeHidden();
    await panelToggle(page).click();
    await expect(box(page)).toHaveValue("Keep this");
  });

  test("N and the Note tool show the hidden panel on its Notes tab and focus the note box", async ({ page, rushes }) => {
    await rushes.addCut();
    await page.goto(rushes.url);
    await videoReady(page);
    await page.keyboard.press("\\");
    await expect(notesPanel(page)).toBeHidden();
    await page.keyboard.press("n");
    await expect(notesPanel(page)).toBeVisible();
    await expect(box(page)).toBeFocused();
    // From Activity too: back on Notes, with the box focused.
    await box(page).blur();
    await panelTab(page, "Activity").click();
    await page.locator("main.body").click({ position: { x: 5, y: 5 } });
    await toolButton(page, "Note").click();
    await expect(panelTab(page, "Notes")).toHaveAttribute("aria-selected", "true");
    await expect(box(page)).toBeFocused();
    await box(page).blur();
    await page.keyboard.press("\\");
    await expect(notesPanel(page)).toBeHidden();
    await toolButton(page, "Note").click();
    await expect(notesPanel(page)).toBeVisible();
    await expect(box(page)).toBeFocused();
  });

  test("at 1000 px N and the Note tool open the drawer and focus the note box, on the Timeline and on a Voice tab", async ({ page, rushes }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await rushes.addCut();
    await rushes.addVariant("voice", "Gerald", { round: "Round 1", seconds: 2, freq: 220 });
    await page.goto(rushes.url);
    await videoReady(page);
    await expect(notesPanel(page)).toBeHidden();
    await page.keyboard.press("n");
    await expect(notesPanel(page)).toBeVisible();
    await expect(box(page)).toBeFocused();
    await box(page).blur();
    await page.keyboard.press("\\");
    await expect(notesPanel(page)).toBeHidden();
    await toolButton(page, "Note").click();
    await expect(notesPanel(page)).toBeVisible();
    await expect(box(page)).toBeFocused();
    await box(page).blur();
    await page.keyboard.press("\\");
    await page.keyboard.press("3");
    await expect(reviewTab(page, "Voice")).toHaveAttribute("aria-selected", "true");
    await expect(notesPanel(page)).toBeHidden();
    await page.keyboard.press("n");
    await expect(notesPanel(page)).toBeVisible();
    await expect(box(page)).toBeFocused();
  });

  test("Escape that closes a menu or the Sent panel leaves The whole mix and the range; Escape in the empty box lets go of The whole mix only", async ({ page, rushes }) => {
    await threeInUse(rushes);
    await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 0.5, text: "Hold the end card." });
    await openTimeline(page, rushes, 3);
    await noteTargetMenu(page).selectOption({ label: "The whole mix" });
    await page.keyboard.press("i");
    for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("o");
    const kept = async () => {
      await expect(noteTargetMenu(page)).toHaveValue("mix");
      await expect(rangeChip(page)).toBeVisible();
    };
    await kept();
    // The More menu, closed by Escape.
    await page.getByRole("button", { name: "More", exact: true }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await kept();
    // The Sent panel, closed by Escape.
    await sendButton(page).click();
    await expect(sentDialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sentDialog(page)).toHaveCount(0);
    await kept();
    // Escape in the empty note box: The whole mix goes, the range stays.
    await box(page).focus();
    await page.keyboard.press("Escape");
    await expect(noteTargetMenu(page)).toHaveValue("frame");
    await expect(rangeChip(page)).toBeVisible();
  });

  test("at 1000 px wide the panel is a drawer over the work area, opened and closed with \\ and its button", async ({ page, rushes }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await rushes.addCut();
    await page.goto(rushes.url);
    await videoReady(page);
    await expect(notesPanel(page)).toBeHidden();
    const before = (await monitor(page).boundingBox())!;
    await page.keyboard.press("\\");
    await expect(notesPanel(page)).toBeVisible();
    const drawer = (await notesPanel(page).boundingBox())!;
    // Over the work area: the monitor keeps its width underneath it.
    expect((await monitor(page).boundingBox())!.width).toBe(before.width);
    expect(drawer.x).toBeLessThan(before.x + before.width);
    expect(Math.round(drawer.x + drawer.width)).toBe(1000);
    await notesPanel(page).getByRole("button", { name: "Hide the notes panel · \\" }).click();
    await expect(notesPanel(page)).toBeHidden();
    await panelToggle(page).click();
    await expect(notesPanel(page)).toBeVisible();
    await page.keyboard.press("\\");
    await expect(notesPanel(page)).toBeHidden();
  });

  test("the status bar's send N notes opens Send in the panel, from Visuals and Assets too", async ({ page, rushes }) => {
    await rushes.addCut();
    await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 0.5, text: "Hold the end card." });
    await page.goto(rushes.url);
    await videoReady(page);
    await openWorkspace(page, "Assets");
    await expect(notesPanel(page)).toHaveCount(0);
    await statusSend(page).click();
    await expect(workspaceTab(page, "Review")).toHaveAttribute("aria-selected", "true");
    await expect(sendButton(page)).toBeFocused();
  });
});

// §27, 5.8: a tab per sound. Voice, Music and Effects list every take: new, in use, earlier and put away, under the
// same ruler as the timeline, with the Picture row at the top. The circle picks; the row auditions.
test.describe("a tab per sound", () => {
  const heardOn = (page: Page) => page.evaluate(() => (window as unknown as { __rushesAudio: AudioHook }).__rushesAudio.heard().map((c) => c.id));
  const loadedOn = async (page: Page, n: number) => expect.poll(async () => (await audio(page))?.media.length ?? 0, { timeout: 10_000 }).toBe(n);

  test("three rounds of reads with the second in use list New, In use and Earlier, each under its round", async ({ page, rushes }) => {
    await rushes.addCut();
    await rushes.addVariant("voice", "Jane", { round: "Round 1 · Voices", seconds: 2, freq: 220 });
    const gerald = await rushes.addVariant("voice", "Gerald", { round: "Round 2 · Gerald", seconds: 2, freq: 262 });
    await rushes.addVariant("voice", "Gerald, slower", { round: "Round 2 · Gerald", seconds: 2, freq: 294 });
    await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [gerald.lane.id]: gerald.variant.id } });
    await rushes.addVariant("voice", "Gerald, warmer", { round: "Round 3 · Gerald, fixes", seconds: 2, freq: 330 });
    await page.goto(rushes.url);
    await videoReady(page);
    await expect(reviewTab(page, "Voice")).toHaveText("Voice 1 new");
    await openReviewTab(page, "Voice");
    await expect(takeHeadings(page)).toHaveText(["New · Round 3 · Gerald, fixes", "In use · Round 2 · Gerald", "Earlier · Round 2 · Gerald", "Earlier · Round 1 · Voices"]);
    await expect(takeRows(page)).toHaveCount(4);
    await expect(takeRows(page).locator(".knm")).toHaveText(["Gerald, warmer", "Gerald", "Gerald, slower", "Jane"]);
    await expect(takeCircle(page, "Gerald")).toHaveAttribute("aria-checked", "true");
    await expect(takeCircle(page, "Gerald")).toHaveAccessibleName("In use: Gerald");
    await expect(takeCircle(page, "Gerald")).toHaveAttribute("data-tip", "In use");
    await expect(takeCircle(page, "Jane")).toHaveAttribute("aria-checked", "false");
    await expect(takeCircle(page, "Jane")).toHaveAccessibleName("Use this one: Jane");
    await expect(takeCircle(page, "Jane")).toHaveAttribute("data-tip", "Use this one");
    // The same frame as the timeline: the monitor, the transport, the ruler and the Picture row above the list.
    await expect(monitor(page)).toBeVisible();
    await expect(transport(page)).toBeVisible();
    await expect(ruler(page)).toBeVisible();
    await expect(pictureTrack(page)).toBeVisible();
  });

  test("a take made for an older cut has an amber tag naming that cut; one made for this cut a quiet one", async ({ page, rushes }) => {
    await rushes.addCut();
    await rushes.addVariant("music", "Pulse", { seconds: 2, freq: 220, round: "Round 1" });
    await rushes.addCut();
    await rushes.addVariant("music", "Drift", { seconds: 2, freq: 330, round: "Round 2" });
    await page.goto(rushes.url);
    await videoReady(page);
    await openReviewTab(page, "Music");
    await expect(takeTag(page, "Pulse")).toHaveText("v1");
    await expect(takeTag(page, "Pulse")).toHaveClass(/\bstale\b/);
    await expect(takeBlock(page, "Pulse").locator(".sblock")).toHaveClass(/\bstale\b/);
    await expect(takeTag(page, "Drift")).toHaveText("v2");
    await expect(takeTag(page, "Drift")).not.toHaveClass(/\bstale\b/);
    await expect(takeBlock(page, "Drift").locator(".sblock")).not.toHaveClass(/\bstale\b/);
  });

  test("the circle on a New take makes it In use, the tab's count drops to a plain number, and Unpick (not the circle again) unpicks it", async ({ page, rushes }) => {
    await rushes.addCut();
    await rushes.addVariant("music", "Pulse", { seconds: 2, freq: 220, round: "Round 1" });
    await rushes.addVariant("music", "Drift", { seconds: 2, freq: 330, round: "Round 2" });
    await page.goto(rushes.url);
    await videoReady(page);
    await expect(reviewTab(page, "Music")).toHaveText("Music 2 new");
    await openReviewTab(page, "Music");
    await expect(takeHeadings(page)).toHaveText(["New · Round 2", "New · Round 1"]);
    await takeCircle(page, "Drift").click();
    await expect(takeCircle(page, "Drift")).toHaveAttribute("aria-checked", "true");
    await expect(takeHeadings(page)).toHaveText(["In use · Round 2", "Earlier · Round 1"]);
    await expect(reviewTab(page, "Music")).toHaveText("Music 2");
    expect((await rushes.api("GET", "/api/picks?video=hero")).use.music).toMatchObject({ lane: "round-2", variant: "drift" });
    // Pressed again, the circle on the take in use changes nothing; Unpick, in the row's slot, unpicks it: nothing is in
    // use, so both wait to be chosen again.
    await takeCircle(page, "Drift").click();
    await expect(takeCircle(page, "Drift")).toHaveAttribute("aria-checked", "true");
    expect((await rushes.api("GET", "/api/picks?video=hero")).use.music).toMatchObject({ lane: "round-2", variant: "drift" });
    await pressRowButton(page, "Drift", "Unpick");
    await expect(takeCircle(page, "Drift")).toHaveAttribute("aria-checked", "false");
    await expect(reviewTab(page, "Music")).toHaveText("Music 2 new");
    expect((await rushes.api("GET", "/api/picks?video=hero")).use.music).toBeUndefined();
  });

  test("Put away moves a take under Put away, Bring back returns it to Earlier, and the take in use has no Put away", async ({ page, rushes }) => {
    await rushes.addCut();
    await rushes.addVariant("music", "Pulse", { seconds: 2, freq: 220, round: "Round 1" });
    const drift = await rushes.addVariant("music", "Drift", { seconds: 2, freq: 330, round: "Round 2" });
    await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [drift.lane.id]: drift.variant.id } });
    await page.goto(rushes.url);
    await videoReady(page);
    await openReviewTab(page, "Music");
    await expect(takeHeadings(page)).toHaveText(["In use · Round 2", "Earlier · Round 1"]);
    await expect(putAwayButton(page, "Drift")).toHaveCount(0);
    await pressRowButton(page, "Pulse");
    await expect(takeHeadings(page)).toHaveText(["In use · Round 2", "Archived · 1"]);
    await expect(takeRow(page, "Pulse")).toHaveCount(0);
    const lane = (await rushes.api("GET", "/api/state")).project.lanes.find((l: { id: string }) => l.id === "round-1");
    expect(lane.variants[0].putAway).toEqual(expect.any(String));
    await foldToggle(page, "Archived").click();
    await expect(foldToggle(page, "Archived")).toHaveAttribute("aria-expanded", "true");
    await pressRowButton(page, "Pulse", "Restore");
    await expect(takeHeadings(page)).toHaveText(["In use · Round 2", "Earlier · Round 1"]);
    await takeRow(page, "Pulse").hover();
    await expect(putAwayButton(page, "Pulse")).toBeVisible();
    expect((await rushes.api("GET", "/api/state")).project.lanes.find((l: { id: string }) => l.id === "round-1").variants[0].putAway).toBeUndefined();
  });

  test("selecting an Earlier take plays it in place of the one in use, without changing the pick", async ({ page, rushes }) => {
    await rushes.addCut();
    await rushes.addVariant("music", "Pulse", { seconds: 2, freq: 220, round: "Round 1" });
    const drift = await rushes.addVariant("music", "Drift", { seconds: 2, freq: 330, round: "Round 2" });
    await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [drift.lane.id]: drift.variant.id } });
    await page.goto(rushes.testUrl());
    await videoReady(page);
    await openReviewTab(page, "Music");
    await loadedOn(page, 2);
    // Nothing selected: the take in use plays.
    await expect.poll(() => heardOn(page)).toEqual(["round-2/drift"]);
    await takeName(page, "Pulse").click();
    await expect.poll(() => heardOn(page)).toEqual(["round-1/pulse"]);
    await expect(takeRow(page, "Pulse")).toHaveAttribute("aria-current", "true");
    await expect(takeCircle(page, "Drift")).toHaveAttribute("aria-checked", "true");
    expect((await rushes.api("GET", "/api/picks?video=hero")).use.music).toMatchObject({ lane: "round-2", variant: "drift" });
    // Let go of, the take in use plays again.
    await page.keyboard.press("Escape");
    await expect.poll(() => heardOn(page)).toEqual(["round-2/drift"]);
  });

  test("Music with three new beds lists them under New, and the Timeline tab still has the old bed", async ({ page, rushes }) => {
    await rushes.addCut();
    const old = await rushes.addVariant("music", "Old bed", { seconds: 2, freq: 220, round: "Round 1" });
    await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [old.lane.id]: old.variant.id } });
    for (const [i, name] of ["Pulse", "Drift", "Glow"].entries()) await rushes.addVariant("music", name, { seconds: 2, freq: 260 + i * 40, round: "Round 2" });
    await page.goto(rushes.url);
    await videoReady(page);
    await expect(reviewTab(page, "Music")).toHaveText("Music 3 new");
    await openReviewTab(page, "Music");
    await expect(takeHeadings(page)).toHaveText(["New · Round 2", "In use · Round 1"]);
    await expect(takeRows(page).locator(".knm")).toHaveText(["Pulse", "Drift", "Glow", "Old bed"]);
    await openReviewTab(page, "Timeline");
    await expect(soundBlock(page, "Music")).toHaveAccessibleName(/ · Old bed$/);
  });

  test("the circles are one Tab stop moved by the arrows, Enter on a name selects it, and Space still plays", async ({ page, rushes }) => {
    await rushes.addCut();
    for (const [i, name] of ["Pulse", "Drift", "Glow"].entries()) await rushes.addVariant("music", name, { seconds: 2, freq: 260 + i * 40, round: "Round 1" });
    await page.goto(rushes.testUrl());
    await videoReady(page);
    await openReviewTab(page, "Music");
    await loadedOn(page, 3);
    await expect(takesList(page).locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
    await takeCircle(page, "Pulse").focus();
    await page.keyboard.press("ArrowDown");
    await expect(takeCircle(page, "Drift")).toBeFocused();
    // The arrows move between circles: no frame step, and nothing picked.
    expect((await audio(page))!.time).toBe(0);
    await expect(takeCircle(page, "Drift")).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Enter");
    await expect(takeCircle(page, "Drift")).toHaveAttribute("aria-checked", "true");
    await takeName(page, "Glow").focus();
    await page.keyboard.press("Enter");
    await expect(takeRow(page, "Glow")).toHaveAttribute("aria-current", "true");
    await expect.poll(() => heardOn(page)).toEqual(["round-1/glow"]);
    await page.keyboard.press(" ");
    await expect.poll(async () => (await audio(page))!.playing).toBe(true);
  });

  test("with a take selected a note is a point at the playhead once it has moved, and the target's menu offers the whole take", async ({ page, rushes }) => {
    await rushes.addCut();
    await rushes.addVariant("music", "Pulse", { seconds: 2, freq: 220, round: "Round 1" });
    await page.goto(rushes.testUrl());
    await videoReady(page);
    await openReviewTab(page, "Music");
    await loadedOn(page, 1);
    await takeName(page, "Pulse").click();
    await expect(noteTargetLabel(page)).toHaveText(/Music · Pulse$/);
    await expect(noteTargetMenu(page)).toHaveValue("whole");
    for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
    await expect(noteTargetLabel(page)).toContainText("00:00:01:00 · Music · Pulse");
    await expect(noteTargetMenu(page)).toHaveValue("point");
    await noteTargetMenu(page).selectOption({ label: "The whole bed" });
    await expect(noteTargetLabel(page)).not.toContainText("00:00:01:00");
    const box = notesPanel(page).getByRole("textbox", { name: "New note" });
    await box.fill("Too busy overall.");
    await box.press("Enter");
    await expect.poll(async () => (await rushes.api("GET", "/api/notes?stage=music")).notes.length).toBe(1);
    expect((await rushes.api("GET", "/api/notes?stage=music")).notes[0]).toMatchObject({ on: "round-1/pulse", scope: "whole", t: null });
  });

  // Red, 17 Nov 2026: two passes named "Pass 3A felt" and "Pass 3B pillow" both read "Pass 3…" beside a "1 film" chip. The
  // rows on this film have no Films count now, the details and version sit at the right-hand end, and the name has the rest.
  test("a take's row has no Films count, its details and version at the right-hand end, and two names that differ only at the end both read in full", async ({ page, rushes }) => {
    await rushes.addCut("hero", "Hero");
    await rushes.addCut("cutdown", "Cutdown");
    const felt = "Whoosh and taps, soft, felt";
    const pillow = "Whoosh and taps, soft, pillow";
    await rushes.addVariant("sfx", felt, { seconds: 2, freq: 220, round: "Round 1", video: ["Hero", "Cutdown"], meta: { description: "Felt mallet on the taps" } });
    const used = await rushes.addVariant("sfx", pillow, { seconds: 2, freq: 330, round: "Round 1", video: ["Hero", "Cutdown"], meta: { description: "Pillow hits on the taps" } });
    await rushes.addVariant("sfx", "Cutdown only", { seconds: 2, freq: 440, round: "Round 1", video: "Cutdown" });
    await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [used.lane.id]: used.variant.id } });
    await page.goto(rushes.url);
    await videoReady(page);
    await openReviewTab(page, "Effects");
    await expect(takeRows(page).locator("[data-name]")).toHaveText([pillow, felt]);
    await expect(takeRows(page).getByRole("button", { name: /^Films for/ })).toHaveCount(0);
    await page.mouse.move(1430, 890);
    for (const name of [felt, pillow]) {
      const row = takeRow(page, name);
      // The whole name on screen, measured: not cut short by its column, nothing over it, and its box clear of the details.
      const text = row.locator(".knm [data-name]");
      expect(await text.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await expect(putAwayButton(page, name, name === pillow ? "Unpick" : "Archive")).toBeHidden();
      const head = (await row.locator(".khead").boundingBox())!;
      const nm = (await text.boundingBox())!;
      const info = (await row.getByRole("button", { name: `Details for ${name}` }).boundingBox())!;
      const tag = (await takeTag(page, name).boundingBox())!;
      expect(nm.x + nm.width).toBeLessThanOrEqual(info.x);
      expect(info.x + info.width).toBeLessThanOrEqual(tag.x);
      // The version is the last thing in the head, against its right-hand padding.
      expect(head.x + head.width - (tag.x + tag.width)).toBeLessThanOrEqual(12);
    }
    // A mouse on a row: Archive (Unpick on the take in use) shows just before the details, never over them or the version.
    for (const [name, kind] of [[felt, "Archive"], [pillow, "Unpick"]] as const) {
      await takeRow(page, name).hover();
      const btn = putAwayButton(page, name, kind);
      await expect(btn).toBeVisible();
      const b = (await btn.boundingBox())!;
      const info = (await takeRow(page, name).getByRole("button", { name: `Details for ${name}` }).boundingBox())!;
      expect(b.x + b.width).toBeLessThanOrEqual(info.x);
      expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest(".kput") !== null, [b.x + b.width / 2, b.y + b.height / 2])).toBe(true);
      // Its room came from the name, never from the details or version: they haven't moved, and the name it cut short
      // has its full name first in its tooltip.
      const tag = (await takeTag(page, name).boundingBox())!;
      const head = (await takeRow(page, name).locator(".khead").boundingBox())!;
      expect(head.x + head.width - (tag.x + tag.width)).toBeLessThanOrEqual(12);
      const text = takeRow(page, name).locator(".knm [data-name]");
      expect(await text.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(b.x);
      if (await text.evaluate((el) => el.scrollWidth > el.clientWidth)) await expect(takeName(page, name)).toHaveAttribute("data-tip", new RegExp(`^${name}\\n`));
    }
    // A take not on this film keeps its Films button, the only way to put it here, with no count on it.
    await foldToggle(page, "Not on this film").click();
    const films = takesList(page).getByRole("button", { name: /^Films for Cutdown only/ });
    await expect(films).toHaveText("Films");
    await expect(films).toHaveAttribute("data-tip", "On Cutdown");
    await films.click();
    await expect(page.getByRole("group", { name: "Films for Cutdown only" })).toBeVisible();
  });

  test("Archive on a take two films share takes it off this film only, never archiving it on the other", async ({ page, rushes }) => {
    await rushes.addCut("hero", "Hero");
    await rushes.addCut("cutdown", "Cutdown");
    const pulse = await rushes.addVariant("music", "Pulse", { seconds: 2, freq: 220, round: "Round 1", video: ["Hero", "Cutdown"] });
    await page.goto(rushes.url);
    await videoReady(page);
    await openReviewTab(page, "Music");
    await pressRowButton(page, "Pulse");
    await expect(page.locator(".toast", { hasText: "Taken off this film" })).toBeVisible();
    await expect.poll(async () => {
      const p = (await rushes.api("GET", "/api/state")).project;
      const v = p.lanes.find((l: { id: string }) => l.id === pulse.lane.id).variants.find((x: { id: string }) => x.id === pulse.variant.id);
      return { videos: v.videos, away: v.putAway ?? null };
    }).toEqual({ videos: ["cutdown"], away: null });
    await expect(takeRow(page, "Pulse")).toHaveCount(0);
  });

  test("on Effects, choosing The whole pass with a cue selected puts the note on the pass, not the cue", async ({ page, rushes }) => {
    await rushes.addCut();
    await rushes.addVariant("sfx", "Pass A", { seconds: 3, freq: 880, round: "Round 1", cues: [{ name: "Swipe", t: 1.5 }] });
    await page.goto(rushes.testUrl());
    await videoReady(page);
    await openReviewTab(page, "Effects");
    await loadedOn(page, 1);
    await takeRow(page, "Pass A").locator(".cue", { hasText: "Swipe" }).click();
    await expect(noteTargetLabel(page)).toHaveText(/^00:00:01:\d\d · Effects · Cue · Swipe$/);
    await noteTargetMenu(page).selectOption({ label: "The whole pass" });
    await expect(noteTargetLabel(page)).toHaveText("Effects · Pass A");
    const box = notesPanel(page).getByRole("textbox", { name: "New note" });
    await box.fill("Too busy overall.");
    await box.press("Enter");
    await expect.poll(async () => (await rushes.api("GET", "/api/notes?stage=sfx")).notes.length).toBe(1);
    expect((await rushes.api("GET", "/api/notes?stage=sfx")).notes[0]).toMatchObject({ on: "round-1/pass-a", scope: "whole", t: null });
  });

  test("a sound's tab plays only its own sound (round 1): never the other sounds in use, and no Only this sound button", async ({ page, rushes }) => {
    const { read, bed, pass } = await threeInUse(rushes);
    const glow = await rushes.addVariant("music", "Glow", { seconds: 4, freq: 440 });
    await rushes.api("PUT", "/api/picks", { video: "hero", levels: { voice: -6, music: -9, sfx: 3 } });
    // A browser that turned the old switch on: the stored setting means nothing now.
    await page.addInitScript(() => localStorage.setItem("rushes:solo-tab", "0"));
    await page.goto(rushes.testUrl());
    await videoReady(page);
    for (const [tab, own] of [["Music", `${bed.lane.id}/${bed.variant.id}`], ["Voice", `${read.lane.id}/${read.variant.id}`], ["Effects", `${pass.lane.id}/${pass.variant.id}`]] as const) {
      await openReviewTab(page, tab);
      // Only this sound's takes are loaded at all, and only the one in use is heard: the others in use never play under it.
      await loadedOn(page, tab === "Music" ? 2 : 1);
      await expect.poll(() => heardOn(page)).toEqual([own]);
      await expect(page.getByRole("button", { name: "Only this sound" })).toHaveCount(0);
      // The cut's own sound stays silent here, as before.
      expect(await videoMuted(page)).toBe(true);
    }
    // A sound's tab plays its take at full level under the transport's volume: the saved level is the Timeline's.
    await openReviewTab(page, "Music");
    await loadedOn(page, 2);
    const lanes = (await audio(page))!.lanes;
    expect(lanes.music).toBeCloseTo(1, 3);
    // Selecting another bed plays it in the bed's place, alone.
    await takeName(page, "Glow").click();
    await expect.poll(() => heardOn(page)).toEqual([`${glow.lane.id}/${glow.variant.id}`]);
    // The Timeline tab's mix is unchanged: all three, at their saved levels.
    await openReviewTab(page, "Timeline");
    await expect.poll(async () => (await heardOn(page)).length).toBe(3);
    const mix = (await audio(page))!.lanes;
    expect(mix.vo).toBeCloseTo(10 ** (-6 / 20), 3);
    expect(mix.sfx).toBeCloseTo(10 ** (3 / 20), 3);
  });

  test("beds added with no round on two days show under two day headings, the newest day first", async ({ page, rushes }) => {
    await rushes.addCut();
    await rushes.addVariant("music", "Monday bed", { seconds: 2, freq: 220 });
    await rushes.addVariant("music", "Tuesday bed", { seconds: 2, freq: 330 });
    // Date them a day apart, as if they had come in on different days.
    const file = join(rushes.root, ".rushes", "project.json");
    const project = JSON.parse(await readFile(file, "utf8"));
    const music = project.lanes.find((l: { id: string }) => l.id === "music");
    music.variants[0].addedAt = "2026-11-09T12:00:00.000Z";
    music.variants[1].addedAt = "2026-11-10T12:00:00.000Z";
    project.rev += 1;
    await writeFile(file, JSON.stringify(project, null, 2));
    await page.goto(rushes.url);
    await videoReady(page);
    await openReviewTab(page, "Music");
    const day = (iso: string) => page.evaluate((d) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" }), iso);
    await expect(takeHeadings(page)).toHaveText([`New · ${await day("2026-11-10T12:00:00.000Z")}`, `New · ${await day("2026-11-09T12:00:00.000Z")}`]);
    await expect(takeRows(page).locator(".knm")).toHaveText(["Tuesday bed", "Monday bed"]);
  });
});

// ---- final review I5 and m1: a sound's tab shows the cut chosen in the Cut menu, counted at that cut's frame rate ----
test("a sound's tab shows the cut chosen in the Cut menu, as the Timeline does", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.addCut();
  await rushes.addVariant("voice", "Gerald", { round: "Round 1 · Voices", seconds: 4, freq: 220 });
  await page.goto(rushes.testUrl());
  await videoReady(page);
  const src = () => page.locator("video").evaluate((v: HTMLVideoElement) => decodeURIComponent(v.currentSrc || v.src));
  await expect.poll(src).toContain("hero_v2");
  await pickVersion(page, "v1");
  await expect.poll(src).toContain("hero_v1");
  await page.keyboard.press("3");
  await expect(reviewTab(page, "Voice")).toHaveAttribute("aria-selected", "true");
  await expect.poll(src).toContain("hero_v1");
  await expect(cutButton(page)).toHaveAttribute("data-version", "v1");
  await expect(statusBar(page)).toContainText("v1");
  // Picked here, the next cut shows here and on the Timeline.
  await pickVersion(page, "v2");
  await expect.poll(src).toContain("hero_v2");
  await page.keyboard.press("2");
  await expect.poll(src).toContain("hero_v2");
});

test("a sound's tab counts frames at the cut's frame rate, as the Timeline does", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.addVariant("voice", "Gerald", { round: "Round 1 · Voices", seconds: 4, freq: 220 });
  // A 25 fps cut in a project that says 30 (as the demo did before the final review).
  const file = join(rushes.root, ".rushes", "project.json");
  const project = JSON.parse(await readFile(file, "utf8"));
  project.fps = 30;
  project.videos[0].versions[0].fps = 25;
  await writeFile(file, JSON.stringify(project, null, 2));
  await page.goto(rushes.testUrl());
  await videoReady(page);
  await expect(statusBar(page)).toContainText("25 fps");
  const step = transport(page).getByRole("button", { name: "Forward one frame · →" });
  await step.click();
  await expect.poll(() => page.getByLabel("Timecode").textContent()).toMatch(/^0:00\.04/);
  await page.keyboard.press("3");
  await expect(reviewTab(page, "Voice")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => page.getByLabel("Timecode").textContent()).toMatch(/^0:00\.04/);
  await step.click();
  await expect.poll(() => page.getByLabel("Timecode").textContent()).toMatch(/^0:00\.08/);
  await expect(page.locator(".tcover")).toContainText("f2");
});

// ---- small things from the final review ----
test("m2: picking another cut waits for a marked In, as switching films does", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(cutButton(page)).toHaveAttribute("data-version", "v2");
  await page.keyboard.press("i");
  await expect(rangeChip(page)).toBeVisible();
  await cutButton(page).click();
  await page.getByRole("listbox", { name: "Versions" }).locator('[role="option"][data-version="v1"]').click();
  await expect(page.getByRole("status")).toHaveText("Add or clear your note first");
  await expect(cutButton(page)).toHaveAttribute("data-version", "v2");
  await expect(rangeChip(page)).toBeVisible();
  // Cleared, the cut can be picked.
  await rangeChip(page).getByRole("button", { name: "Clear range" }).click();
  await pickVersion(page, "v1");
});

test("m4: after a note on the whole mix, the next note is on this frame again", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  await noteTargetMenu(page).selectOption({ label: "The whole mix" });
  const box = notesPanel(page).getByRole("textbox", { name: "New note" });
  await box.fill("Too loud overall.");
  await box.press("Enter");
  await expect.poll(async () => (await rushes.api("GET", "/api/notes?stage=mix")).notes.length).toBe(1);
  await expect(noteTargetMenu(page)).toHaveValue("frame");
  await box.fill("Hold this frame.");
  await box.press("Enter");
  await expect.poll(async () => (await rushes.api("GET", "/api/notes?stage=picture")).notes.length).toBe(1);
});

// ---- final review I6: the target line names its target, on a line of its own ----
test.describe("the note's target line", () => {
  test("at the panel's default width it names a take with its sound, and a shot, in full on their own line", async ({ page, rushes }) => {
    await rushes.addCut();
    await rushes.api("PUT", "/api/videos/hero/shots", { shots: [{ name: "Opening wide", start: 0 }, { name: "The laptop lid", start: 2 }] });
    await rushes.addVariant("music", "B · Warm keys", { seconds: 4, freq: 330 });
    await page.goto(rushes.testUrl());
    await videoReady(page);
    expect(Math.round((await notesPanel(page).boundingBox())!.width)).toBe(360);
    // This frame: the menu and the timecode on the first line, the shot on the second.
    await expect(noteTargetWhen(page)).toHaveText("00:00:00:00");
    await expect(noteTargetName(page)).toHaveText("01 Opening wide");
    await expectReadableInRow(noteTargetName(page), noteTargetLine(page));
    expect((await noteTargetName(page).boundingBox())!.y).toBeGreaterThan((await noteTargetMenu(page).boundingBox())!.y + 10);
    // A take on its tab, at a moment: "This moment" and the time, then the take with its sound.
    await openReviewTab(page, "Music");
    await takeName(page, "B · Warm keys").click();
    await transport(page).getByRole("button", { name: "Forward one frame · →" }).click();
    await expect(noteTargetMenu(page)).toHaveValue("point");
    await expect(noteTargetWhen(page)).toHaveText("00:00:00:01");
    await expect(noteTargetName(page)).toHaveText("Music · B · Warm keys");
    await expectReadableInRow(noteTargetName(page), noteTargetLine(page));
  });

  test("a long name wraps to a second line, then ends in an ellipsis with the whole name in its tooltip", async ({ page, rushes }) => {
    // A read is named with its round: two long names make one name of three lines and more.
    const round = "Round 4 · The director's second pass, slower and warmer";
    const read = "Gerald, retimed to the new cut with every breath kept";
    await rushes.addCut();
    await rushes.addVariant("voice", read, { seconds: 4, freq: 220, round });
    await page.goto(rushes.testUrl());
    await videoReady(page);
    await openReviewTab(page, "Voice");
    await takeName(page, read).click();
    const name = noteTargetName(page);
    await expect(name).toHaveAttribute("data-tip", `Voice · ${round} · ${read}`);
    const lines = await name.locator(".ntclamp").evaluate((el) => {
      const lh = parseFloat(getComputedStyle(el).lineHeight);
      return { lines: Math.round(el.clientHeight / lh), cut: el.scrollHeight > el.clientHeight };
    });
    expect(lines).toEqual({ lines: 2, cut: true });
    // Inside the panel, whatever it holds.
    const [n, p] = [(await name.boundingBox())!, (await notesPanel(page).boundingBox())!];
    expect(n.x + n.width).toBeLessThanOrEqual(p.x + p.width);
  });
});
