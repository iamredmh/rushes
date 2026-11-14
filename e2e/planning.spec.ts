import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, reviewTab, openWorkspace, workspaceTab, notesPanel, sendButton, sentDialog, planSwitch, planTab, openPlanPage, editedMark, baselineText, planStatus, noteTargetLabel, currentFilm } from "./fixture.js";

// §24 step 2, §27: Plan is a workspace with a three-part switch (Brief, Script, Storyboard); brief.md is the file of record for the Brief page.

const BRIEF = `# Brief: Lumen launch film

Status: draft

## Purpose
Show that Lumen finds the best takes.

## Tone
Calm and dry.
`;

const SCRIPT = { sections: [{ start: 0, end: 13, current: "Your work lives on one laptop." }] };
const read = (root: string) => readFile(join(root, "brief.md"), "utf8");

test("Plan is one workspace with a switch holding Brief, Script and Storyboard", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  const plan = workspaceTab(page, "Plan");
  await expect(plan).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Brief" })).toBeVisible();
  // The pages are on the switch in the work area, not in the top bar, and there is no menu of them any more.
  await expect(page.getByRole("tablist", { name: "Workspaces" }).getByRole("tab", { name: /Script/ })).toHaveCount(0);
  await expect(planSwitch(page).getByRole("tab")).toHaveText([/Brief/, /Script/, /Storyboard/]);
  await expect(planTab(page, "Brief")).toHaveAttribute("aria-selected", "true");
  await planTab(page, "Script").click();
  await expect(page.getByRole("heading", { name: "Script" })).toBeVisible();
  await expect(planTab(page, "Script")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("menu", { name: "Planning" })).toHaveCount(0);
  await expect(plan).toHaveAttribute("aria-selected", "true");
});

test("the switch is keyboard-driven: arrows move between its pages, Enter opens one", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  await planTab(page, "Brief").focus();
  await page.keyboard.press("ArrowRight");
  await expect(planTab(page, "Script")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(planTab(page, "Storyboard")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(planTab(page, "Script")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Script" })).toBeVisible();
  await page.keyboard.press("Home");
  await expect(planTab(page, "Brief")).toBeFocused();
  await page.keyboard.press("End");
  await expect(planTab(page, "Storyboard")).toBeFocused();
});

test("Brief edits are saved to brief.md, marked as changed, and can be reverted", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  const box = page.getByLabel("Your version of Purpose");
  await box.fill("Show how fast Lumen is.");
  const row = page.locator('.srow[data-section="Purpose"]');
  await expect(row).toHaveClass(/changed/);
  await expect.poll(() => read(rushes.root)).toContain("## Purpose\nShow how fast Lumen is.\n");
  await expect(editedMark(row)).toContainText("Edited by you");
  await expect(baselineText(row)).toHaveText("Show that Lumen finds the best takes.");
  await page.getByRole("button", { name: "Revert Purpose" }).click();
  await expect(box).toHaveValue("Show that Lumen finds the best takes.");
  await expect(editedMark(row)).toHaveCount(0);
  await expect.poll(() => read(rushes.root)).toBe(BRIEF);
});

test("two edits in a row both land, and the tab count follows", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  await page.getByLabel("Your version of Purpose").fill("One.");
  await page.getByLabel("Your version of Tone").fill("Two.");
  await expect.poll(() => read(rushes.root)).toContain("## Purpose\nOne.\n\n## Tone\nTwo.\n");
  await expect(sendButton(page)).toContainText("2");
});

test("approving sets the status line, and editing an approved brief reopens it", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  await expect(planStatus(page)).toHaveText("Brief not approved yet · 0 edited");
  await page.getByRole("button", { name: "Approve brief" }).click();
  await expect.poll(() => read(rushes.root)).toContain("Status: approved");
  await expect(page.getByRole("button", { name: "Approved" })).toHaveAttribute("aria-pressed", "true");
  await expect(planStatus(page)).toHaveText("Brief approved · 0 edited");
  await page.getByLabel("Your version of Tone").fill("Warm.");
  await expect.poll(() => read(rushes.root)).toContain("Status: draft");
  await expect(page.getByRole("button", { name: "Approve brief" })).toBeVisible();
  await expect(planStatus(page)).toHaveText("Brief not approved yet · 1 edited");
});

test("a change the agent makes to brief.md shows up without a reload, and becomes the baseline", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  const tone = page.locator('.srow[data-section="Tone"]');
  await expect(page.getByLabel("Your version of Tone")).toHaveValue("Calm and dry.");
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF.replace("Calm and dry.", "Warm and quick.") }]);
  await expect(page.getByLabel("Your version of Tone")).toHaveValue("Warm and quick.", { timeout: 8000 });
  await expect(editedMark(tone)).toHaveCount(0);
  await expect(tone).not.toHaveClass(/changed/);
});

test("with no brief.md, Brief is a locked page that says what to ask the agent", async ({ page, rushes }) => {
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  await openWorkspace(page, "Plan");
  const brief = planTab(page, "Brief");
  await expect(brief).toHaveAttribute("data-locked", "true");
  await brief.click();
  await expect(page.getByRole("heading", { name: "Brief" })).toBeVisible();
  await expect(page.getByLabel("Prompt for your agent")).toHaveValue(/start a brief/);
  await expect(page.getByRole("button", { name: "Copy prompt for your agent" })).toBeVisible();
});

test("key 1 opens Plan on the page last used, and 2 to 8 stay where they were", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  await rushes.addCut();
  await page.goto(rushes.url);
  await expect(reviewTab(page, "Timeline")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("1");
  await expect(page.getByRole("heading", { name: "Script" })).toBeVisible();
  await expect(planTab(page, "Script")).toHaveAttribute("aria-selected", "true");
  await openPlanPage(page, "Brief");
  await page.keyboard.press("2");
  await expect(reviewTab(page, "Timeline")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("1");
  await expect(page.getByRole("heading", { name: "Brief" })).toBeVisible();
  await page.keyboard.press("8");
  await expect(workspaceTab(page, "Assets")).toHaveAttribute("aria-selected", "true");
});

test("Send on Brief gives a message that names what changed, and records nothing", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  await page.getByLabel("Your version of Purpose").fill("Mine.");
  await expect(sendButton(page)).toContainText("1");
  await sendButton(page).click();
  const dialog = sentDialog(page);
  await expect(dialog).toContainText("Message for your agent");
  await expect(dialog).toContainText("this section in brief.md: Purpose");
  expect((await rushes.api("GET", "/api/state")).batches.batches).toHaveLength(0);
});

test("the switch carries a tick on the approved brief and none on the script still to approve, and keeps it once a cut exists", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF.replace("Status: draft", "Status: approved") }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  await expect(planTab(page, "Brief")).toHaveAccessibleName(/Approved/);
  await expect(planTab(page, "Script")).not.toHaveAccessibleName(/Approved/);
  await expect(planTab(page, "Storyboard")).not.toHaveAccessibleName(/Approved/);
  // Not all three are approved, so the top bar's Plan tab has no tick of its own.
  await expect(workspaceTab(page, "Plan").locator(".pready")).toHaveCount(0);
  await rushes.addCut();
  await openWorkspace(page, "Review");
  await expect(reviewTab(page, "Timeline")).toBeVisible();
  await openWorkspace(page, "Plan");
  await expect(planTab(page, "Brief")).toHaveAccessibleName(/Approved/);
});

test("the switch shows a tick on an approved page, and a dot on a page with edits not sent yet", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF.replace("Status: draft", "Status: approved") }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  await expect(planTab(page, "Brief").locator(".pready")).toBeVisible();
  await expect(planTab(page, "Brief").locator(".dot")).toHaveCount(0);
  // Editing the approved brief reopens it: the tick goes and the dot says there is an edit to send.
  await page.getByLabel("Your version of Tone").fill("Warm.");
  await expect(planTab(page, "Brief").locator(".dot")).toBeVisible();
  await expect(planTab(page, "Brief")).not.toHaveAccessibleName(/Approved/);
  await expect(planTab(page, "Brief").locator(".pready")).toHaveCount(0);
});

test("editing a script line marks it Edited by you, with the current wording struck through beneath, and Send counts it", async ({ page, rushes }) => {
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  await openPlanPage(page, "Script");
  const row = page.locator(".srow").first();
  await expect(editedMark(row)).toHaveCount(0);
  await expect(planStatus(page)).toHaveText("0 of 1 line approved · 0 edited");
  await expect(sendButton(page)).toHaveCount(0);
  await row.getByRole("textbox", { name: /^Your version of/ }).fill("Your work lives everywhere.");
  await expect(editedMark(row)).toContainText("Edited by you");
  await expect(baselineText(row)).toHaveText("Your work lives on one laptop.");
  await expect(sendButton(page)).toHaveAccessibleName("Send 1");
  // An edited line is a change, not a note, and the status bar says so (Send itself is "Send 1").
  await expect(page.locator("footer.status")).toContainText("Next: send 1 change");
  await expect(page.locator("footer.status")).not.toContainText("note");
  await expect(planStatus(page)).toHaveText("0 of 1 line approved · 1 edited");
  await expect(planTab(page, "Script").locator(".dot")).toBeVisible();
  // Revert goes back to the current wording, and the mark goes with it.
  await row.getByRole("button", { name: "Revert" }).click();
  await expect(editedMark(row)).toHaveCount(0);
  await expect(sendButton(page)).toHaveCount(0);
  // Approve is a toggle whose tooltip is its name, on or off.
  const approve = row.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toHaveAttribute("data-tip", "Approve");
  await approve.click();
  await expect(approve).toHaveAttribute("aria-pressed", "true");
  await expect(approve).toHaveAttribute("data-tip", "Approve");
});

test("the top bar's Plan tab opens the Plan page last used", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  await rushes.addCut();
  await page.goto(rushes.url);
  await openPlanPage(page, "Script");
  await openWorkspace(page, "Review");
  await expect(reviewTab(page, "Timeline")).toHaveAttribute("aria-selected", "true");
  await workspaceTab(page, "Plan").click();
  await expect(page.getByRole("heading", { name: "Script" })).toBeVisible();
  await expect(planTab(page, "Script")).toHaveAttribute("aria-selected", "true");
});

test("every editable text on a Plan page sits in a field with a visible edge, at rest", async ({ page, rushes }) => {
  await rushes.writeFiles([
    { path: "brief.md", text: BRIEF },
    { path: "storyboard.md", text: "# Storyboard: Lumen launch film\n\n## Shot 01 · Cold open\nTag: ESTABLISH\nLength: 3\nStatus: draft\nDirection:\n\nThe headline sits on a pale card.\n" },
  ]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  const hasEdge = async (box: import("@playwright/test").Locator, row: string) => {
    await expect(box).toBeVisible();
    const edge = await box.evaluate((el, row) => {
      const s = getComputedStyle(el);
      return { width: parseFloat(s.borderTopWidth), colour: s.borderTopColor, bg: getComputedStyle(el.closest(row)!).backgroundColor };
    }, row);
    expect(edge.width).toBeGreaterThan(0);
    expect(edge.colour).not.toBe("rgba(0, 0, 0, 0)");
    expect(edge.colour).not.toBe(edge.bg);
  };
  await openPlanPage(page, "Brief");
  await hasEdge(page.getByLabel("Your version of Tone"), ".srow");
  // A script line, a storyboard shot and its direction too.
  await openPlanPage(page, "Script");
  await hasEdge(page.locator(".srow").first().getByRole("textbox", { name: /^Your version of/ }), ".srow");
  await openPlanPage(page, "Storyboard");
  await hasEdge(page.getByLabel("Your version of shot 1"), ".sbrow");
  await hasEdge(page.getByLabel("Direction for shot 1"), ".sbrow");
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

test("a digit typed in a Plan page's field stays in the field instead of switching workspace", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await rushes.addCut();
  await page.goto(rushes.url);
  await openPlanPage(page, "Brief");
  const tone = page.getByLabel("Your version of Tone");
  await tone.click();
  await tone.press("End");
  // Outside a field, 3 is Voice. Inside one, the key is text.
  await page.keyboard.press("3");
  await expect(tone).toHaveValue("Calm and dry.3");
  await expect(workspaceTab(page, "Plan")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Brief" })).toBeVisible();
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

test("Send straight after typing names the section just edited", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  await page.getByLabel("Your version of Purpose").fill("Mine.");
  await sendButton(page).click();
  await expect(sentDialog(page)).toContainText("this section in brief.md: Purpose");
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

test("an unchanged brief's page still offers Send, and its message carries the brief's line", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  await expect(page.getByRole("heading", { name: "Brief" })).toBeVisible();
  await expect(sendButton(page)).toHaveAccessibleName("Send");
  await sendButton(page).click();
  await expect(sentDialog(page)).toContainText("Message for your agent");
  await expect(sentDialog(page)).toContainText("the brief is still a draft");
  // Elsewhere, with nothing waiting, there is no Send.
  await sentDialog(page).getByRole("button", { name: "Close" }).click();
  await page.keyboard.press("2");
  await expect(sendButton(page)).toHaveCount(0);
});

test("the locked Brief page offers its own prompt, and no Send, since there is no brief to send", async ({ page, rushes }) => {
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  await openPlanPage(page, "Brief");
  await expect(page.getByLabel("Prompt for your agent")).toHaveValue(/brief\.md/);
  await expect(notesPanel(page)).toBeVisible();
  await expect(sendButton(page)).toHaveCount(0);
  await expect(sentDialog(page)).toHaveCount(0);
});

// Deferred minors from the step 2 review.
test("left and right on the Plan switch move between its pages and reach nothing behind it", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  await rushes.addCut();
  await page.goto(rushes.url);
  await openPlanPage(page, "Brief");
  await planTab(page, "Brief").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(planTab(page, "Storyboard")).toBeFocused();
  // Moving along the switch opens nothing: the page and the workspace stay where they were until a page is picked.
  await expect(page.getByRole("heading", { name: "Brief" })).toBeVisible();
  await expect(planTab(page, "Brief")).toHaveAttribute("aria-selected", "true");
  await expect(workspaceTab(page, "Plan")).toHaveAttribute("aria-selected", "true");
  // The arrows never reached the desk's own key handler: its listener on the window heard none of them.
  await page.evaluate(() => {
    (window as unknown as { __heard: string[] }).__heard = [];
    window.addEventListener("keydown", (e) => (window as unknown as { __heard: string[] }).__heard.push(e.key));
  });
  await page.keyboard.press("ArrowLeft");
  await expect(planTab(page, "Script")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(planTab(page, "Storyboard")).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { __heard: string[] }).__heard)).toEqual([]);
  // And the switch is a tab list over the page on show: its tabs control the Plan page, which is their tab panel.
  await expect(planTab(page, "Brief")).toHaveAttribute("aria-controls", "plan-page");
  await expect(page.getByRole("tabpanel", { name: /^Brief/ })).toBeVisible();
});

test("picking a page on the Plan switch with the keyboard leaves focus on its tab, not nowhere", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  await planTab(page, "Brief").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Script" })).toBeVisible();
  await expect(planTab(page, "Script")).toBeFocused();
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
  // With nothing to count, the page has no status line.
  await expect(planStatus(page)).toHaveCount(0);
});

test("a brief.md that is deleted while the page is open is dropped without a reload", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  await page.goto(rushes.url);
  await expect(page.getByLabel("Your version of Tone")).toBeVisible();
  // The server looks for outside changes every half second: let it see the file once before it is taken away.
  await page.waitForTimeout(1200);
  await rm(join(rushes.root, "brief.md"));
  await expect(page.getByLabel("Your version of Tone")).toHaveCount(0, { timeout: 8000 });
});

// Review of the follow-ups: the retry of a refused save must never write over what the person did after it.
test("a refused save is not written over text typed after it", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  const tone = page.getByLabel("Your version of Tone");
  await expect(tone).toHaveValue("Calm and dry.");
  let calls = 0;
  await page.route("**/api/brief/sections/*", async (route) => {
    calls++;
    if (calls === 1) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "brief_changed", message: "brief.md changed since you loaded it." }) });
    if (calls === 2) {
      // The second try is slow, and the person keeps typing while it is in flight.
      await new Promise((r) => setTimeout(r, 1200));
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "brief_changed", message: "brief.md changed since you loaded it." }) });
    }
    return route.continue();
  });
  await tone.fill("Warm.");
  await page.waitForTimeout(700);
  await tone.fill("Warm and dry.");
  await expect.poll(() => read(rushes.root), { timeout: 15000 }).toContain("## Tone\nWarm and dry.\n");
  await page.waitForTimeout(2500);
  expect(await read(rushes.root)).toContain("## Tone\nWarm and dry.\n");
});

test("a refused save is not tried again over an approval made after it", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  const tone = page.getByLabel("Your version of Tone");
  await expect(tone).toHaveValue("Calm and dry.");
  let refused = 0;
  await page.route("**/api/brief/sections/*", (route) => {
    if (refused < 2) {
      refused++;
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "brief_changed", message: "brief.md changed since you loaded it." }) });
    }
    return route.continue();
  });
  await tone.fill("Warm.");
  await expect(page.locator(".toast")).toContainText("Couldn't save Tone");
  await page.getByRole("button", { name: "Approve brief" }).click();
  await expect.poll(() => read(rushes.root), { timeout: 8000 }).toContain("Status: approved");
  await page.waitForTimeout(2500);
  const text = await read(rushes.root);
  expect(text).toContain("Status: approved");
  expect(text).toContain("## Tone\nCalm and dry.\n");
});

test("typing in a section and pressing Approve straight away saves the text and approves, with no complaint", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await page.goto(rushes.url);
  const tone = page.getByLabel("Your version of Tone");
  await expect(tone).toHaveValue("Calm and dry.");
  // The server has written the file, and the page has already heard about it, when the answer to the save arrives.
  await page.route("**/api/brief/sections/*", async (route) => {
    const res = await route.fetch();
    await new Promise((r) => setTimeout(r, 900));
    await route.fulfill({ response: res });
  });
  await tone.fill("Warm.");
  await page.getByRole("button", { name: "Approve brief" }).click();
  await expect.poll(() => read(rushes.root), { timeout: 8000 }).toContain("Status: approved");
  expect(await read(rushes.root)).toContain("## Tone\nWarm.\n");
  await expect(page.locator(".toast")).toHaveCount(0);
});

// Task 7a fix round 1: a field sized to its text must size again when it gets narrower, or the lines that wrap are hidden.
test("a Plan field that wraps onto more lines when the window narrows still shows all its text", async ({ page, rushes }) => {
  const long = "Your work lives on one laptop, and every take you have ever recorded sits in a folder nobody has opened since the shoot, waiting.";
  await rushes.api("PUT", "/api/script", { sections: [{ start: 0, end: 13, current: long }] });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(rushes.url);
  await openPlanPage(page, "Script");
  const box = page.locator(".srow").first().getByRole("textbox", { name: /^Your version of/ });
  await expect(box).toHaveValue(long);
  const fits = () => box.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  const wide = await fits();
  expect(wide.client).toBeGreaterThanOrEqual(wide.scroll);
  await page.setViewportSize({ width: 720, height: 900 });
  await expect.poll(async () => (await fits()).scroll).toBeGreaterThan(wide.scroll);
  await expect.poll(async () => { const f = await fits(); return f.client >= f.scroll; }).toBe(true);
});

// Final review I2: the Plan workspace's note box is behind the same guard as Review's. Leaving the page would unmount the
// box and lose what was typed; another Plan page would quietly aim it at "The script" instead of its line.
test("a half-typed note on the Script page holds the page: Review, Assets, Brief and another film all wait for it", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  await rushes.addCut();
  await rushes.addCut(undefined, "Cutdown");
  await page.goto(rushes.url);
  await openPlanPage(page, "Script");
  await page.locator(".srow").first().click();
  const target = await noteTargetLabel(page).textContent();
  expect(target).not.toBe("The script");
  const box = notesPanel(page).getByRole("textbox", { name: "New note" });
  await box.fill("Half a thought");
  const film = await currentFilm(page).textContent();
  const refused = async () => {
    await expect(page.getByRole("status")).toHaveText("Add or clear your note first");
    await expect(planTab(page, "Script")).toHaveAttribute("aria-selected", "true");
    await expect(box).toHaveValue("Half a thought");
    await expect(noteTargetLabel(page)).toHaveText(target!);
  };
  await workspaceTab(page, "Review").click();
  await refused();
  await workspaceTab(page, "Assets").click();
  await refused();
  await planTab(page, "Brief").click();
  await refused();
  await box.blur();
  await page.keyboard.press("]");
  await expect(page.getByRole("status")).toHaveText(`Add or clear your note on ${film} first`);
  await expect(currentFilm(page)).toHaveText(film!);
  await expect(box).toHaveValue("Half a thought");
  // Cleared, the way is open again.
  await box.fill("");
  await planTab(page, "Brief").click();
  await expect(planTab(page, "Brief")).toHaveAttribute("aria-selected", "true");
});

// Final review m7 (ruling): neither the Brief nor the Storyboard page took notes before the desk, and a note typed there
// was filed as a script note. Their panel lists the script's notes and says where to write one; Send stays.
test("the Brief and Storyboard pages have no note box: their panel lists the script's notes and points to the Script page", async ({ page, rushes }) => {
  await rushes.writeFiles([{ path: "brief.md", text: BRIEF }, { path: "storyboard.md", text: "# Storyboard: Lumen\n\n## Shot 01 · Cold open\nTag: ESTABLISH\nLength: 3\nStatus: draft\nDirection:\n\nA laptop on a desk.\n" }]);
  await rushes.api("PUT", "/api/script", SCRIPT);
  await rushes.api("POST", "/api/notes", { stage: "script", video: null, version: null, on: null, scope: "whole", t: null, tOut: null, text: "Shorter overall" });
  await page.goto(rushes.url);
  for (const name of ["Brief", "Storyboard"] as const) {
    await openPlanPage(page, name);
    await expect(notesPanel(page).getByRole("textbox", { name: "New note" })).toHaveCount(0);
    await expect(notesPanel(page)).toContainText("Notes on the plan are written on the Script page.");
    await expect(notesPanel(page).locator(".note")).toHaveText([/Shorter overall/]);
    await expect(sendButton(page)).toBeVisible();
  }
  await openPlanPage(page, "Script");
  await expect(notesPanel(page).getByRole("textbox", { name: "New note" })).toBeVisible();
  await expect(notesPanel(page)).not.toContainText("Notes on the plan are written on the Script page.");
});
