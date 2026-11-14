import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test, cutButton, videoReady, reviewTab, openWorkspace, workspaceTab, currentFilm, pickFilm, activity, notesPanel, openActivity, panelTab, panelToggle, sendButton, takesList, openPlanPage } from "./fixture.js";

// §27, 5.7: the Change Log is the notes panel's Activity tab. Choosing the tab opens it; choosing Notes puts it away.
const logButton = (page: Page) => panelTab(page, "Activity");
const rows = (page: Page) => activity(page).locator(".lrow");

test("Activity lists a pick and a new cut, newest first, and a dot on its tab says an entry is not yet seen (§27, 5.7)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  const bed = await rushes.addVariant("music", "Warm keys", { seconds: 2, freq: 330 });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(panelTab(page, "Activity")).toHaveAccessibleName("Activity (new entries)");
  await expect(panelTab(page, "Activity").locator(".cdot")).toHaveCount(1);
  await openActivity(page);
  await expect(panelTab(page, "Activity").locator(".cdot")).toHaveCount(0);
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [bed.lane.id]: bed.variant.id } });
  await rushes.addCut("second cut");
  await expect(rows(page)).toHaveText([/2 cuts added, the latest v2: second cut/, /Picks for “Hero”: music “Warm keys”/, /Music: “Warm keys” added/]);
  // Back on Notes, a new entry puts the dot back on the Activity tab.
  await panelTab(page, "Notes").click();
  await rushes.api("POST", "/api/log", { text: "Moved the logo up" });
  await expect(panelTab(page, "Activity").locator(".cdot")).toHaveCount(1);
  await expect(panelTab(page, "Activity")).toHaveAccessibleName("Activity (new entries)");
});

/**
 * Replaces a project file whole, the way Rushes writes them (a temp file, then a rename). A plain
 * writeFile truncates first, and a server that reads in between finds a corrupt log, sets it aside
 * as log.json.bad (§22.9) and starts a fresh one: the test's hand-made history is gone, and the
 * drawer says "Nothing yet". That is a race the test loses now and then on a busy runner.
 */
async function replaceFile(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

/** A log.json written by hand: `n` lines a minute apart, all backfilled. The file keeps them oldest first, as appends do. */
function bigLog(n: number, dropped = 0) {
  const t0 = Date.now() - 60_000;
  const entries = Array.from({ length: n }, (_, i) => ({
    id: `l_${String(n - i).padStart(5, "0")}`, at: new Date(t0 - i * 60_000).toISOString(), area: "project", kind: "entry",
    text: `Decision ${n - i}: kept the wide shot`, video: null, version: null, ref: null, by: "agent", tab: null, n: 1, subject: "",
  })).reverse();
  return JSON.stringify({ schema: 1, rev: n, backfilled: true, undated: [], dropped, entries });
}

test("Activity, the Change Log in the notes panel, lists newest first by day; Esc from inside it gives focus to its tab (§22.8, §27 5.7)", async ({ page, rushes }) => {
  await rushes.addCut("v1: first pass; rough timing");
  await rushes.addVariant("music", "Night drive", { seconds: 2, freq: 220, lane: "night-drive" });
  await page.goto(rushes.url);
  await videoReady(page);
  const button = logButton(page);
  await expect(button).toHaveAttribute("aria-selected", "false");
  await button.click();
  await expect(button).toHaveAttribute("aria-selected", "true");
  const d = activity(page);
  await expect(d.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(rows(page)).toHaveText([/Music: “Night drive” added to night-drive/, /v1 added: first pass/]);
  await expect(rows(page).nth(0)).toContainText("agent");
  await expect(rows(page).nth(0).locator(".ltag")).toHaveText("Music");
  await expect(rows(page).nth(0)).toHaveAccessibleName(/^Music: “Night drive” added to night-drive \(Music, \d\d:\d\d, by the agent\)$/);
  // In the panel, the right-hand column: its tabs above it, the panel against the window's right.
  const panel = (await notesPanel(page).boundingBox())!;
  const box = (await d.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(panel.x);
  expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
  expect(panel.x + panel.width).toBeGreaterThan(1400);
  await expect(button).toBeInViewport();
  await expect(d.getByLabel("Add a line to the log")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(button).toBeFocused();
  await expect(d).toBeVisible();
  // Choosing Notes puts it away.
  await panelTab(page, "Notes").click();
  await expect(d).toHaveCount(0);
  await expect(panelTab(page, "Notes")).toHaveAttribute("aria-selected", "true");
});

test("from the keyboard: its tab opens it, the arrows move between the tabs, and typing in the input fires no shortcut (§22.8)", async ({ page, rushes, browserName }) => {
  await rushes.addCut("first cut");
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).focus();
  await page.keyboard.press("Enter");
  const input = activity(page).getByLabel("Add a line to the log");
  await expect(input).toBeFocused();
  const t0 = await page.getByLabel("Timecode").textContent();
  await input.pressSequentially("2 4 [ ] i o n ?");
  await expect(input).toHaveValue("2 4 [ ] i o n ?");
  await expect(reviewTab(page, "Timeline")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
  await expect(page.getByLabel("Timecode")).toHaveText(t0!);
  // Esc from the input gives focus back to the tab (R13); the arrows choose Notes and Activity again, focus staying on the tabs.
  await page.keyboard.press("Escape");
  await expect(logButton(page)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(activity(page)).toHaveCount(0);
  await expect(panelTab(page, "Notes")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(activity(page)).toBeVisible();
  await expect(logButton(page)).toBeFocused();
  await input.click();
  // Tab moves from the input to Add, then into the chips (one stop for the group). WebKit's Tab
  // skips buttons unless Safari's "Press Tab to highlight each item" is on, so this part is Chromium's.
  if (browserName === "webkit") return;
  await page.keyboard.press("Tab");
  await expect(activity(page).getByRole("button", { name: "Add", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(activity(page).getByRole("radio", { name: "All" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(activity(page).getByRole("group", { name: "Entries" })).toBeFocused();
});

test("a line added in Activity is by you, about the tab on screen; the filters are a radio group kept for the session (§22.8)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await rushes.addVariant("music", "Night drive", { seconds: 2, freq: 220 });
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  const input = activity(page).getByLabel("Add a line to the log");
  await input.fill("Decided to slow the zooms; the first cut felt rushed");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(rows(page).first()).toContainText("Decided to slow the zooms");
  await expect(rows(page).first()).toContainText("added by you");
  await expect(rows(page).first().locator(".ltag")).toHaveText("Picture");
  expect(await rows(page).first().evaluate((el) => el.tagName)).toBe("DIV"); // nowhere to go (R14)
  const { entries } = await rushes.api("GET", "/api/log");
  expect(entries[0]).toMatchObject({ by: "user", area: "picture", kind: "entry" });

  const chips = activity(page).getByRole("radiogroup", { name: "Show" });
  await expect(chips.getByRole("radio")).toHaveText(["All", "Picture", "Voice", "Music", "Sound effects", "Mix", "Visuals", "Notes", "Files"]);
  await chips.getByRole("radio", { name: "All" }).focus();
  const t0 = await page.getByLabel("Timecode").textContent();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await expect(chips.getByRole("radio", { name: "Music" })).toHaveAttribute("aria-checked", "true");
  await expect(chips.getByRole("radio", { name: "Music" })).toBeFocused();
  await expect(chips.getByRole("radio", { checked: true })).toHaveCount(1);
  await expect(page.getByLabel("Timecode")).toHaveText(t0!); // the arrows moved the chips, not the playhead
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Music:");
  await page.reload();
  await videoReady(page);
  await expect(activity(page)).toBeVisible();
  await expect(chips.getByRole("radio", { name: "Music" })).toHaveAttribute("aria-checked", "true");
  await chips.getByRole("radio", { name: "Sound effects" }).click();
  await expect(activity(page).getByText("Nothing for this filter.")).toBeVisible();
});

test("ten variants registered at once make one line (§22.5, §22.11)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await Promise.all(Array.from({ length: 10 }, (_, i) => rushes.addVariant("music", `Bed ${i + 1}`, { seconds: 1, freq: 200 + i * 20 })));
  await page.goto(rushes.url);
  await logButton(page).click();
  await expect(rows(page)).toHaveText([/Music: 10 variants added/, /v1 added: first cut/]);
});

test("while you read further down, new lines wait behind an 'N new' pill and the list doesn't jump (§22.8, §22.11)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  for (let i = 1; i <= 40; i++) await rushes.api("POST", "/api/log", { text: `Decision ${i}: kept the wide shot` });
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  await expect(rows(page)).toHaveCount(41);
  const list = activity(page).locator(".dlist");
  await list.evaluate((el) => { el.scrollTop = 600; });
  const before = await list.evaluate((el) => el.scrollTop);
  const firstVisible = () =>
    list.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      return [...el.querySelectorAll(".lrow")].find((r) => r.getBoundingClientRect().bottom > top + 40)?.textContent ?? "";
    });
  const reading = await firstVisible();
  await rushes.api("POST", "/api/log", { text: "Swapped the end card for line B" });
  const pill = activity(page).getByRole("button", { name: "1 new" });
  await expect(pill).toBeVisible();
  expect(await list.evaluate((el) => el.scrollTop)).toBe(before);
  expect(await firstVisible()).toBe(reading);
  await expect(rows(page)).toHaveCount(41); // the new line waits
  await rushes.api("POST", "/api/log", { text: "And moved the logo up" });
  await expect(activity(page).getByRole("button", { name: "2 new" })).toBeVisible();
  expect(await firstVisible()).toBe(reading);
  await activity(page).getByRole("button", { name: "2 new" }).click();
  await expect(rows(page).first()).toContainText("And moved the logo up");
  await expect(rows(page).nth(1)).toContainText("Swapped the end card for line B");
  await expect(activity(page).locator(".dpill")).toHaveCount(0);
  await expect(activity(page).getByRole("group", { name: "Entries" })).toBeFocused(); // the newest line goes nowhere, so the list
  expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
});

test("at the top of the list, new lines simply appear (§22.8)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  await expect(rows(page)).toHaveCount(1);
  await rushes.api("POST", "/api/log", { text: "Swapped the end card for line B" });
  await expect(rows(page).first()).toContainText("Swapped the end card for line B");
  await expect(activity(page).locator(".dpill")).toHaveCount(0);
});

test("a focused row keeps focus as lines arrive at the top (§22.11)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await rushes.api("POST", "/api/log", { text: "Look at the end card", video: "hero", version: "v1" });
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  const linked = activity(page).getByRole("button", { name: /Look at the end card/ });
  await linked.focus();
  for (let i = 1; i <= 5; i++) await rushes.api("POST", "/api/log", { text: `Note to self ${i}` });
  await expect(rows(page)).toHaveCount(7);
  await expect(linked).toBeFocused();
});

test("the dot says lines arrived since Activity was last on screen; opening it clears the dot (R19)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(logButton(page)).toHaveAccessibleName("Activity (new entries)");
  await logButton(page).click();
  await panelTab(page, "Notes").click(); // put away again: seen
  await expect(logButton(page)).toHaveAccessibleName("Activity");
  await rushes.api("POST", "/api/log", { text: "Moved the logo up" });
  await expect(logButton(page).locator(".cdot")).toHaveCount(1);
  await page.reload();
  await expect(logButton(page).locator(".cdot")).toHaveCount(1); // kept in the browser
  await logButton(page).click();
  await expect(logButton(page).locator(".cdot")).toHaveCount(0);
  // A line that arrives while it's open is seen.
  await rushes.api("POST", "/api/log", { text: "Moved the logo down again" });
  await expect(rows(page).first()).toContainText("Moved the logo down again");
  await panelTab(page, "Notes").click();
  await page.reload();
  await expect(logButton(page)).toHaveAccessibleName("Activity");
});

test("a row with somewhere to go opens it: a line on v1 opens Picture at v1, a variant opens its tab and row (R18)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await rushes.addCut("second cut");
  await rushes.addVariant("music", "Night drive", { seconds: 2, freq: 220, lane: "night-drive" });
  await rushes.api("POST", "/api/log", { text: "The end card on v1 read better", video: "hero", version: "v1" });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(cutButton(page)).toHaveAttribute("data-version", "v2");
  await logButton(page).click();
  await expect(rows(page)).toHaveText([/The end card on v1/, /Music: “Night drive”/, /2 cuts added, the latest v2: second cut/]);
  await expect(rows(page).locator(".lgo")).toHaveText(["›", "›", "›"]);
  await activity(page).getByRole("button", { name: /The end card on v1 read better/ }).click();
  await expect(cutButton(page)).toHaveAttribute("data-version", "v1");
  await expect(activity(page)).toBeVisible();
  await activity(page).getByRole("button", { name: /Music: “Night drive” added/ }).click();
  await expect(reviewTab(page, "Music")).toHaveAttribute("aria-selected", "true");
  await expect(takesList(page).locator('.take[data-take="night-drive/night-drive"] .knm')).toBeFocused();
  // And back to the cut, from the Music tab.
  await activity(page).getByRole("button", { name: /2 cuts added/ }).click();
  await expect(reviewTab(page, "Timeline")).toHaveAttribute("aria-selected", "true");
});

test("an empty log says so; audio from before the log is listed undated; Export as Markdown writes the file (§22.6–§22.8)", async ({ page, rushes }) => {
  await page.goto(rushes.url);
  await logButton(page).click();
  await expect(activity(page).getByText("Nothing yet. Rushes writes a line here whenever a cut, a take or a variant is added.")).toBeVisible();
  await expect(activity(page).locator(".dfoot")).toContainText("0 entries");
  await rushes.addVariant("music", "Night drive", { seconds: 2, freq: 220, lane: "night-drive" });
  // History made by hand: the variant was already there when the log began.
  await replaceFile(join(rushes.root, ".rushes", "log.json"), JSON.stringify({ schema: 1, rev: 99, backfilled: true, undated: ["night-drive/night-drive"], dropped: 0, entries: [] }));
  const before = activity(page).getByRole("region", { name: "Before the log" });
  await expect(before).toContainText("Music: night-drive (1 variant)");
  await expect(activity(page).getByText(/^Nothing yet/)).toHaveCount(0);
  await activity(page).getByRole("button", { name: "Export as Markdown" }).click();
  const status = page.getByRole("status");
  await expect(status).toContainText(/Saved to exports\/change-log-\d{4}-\d{2}-\d{2}\.md/);
  const name = (await status.textContent())!.match(/exports\/(change-log-[\d-]+\.md)/)![1];
  const md = await readFile(join(rushes.root, "exports", name), "utf8");
  expect(md).toContain("# My Film — change log");
  expect(md).toContain("## Before the log\n- Music: night-drive (1 variant)");
});

test("a log that can't be read says so in plain words, never the raw error (§22.8)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  // A folder where log.json should be: the server answers 500 with an errno in its message.
  await rm(join(rushes.root, ".rushes", "log.json"), { force: true });
  await mkdir(join(rushes.root, ".rushes", "log.json"));
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  const alert = activity(page).getByRole("alert");
  await expect(alert).toHaveText("The Change Log couldn't be read. Run rushes doctor to see why.");
  await expect(activity(page)).not.toContainText(/EISDIR|illegal|internal/i);
  // A line that can't be written, and an export that can't be made, say so too.
  await activity(page).getByLabel("Add a line to the log").fill("Kept the wide shot");
  await activity(page).getByLabel("Add a line to the log").press("Enter");
  await expect(page.getByRole("status")).toHaveText(/^That line wasn't added: the Change Log couldn't be written\. Run rushes doctor to see why\.$/);
  await activity(page).getByRole("button", { name: "Export as Markdown" }).click();
  await expect(page.getByRole("status")).toHaveText(/^The Markdown wasn't saved: the Change Log couldn't be read or written\. Run rushes doctor to see why\.$/);
});

test("a long line wraps inside Activity; nothing scrolls sideways (§22.8)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await rushes.api("POST", "/api/log", { text: `${"Supercalifragilistic".repeat(5)} and then the zooms were slowed down by half across every shot of the hero film` });
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  await expect(rows(page)).toHaveCount(2);
  const sideways = await activity(page).evaluate((el) => [el, ...el.querySelectorAll("*")].filter((x) => x.scrollWidth > x.clientWidth + 1 && getComputedStyle(x).overflowX !== "visible" && !x.classList.contains("ltag")).length);
  expect(sideways).toBe(0);
  const box = (await rows(page).first().locator(".ltext").boundingBox())!;
  expect(box.height).toBeGreaterThan(60); // wrapped onto several lines
  expect(box.x + box.width).toBeLessThanOrEqual(1440);
});

test("5,000 lines: Activity shows the newest 1000 and says so, and stays quick (R16, §22.9)", async ({ page, rushes }) => {
  await mkdir(join(rushes.root, ".rushes"), { recursive: true });
  await replaceFile(join(rushes.root, ".rushes", "log.json"), bigLog(5000, 12));
  await page.goto(rushes.url);
  const t0 = Date.now();
  await logButton(page).click();
  await expect(rows(page)).toHaveCount(1000);
  const opened = Date.now() - t0;
  await expect(activity(page).locator(".dfoot")).toContainText("Showing the newest 1000 of 5000 · Earlier entries were removed");
  await expect(rows(page).first()).toContainText("Decision 5000");
  // A live line on a full log: drops the oldest, shows at the top.
  const t1 = Date.now();
  await rushes.api("POST", "/api/log", { text: "Swapped the end card for line B" });
  await expect(rows(page).first()).toContainText("Swapped the end card for line B");
  const live = Date.now() - t1;
  console.log(`5000-line log: drawer open ${opened} ms, live line ${live} ms`);
  expect(opened).toBeLessThan(5000);
  expect(live).toBeLessThan(5000);
});

test("under 560 px the panel's drawer is full width, with no slide, and a jump closes it (§22.8, R18, §27 5.7)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 500, height: 800 });
  await page.goto(rushes.url);
  await panelToggle(page).click();
  await logButton(page).click();
  expect(await notesPanel(page).evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  expect(Math.round((await notesPanel(page).boundingBox())!.width)).toBe(500);
  await expect(logButton(page)).toBeInViewport();
  // Nothing in the drawer is wider than it (the page behind has its own, older overflow at this width).
  expect(await activity(page).evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= 500)).toBe(true);
  await activity(page).getByRole("button", { name: /v1 added/ }).click();
  await expect(notesPanel(page)).toBeHidden();
});

test("Activity isn't modal, and stays open across Plan and Review: tabs and keys still work with it open (§22.8)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  await openPlanPage(page, "Script");
  await expect(workspaceTab(page, "Plan")).toHaveAttribute("aria-selected", "true");
  await expect(activity(page)).toBeVisible();
  await page.keyboard.press("2");
  await expect(reviewTab(page, "Timeline")).toHaveAttribute("aria-selected", "true");
});

// ---- fix round 1 ----

test("a focused row from an older day keeps focus when today's first line arrives (I1, §22.11)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  // Yesterday's history, by hand: a line that goes somewhere (the cut), so its row is a button.
  const at = new Date(Date.now() - 86_400_000).toISOString();
  await replaceFile(join(rushes.root, ".rushes", "log.json"), JSON.stringify({
    schema: 1, rev: 5, backfilled: true, undated: [], dropped: 0,
    entries: [{ id: "l_old", at, area: "picture", kind: "entry", text: "Look at the end card", video: "hero", version: "v1", ref: null, by: "agent", tab: null, n: 1, subject: "" }],
  }));
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  await expect(activity(page).getByRole("heading", { name: "Yesterday" })).toBeVisible();
  await expect(activity(page).getByRole("heading", { name: "Today" })).toHaveCount(0);
  const linked = activity(page).getByRole("button", { name: /Look at the end card/ });
  await linked.focus();
  await rushes.api("POST", "/api/log", { text: "Moved the logo up" });
  await expect(activity(page).getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(linked).toBeFocused();
});

test("with a filter on, live lines from other areas stay out (I3)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  await activity(page).getByRole("radio", { name: "Music" }).click();
  await expect(activity(page).getByText("Nothing for this filter.")).toBeVisible();
  await rushes.api("POST", "/api/log", { text: "Moved the logo up", area: "picture" });
  await rushes.addVariant("music", "Night drive", { seconds: 1, freq: 220, lane: "night-drive" });
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Night drive");
  await expect(activity(page)).not.toContainText("Moved the logo up");
});

test("a slow answer for an older filter never replaces the newer one (I3)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await rushes.addVariant("music", "Night drive", { seconds: 1, freq: 220, lane: "night-drive" });
  // The unfiltered list answers late; the Music one at once.
  await page.route(/\/api\/log\?/, async (route) => {
    if (!new URL(route.request().url()).searchParams.has("area")) await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  await activity(page).getByRole("radio", { name: "Music" }).click();
  await expect(rows(page)).toHaveCount(1);
  await page.waitForTimeout(1200); // the late answer for All has arrived by now
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Night drive");
});

test("Esc in the note box keeps its own meaning and leaves Activity open (R13, I3)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  await expect(activity(page).getByLabel("Add a line to the log")).toBeFocused(); // mounted, its Esc listener with it
  // The note box waits, hidden, behind the Notes tab: a second view with a note box has one on show (the Voice tab's).
  await page.keyboard.press("3");
  await panelTab(page, "Notes").click();
  const note = notesPanel(page).getByRole("textbox", { name: "New note" });
  await note.focus();
  await note.press("Escape");
  await expect(note).not.toBeFocused(); // the note box's own Esc: it lets go of the keyboard
  // Two frames: a close would have rendered by now, so the check below can't pass early.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(panelTab(page, "Notes")).toHaveAttribute("aria-selected", "true");
  await expect(notesPanel(page)).toBeVisible();
});

test("Activity reopening with the page doesn't take focus (I3)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  await expect(activity(page).getByLabel("Add a line to the log")).toBeFocused();
  await page.reload();
  await videoReady(page);
  await expect(activity(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(activity(page).getByLabel("Add a line to the log")).not.toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test("a row about another film switches to that film (R18, I3)", async ({ page, rushes }) => {
  await rushes.addCut("hero cut");
  await rushes.addCut("cutdown first", "Cutdown");
  await rushes.addCut("cutdown second", "Cutdown");
  await rushes.api("POST", "/api/log", { text: "The cutdown's first ending was better", video: "cutdown", version: "v1" });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(currentFilm(page)).toHaveText("Hero");
  await logButton(page).click();
  await activity(page).getByRole("button", { name: /The cutdown's first ending was better/ }).click();
  await expect(currentFilm(page)).toHaveText("Cutdown");
  await expect(cutButton(page)).toHaveAttribute("data-version", "v1");
});

test("a line added under a filter that leaves it out says where it went (M1)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  await activity(page).getByRole("radio", { name: "Music" }).click();
  const input = activity(page).getByLabel("Add a line to the log");
  await input.fill("Kept the wide shot");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(page.getByRole("status")).toHaveText("Added under Picture. Choose All or Picture to see it.");
  await activity(page).getByRole("radio", { name: "Picture" }).click();
  await expect(rows(page).first()).toContainText("Kept the wide shot");
});

test("under 560 px a jump that closes the drawer gives focus back to its button in the top bar (M2)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.setViewportSize({ width: 500, height: 800 });
  await page.goto(rushes.url);
  await panelToggle(page).click();
  await logButton(page).click();
  await activity(page).getByRole("button", { name: /v1 added/ }).click();
  await expect(notesPanel(page)).toBeHidden();
  await expect(panelToggle(page)).toBeFocused();
});

test("opening Activity in one browser tab clears the dot in another (M3)", async ({ page, rushes, context }) => {
  await rushes.addCut("first cut");
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(logButton(page).locator(".cdot")).toHaveCount(1);
  const other = await context.newPage();
  await other.goto(rushes.url);
  await logButton(other).click();
  await expect(activity(other)).toBeVisible();
  await expect(logButton(page).locator(".cdot")).toHaveCount(0);
  await other.close();
});

test("a line Activity has shown is seen, even when the page hears of it after Activity is put away (R19)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  await panelTab(page, "Notes").click();
  await expect(logButton(page).locator(".cdot")).toHaveCount(0);
  // The page's state answers late; the drawer's own fetch of the log doesn't.
  await page.route(/\/api\/state/, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await rushes.api("POST", "/api/log", { text: "Moved the logo up" });
  await logButton(page).click();
  await expect(rows(page).first()).toContainText("Moved the logo up");
  await panelTab(page, "Notes").click();
  await page.waitForTimeout(2500); // the late state, with the new head, has arrived
  await expect(logButton(page).locator(".cdot")).toHaveCount(0);
});

test("the drawer stays under the top bar while the work area scrolls, and the page itself never does (I2)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.setViewportSize({ width: 1000, height: 420 });
  await page.goto(rushes.url);
  await videoReady(page);
  await panelToggle(page).click();
  await logButton(page).click();
  const under = () => page.evaluate(() => {
    const head = document.querySelector("header.top")!.getBoundingClientRect().bottom;
    return [Math.round(document.querySelector(".npanel")!.getBoundingClientRect().top), Math.max(0, Math.round(head))];
  });
  const [top0, head0] = await under();
  expect(top0).toBe(head0);
  // The window is short: the work area has more than it shows, and scrolls inside the frame.
  expect(await page.locator("main.body").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.mouse.move(300, 300);
  await page.mouse.wheel(0, 40);
  await expect.poll(() => page.locator("main.body").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const [top1, head1] = await under();
  expect([top1, head1]).toEqual([top0, head0]);
});

test("a line that arrives while Activity is open counts as seen, even when its filter hides it (R19)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.goto(rushes.url);
  await videoReady(page);
  await logButton(page).click();
  await activity(page).getByRole("radio", { name: "Music" }).click();
  await expect(activity(page).getByText("Nothing for this filter.")).toBeVisible();
  await rushes.api("POST", "/api/log", { text: "Moved the logo up", area: "picture" });
  // The filtered list shows nothing new, so there's nothing on the page to wait for: give the change
  // event and the state's refetch time to land (both are local and take a few milliseconds).
  await page.waitForTimeout(800);
  await panelTab(page, "Notes").click();
  await page.reload();
  await expect(logButton(page)).toHaveAccessibleName("Activity");
});

// ---- the header with a long project (Task 7's realistic check) ----

/** Two films with long names, a long project name, a locked cut with a long label, 59 found files and eight open notes. */
async function longProject(rushes: any) {
  await rushes.addCut("Opening titles: the logo lands on the first beat", "Lumen teaser");
  await rushes.addCut("First pass; rough timing", "Lumen launch film");
  await rushes.addCut("Tighter middle 35; trimmed the opening two seconds and moved the logo to land on the first beat", "Lumen launch film");
  await rushes.api("PUT", "/api/videos/lumen-launch-film/lock", { version: "v2" });
  for (let i = 1; i <= 8; i++) await rushes.api("POST", "/api/notes", { stage: "picture", video: "lumen-launch-film", version: "v2", scope: "point", t: i * 0.3, text: `Note ${i}: hold the end card longer` });
  await rushes.writeFiles(Array.from({ length: 59 }, (_, i) => ({ path: `auditions/try-${String(i + 1).padStart(2, "0")}.wav`, seconds: 0.5 + (i % 5) * 0.25, freq: 200 + i * 5 })));
  await rushes.scan();
  const file = join(rushes.root, ".rushes", "project.json");
  const p = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...p, name: "Lumen launch film" }, null, 2));
}

/** The notes panel's tab row: its visible children, with their boxes. */
const barRow = (page: Page) =>
  page.locator(".npanel .ntabs").evaluate((h) =>
    [...h.querySelectorAll(".ntab")].filter((c) => (c as HTMLElement).offsetParent !== null && c.getBoundingClientRect().width > 0).map((c) => {
      const r = c.getBoundingClientRect();
      return { name: `${c.tagName.toLowerCase()}.${c.className}`.slice(0, 40), top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), mid: Math.round((r.top + r.bottom) / 2) };
    }));

for (const width of [1440, 1280, 1100]) {
  test(`at ${width} px a long project's top bar stays one line, and Activity and Send share the notes panel (Task 7, §27 5.7)`, async ({ page, rushes }) => {
    await longProject(rushes);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(rushes.url);
    await videoReady(page);
    await expect(page.locator("header.top .proj")).toContainText("Lumen launch film");
    await expect(workspaceTab(page, "Assets").locator(".wcount")).toHaveText("59");
    await pickFilm(page, "Lumen launch film"); // locked at its long-labelled cut
    await videoReady(page);
    await expect(cutButton(page)).toContainText("Tighter middle 35");
    const send = sendButton(page);
    await expect(send).toContainText("8");
    // At 1100 px and wider the panel is the right-hand column, not a drawer.
    await expect(notesPanel(page)).toBeVisible();
    const row = await barRow(page);
    expect(row).toHaveLength(2);
    const mids = row.map((c) => c.mid);
    expect(Math.max(...mids) - Math.min(...mids), JSON.stringify(row)).toBeLessThanOrEqual(2);
    const [s, p] = [(await send.boundingBox())!, (await notesPanel(page).boundingBox())!];
    expect(s.x + s.width).toBeLessThanOrEqual(p.x + p.width); // in the panel's foot
    expect(s.y + s.height).toBeLessThanOrEqual(p.y + p.height);
    expect((await page.locator(".npanel .ntabs").boundingBox())!.height).toBeLessThan(50);
    expect((await page.locator("header.top").boundingBox())!.height).toBeLessThan(50);
    // Nothing in the top bar spills out of it, and nothing in it spills out of its own box (a cut
    // button wider than its slot, a film's name past its button).
    expect(await page.locator("header.top").evaluate((h) => h.scrollWidth <= h.clientWidth)).toBe(true);
    const spills = await page.locator("header.top").evaluate((h) =>
      [...h.querySelectorAll(".tleft > *, .vwrap > .vbtn, .vbtn > *, .pick > *, .proj > *")]
        .filter((c) => c.getBoundingClientRect().width > 1 && c.getBoundingClientRect().right > c.parentElement!.getBoundingClientRect().right + 1)
        .map((c) => `${c.parentElement!.className} > ${c.className || c.tagName}`));
    expect(spills).toEqual([]);
    // Names that don't fit are cut short on one line, never wrapped onto a second.
    const wrapped = await page.locator("header.top").evaluate((h) =>
      [...h.querySelectorAll(".proj .pname, .pick .filmname, .vbtn .vlbl")].filter((el) => el.getBoundingClientRect().height > 26).map((el) => el.textContent));
    expect(wrapped).toEqual([]);
    if (width === 1440) {
      // At 1440 the film's name, what you switch between, is whole.
      expect(await page.locator("header.top .pick .filmname").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
  });
}

test("Send fills the foot of the notes panel, at the window's right, when there's room to spare (Task 7, §27 5.7)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 0.5, text: "Hold the end card." });
  await page.goto(rushes.url);
  await videoReady(page);
  const send = (await sendButton(page).boundingBox())!;
  const panel = (await notesPanel(page).boundingBox())!;
  expect(Math.round(send.x + send.width)).toBe(Math.round(panel.x + panel.width) - 10);
  expect(panel.x + panel.width).toBeGreaterThan(1400);
});

test("the top bar's notes panel button is an icon, named for screen readers and by a tooltip, at every width (Task 7, §27 5.7)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.setViewportSize({ width: 1050, height: 800 });
  await page.goto(rushes.url);
  await videoReady(page);
  const button = panelToggle(page);
  await expect(button).toHaveAccessibleName("Show the notes panel · \\"); // a drawer, closed, under 1100 px
  expect((await button.boundingBox())!.width).toBeLessThan(48);
  expect(await button.evaluate((el) => getComputedStyle(el, "::after").content)).toBe('"Show the notes panel · \\\\"');
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(button).toHaveAccessibleName("Hide the notes panel · \\");
  expect((await button.boundingBox())!.width).toBeLessThan(48);
});

test("a label, a note and a log line in a right-to-left script start on their own side, so truncation keeps the start (final review)", async ({ page, rushes }) => {
  const hebrew = "גרסה ארוכה מאוד שנחתכת בסוף השורה כדי לבדוק את הקיצור של התווית";
  await rushes.addCut("v1: first pass; rough timing");
  await rushes.api("POST", "/api/versions", { video: "Hero", file: "renders/hero_v1.mp4", note: hebrew, label: hebrew.slice(0, 44) });
  await rushes.api("POST", "/api/log", { text: hebrew, area: "picture" });
  await page.goto(rushes.url);
  await videoReady(page);
  const direction = (el: Element) => getComputedStyle(el).direction; // for evaluate(); evaluateAll can't see it
  // The version button. (§27, 5.4: the note no longer sits under the picture; it is the open list's detail, below.)
  await expect(cutButton(page)).toContainText(hebrew.slice(0, 10));
  expect(await page.locator(".vbtn .vlbl").evaluate(direction)).toBe("rtl");
  // The open list: each row by its own text, and the note beside it.
  await cutButton(page).click();
  expect(await page.locator(".vrow .vlbl").evaluateAll((els) => els.map((el) => getComputedStyle(el).direction))).toEqual(["rtl", "ltr"]);
  await expect(page.locator(".vdetail p")).toContainText(hebrew.slice(0, 10));
  expect(await page.locator(".vdetail p").evaluate(direction)).toBe("rtl");
  await page.keyboard.press("Escape");
  // The drawer's rows go by their own first letter: the Hebrew line is right-to-left, "2 cuts added, …" is not.
  await logButton(page).click();
  await expect(rows(page)).toHaveCount(2);
  expect(await rows(page).locator(".ltext").evaluateAll((els) => els.map((el) => [(el.textContent ?? "").slice(0, 2), getComputedStyle(el).direction]))).toEqual([
    [hebrew.slice(0, 2), "rtl"],
    ["2 ", "ltr"],
  ]);
});

test("the top bar's tooltips stay above the open drawer, so More's can still be read (final review)", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(rushes.url);
  await videoReady(page);
  await panelToggle(page).click();
  await logButton(page).click();
  // A tooltip is a pseudo-element with pointer-events none, so a test can't hit it; with the events
  // on, the element under a point inside it is the button's own, unless the drawer covers it.
  await page.addStyleTag({ content: ".top [data-tip]::after { pointer-events: auto !important; }" });
  const more = page.getByRole("button", { name: "More", exact: true });
  await more.hover();
  await expect(more).toHaveCSS("position", "relative");
  const box = (await more.boundingBox())!;
  const head = (await page.locator("header.top").boundingBox())!;
  const d = (await notesPanel(page).boundingBox())!;
  // A point of the tooltip that lies below the top bar, over the drawer.
  const x = box.x + box.width / 2 - 4;
  const y = head.y + head.height + 6;
  expect(y).toBeGreaterThan(box.y + box.height + 6);
  expect(x).toBeGreaterThan(d.x);
  expect(y).toBeGreaterThan(d.y);
  const hit = await page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    return { inDrawer: !!el?.closest(".npanel"), inBar: !!el?.closest(".rtabrow"), tip: el?.closest("[data-tip]")?.getAttribute("aria-label") ?? null };
  }, [x, y]);
  expect(hit).toEqual({ inDrawer: false, inBar: false, tip: "More" });
});
