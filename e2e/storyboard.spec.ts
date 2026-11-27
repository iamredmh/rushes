import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, reviewTab, openWorkspace, notesPanel, sendButton, sentDialog, workspaceTab, planSwitch, planTab, openPlanPage, editedMark, baselineText, planStatus } from "./fixture.js";

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
/** §38.4: the shot on show's details (what happens, direction, Edited by you). Only the shot in the frame has them. */
const row = (page: import("@playwright/test").Page, heading: string) => page.locator(`.sbdetail[data-shot="${heading}"]`);
/** §38.4: puts shot n in the frame, from the strip. */
async function goShot(page: import("@playwright/test").Page, n: number) {
  await page.getByRole("list", { name: "Shots" }).getByRole("listitem").nth(n - 1).click();
}
/** §38.4: shot n's description field, opened with Edit (the description reads as text until then). */
async function shotBox(page: import("@playwright/test").Page, n: number) {
  await goShot(page, n);
  const box = page.getByLabel(`Your version of shot ${n}`, { exact: true });
  if (!(await box.isVisible().catch(() => false))) await page.getByRole("button", { name: `Edit shot ${n}`, exact: true }).click();
  await expect(box).toBeVisible();
  return box;
}

async function withBoard(rushes: { root: string; writeFiles(f: { path: string; text?: string }[]): Promise<void> }, text = BOARD) {
  await rushes.writeFiles([{ path: "storyboard.md", text }]);
  await mkdir(join(rushes.root, "storyboard"), { recursive: true });
  await writeFile(join(rushes.root, "storyboard", "shot-01.png"), PNG);
}

async function openStoryboard(page: import("@playwright/test").Page) {
  await openPlanPage(page, "Storyboard");
}

test("with no storyboard.md, Storyboard is a locked page that says what to ask the agent", async ({ page, rushes }) => {
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  await openWorkspace(page, "Plan");
  const item = planTab(page, "Storyboard");
  await expect(item).toHaveAttribute("data-locked", "true");
  await item.click();
  await expect(page.getByRole("heading", { name: "Storyboard" })).toBeVisible();
  await expect(page.getByLabel("Prompt for your agent")).toHaveValue(/storyboard\.md/);
  // There is no storyboard to send: the panel has no Send, and the page's prompt is the way to get one.
  await expect(notesPanel(page)).toBeVisible();
  await expect(sendButton(page)).toHaveCount(0);
});

test("§38.4 shows one shot large with its still, a strip of every shot, and an empty frame for a still that is missing", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.goto(rushes.url);
  await openStoryboard(page);
  await expect(page.getByRole("list", { name: "Shots" }).getByRole("listitem")).toHaveCount(2);
  const img = page.locator(".sbframe img");
  await expect(img).toBeVisible();
  expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator(".sbhead")).toContainText("Cold open");
  await expect(row(page, "Shot 01 · Cold open")).toContainText("The headline sits on a pale card.");
  await goShot(page, 2);
  await expect(page.locator(".sbframe")).toContainText("No still for this shot yet");
  await expect(page.locator(".sbhead")).toContainText("Drop a folder");
  await goShot(page, 1);
  await expect(editedMark(row(page, "Shot 01 · Cold open"))).toHaveCount(0);
  await expect(planStatus(page)).toHaveText("0 of 2 shots approved · 0 edited");
});

test("planned length is shown against the brief's target", async ({ page, rushes }) => {
  await withBoard(rushes);
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  await openStoryboard(page);
  // §38.4: the planned length against the brief sits at the head of Overview, beside the count of shots.
  await page.getByRole("button", { name: "Overview", exact: true }).first().click();
  await expect(page.locator(".shead .meta")).toHaveText("2 shots");
  await expect(page.locator(".sbtotal")).toContainText("8.0 / 30 s planned");
});

test("edits to a shot's words and direction are saved into storyboard.md, marked as changed, and can be reverted", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.goto(rushes.url);
  await openStoryboard(page);
  const r = row(page, "Shot 01 · Cold open");
  await (await shotBox(page, 1)).fill("A pale card, then the title.");
  await page.getByLabel("Direction for shot 1").fill("Slower.");
  await expect(r).toHaveClass(/changed/);
  await expect.poll(() => read(rushes.root)).toContain("Direction: Slower.\n\nA pale card, then the title.\n");
  await expect(editedMark(r)).toContainText("Edited by you");
  await expect(baselineText(r).first()).toHaveAttribute("data-before", "The headline sits on a pale card.");
  await expect(planStatus(page)).toHaveText("0 of 2 shots approved · 1 edited");
  await page.getByRole("button", { name: "Revert shot 1" }).click();
  await expect(r).toContainText("The headline sits on a pale card.");
  await expect(editedMark(r)).toHaveCount(0);
  await expect.poll(() => read(rushes.root)).toBe(BOARD);
});

test("approving a shot sets its status, and changing an approved shot reopens it", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.goto(rushes.url);
  await openStoryboard(page);
  await page.getByRole("button", { name: "Approve shot 1" }).click();
  await expect.poll(() => read(rushes.root)).toContain("Status: approved");
  await expect(page.getByRole("button", { name: "Approve shot 1" })).toHaveAttribute("aria-pressed", "true");
  // Its tooltip is its name, on or off.
  await expect(page.getByRole("button", { name: "Approve shot 1" })).toHaveAttribute("data-tip", "Approve shot 1");
  await (await shotBox(page, 1)).fill("Different.");
  await expect.poll(() => read(rushes.root)).toContain("Different.");
  expect(await read(rushes.root)).not.toContain("Status: approved");
  await expect(page.getByRole("button", { name: "Approve shot 1" })).toHaveAttribute("aria-pressed", "false");
});

test("a change the agent makes to storyboard.md shows up without a reload, and becomes the baseline", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.goto(rushes.url);
  await openStoryboard(page);
  await goShot(page, 2);
  await rushes.writeFiles([{ path: "storyboard.md", text: BOARD.replace("A folder of clips lands in the window.", "Clips fall in from the right.") }]);
  await expect(row(page, "Shot 02 · Drop a folder")).toContainText("Clips fall in from the right.", { timeout: 8000 });
  await expect(editedMark(row(page, "Shot 02 · Drop a folder"))).toHaveCount(0);
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
  const box = await shotBox(page, 2);
  await box.fill("Mine.");
  await rushes.writeFiles([{ path: "storyboard.md", text: BOARD.replace("## Shot 01 ·", "## Shot 00 · Title card\nLength: 1\n\nA title.\n\n## Shot 01 ·") }]);
  await expect.poll(() => read(rushes.root), { timeout: 15000 }).toContain("Status: draft\nDirection:\n\nMine.\n");
  expect(await read(rushes.root)).toContain("## Shot 00 · Title card");
  await expect(box).toHaveValue("Mine.");
});

test("text typed in a shot survives the agent renumbering the shots", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.goto(rushes.url);
  await openStoryboard(page);
  await page.route("**/api/storyboard/shots/*", async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  const box = await shotBox(page, 2);
  await box.fill("Mine.");
  // A new first shot goes in and every shot is numbered again: "Shot 02 · Drop a folder" is now "Shot 03 · Drop a folder".
  await rushes.writeFiles([
    {
      path: "storyboard.md",
      text: BOARD.replace("## Shot 02 ·", "## Shot 03 ·").replace("## Shot 01 ·", "## Shot 02 ·").replace("## Shot 02 · Cold open", "## Shot 01 · Title card\nLength: 1\n\nA title.\n\n## Shot 02 · Cold open"),
    },
  ]);
  await expect.poll(() => read(rushes.root), { timeout: 15000 }).toContain("Status: draft\nDirection:\n\nMine.\n");
  expect(await read(rushes.root)).toContain("## Shot 03 · Drop a folder");
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("the page keeps working when the agent deletes the last shot while another is being typed in", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.goto(rushes.url);
  await openStoryboard(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/storyboard/shots/*", async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  await (await shotBox(page, 2)).fill("Mine.");
  await rushes.writeFiles([{ path: "storyboard.md", text: BOARD.slice(0, BOARD.indexOf("## Shot 02")) }]);
  await expect(page.getByRole("list", { name: "Shots" }).getByRole("listitem")).toHaveCount(1, { timeout: 15000 });
  await expect(page.getByRole("heading", { name: "Storyboard" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("Send straight after typing names the shot just edited", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.goto(rushes.url);
  await openStoryboard(page);
  await (await shotBox(page, 2)).fill("Mine.");
  await sendButton(page).click();
  const dialog = sentDialog(page);
  await expect(dialog).toContainText("this shot: Shot 02 · Drop a folder");
  await expect(dialog).toContainText("0 of 2 shots in storyboard.md are approved");
  expect((await rushes.api("GET", "/api/state")).batches.batches).toHaveLength(0);
});

test("§38.4 arrows move between shots, and Overview shows every shot and opens the one clicked", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.goto(rushes.url);
  await openStoryboard(page);
  // From the page itself: the Plan switch, where focus starts, has arrows of its own.
  await page.locator(".sbhead .sbname").click();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".sbhead")).toContainText("Drop a folder");
  await expect(page.locator(".vzcount")).toHaveText("02 / 02");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".sbhead")).toContainText("Cold open");
  await page.getByRole("button", { name: "Overview", exact: true }).first().click();
  const grid = page.getByRole("list", { name: "Every shot" });
  await expect(grid.getByRole("listitem")).toHaveCount(2);
  await grid.getByRole("listitem", { name: "Shot 2, Drop a folder" }).click();
  await expect(grid).toHaveCount(0);
  await expect(page.locator(".sbhead")).toContainText("Drop a folder");
});

test("§38.4 a box drawn on a still becomes a note on that shot, numbered on the still, and goes out with Send", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.goto(rushes.url);
  await openStoryboard(page);
  const frame = page.locator(".sbframe");
  const b = (await frame.boundingBox())!;
  await page.mouse.move(b.x + b.width * 0.2, b.y + b.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.5, { steps: 5 });
  await page.mouse.up();
  await expect(frame.locator(".vzbox.draft")).toBeVisible();
  await expect(notesPanel(page)).toContainText("Shot 01 · Cold open · region");
  const box = notesPanel(page).getByRole("textbox", { name: "New note" });
  await expect(box).toBeFocused();
  await box.fill("Make the card warmer.");
  await box.press("Enter");
  await expect(frame.locator(".vzbox:not(.draft)")).toHaveCount(1);
  await expect(frame.locator(".vzbox .no")).toHaveText("1");
  await expect(notesPanel(page).locator(".note")).toContainText("Make the card warmer.");
  const { notes } = await rushes.api("GET", "/api/notes");
  expect(notes[0]).toMatchObject({ stage: "storyboard", on: "shot/1", shot: { n: 1, name: "Cold open" }, still: "storyboard/shot-01.png" });
  expect(notes[0].box.w).toBeGreaterThan(0.2);
  await expect(page.getByRole("list", { name: "Shots" }).getByRole("listitem").first().locator(".sbbadge")).toHaveText("1");
  await sendButton(page).click();
  await expect.poll(async () => (await rushes.api("GET", "/api/state")).batches.batches.length).toBe(1);
});

test("§38.4 a box is not drawn on a still that changed after it was made, and the note says so", async ({ page, rushes }) => {
  await withBoard(rushes);
  await writeFile(join(rushes.root, "storyboard", "shot-01b.png"), PNG);
  await rushes.api("POST", "/api/notes", { stage: "storyboard", on: "shot/1", scope: "whole", text: "Warmer.", box: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } });
  await page.goto(rushes.url);
  await openStoryboard(page);
  await expect(page.locator(".sbframe .vzbox")).toHaveCount(1);
  await rushes.writeFiles([{ path: "storyboard.md", text: BOARD.replace("shot-01.png", "shot-01b.png") }]);
  await expect(page.locator(".sbframe .vzbox")).toHaveCount(0, { timeout: 8000 });
  await expect(notesPanel(page).locator(".note")).toContainText("(on the earlier still)");
});

test("the Plan workspace says Ready to build once the brief, the script and every shot are approved", async ({ page, rushes }) => {
  await withBoard(rushes, BOARD.replaceAll("Status: draft", "Status: approved"));
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF.replace("Status: draft", "Status: approved") }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  const { script } = await rushes.api("GET", "/api/script");
  await rushes.api("PATCH", `/api/script/${script.sections[0].id}`, { status: "approved" });
  await page.goto(rushes.url);
  await expect(workspaceTab(page, "Plan").locator(".pready")).toBeVisible();
  for (const name of ["Brief", "Script", "Storyboard"] as const) await expect(planTab(page, name)).toHaveAccessibleName(/Approved/);
  const row = page.locator(".planrow");
  await expect(row).toContainText("Ready to build");
  await expect(row.getByRole("button", { name: "Copy prompt for your agent" })).toBeVisible();
  // One shot reopened and it is no longer ready.
  await openStoryboard(page);
  await page.getByRole("button", { name: "Approve shot 1" }).click();
  await expect(workspaceTab(page, "Plan").locator(".pready")).toHaveCount(0);
  await expect(planTab(page, "Storyboard")).not.toHaveAccessibleName(/Approved/);
  await expect(planSwitch(page)).toBeVisible();
  await expect(row).not.toContainText("Ready to build");
});

test("with the plan approved, key 1 opens the Plan page last used, where Ready to build is", async ({ page, rushes }) => {
  await withBoard(rushes, BOARD.replaceAll("Status: draft", "Status: approved"));
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF.replace("Status: draft", "Status: approved") }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  const { script } = await rushes.api("GET", "/api/script");
  await rushes.api("PATCH", `/api/script/${script.sections[0].id}`, { status: "approved" });
  await page.goto(rushes.url);
  await openStoryboard(page);
  // Away from Plan, key 1 goes back to the page last used (the status bar no longer says what is next: Red, round 2).
  await page.keyboard.press("8");
  await expect(workspaceTab(page, "Assets")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("footer.status")).not.toContainText("ask for cut 1");
  await page.keyboard.press("1");
  await expect(workspaceTab(page, "Plan")).toHaveAttribute("aria-selected", "true");
  await expect(planTab(page, "Storyboard")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".planrow")).toContainText("Ready to build");
  await expect(page.locator(".planrow").getByRole("button", { name: "Copy prompt for your agent" })).toBeVisible();
});

test("a film's first cut starts with the storyboard's shots, and says what the plan is waiting on", async ({ rushes }) => {
  await withBoard(rushes);
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  const r = await rushes.api("POST", "/api/versions", { video: "Hero", file: "renders/hero.mp4" });
  expect(r.planWarning).toContain("still waiting on the brief and the storyboard");
  expect(r.version.shots.map((s: { name: string; start: number }) => [s.name, s.start])).toEqual([["Cold open", 0], ["Drop a folder", 3]]);
});

test("key 1 comes back to the Storyboard when it was the page last used", async ({ page, rushes }) => {
  await withBoard(rushes);
  await rushes.addCut();
  await page.goto(rushes.url);
  await openStoryboard(page);
  await page.keyboard.press("2");
  await expect(reviewTab(page, "Timeline")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("1");
  await expect(page.getByRole("heading", { name: "Storyboard" })).toBeVisible();
});

// Deferred minors from the step 3 review.
test("the tick is not tried again against a shot the agent has rewritten since you looked", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.goto(rushes.url);
  await openStoryboard(page);
  await page.route("**/api/storyboard/shots/*", async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  await page.getByRole("button", { name: "Approve shot 1" }).click();
  await rushes.writeFiles([{ path: "storyboard.md", text: BOARD.replace("The headline sits on a pale card.", "The headline is now huge.") }]);
  await expect(page.locator(".toast")).toContainText("Couldn't save shot 1", { timeout: 15000 });
  expect(await read(rushes.root)).toContain("Status: draft");
  expect(await read(rushes.root)).not.toContain("Status: approved");
});

test("a storyboard.md with no shots yet says so instead of '0 shots'", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "storyboard.md", text: "# Storyboard: Lumen\n\nNotes only, no shots.\n" }]);
  await page.goto(rushes.url);
  await openPlanPage(page, "Storyboard");
  await expect(page.getByText("storyboard.md has no shots yet")).toBeVisible();
});

test("a description the agent's rewrites refused is not lost when the same shot's direction is edited next", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.goto(rushes.url);
  await openStoryboard(page);
  let refused = 0;
  await page.route("**/api/storyboard/shots/*", (route) => {
    if (refused < 2) {
      refused++;
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "storyboard_changed", message: "storyboard.md changed since you loaded it." }) });
    }
    return route.continue();
  });
  await (await shotBox(page, 1)).fill("Mine.");
  await expect(page.locator(".toast")).toContainText("Couldn't save shot 1");
  await page.getByLabel("Direction for shot 1").fill("Slower.");
  await expect.poll(() => read(rushes.root), { timeout: 15000 }).toContain("Direction: Slower.");
  expect(await read(rushes.root)).toContain("Mine.");
});

test("§38.4 one shot fits the work area without a scroll, its words beside the still, and Overview shows what happens", async ({ page, rushes }) => {
  await withBoard(rushes);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(rushes.url);
  await openStoryboard(page);
  const main = page.locator(".wsmain");
  await expect.poll(() => main.evaluate((m) => m.scrollHeight - m.clientHeight)).toBeLessThanOrEqual(1);
  // No header over the still: the shot's title sits with Previous and Next.
  await expect(page.locator(".sbbar .sbhead")).toContainText("Cold open");
  const frame = (await page.locator(".sbfwrap").boundingBox())!;
  const words = (await page.locator(".sbdetail").boundingBox())!;
  expect(words.x).toBeGreaterThanOrEqual(frame.x + frame.width);
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("listitem", { name: "Shot 2, Drop a folder" }).locator(".sbdesc")).toHaveText("A folder of clips lands in the window.");
});
