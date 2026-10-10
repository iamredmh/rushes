import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./fixture.js";

// §24.12: the Storyboard page over storyboard.md, and the plan's gate.

const BOARD = `# Storyboard: Lumen launch film

## Shot 01 · Cold open
Tag: ESTABLISH
Length: 3
Still: storyboard/shot-01.png
Status: draft
Direction:

The headline sits on a pale card.

## Shot 02 · Drop a folder
Tag: ACTION
Length: 5
Still: storyboard/missing.png
Status: draft
Direction:

A folder of clips lands in the window.
`;
const BRIEF = "# Brief: Lumen\n\nStatus: draft\n\n## Length and formats\nLength: 30 seconds\n\n## Purpose\nShow it.\n";
const SCRIPT = { sections: [{ start: 0, end: 13, current: "Your work lives on one laptop." }] };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const read = (root: string) => readFile(join(root, "storyboard.md"), "utf8");
const row = (page: import("@playwright/test").Page, heading: string) => page.locator(`.sbrow[data-shot="${heading}"]`);

async function withBoard(rushes: { root: string; writeFiles(f: { path: string; text?: string }[]): Promise<void> }, text = BOARD) {
  await rushes.writeFiles([{ path: "storyboard.md", text }]);
  await mkdir(join(rushes.root, "storyboard"), { recursive: true });
  await writeFile(join(rushes.root, "storyboard", "shot-01.png"), PNG);
}

async function openStoryboard(page: import("@playwright/test").Page) {
  await page.getByRole("tab", { name: /Planning/ }).click();
  await page.getByRole("menuitem", { name: /Storyboard/ }).click();
  await expect(page.getByRole("heading", { name: "Storyboard" })).toBeVisible();
}

test("with no storyboard.md, Storyboard is a locked page that says what to ask the agent", async ({ page, rushes }) => {
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  await page.getByRole("tab", { name: /Planning/ }).click();
  const item = page.getByRole("menuitem", { name: /Storyboard/ });
  await expect(item).toHaveAttribute("data-locked", "true");
  await item.click();
  await expect(page.getByRole("heading", { name: "Storyboard" })).toBeVisible();
  await expect(page.getByLabel("Prompt for your agent")).toHaveValue(/storyboard\.md/);
  await page.getByRole("button", { name: /Send to agent/ }).click();
  await expect(page.locator(".toast")).toContainText("no storyboard yet");
});

test("shows a row per shot with its still, and an empty frame for a still that is missing", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.goto(rushes.url);
  await openStoryboard(page);
  await expect(page.locator(".sbrow")).toHaveCount(2);
  const img = row(page, "Shot 01 · Cold open").locator("img");
  await expect(img).toBeVisible();
  expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  await expect(row(page, "Shot 02 · Drop a folder")).toContainText("No still");
  await expect(row(page, "Shot 01 · Cold open").locator(".cur")).toContainText("The headline sits on a pale card.");
});

test("planned length is shown against the brief's target", async ({ page, rushes }) => {
  await withBoard(rushes);
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  await openStoryboard(page);
  await expect(page.locator(".sbtotal")).toContainText("8.0 / 30 s planned");
});

test("edits to a shot's words and direction are saved into storyboard.md, marked as changed, and can be reverted", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.goto(rushes.url);
  await openStoryboard(page);
  const r = row(page, "Shot 01 · Cold open");
  await page.getByLabel("Your version of shot 1").fill("A pale card, then the title.");
  await page.getByLabel("Direction for shot 1").fill("Slower.");
  await expect(r).toHaveClass(/changed/);
  await expect.poll(() => read(rushes.root)).toContain("Direction: Slower.\n\nA pale card, then the title.\n");
  await expect(r.locator(".cur")).toContainText("The headline sits on a pale card.");
  await page.getByRole("button", { name: "Revert shot 1" }).click();
  await expect(page.getByLabel("Your version of shot 1")).toHaveValue("The headline sits on a pale card.");
  await expect.poll(() => read(rushes.root)).toBe(BOARD);
});

test("approving a shot sets its status, and changing an approved shot reopens it", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.goto(rushes.url);
  await openStoryboard(page);
  await page.getByRole("button", { name: "Approve shot 1" }).click();
  await expect.poll(() => read(rushes.root)).toContain("Status: approved");
  await expect(page.getByRole("button", { name: "Approve shot 1" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Your version of shot 1").fill("Different.");
  await expect.poll(() => read(rushes.root)).toContain("Different.");
  expect(await read(rushes.root)).not.toContain("Status: approved");
  await expect(page.getByRole("button", { name: "Approve shot 1" })).toHaveAttribute("aria-pressed", "false");
});

test("a change the agent makes to storyboard.md shows up without a reload, and becomes Current", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.goto(rushes.url);
  await openStoryboard(page);
  await rushes.writeFiles([{ path: "storyboard.md", text: BOARD.replace("A folder of clips lands in the window.", "Clips fall in from the right.") }]);
  await expect(row(page, "Shot 02 · Drop a folder").locator(".cur")).toContainText("Clips fall in from the right.", { timeout: 8000 });
  await expect(page.getByLabel("Your version of shot 2")).toHaveValue("Clips fall in from the right.");
  await expect(row(page, "Shot 02 · Drop a folder")).not.toHaveClass(/changed/);
});

test("text typed in a shot survives the agent adding a shot above it", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.goto(rushes.url);
  await openStoryboard(page);
  // Hold the save back so the agent's rewrite lands first: the save is then really made against a file that has changed.
  await page.route("**/api/storyboard/shots/*", async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  const box = page.getByLabel("Your version of shot 2");
  await box.fill("Mine.");
  await rushes.writeFiles([{ path: "storyboard.md", text: BOARD.replace("## Shot 01 ·", "## Shot 00 · Title card\nLength: 1\n\nA title.\n\n## Shot 01 ·") }]);
  await expect.poll(() => read(rushes.root), { timeout: 15000 }).toContain("Status: draft\nDirection:\n\nMine.\n");
  expect(await read(rushes.root)).toContain("## Shot 00 · Title card");
  await expect(box).toHaveValue("Mine.");
});

test("Send to agent straight after typing names the shot just edited", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.goto(rushes.url);
  await openStoryboard(page);
  await page.getByLabel("Your version of shot 2").fill("Mine.");
  await page.getByRole("button", { name: /Send to agent/ }).click();
  const dialog = page.getByRole("dialog", { name: "Sent to agent" });
  await expect(dialog).toContainText("this shot: Shot 02 · Drop a folder");
  await expect(dialog).toContainText("0 of 2 shots in storyboard.md are approved");
  expect((await rushes.api("GET", "/api/state")).batches.batches).toHaveLength(0);
});

test("a still opens large, and Escape closes it without leaving the page", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.goto(rushes.url);
  await openStoryboard(page);
  await page.getByRole("button", { name: "Enlarge the still for shot 1" }).click();
  const box = page.getByRole("dialog", { name: /Shot 1, Cold open/ });
  await expect(box).toBeVisible();
  await expect(box.locator("img")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Storyboard" })).toBeVisible();
});

test("the Planning tab says Ready to build once the brief, the script and every shot are approved", async ({ page, rushes }) => {
  await withBoard(rushes, BOARD.replaceAll("Status: draft", "Status: approved"));
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF.replace("Status: draft", "Status: approved") }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  const { script } = await rushes.api("GET", "/api/script");
  await rushes.api("PATCH", `/api/script/${script.sections[0].id}`, { status: "approved" });
  await page.goto(rushes.url);
  await expect(page.locator(".pmarks .pready")).toBeVisible();
  await page.getByRole("tab", { name: /Planning/ }).click();
  const menu = page.getByRole("menu", { name: "Planning" });
  await expect(menu).toContainText("Ready to build");
  await expect(menu.getByRole("menuitem", { name: "Copy prompt for your agent" })).toBeVisible();
  // One shot reopened and it is no longer ready.
  await page.keyboard.press("Escape");
  await openStoryboard(page);
  await page.getByRole("button", { name: "Approve shot 1" }).click();
  await expect(page.locator(".pmarks .pready")).toHaveCount(0);
  await expect(page.locator(".pmarks .pm")).toHaveCount(3);
});

test("a film's first cut starts with the storyboard's shots, and says what the plan is waiting on", async ({ rushes }) => {
  await withBoard(rushes);
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  const r = await rushes.api("POST", "/api/versions", { video: "Hero", file: "renders/hero.mp4" });
  expect(r.planWarning).toContain("still waiting on the brief, the script and the storyboard");
  expect(r.version.shots.map((s: { name: string; start: number }) => [s.name, s.start])).toEqual([["Cold open", 0], ["Drop a folder", 3]]);
});

test("key 1 comes back to the Storyboard when it was the page last used", async ({ page, rushes }) => {
  await withBoard(rushes);
  await rushes.addCut();
  await page.goto(rushes.url);
  await openStoryboard(page);
  await page.keyboard.press("2");
  await expect(page.getByRole("tab", { name: /Picture/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("1");
  await expect(page.getByRole("heading", { name: "Storyboard" })).toBeVisible();
});
