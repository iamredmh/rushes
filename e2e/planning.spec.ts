import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./fixture.js";

// §24 step 2: Planning is one tab with a menu (Brief, Script); brief.md is the file of record for the Brief page.

const BRIEF = `# Brief: Lumen launch film

Status: draft

## Purpose
Show that Lumen finds the best takes.

## Tone
Calm and dry.
`;

const SCRIPT = { sections: [{ start: 0, end: 13, current: "Your work lives on one laptop." }] };
const read = (root: string) => readFile(join(root, "brief.md"), "utf8");

test("Planning is one tab with a menu holding Brief and Script", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  const planning = page.getByRole("tab", { name: /Planning/ });
  await expect(planning).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Brief" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Script/ })).toHaveCount(0);
  await planning.click();
  const menu = page.getByRole("menu", { name: "Planning" });
  await expect(menu.getByRole("menuitem")).toHaveText([/Brief/, /Script/, /Storyboard/]);
  await menu.getByRole("menuitem", { name: /Script/ }).click();
  await expect(page.getByRole("heading", { name: "Script" })).toBeVisible();
  await expect(menu).toHaveCount(0);
  await expect(planning).toHaveAttribute("aria-selected", "true");
});

test("the menu is keyboard-driven: ArrowDown opens it, arrows move, Enter picks, Escape closes", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  const planning = page.getByRole("tab", { name: /Planning/ });
  await planning.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: /Brief/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: /Script/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Script" })).toBeVisible();
  await planning.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(planning).toBeFocused();
});

test("Brief edits are saved to brief.md, marked as changed, and can be reverted", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  const box = page.getByLabel("Your version of Purpose");
  await box.fill("Show how fast Lumen is.");
  await expect(page.locator('.srow[data-section="Purpose"]')).toHaveClass(/changed/);
  await expect.poll(() => read(rushes.root)).toContain("## Purpose\nShow how fast Lumen is.\n");
  await expect(page.locator('.srow[data-section="Purpose"] .cur')).toHaveText("Show that Lumen finds the best takes.");
  await page.getByRole("button", { name: "Revert Purpose" }).click();
  await expect(box).toHaveValue("Show that Lumen finds the best takes.");
  await expect.poll(() => read(rushes.root)).toBe(BRIEF);
});

test("two edits in a row both land, and the tab count follows", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  await page.getByLabel("Your version of Purpose").fill("One.");
  await page.getByLabel("Your version of Tone").fill("Two.");
  await expect.poll(() => read(rushes.root)).toContain("## Purpose\nOne.\n\n## Tone\nTwo.\n");
  await expect(page.getByRole("button", { name: /Send to agent/ })).toContainText("2");
});

test("approving sets the status line, and editing an approved brief reopens it", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  await page.getByRole("button", { name: "Approve brief" }).click();
  await expect.poll(() => read(rushes.root)).toContain("Status: approved");
  await expect(page.getByRole("button", { name: "Approved" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Your version of Tone").fill("Warm.");
  await expect.poll(() => read(rushes.root)).toContain("Status: draft");
  await expect(page.getByRole("button", { name: "Approve brief" })).toBeVisible();
});

test("a change the agent makes to brief.md shows up without a reload, and becomes Current", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  await expect(page.locator('.srow[data-section="Tone"] .cur')).toHaveText("Calm and dry.");
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF.replace("Calm and dry.", "Warm and quick.") }]);
  await expect(page.locator('.srow[data-section="Tone"] .cur')).toHaveText("Warm and quick.", { timeout: 8000 });
  await expect(page.getByLabel("Your version of Tone")).toHaveValue("Warm and quick.");
  await expect(page.locator('.srow[data-section="Tone"]')).not.toHaveClass(/changed/);
});

test("with no brief.md, Brief is a locked page that says what to ask the agent", async ({ page, rushes }) => {
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  await page.getByRole("tab", { name: /Planning/ }).click();
  const brief = page.getByRole("menuitem", { name: /Brief/ });
  await expect(brief).toHaveAttribute("data-locked", "true");
  await brief.click();
  await expect(page.getByRole("heading", { name: "Brief" })).toBeVisible();
  await expect(page.getByLabel("Prompt for your agent")).toHaveValue(/start a brief/);
  await expect(page.getByRole("button", { name: "Copy prompt for your agent" })).toBeVisible();
});

test("key 1 opens Planning on the page last used, and 2 to 7 stay where they were", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  await rushes.addCut();
  await page.goto(rushes.url);
  await expect(page.getByRole("tab", { name: /Picture/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("1");
  await expect(page.getByRole("heading", { name: "Script" })).toBeVisible();
  await page.getByRole("tab", { name: /Planning/ }).click();
  await page.getByRole("menuitem", { name: /Brief/ }).click();
  await page.keyboard.press("2");
  await expect(page.getByRole("tab", { name: /Picture/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("1");
  await expect(page.getByRole("heading", { name: "Brief" })).toBeVisible();
  await page.keyboard.press("7");
  await expect(page.getByRole("tab", { name: /Assets/ })).toHaveAttribute("aria-selected", "true");
});

test("Send to agent on Brief gives a message that names what changed, and records nothing", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  await page.getByLabel("Your version of Purpose").fill("Mine.");
  await expect(page.getByRole("button", { name: /Send to agent/ })).toContainText("1");
  await page.getByRole("button", { name: /Send to agent/ }).click();
  const dialog = page.getByRole("dialog", { name: "Sent to agent" });
  await expect(dialog).toContainText("Message for your agent");
  await expect(dialog).toContainText("this section in brief.md: Purpose");
  expect((await rushes.api("GET", "/api/state")).batches.batches).toHaveLength(0);
});

test("while a plan is in progress the Planning tab carries a mark for the brief and one for the script", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF.replace("Status: draft", "Status: approved") }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  await expect(page.locator(".pmarks .pm.ok")).toHaveCount(1);
  await expect(page.locator(".pmarks .pm.none")).toHaveCount(2);
  await rushes.addCut();
  await expect(page.locator(".pmarks")).toHaveCount(0);
});

test("a save refused because the agent rewrote the file is tried again against the file's new hash", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  let puts = 0;
  await page.route("**/api/brief/sections/*", (route) => {
    puts++;
    if (puts === 1) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "brief_changed", message: "brief.md changed since you loaded it." }) });
    return route.continue();
  });
  await page.getByLabel("Your version of Tone").fill("Warm.");
  await expect.poll(() => read(rushes.root)).toContain("## Tone\nWarm.\n");
  expect(puts).toBe(2);
});

test("a save refused twice says so and leaves the file alone", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  await page.route("**/api/brief/sections/*", (route) =>
    route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "brief_changed", message: "brief.md changed since you loaded it." }) }),
  );
  await page.getByLabel("Your version of Tone").fill("Warm.");
  await expect(page.locator(".toast")).toContainText("Couldn't save Tone");
  expect(await read(rushes.root)).toBe(BRIEF);
});

test("with the Planning menu open, a digit stays in the menu instead of switching tabs", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await rushes.addCut();
  await page.goto(rushes.url);
  await page.getByRole("tab", { name: /Planning/ }).click();
  await expect(page.getByRole("menu", { name: "Planning" })).toBeVisible();
  // Outside the menu, 3 is Voiceover. Inside it, the key stays put.
  await page.keyboard.press("3");
  await expect(page.getByRole("tab", { name: /Picture/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: /Voiceover/ })).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("menu", { name: "Planning" })).toBeVisible();
});

// Final review: the first two lost the person's work, and the 409 tests above fake the server's answer.
test("text typed in a row survives the agent adding a section above it", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  // Hold the save back so the agent's rewrite lands first: the save is then really made against a file that has changed.
  await page.route("**/api/brief/sections/*", async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  const tone = page.getByLabel("Your version of Tone");
  await tone.fill("Warm.");
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF.replace("## Purpose", "## Hook\nOpen on the number.\n\n## Purpose") }]);
  await expect.poll(() => read(rushes.root), { timeout: 15000 }).toContain("## Tone\nWarm.\n");
  expect(await read(rushes.root)).toContain("## Hook\nOpen on the number.");
  await expect(tone).toHaveValue("Warm.");
});

test("Send to agent straight after typing names the section just edited", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  await page.getByLabel("Your version of Purpose").fill("Mine.");
  await page.getByRole("button", { name: /Send to agent/ }).click();
  await expect(page.getByRole("dialog", { name: "Sent to agent" })).toContainText("this section in brief.md: Purpose");
});

test("key 1 on the Brief page the dashboard opened on stays on Brief", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  await expect(page.getByRole("heading", { name: "Brief" })).toBeVisible();
  await page.keyboard.press("1");
  await expect(page.getByRole("heading", { name: "Brief" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Script" })).toHaveCount(0);
});

test("Send to agent on the locked Brief page says there is no brief, not that it is a draft", async ({ page, rushes }) => {
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  await page.getByRole("tab", { name: /Planning/ }).click();
  await page.getByRole("menuitem", { name: /Brief/ }).click();
  await page.getByRole("button", { name: /Send to agent/ }).click();
  await expect(page.getByRole("dialog", { name: "Sent to agent" })).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText("no brief yet");
});

// Deferred minors from the step 2 review.
test("with the Planning menu open over Picture, left and right do not step the frame", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await rushes.addCut();
  await page.goto(rushes.url);
  await page.getByRole("tab", { name: /Picture/ }).click();
  const tc = page.getByLabel("Timecode");
  await expect(tc).toBeVisible();
  // Outside the menu, the arrow steps a frame (this is what the menu must not let through).
  const before = await tc.textContent();
  await page.getByRole("button", { name: "Forward one frame" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tc).not.toHaveText(before!);
  const stepped = await tc.textContent();
  await page.getByRole("tab", { name: /Planning/ }).click();
  await expect(page.getByRole("menu", { name: "Planning" })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(tc).toHaveText(stepped!);
});

test("picking a Planning menu item with the keyboard leaves focus on the Planning tab, not nowhere", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  const planning = page.getByRole("tab", { name: /Planning/ });
  await planning.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Script" })).toBeVisible();
  await expect(planning).toBeFocused();
});

test("text refused twice is tried again when the file next changes, not left until the next edit", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  await expect(page.getByLabel("Your version of Tone")).toHaveValue("Calm and dry.");
  let refused = 0;
  await page.route("**/api/brief/sections/*", (route) => {
    if (refused < 2) {
      refused++;
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "brief_changed", message: "brief.md changed since you loaded it." }) });
    }
    return route.continue();
  });
  await page.getByLabel("Your version of Tone").fill("Warm.");
  await expect(page.locator(".toast")).toContainText("Couldn't save Tone");
  expect(await read(rushes.root)).toBe(BRIEF);
  // The agent touches another part of the file: that is the next moment the text can be saved, and it is.
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF.replace("Show that Lumen finds the best takes.", "Show that Lumen finds the best takes, fast.") }]);
  await expect.poll(() => read(rushes.root), { timeout: 15000 }).toContain("## Tone\nWarm.\n");
  expect(await read(rushes.root)).toContain("best takes, fast.");
});

test("Approve brief is not tried again against a brief the agent has rewritten since you looked", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  await expect(page.getByLabel("Your version of Tone")).toHaveValue("Calm and dry.");
  await page.route("**/api/brief/status", async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  await page.getByRole("button", { name: "Approve brief" }).click();
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF.replace("Calm and dry.", "Loud and fast.") }]);
  await expect(page.locator(".toast")).toContainText("Couldn't save the brief's status", { timeout: 15000 });
  expect(await read(rushes.root)).toContain("Status: draft");
});

test("the Brief page shows the film's title, and says so when brief.md has no sections yet", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  await expect(page.locator(".shead")).toContainText("Lumen launch film");
  await rushes.writeFiles([{ path: "brief.md", text: "# Brief: Lumen launch film\n\nStatus: draft\n\nJust some notes, no headings.\n" }]);
  await expect(page.getByText("brief.md has no ## sections yet")).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".shead")).not.toContainText("0 sections");
});
