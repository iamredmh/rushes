import type { Locator, Page } from "@playwright/test";
import { expect, hasFfmpeg, test, type Rushes } from "./fixture.js";

declare global {
  interface Window {
    __rushesOpenFound?: (kind?: "voice" | "music" | "sfx" | "cut" | "other") => void;
  }
}

// Plan 5, Task 5: Assets › Found (§20.5). Invented names throughout; every file is generated into the
// test's own project folder. Nothing here depends on a file being scored high enough to be brought in
// on its own unless a test says so: the names share no word with the cut ("hero_v1") and lengths are
// kept away from its 4 s.

const FOOTER = "Up to 12 files of each kind at a time, so the tabs stay quick. Each voiceover folder becomes its own round.";

const row = (page: Page, name: string): Locator => page.locator(".frow", { has: page.getByRole("checkbox", { name: `Tick ${name}` }) });
const bringIn = (page: Page): Locator => page.getByRole("button", { name: /^Bring in/ });
const foundButton = (page: Page): Locator => page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: /^Found/ });

/** Opens the dashboard on Assets › Found. */
async function openFound(page: Page, rushes: Rushes): Promise<void> {
  await page.goto(rushes.url);
  await page.getByRole("tab", { name: /Assets/ }).click();
  await foundButton(page).click();
  await expect(page.getByRole("heading", { name: "Found" })).toBeVisible();
}

const SOME: Parameters<Rushes["writeFiles"]>[0] = [
  { path: "vo/take-one.wav", seconds: 8, freq: 220 },
  { path: "vo/take-two.wav", seconds: 9, freq: 247 },
  { path: "bed/loop-low.wav", seconds: 10, freq: 131 },
  { path: "audition/try-a.wav", seconds: 1.5, freq: 330 },
  { path: "audition/try-b.wav", seconds: 2, freq: 349 },
  { path: "old/draft.mp4", video: true },
];

test("Found is first in the Assets sidebar with its count; groups, reasons, the card and the header chip show", async ({ page, rushes }) => {
  test.skip(!hasFfmpeg, "the card needs ffprobe: the read is picked by its length");
  await rushes.addCut();
  await rushes.writeFiles([
    { path: "vo/take-read.wav", seconds: 4, freq: 220 }, // the cut's own length: brought in on its own
    { path: "vo/take-alt.wav", seconds: 9, freq: 247 },
    { path: "bed/loop-warm.wav", seconds: 10, freq: 131 },
    { path: "audition/try-a.wav", seconds: 1.5, freq: 330 },
    { path: "audition/try-b.wav", seconds: 2, freq: 349 },
    { path: "old/draft.mp4", video: true },
  ]);
  const { added } = await rushes.scan();
  expect(added.map((a) => a.path)).toEqual(["vo/take-read.wav"]);

  await page.goto(rushes.url);
  // The chip: one brought in, five left. It is there before Found has been opened.
  const chip = page.locator(".foundchip");
  await expect(chip).toHaveText("1 brought in · 5 more found");

  await page.getByRole("tab", { name: /Assets/ }).click();
  const folders = page.getByRole("navigation", { name: "Folders" }).locator(".afolder-btn");
  await expect(folders.first()).toHaveText(/^Found\s*5$/);
  await foundButton(page).click();

  // The chip has done its job once Found is open.
  await expect(chip).toHaveCount(0);

  // The card of what came in with the cut, with its reasons (the read's description).
  const card = page.locator(".fcard.in");
  await expect(card.getByRole("button", { name: /Brought in with this cut/ })).toHaveAttribute("aria-expanded", "true");
  await expect(card.locator(".frow")).toHaveCount(1);
  await expect(card.locator(".frow")).toContainText("take-read.wav");
  await expect(card.locator(".frow .freasons")).toContainText("same length as the cut");
  // It collapses.
  await card.getByRole("button", { name: /Brought in with this cut/ }).click();
  await expect(card.locator(".frow")).toHaveCount(0);
  await card.getByRole("button", { name: /Brought in with this cut/ }).click();
  await expect(card.locator(".frow")).toHaveCount(1);

  // Groups by folder, with the cuts last as "Other cuts"; each shows its count.
  const heads = page.locator(".fgroup > .gh");
  await expect(heads).toHaveCount(4);
  await expect(heads.last()).toContainText("Other cuts");
  await expect(heads.last()).toContainText("1");
  await expect(page.locator(".fgroup", { hasText: "Audition" }).locator(".gh")).toContainText("2");
  await expect(page.locator(".fgroup", { has: page.getByRole("button", { name: /^Vo 1/ }) })).toContainText("take-alt.wav");
  // A group collapses.
  const audition = page.locator(".fgroup", { has: page.getByRole("button", { name: /^Audition/ }) });
  await audition.getByRole("button", { name: /^Audition/ }).click();
  await expect(audition.locator(".frow")).toHaveCount(0);
  await audition.getByRole("button", { name: /^Audition/ }).click();
  await expect(audition.locator(".frow")).toHaveCount(2);

  // A row: checkbox, play, name (with its path as a tooltip), kind, a length and a size. A cut has no play button.
  const alt = row(page, "take-alt.wav");
  await expect(alt.locator(".fname")).toHaveAttribute("title", "vo/take-alt.wav");
  await expect(alt.getByRole("combobox", { name: "Kind of take-alt.wav" })).toHaveValue("voice");
  await expect(alt.locator(".fdur")).toHaveText("0:09.0");
  await expect(alt.locator(".fsize")).toHaveText(/KB$/);
  await expect(alt.getByRole("button", { name: "Play take-alt.wav" })).toBeVisible();
  await expect(row(page, "draft.mp4").getByRole("button", { name: /^Play/ })).toHaveCount(0);
  await expect(row(page, "draft.mp4").getByText("Cut", { exact: true })).toBeVisible();
  await expect(page.getByText(FOOTER)).toBeVisible();
  await expect(bringIn(page)).toBeDisabled();

  // Away from Found and back: nothing has changed, so the chip stays away. A new change brings it back.
  await page.getByRole("tab", { name: /Picture/ }).click();
  await expect(chip).toHaveCount(0);
  await rushes.writeFiles([{ path: "bed/loop-new.wav", seconds: 11, freq: 110 }]);
  await rushes.scan();
  await expect(chip).toHaveText("1 brought in · 6 more found");
  // The chip opens Assets › Found.
  await chip.click();
  await expect(page.getByRole("tab", { name: /Assets/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Found" })).toBeVisible();
  await expect(row(page, "loop-new.wav")).toBeVisible();
  await expect(chip).toHaveCount(0);
});

test("ticked files come in as unpicked reads: the rows leave, the tabs unlock, a toast says so", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  const picksBefore = await rushes.api("GET", "/api/picks");

  await openFound(page, rushes);
  await expect(page.getByRole("tab", { name: /Voiceover/ })).toHaveAttribute("data-locked", "true");
  await expect(page.getByRole("tab", { name: /Music/ })).toHaveAttribute("data-locked", "true");

  await row(page, "take-one.wav").getByRole("checkbox").check();
  await expect(bringIn(page)).toHaveText("Bring in 1");
  await row(page, "loop-low.wav").getByRole("checkbox").check();
  await expect(bringIn(page)).toHaveText("Bring in 2");
  await bringIn(page).click();

  await expect(page.getByRole("status")).toHaveText("Brought in 2 files");
  await expect(row(page, "take-one.wav")).toHaveCount(0);
  await expect(row(page, "loop-low.wav")).toHaveCount(0);
  await expect(bringIn(page)).toBeDisabled();
  await expect(bringIn(page)).toHaveText("Bring in");
  // They are in the "Brought in" card now, and the sidebar count went down.
  await expect(page.locator(".fcard.in .frow")).toHaveCount(2);
  await expect(foundButton(page)).toHaveText(/4$/);

  // The Voiceover and Music tabs unlock and show those files; nothing is picked.
  await expect(page.getByRole("tab", { name: /Voiceover/ })).not.toHaveAttribute("data-locked");
  await expect(page.getByRole("tab", { name: /Music/ })).not.toHaveAttribute("data-locked");
  expect(await rushes.api("GET", "/api/picks")).toEqual(picksBefore);
  const { project } = await rushes.api("GET", "/api/state");
  const variants = project.lanes.flatMap((l: { stage: string; name: string; variants: { file: string }[] }) => l.variants.map((v) => [l.stage, l.name, v.file]));
  expect(variants.sort()).toEqual([["music", "Music", "bed/loop-low.wav"], ["voice", "Vo", "vo/take-one.wav"]]);
  await page.getByRole("tab", { name: /Voiceover/ }).click();
  await expect(page.getByText("take-one", { exact: false }).first()).toBeVisible();
  await page.getByRole("tab", { name: /Music/ }).click();
  await expect(page.getByText("loop-low", { exact: false }).first()).toBeVisible();
});

test("Not these hides a file for good, and Hidden lists it with a Restore", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  await openFound(page, rushes);
  await expect(page.getByRole("button", { name: /^Hidden/ })).toHaveCount(0);

  await expect(page.getByRole("button", { name: "Not these" })).toBeDisabled();
  await row(page, "try-a.wav").getByRole("checkbox").check();
  await page.getByRole("button", { name: "Not these" }).click();
  await expect(row(page, "try-a.wav")).toHaveCount(0);
  await expect(row(page, "try-b.wav")).toBeVisible();
  await expect(foundButton(page)).toHaveText(/5$/);
  await expect(page.getByRole("button", { name: "Hidden (1)" })).toBeVisible();

  // Hidden for good: it is still hidden after a reload.
  await page.reload();
  await page.getByRole("tab", { name: /Assets/ }).click();
  await foundButton(page).click();
  await expect(row(page, "try-a.wav")).toHaveCount(0);
  await page.getByRole("button", { name: "Hidden (1)" }).click();
  const hidden = page.locator(".fhidden");
  await expect(hidden).toContainText("try-a.wav");
  await expect(hidden).toContainText("Audition");
  await hidden.getByRole("button", { name: "Restore try-a.wav" }).click();

  // Back in the list, and the Hidden link is gone.
  await expect(row(page, "try-a.wav")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Hidden/ })).toHaveCount(0);
  await expect(foundButton(page)).toHaveText(/6$/);
});

test("changing a row's kind, then bringing it in, lands it in the right tab", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  await openFound(page, rushes);

  const kind = row(page, "try-a.wav").getByRole("combobox", { name: "Kind of try-a.wav" });
  await expect(kind).toHaveValue("other");
  // The menu offers the audio kinds; a cut's kind can't be changed.
  await expect(kind.locator("option")).toHaveText(["Voiceover", "Music", "Sound effects", "Other audio"]);
  await expect(row(page, "draft.mp4").getByRole("combobox")).toHaveCount(0);
  await kind.selectOption("music");
  // The filter counts follow the change.
  await expect(page.getByRole("button", { name: "Music 2" })).toBeVisible();
  await row(page, "try-a.wav").getByRole("checkbox").check();
  await bringIn(page).click();
  await expect(page.getByRole("status")).toHaveText("Brought in 1 file");

  await page.getByRole("tab", { name: /Music/ }).click();
  await expect(page.getByText("try-a", { exact: false }).first()).toBeVisible();
  const { project } = await rushes.api("GET", "/api/state");
  const music = project.lanes.find((l: { stage: string }) => l.stage === "music");
  expect(music.variants.map((v: { file: string }) => v.file)).toEqual(["audition/try-a.wav"]);
  expect(project.lanes.some((l: { stage: string }) => l.stage === "voice")).toBe(false);
});

test("a file with no kind says so instead of guessing, and stays ticked", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  await openFound(page, rushes);
  await row(page, "try-b.wav").getByRole("checkbox").check();
  await row(page, "take-one.wav").getByRole("checkbox").check();
  await bringIn(page).click();
  await expect(page.getByRole("status")).toHaveText("Brought in 1 file. 1 couldn't be added: choose a kind for this file.");
  // The one that failed stays, still ticked, with the reason beside it; the other left.
  await expect(row(page, "take-one.wav")).toHaveCount(0);
  await expect(row(page, "try-b.wav").locator(".ffail")).toHaveText("Couldn't be added: choose a kind for this file");
  await expect(row(page, "try-b.wav").getByRole("checkbox")).toBeChecked();
  await expect(bringIn(page)).toHaveText("Bring in 1");
  // Pick a kind and it goes.
  await row(page, "try-b.wav").getByRole("combobox").selectOption("sfx");
  await expect(row(page, "try-b.wav").locator(".ffail")).toHaveCount(0);
  await bringIn(page).click();
  await expect(page.getByRole("status")).toHaveText("Brought in 1 file");
  await expect(row(page, "try-b.wav")).toHaveCount(0);
});

test("a file that has gone since the scan is reported, and the others still come in", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  await openFound(page, rushes);
  await row(page, "take-one.wav").getByRole("checkbox").check();
  await row(page, "take-two.wav").getByRole("checkbox").check();
  const { rm } = await import("node:fs/promises");
  await rm(`${rushes.root}/vo/take-two.wav`);
  await bringIn(page).click();
  await expect(page.getByRole("status")).toHaveText("Brought in 1 file. 1 couldn't be added: that file has gone.");
  await expect(row(page, "take-one.wav")).toHaveCount(0);
  await expect(row(page, "take-two.wav").locator(".ffail")).toHaveText("Couldn't be added: that file has gone");
});

test("playing a found file starts it from /media, and playing another stops the first", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  await openFound(page, rushes);

  const one = row(page, "take-one.wav").getByRole("button", { name: "Play take-one.wav" });
  const two = row(page, "take-two.wav").getByRole("button", { name: "Play take-two.wav" });
  const audio = () => page.evaluate(() => {
    const a = document.querySelector("audio")!;
    return { paused: a.paused, src: decodeURIComponent(a.src) };
  });
  // Nothing plays on its own.
  expect((await audio()).paused).toBe(true);
  await one.click();
  await expect(one).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await audio()).paused).toBe(false);
  expect((await audio()).src).toContain("/media?path=vo/take-one.wav");

  await two.click();
  await expect(two).toHaveAttribute("aria-pressed", "true");
  await expect(one).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await audio()).src).toContain("vo/take-two.wav");
  expect((await audio()).paused).toBe(false);

  // Pressing the playing one pauses it.
  await two.click();
  await expect(two).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await audio()).paused).toBe(true);

  // Changing folder stops whatever plays.
  await one.click();
  await expect.poll(async () => (await audio()).paused).toBe(false);
  await page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: /^Cuts/ }).click();
  await foundButton(page).click();
  await expect(row(page, "take-one.wav").getByRole("button", { name: "Play take-one.wav" })).toHaveAttribute("aria-pressed", "false");
});

test("search and the kind filters narrow the list, and the counts follow", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  await openFound(page, rushes);

  const all = page.getByRole("group", { name: "Kind" });
  await expect(all.getByRole("button", { name: "All 6" })).toHaveAttribute("aria-pressed", "true");
  await expect(all.getByRole("button", { name: "Voiceover 2" })).toBeVisible();
  await expect(all.getByRole("button", { name: "Music 1" })).toBeVisible();
  await expect(all.getByRole("button", { name: "Other audio 2" })).toBeVisible();
  await expect(all.getByRole("button", { name: "Cut 1" })).toBeVisible();
  await expect(all.getByRole("button", { name: /Sound effects/ })).toHaveCount(0);

  await all.getByRole("button", { name: "Voiceover 2" }).click();
  await expect(page.locator(".frow")).toHaveCount(2);
  await expect(row(page, "take-one.wav")).toBeVisible();
  await all.getByRole("button", { name: "Cut 1" }).click();
  await expect(page.locator(".frow")).toHaveCount(1);
  await expect(row(page, "draft.mp4")).toBeVisible();
  await all.getByRole("button", { name: /^All/ }).click();
  await expect(page.locator(".frow")).toHaveCount(6);

  const search = page.getByRole("searchbox", { name: "Search found files" });
  await search.fill("TRY");
  await expect(page.locator(".frow")).toHaveCount(2);
  await search.fill("audition/try-b");
  await expect(page.locator(".frow")).toHaveCount(1);
  await search.fill("nothing like this");
  await expect(page.getByText("Nothing matches.")).toBeVisible();
  await search.fill("");
  await expect(page.locator(".frow")).toHaveCount(6);
  // Search and a kind together.
  await search.fill("o");
  await all.getByRole("button", { name: /^Voiceover/ }).click();
  await expect(page.locator(".frow")).toHaveCount(2);
});

test("a 13th ticked file of one kind is held back with the cap line, and 12 come in", async ({ page, rushes }) => {
  // No cut at all: a folder of reads is enough to open Assets.
  const lines = Array.from({ length: 13 }, (_, i) => ({ path: `vo/line-${String(i + 1).padStart(2, "0")}.wav`, seconds: 1, freq: 200 + i * 10 }));
  await rushes.writeFiles(lines);
  await rushes.scan();

  await page.goto(rushes.url);
  await expect(page.locator(".foundchip")).toHaveText("13 found");
  await expect(page.getByRole("tab", { name: /Assets/ })).not.toHaveAttribute("data-locked");
  await page.getByRole("tab", { name: /Assets/ }).click();
  // With nothing else in Assets, Found is what opens.
  await expect(page.getByRole("heading", { name: "Found" })).toBeVisible();
  for (const l of lines) await row(page, l.path.slice(3)).getByRole("checkbox").check();
  await expect(bringIn(page)).toHaveText("Bring in 13");
  await bringIn(page).click();
  await expect(page.getByRole("status")).toHaveText("Brought in 12 files. 1 couldn't be added: up to 12 at a time, so the tabs stay quick.");
  await expect(page.locator(".fgroup .frow")).toHaveCount(1);
  const { project } = await rushes.api("GET", "/api/state");
  const voice = project.lanes.filter((l: { stage: string }) => l.stage === "voice");
  expect(voice.flatMap((l: { variants: unknown[] }) => l.variants)).toHaveLength(12);
  // Each voiceover folder becomes its own round.
  expect(voice.map((l: { name: string }) => l.name)).toEqual(["Vo"]);
  await expect(page.locator(".frow .ffail")).toHaveText("Couldn't be added: up to 12 at a time, so the tabs stay quick");
  // Bring in once more: the last one goes.
  await bringIn(page).click();
  await expect(page.getByRole("status")).toHaveText("Brought in 1 file");
});

test.describe("without ffprobe", () => {
  test.use({ noFfmpeg: true });
  test("the list still shows, with lengths as a dash", async ({ page, rushes }) => {
    await rushes.addCut();
    await rushes.writeFiles(SOME);
    await rushes.scan();
    await openFound(page, rushes);
    await expect(page.locator(".frow")).toHaveCount(6);
    const durations = await page.locator(".frow .fdur").allTextContents();
    expect(durations).toEqual(Array(6).fill("—"));
    // Names and sizes still show, and a file can still come in.
    await expect(row(page, "take-one.wav").locator(".fsize")).toHaveText(/KB$/);
    await row(page, "take-one.wav").getByRole("checkbox").check();
    await bringIn(page).click();
    await expect(page.getByRole("status")).toHaveText("Brought in 1 file");
  });
});

test("the page stays within the window with Found open, even with a very long file name", async ({ page, rushes }) => {
  await rushes.addCut();
  const long = `${"a-very-long-name-for-a-take-that-goes-on-".repeat(5)}end.wav`;
  await rushes.writeFiles([...SOME, { path: `vo_with_a_rather_long_folder_name_indeed/${long}`, seconds: 6 }]);
  await rushes.scan();
  await openFound(page, rushes);
  await expect(page.locator(".frow")).toHaveCount(7);
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    inner: window.innerWidth,
    found: document.querySelector(".amain.found")!.getBoundingClientRect().right,
    rows: [...document.querySelectorAll(".frow")].map((r) => r.getBoundingClientRect().right),
  }));
  expect(widths.inner).toBe(1440);
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  expect(widths.found).toBeLessThanOrEqual(widths.inner);
  for (const r of widths.rows) expect(r).toBeLessThanOrEqual(widths.inner);
  // Nothing in a row is cut off by the next column: the kind menu, length and size all sit inside the row.
  const overflow = await page.locator(".frow").evaluateAll((rows) =>
    rows.filter((r) => [...r.children].some((c) => c.getBoundingClientRect().right > r.getBoundingClientRect().right + 0.5)).length,
  );
  expect(overflow).toBe(0);
});

test("with the keyboard: Space ticks a row, a focused play button plays on Enter, and the kind menu takes a choice", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  await openFound(page, rushes);

  const box = row(page, "take-one.wav").getByRole("checkbox");
  await box.focus();
  await page.keyboard.press("Space");
  await expect(box).toBeChecked();
  await expect(bringIn(page)).toHaveText("Bring in 1");
  await page.keyboard.press("Space");
  await expect(box).not.toBeChecked();
  // A real button: focus it (Safari's own Tab skips buttons unless the user turns that on), and Enter plays it.
  const play = row(page, "take-one.wav").getByRole("button", { name: "Play take-one.wav" });
  await play.focus();
  await expect(play).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(play).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Space");
  await expect(play).toHaveAttribute("aria-pressed", "false");
  // The kind menu takes the keyboard too.
  const kind = row(page, "try-a.wav").getByRole("combobox");
  await kind.focus();
  await kind.selectOption("sfx");
  await expect(kind).toHaveValue("sfx");
});

test("Look again finds what arrived since, and the list fills from the server's own change", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  await openFound(page, rushes);
  await expect(page.locator(".frow")).toHaveCount(6);

  await rushes.writeFiles([{ path: "audition/try-c.wav", seconds: 1.2 }]);
  const again = page.getByRole("button", { name: "Look again" });
  await expect(again).toBeVisible();
  await again.click();
  await expect(row(page, "try-c.wav")).toBeVisible();
  await expect(page.locator(".frow")).toHaveCount(7);
  await expect(foundButton(page)).toHaveText(/7$/);
});

test("while the server is looking, the tray says so; the list is already there", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  // The state the server sends while a walk is running.
  await page.route("**/api/state", async (route) => {
    // The server may already be gone when the test ends and the page asks once more.
    const res = await route.fetch().catch(() => null);
    if (!res) return route.abort();
    const json = await res.json();
    json.found.scanning = true;
    await route.fulfill({ response: res, json });
  });
  await openFound(page, rushes);
  await expect(page.getByText("Looking through the folder…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Look again" })).toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".frow")).toHaveCount(6);
});

test("nothing else found says so, and offers Look again", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles([{ path: "vo/only.wav" }]);
  await rushes.scan();
  await openFound(page, rushes);
  await row(page, "only.wav").getByRole("checkbox").check();
  await row(page, "only.wav").getByRole("combobox").selectOption("voice");
  await bringIn(page).click();
  await expect(page.getByText("Nothing else found in this folder.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Look again" })).toBeVisible();
});

// ---- Task 5 fix round 1 ----

const audioPaused = (page: Page) => page.evaluate(() => document.querySelector("audio")!.paused);
const rowPaths = (page: Page) => page.locator(".fgroup .frow").evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.path!));
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

test("the request to open Found is used once: a later plain visit to Assets opens where Assets always did", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  await page.goto(rushes.testUrl());
  await page.getByRole("tab", { name: /Picture/ }).click();
  await page.locator(".foundchip").click();
  await expect(page.getByRole("heading", { name: /^Found/ })).toBeVisible();
  // Away and back, plain: Cuts, as ever; and with a kind asked for, it is used once too.
  await page.getByRole("tab", { name: /Picture/ }).click();
  await page.getByRole("tab", { name: /Assets/ }).click();
  await expect(page.getByRole("heading", { name: /^Cuts/ })).toBeVisible();
  await page.evaluate(() => window.__rushesOpenFound!("music"));
  await expect(page.getByRole("heading", { name: /^Found/ })).toBeVisible();
  await expect(page.getByRole("group", { name: "Kind" }).getByRole("button", { name: /^Music/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".frow")).toHaveCount(1);
  await page.getByRole("tab", { name: /Picture/ }).click();
  await page.getByRole("tab", { name: /Assets/ }).click();
  await expect(page.getByRole("heading", { name: /^Cuts/ })).toBeVisible();
  // Open Found by hand again: no kind is held over.
  await foundButton(page).click();
  await expect(page.getByRole("group", { name: "Kind" }).getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
});

test("a found row that stops being on screen stops playing: hidden with Not these, searched away, or its group collapsed", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  await openFound(page, rushes);
  const play = (name: string) => row(page, name).getByRole("button", { name: `Play ${name}` });

  // Not these on the playing row.
  await play("take-one.wav").click();
  await expect.poll(() => audioPaused(page)).toBe(false);
  await row(page, "take-one.wav").getByRole("checkbox").check();
  await page.getByRole("button", { name: "Not these" }).click();
  await expect(row(page, "take-one.wav")).toHaveCount(0);
  await expect.poll(() => audioPaused(page)).toBe(true);
  await expect(page.locator(".fplay[aria-pressed='true']")).toHaveCount(0);

  // A search that hides it.
  await play("take-two.wav").click();
  await expect.poll(() => audioPaused(page)).toBe(false);
  await page.getByRole("searchbox", { name: "Search found files" }).fill("loop");
  await expect.poll(() => audioPaused(page)).toBe(true);
  await page.getByRole("searchbox", { name: "Search found files" }).fill("");

  // Its group collapsed.
  await play("take-two.wav").click();
  await expect.poll(() => audioPaused(page)).toBe(false);
  await page.locator(".fgroup", { has: page.getByRole("button", { name: /^Vo 1/ }) }).getByRole("button", { name: /^Vo 1/ }).click();
  await expect.poll(() => audioPaused(page)).toBe(true);
});

test("focus stays in the list: after Bring in and Not these on the next row, or the search box when none is left; after Restore on the next Restore", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  await openFound(page, rushes);
  const focusedLabel = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? "");

  // Bring in: the row after the one that left.
  await expect(page.locator(".fgroup .frow")).toHaveCount(6);
  let paths = await rowPaths(page);
  // Whichever voice read the list puts first (the order follows the scores): it comes in, and focus lands on what follows it.
  const first = paths.find((p) => p.startsWith("vo/"))!;
  const after = paths[paths.indexOf(first) + 1] ?? paths[paths.indexOf(first) - 1];
  await row(page, base(first)).getByRole("checkbox").check();
  await bringIn(page).click();
  await expect(row(page, base(first))).toHaveCount(0);
  await expect.poll(focusedLabel).toBe(`Tick ${base(after)}`);

  // Not these: the same.
  await expect(page.locator(".fgroup .frow")).toHaveCount(5);
  paths = await rowPaths(page);
  const victim = paths.find((p) => p.endsWith("try-a.wav"))!; // not the one that left: the other vo read, if it is in the way, is not touched
  const next = paths[paths.indexOf(victim) + 1] ?? paths[paths.indexOf(victim) - 1];
  await row(page, "try-a.wav").getByRole("checkbox").check();
  await page.getByRole("button", { name: "Not these" }).click();
  await expect(row(page, "try-a.wav")).toHaveCount(0);
  await expect.poll(focusedLabel).toBe(`Tick ${base(next)}`);

  // Restore: hide two more, open Hidden, restore the first; the next Restore button has focus.
  for (const n of ["try-b.wav", "loop-low.wav"]) await row(page, n).getByRole("checkbox").check();
  await page.getByRole("button", { name: "Not these" }).click();
  await page.getByRole("button", { name: /^Hidden \(3\)/ }).click();
  const restores = page.locator(".fhidden").getByRole("button", { name: /^Restore/ });
  await expect(restores).toHaveCount(3);
  const names = await restores.evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")!));
  await restores.first().click();
  await expect(restores).toHaveCount(2);
  await expect.poll(focusedLabel).toBe(names[1]);
  await restores.first().click();
  await expect(restores).toHaveCount(1);
  await expect.poll(focusedLabel).toBe(names[2]);
  // The last one: the restored file's own tick box.
  await restores.first().click();
  await expect(page.locator(".fhidden")).toHaveCount(0);
  await expect.poll(focusedLabel).toBe(`Tick ${names[2].replace("Restore ", "")}`);
});

test("with nothing left to land on, focus goes to the search box", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles([{ path: "vo/only.wav" }]);
  await rushes.scan();
  await openFound(page, rushes);
  await row(page, "only.wav").getByRole("checkbox").check();
  await page.getByRole("button", { name: "Not these" }).click();
  await expect(page.getByText("Nothing else found in this folder.")).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search found files" })).toBeFocused();
});

test("Not these hides only the ticked rows you can see", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  await openFound(page, rushes);
  await row(page, "take-one.wav").getByRole("checkbox").check();
  await page.getByRole("searchbox", { name: "Search found files" }).fill("audition");
  await row(page, "try-a.wav").getByRole("checkbox").check();
  // The tick on the row out of sight is still there for Bring in, but Not these is about what is on screen.
  await expect(bringIn(page)).toHaveText("Bring in 2");
  await page.getByRole("button", { name: "Not these" }).click();
  await expect(page.getByRole("status")).toHaveText("Hid 1 file");
  await page.getByRole("searchbox", { name: "Search found files" }).fill("");
  await expect(row(page, "try-a.wav")).toHaveCount(0);
  await expect(row(page, "take-one.wav")).toBeVisible();
  await expect(row(page, "take-one.wav").getByRole("checkbox")).toBeChecked();
  await expect(page.getByRole("button", { name: "Hidden (1)" })).toBeVisible();
  // With nothing ticked in view, Not these is off.
  await page.getByRole("searchbox", { name: "Search found files" }).fill("audition");
  await expect(page.getByRole("button", { name: "Not these" })).toBeDisabled();
});

test("a read that was in flight before Bring in cannot bring the rows back", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  await openFound(page, rushes);
  await expect(row(page, "take-one.wav")).toBeVisible();
  // From here every read of the list is held after the server has answered, so each one is out of date by the time it lands.
  const gates: (() => void)[] = [];
  let delivered = 0;
  let hold = true;
  await page.route("**/api/found", async (route) => {
    if (!hold) return route.continue();
    const res = await route.fetch().catch(() => null);
    if (!res) return route.abort();
    await new Promise<void>((release) => gates.push(release));
    await route.fulfill({ response: res }).catch(() => undefined);
    delivered++;
  });
  await rushes.api("POST", "/api/found/scan", {});
  await expect.poll(() => gates.length).toBeGreaterThan(0);
  const stale = gates.splice(0);

  await row(page, "take-one.wav").getByRole("checkbox").check();
  await bringIn(page).click();
  await expect(page.getByRole("status")).toHaveText("Brought in 1 file");
  await expect(row(page, "take-one.wav")).toHaveCount(0);
  // The old reads land now; the row must stay gone.
  for (const release of stale) release();
  await expect.poll(() => delivered).toBeGreaterThanOrEqual(stale.length);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); // the page has drawn what landed
  await expect(row(page, "take-one.wav")).toHaveCount(0);
  hold = false;
  for (const release of gates.splice(0)) release();
  await expect(row(page, "take-one.wav")).toHaveCount(0);
});

test("the 'in the project' label sits in the card's header, not on a stray line", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  await openFound(page, rushes);
  await row(page, "take-one.wav").getByRole("checkbox").check();
  await bringIn(page).click();
  const head = page.locator(".fcard.in").getByRole("button", { name: /Brought in with this cut/ });
  const label = page.locator(".fcard.in").getByText("in the project");
  await expect(label).toBeVisible();
  const [h, l] = await Promise.all([head.boundingBox(), label.boundingBox()]);
  expect(l!.width).toBeGreaterThan(60);
  expect(l!.x).toBeGreaterThanOrEqual(h!.x);
  expect(l!.x + l!.width).toBeLessThanOrEqual(h!.x + h!.width + 1);
  expect(l!.y).toBeGreaterThanOrEqual(h!.y - 1);
  expect(l!.y + l!.height).toBeLessThanOrEqual(h!.y + h!.height + 1);
  // And no stray vertical rule through the tray.
  expect(await page.locator(".amain.found *").evaluateAll((els) => els.filter((e) => getComputedStyle(e).position === "absolute" && (e as HTMLElement).offsetWidth <= 1 && (e as HTMLElement).offsetHeight > 10).length)).toBe(0);
});

test("pressing Bring in twice quickly sends one request", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  await openFound(page, rushes);
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/found/bring-in")) posts++;
  });
  // Slow the answer, so the second press lands while the first is still out.
  await page.route("**/api/found/bring-in", async (route) => {
    await new Promise((r) => setTimeout(r, 300));
    await route.continue();
  });
  await row(page, "take-one.wav").getByRole("checkbox").check();
  await bringIn(page).evaluate((b: HTMLButtonElement) => {
    b.click();
    b.click();
  });
  await expect(page.getByRole("status")).toHaveText("Brought in 1 file");
  expect(posts).toBe(1);
  expect((await rushes.api("GET", "/api/state")).project.lanes.flatMap((l: { variants: unknown[] }) => l.variants)).toHaveLength(1);
});

test("a kind asked for is kept while the folder is still being looked through, and drops to All once it is done", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  let scanning = true;
  await page.route("**/api/state", async (route) => {
    const res = await route.fetch().catch(() => null);
    if (!res) return route.abort();
    const json = await res.json();
    json.found.scanning = scanning;
    await route.fulfill({ response: res, json });
  });
  await page.goto(rushes.testUrl());
  await page.getByRole("tab", { name: /Assets/ }).click();
  // No sound effects in the list yet: while it fills, the filter waits for them.
  await page.evaluate(() => window.__rushesOpenFound!("sfx"));
  await expect(page.getByText("Looking through the folder…")).toBeVisible();
  await expect(page.getByText("Nothing matches.")).toBeVisible();
  await expect(page.locator(".frow")).toHaveCount(0);
  // Done looking, and still none: back to All.
  scanning = false;
  await rushes.api("POST", "/api/found/scan", {});
  await expect(page.locator(".frow")).toHaveCount(6);
  await expect(page.getByRole("group", { name: "Kind" }).getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
});

test("file names that read right to left, or mix directions, stay in their own cell", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles([
    { path: "vo/שלום-take.wav", seconds: 8 },
    { path: "vo/take-مرحبا-two.wav", seconds: 9 },
    { path: "vo/plain.wav", seconds: 7 },
  ]);
  await rushes.scan();
  await openFound(page, rushes);
  for (const name of ["שלום-take.wav", "take-مرحبا-two.wav"]) {
    const n = row(page, name).locator(".fname");
    await expect(n).toHaveText(name);
    await expect(n).toHaveAttribute("dir", "auto");
    expect(await n.evaluate((e) => getComputedStyle(e).unicodeBidi)).toMatch(/isolate/);
  }
  // The columns after the name keep their places.
  const rights = await page.locator(".frow").evaluateAll((rows) => rows.map((r) => [r.querySelector(".fdur")!.getBoundingClientRect().right, r.querySelector(".fsize")!.getBoundingClientRect().right]));
  expect(new Set(rights.map((r) => Math.round(r[1]))).size).toBe(1);
  expect(new Set(rights.map((r) => Math.round(r[0]))).size).toBe(1);
});

test("the tray is a labelled region", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  await openFound(page, rushes);
  await expect(page.getByRole("region", { name: "Found files" })).toBeVisible();
});

test("the chip returns when one file is swapped for another, even if the counts do not change", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(SOME);
  await rushes.scan();
  await openFound(page, rushes);
  const chip = page.locator(".foundchip");
  await expect(chip).toHaveCount(0);
  await page.getByRole("tab", { name: /Picture/ }).click();
  await expect(chip).toHaveCount(0);
  const { rm } = await import("node:fs/promises");
  await rm(`${rushes.root}/vo/take-two.wav`);
  await rushes.writeFiles([{ path: "vo/take-three.wav", seconds: 9 }]);
  await rushes.scan();
  const counts = (await rushes.api("GET", "/api/state")).found.counts;
  expect(counts).toMatchObject({ voice: 2, music: 1, other: 2, cut: 1 });
  await expect(chip).toHaveText("6 found");
});

// Plan 5, Task 6: a locked tab says when files of its kind were found (§20.5), and Review opens Found on that kind.
const LOCKED_LINES: Parameters<Rushes["writeFiles"]>[0] = [
  // Lengths well away from the cut's 4 s and names that share nothing with it: none is brought in on its own.
  { path: "bed/loop-low.wav", seconds: 10, freq: 131 },
  { path: "bed/loop-high.wav", seconds: 11, freq: 196 },
  { path: "score/theme-a.wav", seconds: 12, freq: 165 },
  { path: "vo/take-one.wav", seconds: 8, freq: 220 },
  { path: "vo/take-two.wav", seconds: 9, freq: 247 },
  { path: "fx/whoosh-a.wav", seconds: 1.5, freq: 330 },
];
const tab = (page: Page, name: RegExp): Locator => page.getByRole("tab", { name });
const foundLine = (page: Page): Locator => page.locator(".locked .foundline");

test("a locked tab says how many files of its kind were found, with a Review button that opens Found on that kind", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(LOCKED_LINES);
  await rushes.scan();
  await page.goto(rushes.url);

  await tab(page, /^Music/).click();
  await expect(page.getByRole("heading", { name: "Music" })).toBeVisible();
  await expect(foundLine(page)).toHaveText(/^3 music files found in this project/);
  await tab(page, /^Voiceover/).click();
  await expect(foundLine(page)).toHaveText(/^2 voiceover files found in this project/);
  // One file: singular. The noun for effects is "sound effect".
  await tab(page, /^Sound effects/).click();
  await expect(foundLine(page)).toHaveText(/^1 sound effect file found in this project/);
  // Tabs that take no files of their own have no line.
  await tab(page, /^Mix/).click();
  await expect(page.locator(".locked")).toBeVisible();
  await expect(foundLine(page)).toHaveCount(0);
  await tab(page, /^Script/).click();
  await expect(foundLine(page)).toHaveCount(0);

  // Review opens Assets > Found, filtered to the kind the tab is for.
  await tab(page, /^Music/).click();
  await page.locator(".locked").getByRole("button", { name: /^Review/ }).click();
  await expect(page.getByRole("heading", { name: /^Found/ })).toBeVisible();
  await expect(page.getByRole("group", { name: "Kind" }).getByRole("button", { name: /^Music/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".frow")).toHaveCount(3);
  await expect(row(page, "theme-a.wav")).toBeVisible();

  // And the sound-effects tab's Review lands on sound effects.
  await tab(page, /^Sound effects/).click();
  await page.locator(".locked").getByRole("button", { name: /^Review/ }).click();
  await expect(page.getByRole("group", { name: "Kind" }).getByRole("button", { name: /^Sound effects/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".frow")).toHaveCount(1);
});

test("one music file reads in the singular", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles([{ path: "bed/loop-low.wav", seconds: 10, freq: 131 }]);
  await rushes.scan();
  await page.goto(rushes.url);
  await tab(page, /^Music/).click();
  await expect(foundLine(page)).toHaveText(/^1 music file found in this project/);
  await expect(page.getByText("1 music files")).toHaveCount(0);
});

test("with no files of that kind found, the locked tab has no line and no Review button", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles([
    { path: "vo/take-one.wav", seconds: 8, freq: 220 },
    { path: "old/draft.mp4", video: true },
  ]);
  await rushes.scan();
  await page.goto(rushes.url);
  await tab(page, /^Music/).click();
  await expect(page.locator(".locked")).toBeVisible();
  await expect(foundLine(page)).toHaveCount(0);
  await expect(page.locator(".locked").getByRole("button", { name: /^Review/ })).toHaveCount(0);
  await tab(page, /^Voiceover/).click();
  await expect(foundLine(page)).toHaveText(/^1 voiceover file found in this project/);
});

test("the line follows the live count: hiding, finding and bringing in change it without a reload", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.writeFiles(LOCKED_LINES.slice(0, 3));
  await rushes.scan();
  await page.goto(rushes.url);
  await tab(page, /^Music/).click();
  await expect(foundLine(page)).toHaveText(/^3 music files found/);

  // Hidden with Not these: two left.
  await rushes.api("POST", "/api/found/dismiss", { paths: ["bed/loop-low.wav"] });
  await expect(foundLine(page)).toHaveText(/^2 music files found/);
  // A new file and a look again: three.
  await rushes.writeFiles([{ path: "bed/loop-extra.wav", seconds: 13, freq: 262 }]);
  await rushes.scan();
  await expect(foundLine(page)).toHaveText(/^3 music files found/);
  // Down to one: singular.
  await rushes.api("POST", "/api/found/dismiss", { paths: ["bed/loop-high.wav", "bed/loop-extra.wav"] });
  await expect(foundLine(page)).toHaveText(/^1 music file found/);
  // The last one hidden: the line goes, the tab stays locked.
  await rushes.api("POST", "/api/found/dismiss", { paths: ["score/theme-a.wav"] });
  await expect(foundLine(page)).toHaveCount(0);
  await expect(page.locator(".locked")).toBeVisible();
  // Restored and brought in: the tab unlocks, and the line is gone with the locked page.
  await rushes.api("POST", "/api/found/restore", { paths: ["bed/loop-low.wav"] });
  await expect(foundLine(page)).toHaveText(/^1 music file found/);
  await rushes.api("POST", "/api/found/bring-in", { files: [{ path: "bed/loop-low.wav", kind: "music" }] });
  await expect(page.locator(".locked")).toHaveCount(0);
});

test.describe("a project with 2,000 files", () => {
  // No ffprobe: the lengths are not what is being measured, and 2,000 probes would be.
  test.use({ noFfmpeg: true });
  test.setTimeout(90_000);

  test("opens, searches and ticks without stalling", async ({ page, rushes, browserName }) => {
    const files = [];
    for (let f = 0; f < 20; f++) {
      const folder = `${f < 10 ? "vo" : "bed"}_${String(f % 10).padStart(2, "0")}`;
      for (let i = 0; i < 100; i++) files.push({ path: `${folder}/line-${String(i).padStart(4, "0")}.wav`, seconds: 0.05, freq: 200 + i });
    }
    await rushes.writeFiles(files);
    await rushes.scan();
    await expect.poll(async () => (await rushes.api("GET", "/api/found")).files.length, { timeout: 20_000 }).toBe(2000);

    await page.goto(rushes.url);
    await page.getByRole("tab", { name: /Assets/ }).click();
    const opened = await page.evaluate(async () => {
      const t0 = performance.now();
      const button = [...document.querySelectorAll<HTMLButtonElement>(".asidebar .afolder-btn")].find((b) => b.textContent!.startsWith("Found"))!;
      button.click();
      while (document.querySelectorAll(".frow").length < 2000) await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now() - t0;
    });
    await expect(page.locator(".frow")).toHaveCount(2000);

    // Time from an input to the next painted frame.
    const paint = (action: string) =>
      page.evaluate(async (code) => {
        const t0 = performance.now();
        // eslint-disable-next-line no-new-func
        new Function(code)();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return performance.now() - t0;
      }, action);
    const typeInto = (text: string) =>
      `const el = document.querySelector('input[aria-label="Search found files"]'); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event("input", { bubbles: true }));`;
    const keystrokes: number[] = [];
    for (const q of ["v", "vo", "vo_", "vo_0", "vo_01", "vo_01/line-000"]) keystrokes.push(await paint(typeInto(q)));
    await expect(page.locator(".frow")).toHaveCount(10);
    keystrokes.push(await paint(typeInto("")));
    await expect(page.locator(".frow")).toHaveCount(2000);
    // Ticking one row leaves the other 1,999 as they were (which rows draw again is unit-tested: foundRowChanged).
    await page.locator(".frow input[type=checkbox]").nth(5).check();
    await expect(bringIn(page)).toHaveText("Bring in 1");
    await expect(page.locator(".frow.on")).toHaveCount(1);
    await page.locator(".frow input[type=checkbox]").nth(5).uncheck();
    const ticks: number[] = [];
    for (const i of [0, 700, 1500]) {
      ticks.push(await paint(`document.querySelectorAll('.frow input[type=checkbox]')[${i}].click()`));
    }
    await expect(bringIn(page)).toHaveText("Bring in 3");
    const timings = { openMs: Math.round(opened), searchMaxMs: Math.round(Math.max(...keystrokes)), tickMaxMs: Math.round(Math.max(...ticks)) };
    console.log(`2,000 files, ${browserName}: ${JSON.stringify(timings)}`);
    test.info().annotations.push({ type: "timings", description: JSON.stringify(timings) });
    // The timings are reported, not asserted: a limit on wall time fails on a loaded machine and says nothing
    // about the page. What is asserted is that it finishes: every row drew, every search narrowed, every tick counted.
  });
});
