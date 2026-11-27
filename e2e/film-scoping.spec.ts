import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { expect, test, activity, currentFilm, notesPanel, openActivity, openPlanPage, openWorkspace, panelTab, pickFilm, reviewTab, sendButton, sentDialog, videoReady, workspaceTab } from "./fixture.js";

// §31: everything on the desk belongs to a film. With a film selected, every tab shows only that film's material.
// A two-film project: Meet your agents (the first film) and Five views.

type Rushes = Parameters<Parameters<typeof test>[2]>[0]["rushes"];

const MEET = "Meet your agents";
const FIVE = "Five views";

function crc32(b: Buffer): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function solidPng(w: number, h: number): Buffer {
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([60, 120, 200], 1 + x * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

const brief = (title: string) => `# Brief: ${title}\n\nStatus: draft\n\n## Purpose\n${title} is for people new to agents.\n`;
const board = (name: string) => `# Storyboard: x\n\n## Shot 01 · ${name}\nLength: 3\nStatus: draft\n\nWhat happens.\n`;

/** Two films, each with its own brief, script, notes and a line in the log; Five views has a storyboard; one shared visual. */
async function twoFilms(rushes: Rushes) {
  await rushes.addCut("meet cut", MEET);
  await rushes.addCut("five cut", FIVE);
  await writeFile(join(rushes.root, "brief.md"), brief("Meet brief"));
  await mkdir(join(rushes.root, "films", "five-views"), { recursive: true });
  await writeFile(join(rushes.root, "films", "five-views", "brief.md"), brief("Five brief"));
  await writeFile(join(rushes.root, "films", "five-views", "storyboard.md"), board("Five opening"));
  await rushes.api("PUT", "/api/script", { video: "meet-your-agents", sections: [{ start: 0, end: 3, current: "Meet the agents line" }] });
  await rushes.api("PUT", "/api/script", { video: "five-views", sections: [{ start: 0, end: 3, current: "Five ways to look line" }] });
  const note = (video: string, text: string) => rushes.api("POST", "/api/notes", { stage: "picture", video, version: "v1", scope: "point", t: 1, frame: 30, text });
  await note("meet-your-agents", "Meet note");
  await note("five-views", "Five note one");
  await note("five-views", "Five note two");
  await mkdir(join(rushes.root, "visuals"), { recursive: true });
  await writeFile(join(rushes.root, "visuals", "quote.png"), solidPng(108, 135));
  await rushes.api("POST", "/api/visuals", { name: "Quote still", pages: [{ files: ["visuals/quote.png"] }] });
}

const filmInUrl = (page: Page) => new URL(page.url()).searchParams.get("film");

test("switching films changes Plan's Brief, Script and Storyboard (§31.3, §31.5)", async ({ page, rushes }) => {
  await twoFilms(rushes);
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(currentFilm(page)).toHaveText(MEET);
  await openPlanPage(page, "Brief");
  // §38.3: the words show in the section and in the At a glance made from it; the section is the brief's own.
  await expect(page.locator(".bcards").getByText("Meet brief")).toBeVisible();
  await openPlanPage(page, "Script");
  await expect(page.locator(".prows textarea").first()).toHaveValue("Meet the agents line");
  // Meet your agents has no storyboard: its tab is locked, even though Five views has one.
  await expect(page.getByRole("tablist", { name: "Plan" }).getByRole("tab", { name: /^Storyboard/ })).toContainText("Locked");
  await pickFilm(page, FIVE);
  await expect(page.locator(".prows textarea").first()).toHaveValue("Five ways to look line");
  await openPlanPage(page, "Brief");
  await expect(page.locator(".bcards").getByText("Five brief")).toBeVisible();
  // The first film's brief is the project brief: Five views names it above its own, but none of its sections are here.
  await expect(page.locator(".bcards").getByText("Meet brief")).toHaveCount(0);
  await openPlanPage(page, "Storyboard");
  await expect(page.locator(".sbhead")).toContainText("Five opening");
  // A save on Five views' brief lands in its own file.
  await openPlanPage(page, "Brief");
  // §38.3: a section reads as text until its Edit opens the field.
  await page.locator(".bcards .bedit").first().click();
  const field = page.locator(".bcards textarea").first();
  await field.fill("Five is for people who know agents.");
  await field.blur();
  await expect.poll(async () => (await rushes.api("GET", "/api/brief?video=five-views")).brief.changed).toBe(1);
  expect((await rushes.api("GET", "/api/brief?video=meet-your-agents")).brief.changed).toBe(0);
});

test("the film is in the URL, and a reload keeps it (§31.5)", async ({ page, rushes }) => {
  await twoFilms(rushes);
  await page.goto(rushes.url);
  await videoReady(page);
  await expect.poll(() => filmInUrl(page)).toBe("meet-your-agents");
  await pickFilm(page, FIVE);
  await expect.poll(() => filmInUrl(page)).toBe("five-views");
  await page.reload();
  await videoReady(page);
  await expect(currentFilm(page)).toHaveText(FIVE);
  // A shared link opens on the film it names.
  await page.goto(`${rushes.url}?film=meet-your-agents`);
  await expect(currentFilm(page)).toHaveText(MEET);
});

test("notes, the Review tab counts and Send's count are the film's, and Send sends that film alone (§31.2.2)", async ({ page, rushes }) => {
  await twoFilms(rushes);
  await page.goto(rushes.url);
  await videoReady(page);
  const notes = notesPanel(page);
  await expect(notes.getByText("Meet note")).toBeVisible();
  await expect(notes.getByText("Five note one")).toHaveCount(0);
  await expect(reviewTab(page, "Timeline")).toHaveAttribute("data-tip", "1 open");
  await expect(sendButton(page)).toHaveAccessibleName("Send 1");
  await pickFilm(page, FIVE);
  await expect(notes.getByText("Five note one")).toBeVisible();
  await expect(notes.getByText("Meet note")).toHaveCount(0);
  await expect(reviewTab(page, "Timeline")).toHaveAttribute("data-tip", "2 open");
  await expect(sendButton(page)).toHaveAccessibleName("Send 2");
  await sendButton(page).click();
  await expect(sentDialog(page)).toContainText('about the film "Five views" only');
  const batch = (await rushes.api("GET", "/api/batches/latest")).batch;
  expect(batch.video).toBe("five-views");
  expect(batch.noteIds).toHaveLength(2);
  await page.keyboard.press("Escape");
  // Meet your agents' note is still waiting for its own Send.
  await pickFilm(page, MEET);
  await expect(sendButton(page)).toHaveAccessibleName("Send 1");
});

test("Activity and its dot are the film's (§31.5)", async ({ page, rushes }) => {
  await twoFilms(rushes);
  await page.goto(rushes.url);
  await videoReady(page);
  await openActivity(page);
  await panelTab(page, "Notes").click();
  await pickFilm(page, FIVE);
  await openActivity(page);
  await panelTab(page, "Notes").click();
  await pickFilm(page, MEET);
  await expect(panelTab(page, "Activity").locator(".cdot")).toHaveCount(0);
  // A line about Five views lights Five views' dot only.
  await rushes.api("POST", "/api/log", { text: "Five views: slower titles", video: "five-views" });
  await page.waitForTimeout(500);
  await expect(panelTab(page, "Activity").locator(".cdot")).toHaveCount(0);
  await pickFilm(page, FIVE);
  await expect(panelTab(page, "Activity").locator(".cdot")).toHaveCount(1);
  await openActivity(page);
  await expect(activity(page).getByText("Five views: slower titles")).toBeVisible();
  // A line added here is Five views': Meet your agents' Activity doesn't show it.
  const input = activity(page).getByLabel("Add a line to the log");
  await input.fill("Kept the wide shot on five");
  await input.press("Enter");
  await expect(activity(page).getByText("Kept the wide shot on five")).toBeVisible();
  await pickFilm(page, MEET);
  await openActivity(page);
  await expect(activity(page).getByText("Kept the wide shot on five")).toHaveCount(0);
  await expect(activity(page).getByText("Five views: slower titles")).toHaveCount(0);
});

test("Assets opens on the film in the top bar, with the visuals marked Shared on every film (§31.2.3, §31.5)", async ({ page, rushes }) => {
  await twoFilms(rushes);
  await page.goto(rushes.url);
  await videoReady(page);
  await pickFilm(page, FIVE);
  await openWorkspace(page, "Assets");
  const folders = page.getByRole("navigation", { name: "Folders" });
  await folders.getByRole("button", { name: /^Cuts/ }).click();
  const film = page.getByRole("combobox", { name: "Film" });
  await expect(film).toHaveValue("five-views");
  await expect(page.locator(".amain").getByText(/Five views · v1/)).toBeVisible();
  await expect(page.locator(".amain").getByText(/Meet your agents · v1/)).toHaveCount(0);
  // The folder's count is the film's too (found on Red's project copy: the counts stayed project-wide).
  await expect(folders.getByRole("button", { name: /^Cuts/ }).locator(".count")).toHaveText("1");
  // "All films" is still there to choose.
  await film.selectOption({ label: "All films" });
  await expect(page.locator(".amain").getByText(/Meet your agents · v1/)).toBeVisible();
  await expect(folders.getByRole("button", { name: /^Cuts/ }).locator(".count")).toHaveText("2");
  await folders.getByRole("button", { name: /^Visuals/ }).click();
  await expect(page.locator(".amain").getByText("Shared")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Film" })).toHaveValue("five-views");
  await pickFilm(page, MEET);
  await expect(page.getByRole("combobox", { name: "Film" })).toHaveValue("meet-your-agents");
  await expect(page.locator(".amain").getByText("Shared")).toBeVisible();
  await expect(workspaceTab(page, "Assets")).toHaveAttribute("aria-selected", "true");
});
