import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect, test, videoReady, cutButton, currentFilm, filmButton, openWorkspace, pickFilm, reviewTab, workspaceTab, type FormatSize, type Rushes,
  monitor, pictureTrack, ruler, rulerMarkers, shotBlocks, TOOL_TIPS, toolButton, toolStrip, transport,
  hasFfmpeg, loudness, mixNoteButton, soundBlock, soundButton, soundLevel, soundTakes, soundTrack,
} from "./fixture.js";

// §27, 5.1 to 5.3 and 5.9: the desk's frame. A top bar and a status bar that never move, the Film and Cut menus,
// the workspaces with Review's tabs, and the one line that says what to do next.

const topBar = (page: Page) => page.locator("header.top");
const deskBar = (page: Page) => page.locator(".deskbar");
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

// ---- §27, 5.4 to 5.6: the Timeline tab. The monitor with its tool strip, the transport, the ruler and the Picture track ----

test("the tool strip has five tools, Select first and active, and B makes Box the active one", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  const tools = toolStrip(page).getByRole("button");
  await expect(tools).toHaveCount(5);
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
  await expect(shotBlocks(page)).toHaveText(["01 Open", "02 Turn", "03 Logo"]);
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
  await expect.poll(() => rulerMarkers(page).nth(0).evaluate((el) => getComputedStyle(el, "::after").opacity)).toBe("1");
  const tip = await rulerMarkers(page).nth(0).evaluate((el) => {
    const s = getComputedStyle(el, "::after");
    const m = el.getBoundingClientRect();
    return { top: m.top + parseFloat(s.top), bottom: m.top + parseFloat(s.top) + parseFloat(s.height), marker: m.bottom, panel: el.closest(".tlpanel")!.getBoundingClientRect().bottom };
  });
  expect(tip.top).toBeGreaterThan(tip.marker); // below the marker, never over it
  expect(tip.bottom).toBeLessThanOrEqual(tip.panel); // not cut off by the panel
  await rulerMarkers(page).nth(1).click();
  await expect(page.getByLabel("Timecode")).toContainText("0:02.00");
  await expect(page.locator(".list > .note", { hasText: "Tighter here." })).toHaveAttribute("aria-current", "true");
  // Clicking the ruler itself seeks there.
  const r = (await ruler(page).boundingBox())!;
  await page.mouse.click(r.x + r.width * 0.25, r.y + 4);
  await expect(page.getByLabel("Timecode")).toContainText(/0:00\.9|0:01\.0/);
});

test("F puts the monitor full screen", async ({ page, rushes, browserName }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(transport(page).getByRole("button", { name: "Full screen · F" })).toBeVisible();
  await page.keyboard.press("f");
  const full = () => page.evaluate(() => document.fullscreenElement?.classList.contains("monitor") ?? false);
  // WebKit's headless runner may refuse full screen outright; Chromium grants it to a key press.
  if (browserName === "webkit" && !(await full())) test.skip(true, "this WebKit cannot go full screen");
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
  await expect(soundBlock(page, "Voice")).toHaveText("Gerald");
  await expect(soundBlock(page, "Music")).toHaveText("Warm keys");
  await expect(soundBlock(page, "Effects")).toHaveText("Pass A");
  for (const name of ["Voice", "Music", "Effects"] as const) {
    await expect(soundTrack(page, name).locator(".thead")).toContainText(name);
    await expect(soundTakes(page, name)).toHaveText("1");
    await expect(soundTrack(page, name).locator("canvas.wave")).toHaveCount(1);
  }
  // Under the Picture track, in this order.
  const rows = await page.locator(".tlpanel .trow").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  expect(rows).toEqual([null, "Picture track", "Voice track", "Music track", "Effects track"]);
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
  // The take count opens that sound's tab.
  await soundTakes(page, "Music").click();
  await expect(reviewTab(page, "Music")).toHaveAttribute("aria-selected", "true");
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
  await expect(soundBlock(page, "Effects")).toHaveClass(/empty/);
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [bed.lane.id]: null } });
  // The bed is still there, waiting to be chosen again.
  await expect(soundBlock(page, "Music")).toHaveText("Nothing chosen yet");
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
  for (const name of ["Voice", "Music", "Effects"] as const) await expect(soundBlock(page, name)).toHaveText("Not started");
  await expect(soundTrack(page, "Cut sound")).toHaveCount(0);
  expect(await videoMuted(page)).toBe(false);
});

test.describe("the cut's own sound", () => {
  test.skip(!hasFfmpeg, "needs ffmpeg and ffprobe");

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

test("notes on the mix are listed on the Timeline tab, and Note on the mix saves one on the whole mix", async ({ page, rushes }) => {
  await threeInUse(rushes);
  await rushes.api("POST", "/api/notes", { stage: "mix", video: "hero", on: null, scope: "point", t: 1, text: "Music a touch loud." });
  await openTimeline(page, rushes, 3);
  await expect(page.locator(".note .nx")).toHaveText(["Music a touch loud."]);
  await expect(page.locator(".note .on")).toHaveText(["Whole mix"]);
  await page.getByRole("textbox", { name: "New note" }).fill("Voice sits under the bed.");
  await mixNoteButton(page).click();
  await expect(page.locator(".note")).toHaveCount(2);
  const { notes } = await rushes.api("GET", "/api/notes?stage=mix");
  expect(notes.find((n: { text: string }) => n.text === "Voice sits under the bed.")).toMatchObject({ stage: "mix", on: null, video: "hero" });
  // The mix tab is gone: Review has the timeline and a tab per sound.
  await expect(page.getByRole("tablist", { name: "Review" }).getByRole("tab")).toHaveText([/^Timeline/, /^Voice/, /^Music/, /^Effects/]);
});
