// §28, Send to AI (plan 2): the run's chip in the top bar, and Stop; the Send to AI row above Send and the agent menu;
// the first-Send sheet and what Send does with the answer; the ask cards in the notes panel and the notification for an ask.
// The agent is the fake (e2e/agentFixture.ts).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { rulesPath } from "../src/server/agent/rules.js";
import { cutButton, expect, openPlanPage, openReviewTab, pickFilm, pickVersion, readAgentLog, sendButton, sentDialog, test, videoReady, type AgentRushes } from "./agentFixture.js";

/** The top bar's chip: what the agent is doing. Clicking it opens Activity. */
const chip = (page: Page): Locator => page.locator("header.top .achip");

/** A cut, Send to AI on for Claude Code, and one note to send. Returns the note's id. */
async function readyToSend(rushes: AgentRushes): Promise<string> {
  await rushes.addCut("first cut");
  await rushes.api("POST", "/api/agent/setup", { on: true, agent: "claude" });
  const { note } = await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 0.5, text: "Hold the end card." });
  return note.id as string;
}

/** Every text the chip shows from now on, in order (repeats dropped), so a phase too short to catch with a poll still counts. */
async function watchChip(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __chipSeen: string[] }).__chipSeen = seen;
    const look = () => {
      const t = document.querySelector("header.top .achip")?.textContent ?? "";
      if (t && seen[seen.length - 1] !== t) seen.push(t);
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
    look();
  });
  return () => page.evaluate(() => (window as unknown as { __chipSeen: string[] }).__chipSeen);
}

/** The chip lies inside the top bar, on its one line, clear of the workspaces and the bar's right-hand buttons. */
async function chipFits(page: Page): Promise<void> {
  const bar = (await page.locator("header.top").boundingBox())!;
  const c = (await chip(page).boundingBox())!;
  expect(bar.height).toBeLessThan(50);
  expect(c.x).toBeGreaterThanOrEqual(bar.x);
  expect(c.x + c.width).toBeLessThanOrEqual(bar.x + bar.width);
  expect(c.y).toBeGreaterThanOrEqual(bar.y);
  expect(c.y + c.height).toBeLessThanOrEqual(bar.y + bar.height);
  expect(Math.abs(c.y + c.height / 2 - (bar.y + bar.height / 2))).toBeLessThanOrEqual(2);
  expect(await page.locator("header.top").evaluate((h) => h.scrollWidth <= h.clientWidth)).toBe(true);
  // Clear of the workspaces on its left and of More on its right.
  const ws = (await page.getByRole("tablist", { name: "Workspaces" }).boundingBox())!;
  const more = (await page.getByRole("button", { name: "More", exact: true }).boundingBox())!;
  expect(c.x).toBeGreaterThanOrEqual(ws.x + ws.width);
  expect(c.x + c.width).toBeLessThanOrEqual(more.x);
  // Its words are on screen, not squeezed to nothing.
  expect((await chip(page).locator(".atext").boundingBox())!.width).toBeGreaterThan(40);
}

/** A picture of the top bar, kept with the test's results, to look at. */
async function shoot(page: Page, name: string): Promise<void> {
  const bar = (await page.locator("header.top").boundingBox())!;
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), clip: { x: 0, y: 0, width: bar.width, height: bar.height + 40 } });
}

test("chip follows a run", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [[{ sleep: 1500 }, { stop: "end_turn" }]] });
  await readyToSend(rushes);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(chip(page)).toHaveCount(0);
  const seen = await watchChip(page);
  await rushes.api("POST", "/api/batches", {});
  await expect(chip(page)).toHaveText("Claude Code is working");
  await expect(chip(page)).toBeVisible();
  await chipFits(page);
  await shoot(page, "chip-working-1440");
  await expect(chip(page)).toHaveText("Claude Code finished", { timeout: 10_000 });
  await expect(chip(page)).toBeVisible();
  expect(await seen()).toEqual(["Starting Claude Code", "Claude Code is working", "Claude Code finished"]);
  // A finished run has nothing to stop.
  await expect(page.getByRole("button", { name: "Stop Claude Code" })).toHaveCount(0);
  await chipFits(page);
  await shoot(page, "chip-finished-1440");
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(chip(page)).toBeVisible();
  await chipFits(page);
  await shoot(page, "chip-finished-900");
  // Clicking it opens the notes panel on Activity.
  await chip(page).click();
  await expect(page.getByRole("tabpanel", { name: "Activity" })).toBeVisible();
});

test("Stop ends the run", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [[{ sleep: 10_000 }, { stop: "end_turn" }]] });
  const id = await readyToSend(rushes);
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.api("POST", "/api/batches", {});
  await expect(chip(page)).toHaveText("Claude Code is working");
  const stop = page.getByRole("button", { name: "Stop Claude Code" });
  await expect(stop).toBeVisible();
  await chipFits(page);
  // Stop sits beside the chip, inside the bar.
  const [s, c, bar] = [(await stop.boundingBox())!, (await chip(page).boundingBox())!, (await page.locator("header.top").boundingBox())!];
  expect(s.x).toBeGreaterThanOrEqual(c.x + c.width);
  expect(s.y).toBeGreaterThanOrEqual(bar.y);
  expect(s.y + s.height).toBeLessThanOrEqual(bar.y + bar.height);
  await shoot(page, "chip-working-stop-900");
  // The note is with the agent.
  await page.getByRole("button", { name: "Show the notes panel · \\" }).click();
  const card = page.locator(`.note[data-note="${id}"]`);
  await expect(card.locator(".chk")).toHaveAccessibleName("With your agent · Mark done");
  await stop.click();
  await expect(chip(page)).toHaveCount(0);
  await expect(stop).toHaveCount(0);
  expect((await rushes.api("GET", "/api/agent")).status.phase).toBe("idle");
  // The batch's notes are back to do.
  await expect(card).toBeVisible();
  await expect(card).toHaveClass("note");
  await expect(card.locator(".chk")).toHaveAccessibleName("Mark done");
  await shoot(page, "chip-stopped-900");
});

test("reload mid-run keeps the chip", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [[{ sleep: 10_000 }, { stop: "end_turn" }]] });
  await readyToSend(rushes);
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.api("POST", "/api/batches", {});
  await expect(chip(page)).toHaveText("Claude Code is working");
  await page.reload();
  await videoReady(page);
  await expect(chip(page)).toHaveText("Claude Code is working");
  await expect(chip(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop Claude Code" })).toBeVisible();
  await shoot(page, "chip-after-reload-1440");
});

test("a failed run's chip says why in its tooltip, and has no Stop", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [[{ crash: 3 }]] });
  await readyToSend(rushes);
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.api("POST", "/api/batches", {});
  await expect(chip(page)).toHaveText("Claude Code didn't finish", { timeout: 10_000 });
  await expect(chip(page)).toBeVisible();
  const { status } = await rushes.api("GET", "/api/agent");
  expect(status.phase).toBe("failed");
  expect(status.error).toBeTruthy();
  await expect(chip(page)).toHaveAttribute("data-tip", status.error);
  await expect(page.getByRole("button", { name: "Stop Claude Code" })).toHaveCount(0);
  await chipFits(page);
  await chip(page).hover();
  // The tooltip fades in.
  await expect.poll(() => chip(page).evaluate((el) => getComputedStyle(el, "::after").opacity)).toBe("1");
  await page.screenshot({ path: test.info().outputPath("chip-failed-hover-1440.png"), clip: { x: 640, y: 0, width: 800, height: 140 } });
});

test("a Codex turn that ends in an error shows failed, with Codex's words in the chip's tooltip, not finished (Task 10, 1)", async ({ page, startWithAgent }) => {
  const message = "The 'gpt-6.2-astra' model is not supported when using Codex with a ChatGPT account.";
  const rushes = await startWithAgent({ turns: [[{ fail: message }]] });
  await rushes.addCut("first cut");
  await rushes.api("POST", "/api/agent/setup", { on: true, agent: "codex" });
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 0.5, text: "Hold the end card." });
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.api("POST", "/api/batches", {});
  await expect(chip(page)).toHaveText("Codex didn't finish", { timeout: 10_000 });
  await expect(chip(page)).toHaveAttribute("data-tip", message);
  await expect(chip(page)).not.toContainText("finished");
  const { status } = await rushes.api("GET", "/api/agent");
  expect(status).toMatchObject({ phase: "failed", error: message });
  expect(status.lines.map((l: { text: string }) => l.text)).toContain(`Codex couldn't finish: ${message}`);
  // The note it never touched is back in to do.
  await expect(sendBtn(page)).toHaveAccessibleName("Send 1");
  await chipFits(page);
  await chip(page).hover();
  await expect.poll(() => chip(page).evaluate((el) => getComputedStyle(el, "::after").opacity)).toBe("1");
  await page.screenshot({ path: test.info().outputPath("chip-codex-failed-1440.png"), clip: { x: 640, y: 0, width: 800, height: 140 } });
});

// ---- the Send to AI row and the agent menu (task 3) ----

const panel = (page: Page): Locator => page.getByRole("complementary", { name: "Notes panel" });
const foot = (page: Page): Locator => panel(page).locator(".nfoot");
const row = (page: Page): Locator => foot(page).locator(".agentrow");
const toggle = (page: Page): Locator => foot(page).getByRole("switch", { name: "Send to AI" });
const who = (page: Page): Locator => foot(page).locator(".awho");
const sendBtn = (page: Page): Locator => foot(page).locator(".sendbtn");
const agentMenu = (page: Page): Locator => page.getByRole("menu", { name: "Send to AI" });

/** A cut and one note to send; Send to AI on for Claude Code unless `on` is false. */
async function withNote(rushes: AgentRushes, on = true): Promise<void> {
  await rushes.addCut("first cut");
  if (on) await rushes.api("POST", "/api/agent/setup", { on: true, agent: "claude" });
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 0.5, text: "Hold the end card." });
}

/** A picture of the notes panel's foot (and the menu above it, when open), kept with the test's results, to look at. */
async function shootFoot(page: Page, name: string): Promise<void> {
  const p = (await panel(page).boundingBox())!;
  const f = (await foot(page).boundingBox())!;
  const m = (await agentMenu(page).count()) ? (await agentMenu(page).boundingBox())! : null;
  const top = Math.max(0, Math.min(f.y, m?.y ?? f.y) - 12);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), clip: { x: p.x, y: top, width: p.width, height: f.y + f.height - top + 4 } });
}

/** `inner` lies wholly inside `outer` (to the pixel's rounding). */
function inside(inner: { x: number; y: number; width: number; height: number }, outer: { x: number; y: number; width: number; height: number }): void {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - 0.5);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - 0.5);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height + 0.5);
}

const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The row, Send (while something waits) and the who-line are on screen, inside the foot, one above the other with no
 *  overlap; nothing spills. */
async function footFits(page: Page): Promise<void> {
  const f = (await foot(page).boundingBox())!;
  const parts = [row(page), ...((await sendBtn(page).count()) ? [sendBtn(page)] : []), who(page)];
  const boxes = [];
  for (const p of parts) boxes.push((await p.boundingBox())!);
  for (const b of boxes) {
    expect(b.width).toBeGreaterThan(40);
    expect(b.height).toBeGreaterThan(8);
    inside(b, f);
  }
  // Each above the next, none overlapping.
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false);
  for (let i = 0; i + 1 < boxes.length; i++) expect(boxes[i].y + boxes[i].height).toBeLessThanOrEqual(boxes[i + 1].y + 0.5);
  inside(f, (await panel(page).boundingBox())!);
  // No word cut off or pushed out of its box.
  expect(await foot(page).evaluate((el) => [el, ...el.querySelectorAll("*")].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== "visible").map((e) => e.className))).toEqual([]);
  expect(await row(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
}

/** The open menu is on screen, inside the notes panel (never cut off by its edge or the window's). */
async function menuFits(page: Page): Promise<void> {
  const m = (await agentMenu(page).boundingBox())!;
  inside(m, (await panel(page).boundingBox())!);
  const vp = page.viewportSize()!;
  inside(m, { x: 0, y: 0, width: vp.width, height: vp.height });
  // Its rows are inside it, not scrolled past its edges unseen.
  expect(m.height).toBeGreaterThan(120);
}

test("switch row shows the agent and turns off", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  await withNote(rushes);
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(row(page)).toBeVisible();
  await expect(row(page).getByRole("button", { name: "Send to AI · Claude Code" })).toBeVisible();
  await expect(row(page).getByRole("button", { name: "Send to AI · Claude Code" }).locator("svg.ic")).toBeVisible();
  await expect(toggle(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await expect(who(page)).toHaveText("Edits files in this project, asks before commands");
  await expect(who(page)).toBeVisible();
  expect(await who(page).evaluate((el) => getComputedStyle(el).fontSize)).toBe("12px");
  await footFits(page);
  await shootFoot(page, "row-on-1440");
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
  await expect(who(page)).toHaveText("Copies a prompt for your own chat");
  expect((await rushes.api("GET", "/api/agent")).status.on).toBe(false);
  // Off, the row still names the agent, and Send is as it was.
  await expect(row(page).getByRole("button", { name: "Send to AI · Claude Code" })).toBeVisible();
  await expect(sendBtn(page)).toHaveAccessibleName("Send 1");
  await footFits(page);
  await shootFoot(page, "row-off-1440");
});

test("agent menu changes permissions and removes a rule", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  // No ask card yet (task 5): the rule is written to the user's rules file, where an answered Always would put it.
  const rules = rulesPath(rushes.root, rushes.configDir);
  await mkdir(dirname(rules), { recursive: true });
  await writeFile(rules, JSON.stringify({ permissions: "project-edits", always: [{ kind: "execute", command: "npx hyperframes" }] }));
  await withNote(rushes);
  await page.goto(rushes.url);
  await videoReady(page);
  await row(page).getByRole("button", { name: "Send to AI · Claude Code" }).click();
  const menu = agentMenu(page);
  await expect(menu).toBeVisible();
  await expect(menu.getByText("Send notes to", { exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: /Claude Code/ })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemradio", { name: /Codex/ })).toHaveAttribute("aria-checked", "false");
  await expect(menu.getByRole("menuitemradio", { name: /Claude Code/ })).toContainText("Signed in");
  // No conversation yet: nothing to start fresh.
  await expect(menu.getByRole("menuitem", { name: "Start a fresh conversation" })).toHaveCount(0);
  await expect(menu.getByText("What it may do without asking", { exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: "Accept edits" })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByText("Always rules", { exact: true })).toBeVisible();
  await expect(menu.getByText("Always for npx hyperframes here", { exact: true })).toBeVisible();
  await expect(menu.getByText("Switch off: Send copies a prompt, as now", { exact: true })).toBeVisible();
  await menuFits(page);
  await shootFoot(page, "menu-open-1440");
  await menu.getByRole("menuitemradio", { name: "Manual" }).click();
  await expect(menu.getByRole("menuitemradio", { name: "Manual" })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemradio", { name: "Accept edits" })).toHaveAttribute("aria-checked", "false");
  await expect(who(page)).toHaveText("Asks before everything");
  await menu.getByRole("menuitem", { name: "Remove Always for npx hyperframes here" }).click();
  await expect(menu.getByText("No Always rules yet", { exact: true })).toBeVisible();
  await expect(menu.getByText("Always for npx hyperframes here", { exact: true })).toHaveCount(0);
  await shootFoot(page, "menu-after-1440");
  // I1: the file also keeps the user's answer to the first-Send sheet (withNote set Send to AI up through the route).
  expect(JSON.parse(await readFile(rules, "utf8"))).toEqual({ permissions: "ask-all", always: [], setUp: true, agent: "claude" });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("row fits at 900 px", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  await withNote(rushes);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(rushes.url);
  await videoReady(page);
  await page.getByRole("button", { name: "Show the notes panel · \\" }).click();
  await expect(row(page)).toBeVisible();
  await footFits(page);
  await shootFoot(page, "row-on-900");
  await row(page).getByRole("button", { name: "Send to AI · Claude Code" }).click();
  await expect(agentMenu(page)).toBeVisible();
  await menuFits(page);
  await shootFoot(page, "menu-open-900");
});

test("Set up Send to AI opens the first-Send sheet, and picking an agent turns it on and sends what waits", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [[{ stop: "end_turn" }]] });
  await withNote(rushes, false);
  await page.goto(rushes.url);
  await videoReady(page);
  const setUp = row(page).getByRole("button", { name: "Set up Send to AI" });
  await expect(setUp).toBeVisible();
  await expect(toggle(page)).toHaveCount(0);
  await expect(who(page)).toHaveText("Copies a prompt for your own chat");
  await footFits(page);
  await shootFoot(page, "row-setup-1440");
  await setUp.click();
  await expect(sheet(page)).toBeVisible();
  await expect(agentMenu(page)).toHaveCount(0);
  await expect(whoRadio(page, "Claude Code")).toBeChecked();
  await primary(page).click();
  await primary(page, "Send to Claude Code").click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(row(page).getByRole("button", { name: "Send to AI · Claude Code" })).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await expect(who(page)).toHaveText(/^Edits files in this project, asks before commands/);
  expect((await rushes.api("GET", "/api/agent")).status).toMatchObject({ on: true, agent: "claude", asked: true });
  // A note was waiting, and the sheet's button says Send: it went to the agent.
  await expect(page.locator(".toast")).toHaveText(/^(Sent to|Starting) Claude Code$/);
  await expect(page.getByRole("dialog", { name: "Sent to agent" })).toHaveCount(0);
});

test("an agent that isn't signed in says so, and picking it shows why under its row", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] }, { agents: [{ id: "claude", installed: true, signedIn: true }, { id: "codex", installed: true, signedIn: false }] });
  await withNote(rushes);
  await page.goto(rushes.url);
  await videoReady(page);
  await row(page).getByRole("button", { name: "Send to AI · Claude Code" }).click();
  const menu = agentMenu(page);
  const codex = menu.getByRole("menuitemradio", { name: /Codex/ });
  await expect(codex).toContainText("Not signed in");
  await expect(menu.getByRole("menuitem", { name: "Sign in in Terminal" })).toBeVisible();
  await codex.click();
  const why = menu.getByRole("alert");
  await expect(why).toHaveText("Codex is not signed in. Choose Sign in in Terminal, then try again.");
  await expect(why).toBeVisible();
  // Under Codex's row, and the agent is unchanged.
  expect((await why.boundingBox())!.y).toBeGreaterThanOrEqual((await codex.boundingBox())!.y + (await codex.boundingBox())!.height - 0.5);
  await expect(menu.getByRole("menuitemradio", { name: /Claude Code/ })).toHaveAttribute("aria-checked", "true");
  await menuFits(page);
  await shootFoot(page, "menu-not-signed-in-1440");
});

test("Start a fresh conversation shows once there is one, and drops it", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [[{ stop: "end_turn" }]] });
  await withNote(rushes);
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.api("POST", "/api/batches", {});
  await expect(who(page)).toHaveText("Edits files in this project, asks before commands · next Send continues the conversation", { timeout: 10_000 });
  await row(page).getByRole("button", { name: "Send to AI · Claude Code" }).click();
  const fresh = agentMenu(page).getByRole("menuitem", { name: "Start a fresh conversation" });
  await expect(fresh).toBeVisible();
  await fresh.click();
  await expect(who(page)).toHaveText("Edits files in this project, asks before commands");
  expect((await rushes.api("GET", "/api/agent")).status.session).toBeNull();
});

test("with nothing waiting the foot keeps the row: Set up, then off and on again", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  await rushes.addCut("first cut");
  await page.goto(rushes.url);
  await videoReady(page);
  // No notes: no Send, but the way in is there.
  await expect(sendBtn(page)).toHaveCount(0);
  const setUp = row(page).getByRole("button", { name: "Set up Send to AI" });
  await expect(setUp).toBeVisible();
  await expect(who(page)).toHaveText("Copies a prompt for your own chat");
  await footFits(page);
  await shootFoot(page, "empty-setup-1440");
  // Nothing waits: the sheet sets Send to AI up and sends nothing, and its button says so (I3).
  await setUp.click();
  await primary(page, "Next").click();
  await expect(primary(page)).toHaveText("Use Claude Code");
  await expect(sheet(page).getByRole("button", { name: "Send to Claude Code" })).toHaveCount(0);
  await primary(page, "Use Claude Code").click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  expect((await rushes.api("GET", "/api/batches/latest").catch(() => null))?.batch ?? null).toBeNull();
  // Off with nothing waiting: the row stays where it was, so the switch can turn it on again.
  const before = (await toggle(page).boundingBox())!;
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
  await expect(toggle(page)).toBeVisible();
  await expect(who(page)).toHaveText("Copies a prompt for your own chat");
  const after = (await toggle(page).boundingBox())!;
  expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  await expect(sendBtn(page)).toHaveCount(0);
  await footFits(page);
  await shootFoot(page, "empty-off-1440");
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await expect(who(page)).toHaveText("Edits files in this project, asks before commands");
  expect((await rushes.api("GET", "/api/agent")).status.on).toBe(true);
  await footFits(page);
  await shootFoot(page, "empty-on-1440");
  await page.setViewportSize({ width: 900, height: 700 });
  await page.getByRole("button", { name: "Show the notes panel · \\" }).click();
  await expect(row(page)).toBeVisible();
  await footFits(page);
  await shootFoot(page, "empty-on-900");
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
  await footFits(page);
  await shootFoot(page, "empty-off-900");
});

test("Remove by keyboard keeps focus in the menu", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  const rules = rulesPath(rushes.root, rushes.configDir);
  await mkdir(dirname(rules), { recursive: true });
  await writeFile(rules, JSON.stringify({ permissions: "project-edits", always: [{ kind: "execute", command: "npx hyperframes" }, { kind: "fetch", command: null }] }));
  await withNote(rushes);
  await page.goto(rushes.url);
  await videoReady(page);
  const name = row(page).getByRole("button", { name: "Send to AI · Claude Code" });
  await name.focus();
  await page.keyboard.press("Enter");
  const menu = agentMenu(page);
  await expect(menu).toBeVisible();
  /** The focused element's role and name, when it is a row of the agent menu; null otherwise. */
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (!el || !el.closest('[role="menu"][aria-label="Send to AI"]')) return null;
      return `${el.getAttribute("role")}: ${el.getAttribute("aria-label") ?? el.textContent}`;
    });
  // The last row is the last rule's Remove.
  await page.keyboard.press("End");
  await expect.poll(focused).toBe("menuitem: Remove Always for web requests here");
  await page.keyboard.press("Enter");
  await expect(menu.getByText("Always for web requests here", { exact: true })).toHaveCount(0);
  // Focus goes to the rule before it, and the arrows still move it.
  await expect.poll(focused).toBe("menuitem: Remove Always for npx hyperframes here");
  await page.keyboard.press("ArrowUp");
  await expect.poll(focused).toBe("menuitemradio: Bypass");
  await page.keyboard.press("ArrowDown");
  await expect.poll(focused).toBe("menuitem: Remove Always for npx hyperframes here");
  // The last rule gone, focus goes to the menu's first row.
  await page.keyboard.press("Enter");
  await expect(menu.getByText("No Always rules yet", { exact: true })).toBeVisible();
  await expect.poll(focused).toMatch(/^menuitemradio: .*Claude Code/);
  await page.keyboard.press("ArrowDown");
  await expect.poll(focused).toMatch(/^menuitemradio: .*Codex/);
  await expect(menu).toBeVisible();
  await shootFoot(page, "menu-keyboard-remove-1440");
});

// ---- the first Send, and what Send does with the answer (task 4) ----

/** The first-Send sheet, at either step. */
const sheet = (page: Page): Locator => page.locator(".pop.firstsend");
/** Step 1's radio for a row, by its name ("Claude Code", "Copy a prompt, as now"). */
const whoRadio = (page: Page, name: string): Locator => sheet(page).getByRole("radio", { name: new RegExp(`^${name}`) });
/** Step 1's row (the radio's box and whatever sits beside or under it), by its name. */
const whoRow = (page: Page, name: string): Locator => sheet(page).locator(".fsrow", { has: page.getByRole("radio", { name: new RegExp(`^${name}`) }) });
/** The sheet's primary button, by its words when given. */
const primary = (page: Page, name?: string): Locator => (name ? sheet(page).getByRole("button", { name, exact: true }) : sheet(page).locator(".btn.primary"));
const sentPop = (page: Page): Locator => page.getByRole("dialog", { name: "Sent to agent" });
const toastEl = (page: Page): Locator => page.locator(".toast");

/** The sheet lies inside the window, nothing in it is cut off, it doesn't scroll, and its buttons are on screen. */
async function sheetFits(page: Page): Promise<void> {
  const vp = page.viewportSize()!;
  // Measured once its rows are in (the title shows at once; the rows follow detection).
  await expect(primary(page)).toBeVisible();
  const d = (await sheet(page).boundingBox())!;
  inside(d, { x: 0, y: 0, width: vp.width, height: vp.height });
  expect(d.width).toBeGreaterThan(300);
  expect(await sheet(page).evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  expect(await sheet(page).evaluate((el) => [...el.querySelectorAll("*")].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== "visible").map((e) => e.className))).toEqual([]);
  // The primary button and every row are wholly on screen, inside the sheet.
  for (const el of [primary(page), ...(await sheet(page).locator(".fsopt").all())]) {
    await expect(el).toBeVisible();
    const b = (await el.boundingBox())!;
    expect(b.height).toBeGreaterThan(20);
    inside(b, d);
  }
  // Rows one above the next, none overlapping (read at one moment, so a step changing can't mix two steps' rows).
  const rows = await sheet(page).locator(".fsopt").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ y: r.y, height: r.height })));
  for (let i = 0; i + 1 < rows.length; i++) expect(rows[i].y + rows[i].height).toBeLessThanOrEqual(rows[i + 1].y + 0.5);
}

/** A picture of the sheet (with a little room round it), kept with the test's results, to look at. */
async function shootSheet(page: Page, name: string): Promise<void> {
  const d = (await sheet(page).boundingBox())!;
  const vp = page.viewportSize()!;
  const x = Math.max(0, d.x - 16);
  const y = Math.max(0, d.y - 16);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), clip: { x, y, width: Math.min(vp.width - x, d.width + 32), height: Math.min(vp.height - y, d.height + 32) } });
}

/** The name of whatever has focus: a radio by its label, a button by its words. */
const focusedName = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    if (el instanceof HTMLInputElement) return `radio: ${el.labels?.[0]?.querySelector("b")?.textContent ?? ""}`;
    return `${el.tagName.toLowerCase()}: ${el.getAttribute("aria-label") ?? el.textContent?.trim()}`;
  });

/** Records every write to the clipboard, so a test can say nothing was copied. */
async function watchClipboard(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const writes: string[] = [];
    (window as unknown as { __copied: string[] }).__copied = writes;
    if (navigator.clipboard) navigator.clipboard.writeText = async (t: string) => void writes.push(t);
  });
  return () => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
}

/**
 * Stands in for the browser's notifications, "default" (not yet answered) until asked. Each request records the event
 * being handled when it was made (window.event): "click" or "keydown" inside the press itself, null after an await,
 * when the gesture is gone and Safari and Firefox would ignore it.
 */
async function watchNotifications(page: Page): Promise<() => Promise<(string | null)[]>> {
  await page.addInitScript(() => {
    const asked: (string | null)[] = [];
    (window as unknown as { __notifyAsked: (string | null)[] }).__notifyAsked = asked;
    let permission = "default";
    const Fake = {
      get permission() { return permission; },
      requestPermission() {
        asked.push(window.event ? window.event.type : null);
        permission = "denied";
        return Promise.resolve("denied");
      },
    };
    Object.defineProperty(window, "Notification", { value: Fake, configurable: true, writable: true });
  });
  return () => page.evaluate(() => (window as unknown as { __notifyAsked: (string | null)[] }).__notifyAsked);
}

test("off: Send opens the old dialog", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  await withNote(rushes, false);
  const notifyAsked = await watchNotifications(page);
  await page.goto(rushes.url);
  await videoReady(page);
  await sendBtn(page).click();
  // The first Send asks, and posts nothing until it is answered.
  await expect(sheet(page)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Who should get these notes?" })).toBeVisible();
  await expect(sentPop(page)).toHaveCount(0);
  await expect(whoRadio(page, "Claude Code")).toBeChecked();
  await expect.poll(() => focusedName(page)).toBe("radio: Claude Code");
  await expect(whoRadio(page, "Claude Code").locator("xpath=..")).toContainText("Signed in");
  await expect(whoRadio(page, "Codex")).toBeVisible();
  await expect(primary(page)).toHaveText("Next");
  await sheetFits(page);
  await shootSheet(page, "sheet-who-1440");
  expect(await rushes.api("GET", "/api/batches/latest").catch(() => null)).toBeNull();
  await sheet(page).getByText("Copy a prompt, as now", { exact: true }).click();
  await expect(whoRadio(page, "Copy a prompt, as now")).toBeChecked();
  await expect(primary(page)).toHaveText("Copy a prompt");
  await primary(page).click();
  // Copy skips step 2: today's dialog, exactly as it was.
  await expect(sheet(page)).toHaveCount(0);
  await expect(sentPop(page)).toBeVisible();
  await expect(sentPop(page)).toContainText("picture batch b_1");
  await expect(sentPop(page).getByRole("button", { name: "Copy prompt" })).toBeVisible();
  await expect(sentPop(page).locator(".swhy")).toHaveCount(0);
  expect((await rushes.api("GET", "/api/agent")).status).toMatchObject({ on: false, asked: true });
  expect(await readAgentLog(rushes.agentLog)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(sentPop(page)).toHaveCount(0);
  // Asked once: the next Send goes straight to the dialog.
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Softer cut." });
  await expect(sendBtn(page)).toHaveAccessibleName("Send 1");
  await sendBtn(page).click();
  await expect(sentPop(page)).toContainText("picture batch b_2");
  await expect(sheet(page)).toHaveCount(0);
  // Copying a prompt never asks to notify.
  expect(await notifyAsked()).toEqual([]);
});

test("first Send to Claude Code", async ({ page, startWithAgent }) => {
  // A turn long enough to see the note with the agent (a finished turn gives back the notes it left untouched, M3).
  const rushes = await startWithAgent({ turns: [[{ sleep: 4000 }, { stop: "end_turn" }]] });
  await withNote(rushes, false);
  await page.goto(rushes.url);
  await videoReady(page);
  await sendBtn(page).click();
  await expect(whoRadio(page, "Claude Code")).toBeChecked();
  await primary(page, "Next").click();
  // Step 2, one question.
  const may = page.getByRole("dialog", { name: "What may Claude Code do without asking?" });
  await expect(may).toBeVisible();
  await expect(may.getByRole("radio", { name: "Accept edits" })).toBeChecked();
  await expect(may.getByRole("radio", { name: "Manual" })).not.toBeChecked();
  await expect.poll(() => focusedName(page)).toBe("radio: Accept edits");
  await expect(may.getByText("Rushes never sees a password or key. The agent uses your own sign-in.", { exact: true })).toBeVisible();
  await expect(primary(page)).toHaveText("Send to Claude Code");
  await sheetFits(page);
  await shootSheet(page, "sheet-may-1440");
  // Back goes to step 1, as it was left.
  await may.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("dialog", { name: "Who should get these notes?" })).toBeVisible();
  await expect(whoRadio(page, "Claude Code")).toBeChecked();
  await primary(page, "Next").click();
  await primary(page, "Send to Claude Code").click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(toastEl(page)).toHaveText(/^(Sent to|Starting) Claude Code$/);
  await expect(sentPop(page)).toHaveCount(0);
  expect((await rushes.api("GET", "/api/agent")).status).toMatchObject({ on: true, agent: "claude", asked: true, permissions: "project-edits" });
  // The note is with the agent, and the agent was handed the batch: its badge names the agent, on screen.
  await expect(panel(page).locator(".note .chk")).toHaveAccessibleName("With your agent · Mark done");
  await expect(panel(page).locator(".note .chk")).toBeVisible();
  const badge = panel(page).locator(".note .nbadge");
  await expect(badge).toHaveText("With Claude Code");
  await expect(badge).toBeVisible();
  inside((await badge.boundingBox())!, (await panel(page).locator(".note").boundingBox())!);
  await expect.poll(async () => (await readAgentLog(rushes.agentLog)).some((m) => m.method === "session/prompt"), { timeout: 10_000 }).toBe(true);
  await expect(row(page).getByRole("button", { name: "Send to AI · Claude Code" })).toBeVisible();
});

test("with the notes handed over, the brief's line is left to copy and the dialog says the agent doesn't have it (I4)", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [[{ sleep: 3000 }, { stop: "end_turn" }]] });
  await readyToSend(rushes);
  await rushes.writeFiles([{ path: "brief.md", text: "# Brief: Launch\n\nStatus: draft\n\n## Purpose\nShow the product.\n" }]);
  await page.goto(rushes.url);
  await videoReady(page);
  await openPlanPage(page, "Brief");
  await expect(page.getByRole("heading", { name: "Brief" })).toBeVisible();
  await sendButton(page).click();
  await expect(toastEl(page)).toHaveText(/^(Sent to|Starting) Claude Code$/);
  const dialog = sentDialog(page);
  await expect(dialog).toContainText("Message for your agent");
  const lead = dialog.locator(".slead");
  await expect(lead).toHaveText("Claude Code has the notes. These lines aren't sent to it yet.");
  await expect(lead).toBeVisible();
  // Above the lines it speaks for, inside the dialog.
  expect((await lead.boundingBox())!.y + (await lead.boundingBox())!.height).toBeLessThanOrEqual((await dialog.locator("pre").boundingBox())!.y + 0.5);
  inside((await lead.boundingBox())!, (await dialog.boundingBox())!);
  await expect(dialog.locator("pre")).toContainText("the brief is still a draft");
  await page.screenshot({ path: test.info().outputPath("plan-lead-1440.png"), clip: { x: 900, y: 40, width: 540, height: 420 } });
  // The notes went; the server was never sent the brief's line.
  await expect.poll(async () => (await readAgentLog(rushes.agentLog)).some((m) => m.method === "session/prompt"), { timeout: 10_000 }).toBe(true);
  const sentText = JSON.stringify((await readAgentLog(rushes.agentLog)).filter((m) => m.method === "session/prompt"));
  expect(sentText).not.toContain("the brief is still a draft");
});

test("a start failure recalls and does not copy", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ exitOnStart: 3 });
  await withNote(rushes);
  const copied = await watchClipboard(page);
  await page.goto(rushes.url);
  await videoReady(page);
  await sendBtn(page).click();
  await expect(toastEl(page)).toHaveText(/^Claude Code couldn't start: .+ The notes are back in to do\.$/, { timeout: 10_000 });
  // The agent is named once.
  await expect(toastEl(page)).not.toContainText("could not start");
  await expect(toastEl(page)).toBeVisible();
  await expect(sentPop(page)).toHaveCount(0);
  await expect(sheet(page)).toHaveCount(0);
  const { notes } = await rushes.api("GET", "/api/notes");
  expect(notes.map((n: { status: string }) => n.status)).toEqual(["todo"]);
  await expect(sendBtn(page)).toHaveAccessibleName("Send 1");
  expect(await copied()).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("recalled-toast-1440.png"), clip: { x: 320, y: 0, width: 800, height: 120 } });
  // It stays long enough to read (6 s), not the usual glance.
  await page.waitForTimeout(3500);
  await expect(toastEl(page)).toBeVisible();
});

/** The project's own agent.json, written as a project folder from someone else could arrive with it. */
const forgeAgentJson = (rushes: AgentRushes) =>
  writeFile(join(rushes.root, ".rushes", "agent.json"), JSON.stringify({ schema: 1, rev: 1, on: true, agent: "claude", session: null, asked: true }));

/** The user's own answer to the first-Send sheet, in their rules file (I1), as the setup route writes it: the agent they
 *  turned on, or none (Copy a prompt). */
async function userSetUp(rushes: AgentRushes, agent: "claude" | null = "claude"): Promise<void> {
  const path = rulesPath(rushes.root, rushes.configDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ permissions: "project-edits", always: [], setUp: true, agent }), { mode: 0o600 });
}

test("a prepared project naming an agent shows Set up Send to AI, with no switch, until the sheet is answered (consent fix)", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  await rushes.addCut("first cut");
  await writeFile(join(rushes.root, ".rushes", "agent.json"), JSON.stringify({ schema: 1, rev: 1, on: true, agent: "codex", session: null }));
  expect((await rushes.api("GET", "/api/agent")).status).toMatchObject({ on: false, agent: "codex", asked: false });
  await page.goto(rushes.url);
  await videoReady(page);
  const setUp = row(page).getByRole("button", { name: "Set up Send to AI" });
  await expect(setUp).toBeVisible();
  await expect(row(page)).not.toContainText("Codex");
  await expect(toggle(page)).toHaveCount(0);
  await expect(setUp).not.toHaveAttribute("aria-haspopup", "menu");
  await footFits(page);
  await shootFoot(page, "prepared-setup-1440");
  // It opens the sheet, which asks who and then what it may do; no menu.
  await setUp.click();
  await expect(page.getByRole("dialog", { name: "Who should get these notes?" })).toBeVisible();
  await expect(agentMenu(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  // Nothing was set up on the way.
  expect((await rushes.api("GET", "/api/agent")).status).toMatchObject({ on: false, asked: false });
});

test("after Copy a prompt, a project whose agent.json says on shows the switch off, and Send copies a prompt (consent fix)", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [[{ stop: "end_turn" }]] });
  await rushes.addCut("first cut");
  // The user answered the sheet with Copy a prompt; then something wrote the project's switch on.
  await userSetUp(rushes, null);
  await forgeAgentJson(rushes);
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 0.5, text: "Hold the end card." });
  expect((await rushes.api("GET", "/api/agent")).status).toMatchObject({ on: false, agent: "claude", asked: true });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
  await expect(who(page)).toHaveText("Copies a prompt for your own chat");
  await footFits(page);
  await shootFoot(page, "forged-on-reads-off-1440");
  await sendBtn(page).click();
  // Today's dialog, exactly: no sheet, no reason line, nothing handed over.
  await expect(sentPop(page)).toBeVisible();
  await expect(sentPop(page).getByRole("button", { name: "Copy prompt" })).toBeVisible();
  await expect(sentPop(page).locator(".swhy")).toHaveCount(0);
  await expect(sheet(page)).toHaveCount(0);
  await expect(toastEl(page)).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await readAgentLog(rushes.agentLog)).toEqual([]);
});

test("a project that arrives set up asks first, and hands nothing over until the user sets it up (I1)", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [[{ stop: "end_turn" }]] });
  await rushes.addCut("first cut");
  await forgeAgentJson(rushes);
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 0.5, text: "Hold the end card." });
  // The project's switch is not the user's: it reads off.
  expect((await rushes.api("GET", "/api/agent")).status).toMatchObject({ on: false, agent: "claude", asked: false });
  await page.goto(rushes.url);
  await videoReady(page);
  // Send asks who gets the notes, whatever the project's file says, and posts nothing.
  await sendBtn(page).click();
  await expect(page.getByRole("dialog", { name: "Who should get these notes?" })).toBeVisible();
  await expect(sentPop(page)).toHaveCount(0);
  expect(await rushes.api("GET", "/api/batches/latest").catch(() => null)).toBeNull();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  // Sent another way (the API), the batch is filed but nothing is handed over and no adapter starts.
  const { agent } = await rushes.api("POST", "/api/batches", {});
  expect(agent).toEqual({ handedTo: null, why: "Send to AI is not set up" });
  await page.waitForTimeout(500);
  expect(await readAgentLog(rushes.agentLog)).toEqual([]);
  // The user sets it up through the sheet: their own file holds the answer, and the next Send reaches the agent.
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Softer cut." });
  await expect(sendBtn(page)).toHaveAccessibleName("Send 1");
  await sendBtn(page).click();
  await primary(page, "Next").click();
  await primary(page, "Send to Claude Code").click();
  await expect(toastEl(page)).toHaveText(/^(Sent to|Starting) Claude Code$/);
  expect(JSON.parse(await readFile(rulesPath(rushes.root, rushes.configDir), "utf8"))).toMatchObject({ setUp: true, agent: "claude" });
  await expect.poll(async () => (await readAgentLog(rushes.agentLog)).some((m) => m.method === "session/prompt"), { timeout: 10_000 }).toBe(true);
});

test("not signed in falls back to the dialog with Set up", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] }, { agents: [{ id: "claude", installed: true, signedIn: false }, { id: "codex", installed: true, signedIn: true }] });
  await rushes.addCut("first cut");
  // Set up while Claude Code was signed in (the setup route refuses it now), then signed out.
  await forgeAgentJson(rushes);
  await userSetUp(rushes);
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 0.5, text: "Hold the end card." });
  const copied = await watchClipboard(page);
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await sendBtn(page).click();
  // Nothing was started: today's dialog, with why above the prompt.
  await expect(sentPop(page)).toBeVisible();
  const why = sentPop(page).locator(".swhy");
  await expect(why).toContainText("Claude Code is not signed in");
  await expect(why).toBeVisible();
  await expect(sentPop(page).getByRole("button", { name: "Copy prompt" })).toBeVisible();
  expect((await why.boundingBox())!.y + (await why.boundingBox())!.height).toBeLessThanOrEqual((await sentPop(page).locator("pre").boundingBox())!.y + 0.5);
  inside((await sentPop(page).boundingBox())!, { x: 0, y: 0, width: 1440, height: 900 });
  await page.screenshot({ path: test.info().outputPath("dialog-why-1440.png"), clip: { x: 900, y: 40, width: 540, height: 420 } });
  expect(await copied()).toEqual([]);
  // Set up opens the sheet: Claude Code says it isn't signed in, and offers Terminal.
  await why.getByRole("button", { name: "Set up" }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(sentPop(page)).toHaveCount(0);
  const claudeRow = whoRow(page, "Claude Code");
  await expect(claudeRow).toContainText("Not signed in");
  await expect(claudeRow.getByRole("button", { name: "Sign in in Terminal" })).toBeVisible();
  await expect(whoRadio(page, "Codex")).toBeChecked();
  await sheetFits(page);
  await shootSheet(page, "sheet-not-signed-in-1440");
  await whoRadio(page, "Claude Code").check();
  await primary(page, "Next").click();
  const alert = claudeRow.getByRole("alert");
  await expect(alert).toHaveText("Claude Code is not signed in. Choose Sign in in Terminal, then try again.");
  await expect(alert).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Who should get these notes?" })).toBeVisible();
  await sheetFits(page);
  await shootSheet(page, "sheet-not-signed-in-next-1440");
  await page.setViewportSize({ width: 900, height: 700 });
  await sheetFits(page);
  await shootSheet(page, "sheet-not-signed-in-900");
  // Cancel goes back to the dialog, with its prompt still there to copy.
  await sheet(page).getByRole("button", { name: "Cancel" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(sentPop(page).getByRole("button", { name: "Copy prompt" })).toBeVisible();
});

test("signed out, Send's dialog and its Set up end with the filed notes at the agent, and no note names it before then (I3)", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [[{ sleep: 4000 }, { stop: "end_turn" }]] });
  await rushes.addCut("first cut");
  // Set up while Claude Code was signed in, then signed out.
  await rushes.api("POST", "/api/agent/setup", { on: true, agent: "claude" });
  await rushes.setAgents([{ id: "claude", installed: true, signedIn: false }, { id: "codex", installed: true, signedIn: true }]);
  const { note } = await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 0.5, text: "Hold the end card." });
  await page.goto(rushes.url);
  await videoReady(page);
  await sendBtn(page).click();
  const why = sentPop(page).locator(".swhy");
  await expect(why).toContainText("Claude Code is not signed in");
  // The note is filed but no agent has it: it doesn't claim one, and has no Answer box.
  const c = card(page, note.id);
  await expect(badgeOf(c)).toHaveText("With your agent");
  await expect(replyBox(c)).toHaveCount(0);
  await why.getByRole("button", { name: "Set up" }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(whoRow(page, "Claude Code")).toContainText("Not signed in");
  // The user signs in in Terminal (here: the fake is signed in), then goes on with Claude Code.
  await rushes.setAgents([{ id: "claude", installed: true, signedIn: true }, { id: "codex", installed: true, signedIn: true }]);
  await whoRadio(page, "Claude Code").check();
  await primary(page, "Next").click();
  // The filed notes will go to it: the button says so.
  await expect(primary(page)).toHaveText("Send to Claude Code");
  await primary(page, "Send to Claude Code").click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(toastEl(page)).toHaveText(/^(Sent to|Starting) Claude Code$/);
  // The dialog is done with: the notes are with the agent now.
  await expect(sentPop(page)).toHaveCount(0);
  await expect.poll(async () => (await prompts(rushes)).length, { timeout: 10_000 }).toBe(1);
  expect((await prompts(rushes))[0]).toContain("b_1");
  await expect(badgeOf(c)).toHaveText(/^(With Claude Code|Working on it)$/);
  await expect(replyBox(c)).toHaveAttribute("placeholder", "Answer Claude Code");
});

test("an agent that isn't installed can't be picked; keys move, Escape closes and asks nothing", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] }, { agents: [{ id: "claude", installed: false, signedIn: false }, { id: "codex", installed: true, signedIn: true }] });
  await withNote(rushes, false);
  await page.goto(rushes.url);
  await videoReady(page);
  await sendBtn(page).focus();
  await page.keyboard.press("Enter");
  await expect(sheet(page)).toBeVisible();
  await expect(whoRadio(page, "Claude Code")).toBeDisabled();
  await expect(whoRow(page, "Claude Code")).toContainText("Not installed");
  await expect(whoRadio(page, "Codex")).toBeChecked();
  await expect.poll(() => focusedName(page)).toBe("radio: Codex");
  await sheetFits(page);
  await shootSheet(page, "sheet-not-installed-1440");
  // The arrows move through the rows that can be picked; Enter goes on.
  await page.keyboard.press("ArrowDown");
  await expect(whoRadio(page, "Copy a prompt, as now")).toBeChecked();
  await expect(primary(page)).toHaveText("Copy a prompt");
  await page.keyboard.press("ArrowUp");
  await expect(whoRadio(page, "Codex")).toBeChecked();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "What may Codex do without asking?" })).toBeVisible();
  await expect.poll(() => focusedName(page)).toBe("radio: Accept edits");
  await page.keyboard.press("ArrowUp");
  await expect(sheet(page).getByRole("radio", { name: "Manual" })).toBeChecked();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.getByRole("button", { name: "Show the notes panel · \\" }).click().catch(() => undefined);
  await expect(sheet(page)).toBeVisible();
  await sheetFits(page);
  await shootSheet(page, "sheet-may-900");
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  // Nothing was set up or sent: the next Send asks again.
  expect((await rushes.api("GET", "/api/agent")).status).toMatchObject({ on: false, agent: null, asked: false });
  expect(await rushes.api("GET", "/api/batches/latest").catch(() => null)).toBeNull();
});

test("the sheet's step 1 fits at 900 px", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  await withNote(rushes, false);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(rushes.url);
  await videoReady(page);
  await page.getByRole("button", { name: "Show the notes panel · \\" }).click();
  await sendBtn(page).click();
  await expect(sheet(page)).toBeVisible();
  await sheetFits(page);
  await shootSheet(page, "sheet-who-900");
  await primary(page, "Next").click();
  await expect(page.getByRole("dialog", { name: "What may Claude Code do without asking?" })).toBeVisible();
  await sheetFits(page);
  await shootSheet(page, "sheet-may-claude-900");
});

test("Send to <A> asks to notify in the key press itself, and saves Manual", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [[{ sleep: 4000 }, { stop: "end_turn" }]] });
  await withNote(rushes, false);
  const notifyAsked = await watchNotifications(page);
  await page.goto(rushes.url);
  await videoReady(page);
  await sendBtn(page).click();
  await primary(page, "Next").click();
  const ask = sheet(page).getByRole("radio", { name: "Manual" });
  await ask.check();
  await expect(ask).toBeChecked();
  await ask.focus();
  // Enter on the row confirms, as Send to Claude Code does.
  await page.keyboard.press("Enter");
  await expect(sheet(page)).toHaveCount(0);
  await expect(toastEl(page)).toHaveText(/^(Sent to|Starting) Claude Code$/);
  // Asked once, while the key press was being handled (before the setup request was awaited).
  expect(await notifyAsked()).toEqual(["keydown"]);
  // What was picked is what is kept: the user's own rules file, read back through the status.
  expect((await rushes.api("GET", "/api/agent")).status).toMatchObject({ on: true, agent: "claude", asked: true, permissions: "ask-all" });
  await expect(who(page)).toHaveText(/^Asks before everything/);
});

test("Escape while Send to <A> is on its way doesn't cancel it into a send: the sheet finishes what it started", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [[{ sleep: 4000 }, { stop: "end_turn" }]] });
  await withNote(rushes, false);
  const notifyAsked = await watchNotifications(page);
  // Setup's answer is held until the test lets it go.
  let release!: () => void;
  const held = new Promise<void>((ok) => (release = ok));
  await page.route("**/api/agent/setup", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(rushes.url);
  await videoReady(page);
  await sendBtn(page).click();
  await primary(page, "Next").click();
  await primary(page, "Send to Claude Code").click();
  // Asked in the click itself, while setup is still on its way.
  await expect.poll(notifyAsked).toEqual(["click"]);
  // On its way: the buttons are off, and Escape neither closes the sheet nor lets the dialog under it go.
  for (const name of ["Send to Claude Code", "Cancel", "Back"]) await expect(sheet(page).getByRole("button", { name, exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await expect(sheet(page)).toBeVisible();
  // Nothing has gone to the agent yet.
  expect(await rushes.api("GET", "/api/batches/latest").catch(() => null)).toBeNull();
  expect((await readAgentLog(rushes.agentLog)).some((m) => m.method === "session/prompt")).toBe(false);
  release();
  await expect(sheet(page)).toHaveCount(0);
  await expect(toastEl(page)).toHaveText(/^(Sent to|Starting) Claude Code$/);
  // One batch, sent once.
  const { batch } = await rushes.api("GET", "/api/batches/latest");
  expect(batch.id).toBe("b_1");
  await expect.poll(async () => (await readAgentLog(rushes.agentLog)).filter((m) => m.method === "session/prompt").length, { timeout: 10_000 }).toBe(1);
  expect(await notifyAsked()).toEqual(["click"]);
});

test("Send asks to notify in its own click while Send to AI is on, once", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [[{ stop: "end_turn" }], [{ stop: "end_turn" }]] });
  await withNote(rushes);
  const notifyAsked = await watchNotifications(page);
  await page.goto(rushes.url);
  await videoReady(page);
  await sendBtn(page).click();
  await expect(toastEl(page)).toHaveText(/^(Sent to|Starting) Claude Code$/);
  expect(await notifyAsked()).toEqual(["click"]);
  // The first turn ends having touched nothing, so its note goes back to to do (M3). Wait for the server to say so
  // before adding the next note, or the count races the recall.
  const notesNow = async () => (await rushes.api("GET", "/api/notes")).notes as { status: string; batch: string | null }[];
  await expect.poll(async () => (await notesNow()).map((n) => [n.status, n.batch]), { timeout: 10_000 }).toEqual([["todo", null]]);
  // The browser has been asked: a later Send doesn't ask again.
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Softer cut." });
  await expect(sendBtn(page)).toHaveAccessibleName("Send 2", { timeout: 10_000 });
  await sendBtn(page).click();
  await expect.poll(async () => (await readAgentLog(rushes.agentLog)).filter((m) => m.method === "session/prompt").length, { timeout: 10_000 }).toBe(2);
  expect(await notifyAsked()).toEqual(["click"]);
});

// ---- the ask cards in the notes panel, and the notification for an ask (task 5) ----

const FFPROBE = { toolCallId: "t1", kind: "execute", title: "Run ffprobe", rawInput: { command: "ffprobe -v error renders/a.mp4" } };
const CHAINED = { toolCallId: "t2", kind: "execute", title: "Build and clean up", rawInput: { command: "npm run build && rm -rf out" } };
const HYPERFRAMES = { toolCallId: "t3", kind: "execute", title: "Render the film", rawInput: { command: "npx hyperframes render out/film.mp4" } };

const askCards = (page: Page): Locator => panel(page).locator(".askcard");
/** A card's buttons, by their words, in order. */
const cardButtons = (card: Locator): Promise<string[]> => card.getByRole("button").allTextContents();

/**
 * Presses a card's button once the card takes presses: a card that has just arrived or moved (one above it answered)
 * drops them for a moment, so a double-click can't answer the card that slides into place. The card says when it's
 * ready (data-armed), so this waits on that, not on a clock.
 */
async function answerCard(card: Locator, name: string): Promise<void> {
  await expect(card).toHaveAttribute("data-armed", "true");
  await card.getByRole("button", { name, exact: true }).click();
}

/** Every answer the desk posts to an ask: its id and the body, in order. */
function watchAnswers(page: Page): { id: string; body: unknown }[] {
  const posted: { id: string; body: unknown }[] = [];
  page.on("request", (r) => {
    const m = /\/api\/agent\/permission\/([^/?]+)$/.exec(new URL(r.url()).pathname);
    if (m && r.method() === "POST") posted.push({ id: decodeURIComponent(m[1]), body: r.postDataJSON() });
  });
  return posted;
}

/** What the fake recorded as each permission's answer, by its `record` name. */
async function recorded(rushes: AgentRushes): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const m of await readAgentLog(rushes.agentLog)) if (typeof m.recorded === "string") out[m.recorded] = m.outcome;
  return out;
}

/**
 * The card is on screen in full: inside the notes panel, under the tab row and above the tab's own content, its command
 * in mono on its own line, wrapped (never cut or scrolled) inside the card, its buttons inside it, nothing spilling.
 */
async function cardFits(page: Page, card: Locator): Promise<void> {
  await expect(card).toBeVisible();
  const c = (await card.boundingBox())!;
  const p = (await panel(page).boundingBox())!;
  inside(c, p);
  const vp = page.viewportSize()!;
  inside(c, { x: 0, y: 0, width: vp.width, height: vp.height });
  const tabs = (await panel(page).locator(".ntabs").boundingBox())!;
  expect(c.y).toBeGreaterThanOrEqual(tabs.y + tabs.height - 0.5);
  const body = (await panel(page).locator(".ntabpanel:not([hidden])").boundingBox())!;
  expect(c.y + c.height).toBeLessThanOrEqual(body.y + 0.5);
  expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const cmd = card.locator(".askcmd");
  if (await cmd.count()) {
    const b = (await cmd.boundingBox())!;
    inside(b, c);
    expect(b.width).toBeGreaterThan(c.width / 2);
    expect(await cmd.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Geist Mono/);
    expect(await cmd.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    // On its own line: nothing beside it.
    const title = (await card.locator(".asktitle").boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(title.y + title.height - 0.5);
  }
  for (const btn of await card.getByRole("button").all()) {
    const b = (await btn.boundingBox())!;
    inside(b, c);
    expect(b.height).toBeGreaterThanOrEqual(24);
  }
  // No word cut off or pushed out of its box.
  expect(await card.evaluate((el) => [el, ...el.querySelectorAll("*")].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== "visible").map((e) => e.className))).toEqual([]);
}

/** A picture of the notes panel's top, from the tab row to under the last card, kept with the test's results. */
async function shootAsks(page: Page, name: string): Promise<void> {
  const p = (await panel(page).boundingBox())!;
  const last = (await askCards(page).last().boundingBox())!;
  const y = Math.max(0, p.y - 4);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), clip: { x: Math.max(0, p.x - 4), y, width: p.width + 8, height: last.y + last.height + 16 - y } });
}

/** The colour a token resolves to, as the browser writes colours, for comparing with a computed style. */
const tokenColour = (page: Page, token: string) =>
  page.evaluate((t) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${t})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, token);

test("an ask whose title is only its command shows Run a command, and the command once (Task 10, 5)", async ({ page, startWithAgent }) => {
  const command = "for f in renders/*.mp4; do ffprobe -v error \"$f\"; done";
  const toolCall = { toolCallId: "t9", kind: "execute", title: ` ${command.replace("; do", ";  do")} `, rawInput: { command } };
  const rushes = await startWithAgent({ turns: [[{ permission: { toolCall }, record: "loop" }, { stop: "end_turn" }]] });
  await readyToSend(rushes);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.api("POST", "/api/batches", {});
  const card = askCards(page);
  await expect(card).toHaveCount(1);
  await expect(card.locator(".asktitle")).toHaveText("Run a command");
  await expect(card.locator(".askcmd")).toHaveText(command);
  expect((await card.textContent())!.split("ffprobe").length - 1).toBe(1);
  await expect(card).toHaveAccessibleName("Claude Code wants to: Run a command");
  await cardFits(page, card);
  await page.screenshot({ path: test.info().outputPath("ask-run-a-command-1440.png"), clip: { ...(await card.boundingBox())! } });
  await rushes.api("POST", "/api/agent/permission/ask_1", { choice: "no" });
});

test("an ask shows and Allow once lets the run go on", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [[{ permission: { toolCall: FFPROBE }, record: "ffprobe" }, { stop: "end_turn" }]] });
  await readyToSend(rushes);
  const notifyAsked = await watchNotifications(page);
  const answers = watchAnswers(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(askCards(page)).toHaveCount(0);
  await rushes.api("POST", "/api/batches", {});

  const card = askCards(page);
  await expect(card).toHaveCount(1);
  await expect(card.locator(".asklead")).toHaveText("Claude Code wants to:");
  await expect(card.locator(".asktitle")).toHaveText("Run ffprobe");
  await expect(card.locator(".askcmd")).toHaveText("ffprobe -v error renders/a.mp4");
  // The server offers no Always for a command with a flag where its subcommand would be, and the card shows none.
  const { status } = await rushes.api("GET", "/api/agent");
  expect(status.asks).toMatchObject([{ id: "ask_1", title: "Run ffprobe", command: "ffprobe -v error renders/a.mp4", always: "" }]);
  expect(await cardButtons(card)).toEqual(["Allow once", "No"]);
  // Its left rule is the to-do colour.
  expect(await card.evaluate((el) => getComputedStyle(el).borderLeftColor)).toBe(await tokenColour(page, "--todo"));
  await cardFits(page, card);
  await shootAsks(page, "ask-once-1440");

  // The chip waits on you, in the to-do look: its dot on screen in the to-do colour.
  await expect(chip(page)).toHaveText("Claude Code is waiting for you");
  await expect(page.locator("header.top .agentchip")).toHaveClass(/\btodo\b/);
  await chipFits(page);
  const dot = chip(page).locator(".adot");
  const [d, c] = [(await dot.boundingBox())!, (await chip(page).boundingBox())!];
  expect(d.width).toBeGreaterThanOrEqual(7);
  inside(d, c);
  expect(await dot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await tokenColour(page, "--todo"));
  await shoot(page, "chip-waiting-1440");

  await page.setViewportSize({ width: 900, height: 900 });
  await page.getByRole("button", { name: "Show the notes panel · \\" }).click();
  await cardFits(page, card);
  await shootAsks(page, "ask-once-900");
  await expect(chip(page)).toBeVisible();
  await chipFits(page);
  await shoot(page, "chip-waiting-900");

  // While the answer is on its way, every button is disabled.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/agent/permission/**", async (route) => {
    await held;
    await route.continue();
  });
  await answerCard(card, "Allow once");
  for (const b of await card.getByRole("button").all()) await expect(b).toBeDisabled();
  release();
  await expect(askCards(page)).toHaveCount(0);
  await expect(chip(page)).toHaveText("Claude Code finished", { timeout: 10_000 });

  // The server got exactly the button pressed, and the agent was told allow once; no Always rule was kept.
  expect(answers).toEqual([{ id: "ask_1", body: { choice: "once" } }]);
  await expect.poll(() => recorded(rushes)).toEqual({ ffprobe: { outcome: "selected", optionId: "allow-once" } });
  expect((await rushes.api("GET", "/api/agent")).status.always).toEqual([]);
  // An ask never asks the browser for leave to notify.
  expect(await notifyAsked()).toEqual([]);
});

test("two asks stack and answer separately", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({
    turns: [[{ permissions: [{ toolCall: CHAINED, record: "chained" }, { toolCall: HYPERFRAMES, record: "hyperframes" }] }, { stop: "end_turn" }]],
  });
  await readyToSend(rushes);
  const answers = watchAnswers(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.api("POST", "/api/batches", {});

  await expect(askCards(page)).toHaveCount(2);
  const [first, second] = [askCards(page).nth(0), askCards(page).nth(1)];
  // The two arrive together and the server holds them in the order it took them in (each reads the rules first, so
  // either may come first): the cards are in the server's order, oldest first.
  type Ask = { id: string; title: string; command: string; always: string };
  const asks: Ask[] = (await rushes.api("GET", "/api/agent")).status.asks;
  expect(asks.map((a) => a.id)).toEqual(["ask_1", "ask_2"]);
  const byTitle = (t: string) => asks.find((x) => x.title === t)!;
  // Always only where the server offers one: never for a chained command.
  expect(byTitle("Build and clean up")).toMatchObject({ command: "npm run build && rm -rf out", always: "" });
  expect(byTitle("Render the film")).toMatchObject({ command: "npx hyperframes render out/film.mp4", always: "Always for npx hyperframes here" });
  const buttons = (a: Ask) => (a.always ? ["Allow once", a.always, "No"] : ["Allow once", "No"]);
  for (const [card, ask] of [[first, asks[0]], [second, asks[1]]] as const) {
    await expect(card.locator(".asktitle")).toHaveText(ask.title);
    await expect(card.locator(".askcmd")).toHaveText(ask.command);
    expect(await cardButtons(card)).toEqual(buttons(ask));
  }
  // One above the other.
  const [a, b] = [(await first.boundingBox())!, (await second.boundingBox())!];
  expect(a.y + a.height).toBeLessThanOrEqual(b.y);
  await cardFits(page, first);
  await cardFits(page, second);
  await shootAsks(page, "asks-two-1440");
  // On every tab: Activity shows them too, above its list.
  await panel(page).getByRole("tab", { name: /^Activity/ }).click();
  await expect(page.getByRole("tabpanel", { name: "Activity" })).toBeVisible();
  await expect(askCards(page)).toHaveCount(2);
  await cardFits(page, second);
  await shootAsks(page, "asks-two-activity-1440");
  await panel(page).getByRole("tab", { name: /^Notes/ }).click();

  // The chained command gets No, the other Always; the first card is answered first, and the second stays until its own
  // answer. Always tells the agent allow once, and Rushes keeps the rule itself.
  const choiceFor = (x: Ask) => (x.always ? { choice: "always", button: x.always, record: "hyperframes", option: "allow-once" } : { choice: "no", button: "No", record: "chained", option: "reject-once" });
  const [c1, c2] = [choiceFor(asks[0]), choiceFor(asks[1])];
  expect(new Set([c1.choice, c2.choice])).toEqual(new Set(["always", "no"]));
  await answerCard(first, c1.button);
  await expect(askCards(page)).toHaveCount(1);
  await expect(askCards(page).locator(".asktitle")).toHaveText(asks[1].title);
  await expect.poll(() => recorded(rushes)).toEqual({ [c1.record]: { outcome: "selected", optionId: c1.option } });
  await answerCard(askCards(page), c2.button);
  await expect(askCards(page)).toHaveCount(0);
  await expect.poll(() => recorded(rushes)).toEqual({ chained: { outcome: "selected", optionId: "reject-once" }, hyperframes: { outcome: "selected", optionId: "allow-once" } });
  expect(answers).toEqual([{ id: "ask_1", body: { choice: c1.choice } }, { id: "ask_2", body: { choice: c2.choice } }]);
  const rule = { kind: "execute", command: "npx hyperframes" };
  // The agent is told first and Rushes then writes the rule to the user's file, so the rule shows up a moment after the
  // agent has its answer: wait for it, as the card does, rather than reading it at once.
  await expect.poll(async () => (await rushes.api("GET", "/api/agent")).status.always).toEqual([rule]);
  await expect.poll(async () => JSON.parse(await readFile(rulesPath(rushes.root, rushes.configDir), "utf8")).always).toEqual([rule]);
  await expect(chip(page)).toHaveText("Claude Code finished", { timeout: 10_000 });
});

test("card fits at 900 px", async ({ page, startWithAgent }) => {
  const long =
    "ffmpeg -hide_banner -i renders/the-long-film-name-for-the-festival-cut-v12.mp4 -vf scale=1920:1080:flags=lanczos,format=yuv420p " +
    "-c:v libx264 -crf 18 -preset slow -c:a aac -b:a 320k renders/out/the-long-film-name-for-the-festival-cut-v12-1080p-final-final.mp4 " +
    "renders/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z/0123456789abcdefghijklmnopqrstuvwxyz0123456789.mp4";
  const rushes = await startWithAgent({ turns: [[{ permission: { toolCall: { toolCallId: "t9", kind: "execute", title: "Make the 1080p file", rawInput: { command: long } } } }, { stop: "end_turn" }]] });
  await readyToSend(rushes);
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(rushes.url);
  await videoReady(page);
  await page.getByRole("button", { name: "Show the notes panel · \\" }).click();
  await rushes.api("POST", "/api/batches", {});
  const card = askCards(page);
  await expect(card).toHaveCount(1);
  // The whole command, never cut short: wrapped over several lines inside the card.
  await expect(card.locator(".askcmd")).toHaveText(long);
  expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const lines = await card.locator(".askcmd").evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  expect(lines).toBeGreaterThanOrEqual(4);
  await cardFits(page, card);
  await shootAsks(page, "ask-long-900");
  await page.setViewportSize({ width: 1440, height: 900 });
  await cardFits(page, card);
  await shootAsks(page, "ask-long-1440");
});

/**
 * Stands in for the browser's notifications (granted) and for whether the page is hidden and has focus, so a test can
 * put the desk out of sight either way. Returns what was shown, and setters for hidden and focus.
 */
async function stubNotices(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __shown: { title: string; body: string }[]; __asked: number; __setHidden(h: boolean): void; __setFocused(f: boolean): void };
    w.__shown = [];
    w.__asked = 0;
    let hidden = false;
    let focused = true;
    w.__setHidden = (h) => void (hidden = h);
    w.__setFocused = (f) => void (focused = f);
    Object.defineProperty(Document.prototype, "hidden", { get: () => hidden, configurable: true });
    Object.defineProperty(Document.prototype, "visibilityState", { get: () => (hidden ? "hidden" : "visible"), configurable: true });
    Document.prototype.hasFocus = () => focused;
    class Fake {
      static permission = "granted";
      static requestPermission() {
        w.__asked++;
        return Promise.resolve("granted");
      }
      onclick: (() => void) | null = null;
      constructor(title: string, opts: { body: string }) {
        w.__shown.push({ title, body: opts.body });
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", { value: Fake, configurable: true, writable: true });
  });
  return {
    shown: () => page.evaluate(() => (window as unknown as { __shown: unknown[] }).__shown),
    setHidden: (h: boolean) => page.evaluate((x) => (window as unknown as { __setHidden(h: boolean): void }).__setHidden(x), h),
    setFocused: (f: boolean) => page.evaluate((x) => (window as unknown as { __setFocused(f: boolean): void }).__setFocused(x), f),
  };
}

test("an ask notifies while the page is hidden, once, and so does a question; neither asks for leave", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({
    turns: [[{ permission: { toolCall: FFPROBE }, record: "a" }, { permission: { toolCall: HYPERFRAMES }, record: "b" }, { sleep: 2500 }, { stop: "end_turn" }]],
  });
  const id = await readyToSend(rushes);
  const { shown, setHidden } = await stubNotices(page);
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.api("POST", "/api/batches", {});
  // The first ask arrives while the page is in view: the card says it, no notification.
  await expect(askCards(page)).toHaveCount(1);
  await page.waitForTimeout(300);
  expect(await shown()).toEqual([]);
  // Hidden, the next ask notifies, once, however many statuses follow.
  await setHidden(true);
  await rushes.api("POST", "/api/agent/permission/ask_1", { choice: "once" });
  await expect.poll(shown).toEqual([{ title: "Rushes", body: "Claude Code is waiting for you" }]);
  await rushes.api("POST", "/api/agent/permission/ask_2", { choice: "once" });
  // The agent asks on the note and the turn ends: a question.
  await rushes.api("POST", "/api/replies", { replies: [{ id, reply: "Up or down?" }] });
  await expect.poll(async () => (await rushes.api("GET", "/api/agent")).status.phase, { timeout: 10_000 }).toBe("question");
  await expect.poll(shown).toEqual([
    { title: "Rushes", body: "Claude Code is waiting for you" },
    { title: "Rushes", body: "Claude Code has a question" },
  ]);
  await page.waitForTimeout(500);
  expect(await shown()).toHaveLength(2);
  expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(0);
});

test("an ask notifies while the page is shown but behind another window (no focus), as Safari leaves it visible (I5)", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [[{ permission: { toolCall: FFPROBE }, record: "a" }, { stop: "end_turn" }]] });
  await readyToSend(rushes);
  const { shown, setFocused } = await stubNotices(page);
  await page.goto(rushes.url);
  await videoReady(page);
  // Shown, never hidden, but another window has the focus.
  await setFocused(false);
  expect(await page.evaluate(() => [document.hidden, document.visibilityState, document.hasFocus()])).toEqual([false, "visible", false]);
  await rushes.api("POST", "/api/batches", {});
  await expect(askCards(page)).toHaveCount(1);
  await expect.poll(shown).toEqual([{ title: "Rushes", body: "Claude Code is waiting for you" }]);
  await rushes.api("POST", "/api/agent/permission/ask_1", { choice: "once" });
});

test("a double-click answers only the card it was meant for: the card sliding into place takes no press yet", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({
    turns: [[{ permissions: [{ toolCall: CHAINED, record: CHAINED.title }, { toolCall: { ...CHAINED, toolCallId: "t4", title: "Clean again" }, record: "Clean again" }] }, { stop: "end_turn" }]],
  });
  await readyToSend(rushes);
  const answers = watchAnswers(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.api("POST", "/api/batches", {});
  await expect(askCards(page)).toHaveCount(2);
  const first = askCards(page).nth(0);
  await expect(first).toHaveAttribute("data-armed", "true");
  const firstTitle = await first.locator(".asktitle").textContent();
  // A person's double-click: the first click answers card 1, which goes, and card 2 slides up under the pointer before
  // the second click comes (a browser counts clicks up to ~500 ms apart as one double-click). A synthetic dblclick sends
  // both at once, while card 1's answer is still on its way, so it never meets card 2: the clicks are sent apart here.
  const no = (await first.getByRole("button", { name: "No", exact: true }).boundingBox())!;
  const [x, y] = [no.x + no.width / 2, no.y + no.height / 2];
  await page.mouse.click(x, y);
  await expect(askCards(page)).toHaveCount(1);
  const left = askCards(page);
  await expect(left.locator(".asktitle")).not.toHaveText(firstTitle!);
  // The second click lands on card 2's No, in the place card 1's was.
  expect(await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest("button")?.textContent, [x, y])).toBe("No");
  await page.mouse.click(x, y, { clickCount: 2 });
  // A press from the keyboard is dropped too while it isn't ready.
  await left.getByRole("button", { name: "Allow once" }).focus();
  await page.keyboard.press("Enter");
  // Still not ready after both presses, so both came while it wasn't: the test proves what it says, however slow the
  // machine. (Arming is one way until the card moves again, and the attribute follows it before any other input.)
  await expect(left).toHaveAttribute("data-armed", "false", { timeout: 1 });
  // Exactly one answer reached the server: the card pressed, with No. The other is still pending.
  await page.waitForTimeout(200);
  expect(answers).toEqual([{ id: "ask_1", body: { choice: "no" } }]);
  expect((await rushes.api("GET", "/api/agent")).status.asks.map((a: { id: string }) => a.id)).toEqual(["ask_2"]);
  // Once it has stayed put, it takes its answer as usual.
  await answerCard(left, "Allow once");
  await expect(askCards(page)).toHaveCount(0);
  expect(answers).toEqual([{ id: "ask_1", body: { choice: "no" } }, { id: "ask_2", body: { choice: "once" } }]);
  // The server may hold the two in either order (they arrive together): the agent heard No for the card pressed first.
  const secondTitle = firstTitle === CHAINED.title ? "Clean again" : CHAINED.title;
  await expect.poll(() => recorded(rushes)).toEqual({ [firstTitle!]: { outcome: "selected", optionId: "reject-once" }, [secondTitle]: { outcome: "selected", optionId: "allow-once" } });
});

test("a command's hidden characters show as what they are, and right-to-left can't reorder it", async ({ page, startWithAgent }) => {
  // U+202E would make "rm -rf ~ #txt.exe" read backwards from the override; U+200B hides in "rm".
  const real = "echo safe \u202E# txt.exe ~ fr- mr\u2066 && r\u200Bm -rf out";
  const rushes = await startWithAgent({ turns: [[{ permission: { toolCall: { toolCallId: "t5", kind: "execute", title: "Tidy up", rawInput: { command: real } } } }, { stop: "end_turn" }]] });
  await readyToSend(rushes);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.api("POST", "/api/batches", {});
  const card = askCards(page);
  await expect(card).toHaveCount(1);
  // The server holds the real command; the card shows each hidden character as its code, in its own style.
  expect((await rushes.api("GET", "/api/agent")).status.asks[0].command).toBe(real);
  const cmd = card.locator(".askcmd");
  await expect(cmd).toHaveText("echo safe <U+202E># txt.exe ~ fr- mr<U+2066> && r<U+200B>m -rf out");
  await expect(cmd.locator(".askhid")).toHaveText(["<U+202E>", "<U+2066>", "<U+200B>"]);
  expect(await cmd.evaluate((el) => /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(el.textContent ?? ""))).toBe(false);
  expect(await cmd.evaluate((el) => [getComputedStyle(el).direction, getComputedStyle(el).unicodeBidi])).toEqual(["ltr", "isolate"]);
  // Read left to right in the order typed: "echo" starts the line.
  const firstWord = await cmd.evaluate((el) => {
    const r = document.createRange();
    r.setStart(el.firstChild!, 0);
    r.setEnd(el.firstChild!, 4);
    return r.getBoundingClientRect().x - el.getBoundingClientRect().x;
  });
  expect(firstWord).toBeLessThan(12);
  await cardFits(page, card);
  await shootAsks(page, "ask-hidden-chars-1440");
});

// ---- a note's badge, its thread and the reply box (task 6) ----

const card = (page: Page, id: string): Locator => panel(page).locator(`.note[data-note="${id}"]`);
const badgeOf = (c: Locator): Locator => c.locator(".nbadge");
const threadOf = (c: Locator): Locator => c.locator(".nthread");
const replyBox = (c: Locator): Locator => c.getByRole("textbox", { name: /^Answer / });

/** Every answer the desk posts on a note: the note's id and the body, in order. */
function watchReplies(page: Page): { id: string; body: unknown }[] {
  const posted: { id: string; body: unknown }[] = [];
  page.on("request", (r) => {
    const m = /\/api\/notes\/([^/?]+)\/replies$/.exec(new URL(r.url()).pathname);
    if (m && r.method() === "POST") posted.push({ id: decodeURIComponent(m[1]), body: r.postDataJSON() });
  });
  return posted;
}

/** The prompts the fake was sent, in order. */
async function prompts(rushes: AgentRushes): Promise<string[]> {
  return (await readAgentLog(rushes.agentLog))
    .filter((m) => m.method === "session/prompt")
    .map((m) => (m.params?.prompt ?? []).map((p: { text?: string }) => p.text ?? "").join(""));
}

/**
 * The card's agent parts (badge, thread, reply box) are on screen in full: inside the card, the card inside the notes
 * list and the panel, nothing cut off or scrolled sideways, and long words wrapped rather than spilling.
 */
async function noteFits(page: Page, c: Locator): Promise<void> {
  await expect(c).toBeVisible();
  // Read in one go, so a list still scrolling a focused box into view can't move the card between two reads.
  const r = await c.evaluate((el) => {
    const box = (e: Element | null) => (e ? (({ x, y, width, height }) => ({ x, y, width, height }))(e.getBoundingClientRect()) : null);
    const panelEl = el.closest(".npanel");
    return {
      card: box(el)!,
      panel: box(panelEl)!,
      chk: box(el.querySelector(".chk"))!,
      parts: [".nbadge", ".nthread", ".nreply"].map((s) => box(el.querySelector(s))).filter((b) => b !== null),
      spill: [el, ...el.querySelectorAll("*")].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== "visible").map((e) => e.className),
      wide: el.scrollWidth > el.clientWidth,
    };
  });
  inside(r.card, r.panel);
  expect(r.card.x + r.card.width).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
  for (const b of r.parts) {
    expect(b!.width).toBeGreaterThan(40);
    inside(b!, r.card);
    // In the text column, right of the circle: never under it.
    expect(b!.x).toBeGreaterThanOrEqual(r.chk.x + r.chk.width);
  }
  // Nothing cut off or scrolled sideways (the reply box past four lines scrolls down inside itself, by design).
  expect(r.spill.filter((cls) => cls !== "input")).toEqual([]);
  expect(r.wide).toBe(false);
}

/** A picture of one note's card, kept with the test's results, to look at. */
async function shootNote(page: Page, c: Locator, name: string): Promise<void> {
  await c.scrollIntoViewIfNeeded();
  const b = (await c.boundingBox())!;
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), clip: { x: Math.max(0, b.x - 8), y: Math.max(0, b.y - 8), width: b.width + 16, height: b.height + 16 } });
}

test("a question shows Needs you and the answer goes to the agent", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  const id = await readyToSend(rushes);
  // Turn 1 asks on the note (rushes_reply with no status) and ends; turn 2 is the follow-up with the answer.
  await rushes.setScenario({ turns: [[{ http: { method: "POST", path: "/api/replies", body: { replies: [{ id, reply: "Full stop after the title?" }] } } }, { stop: "end_turn" }], [{ stop: "end_turn" }]] });
  const posted = watchReplies(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.api("POST", "/api/batches", {});

  const c = card(page, id);
  await expect(badgeOf(c)).toHaveText("Needs you", { timeout: 10_000 });
  await expect(c).toHaveClass(/\bneeds\b/);
  // The circle's ring and the card's left edge are the to-do colour; the badge's words too.
  const todo = await tokenColour(page, "--todo");
  expect(await c.locator(".chk").evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(todo);
  expect(await c.evaluate((el) => getComputedStyle(el).boxShadow)).toContain(todo);
  expect(await badgeOf(c).evaluate((el) => getComputedStyle(el).color)).toBe(todo);
  // The agent's line, with its reply icon and its time on the right.
  const lines = threadOf(c).locator(".nline");
  await expect(lines).toHaveCount(1);
  await expect(lines.first().locator(".ntext")).toHaveText("Full stop after the title?");
  await expect(lines.first().locator(".nwho svg.ic")).toBeVisible();
  await expect(lines.first().locator(".ntime")).toHaveText(/^\d\d:\d\d$/);
  const [text, time] = [(await lines.first().locator(".ntext").boundingBox())!, (await lines.first().locator(".ntime").boundingBox())!];
  expect(time.x).toBeGreaterThanOrEqual(text.x + text.width - 0.5);
  // The reply box, one line, for the agent by name.
  const boxEl = replyBox(c);
  await expect(boxEl).toBeVisible();
  await expect(boxEl).toHaveAttribute("placeholder", "Answer Claude Code");
  const oneLine = (await boxEl.boundingBox())!.height;
  expect(oneLine).toBeLessThan(40);
  await noteFits(page, c);
  await shootNote(page, c, "note-needs-you-1440");
  await page.setViewportSize({ width: 900, height: 900 });
  await page.getByRole("button", { name: "Show the notes panel · \\" }).click();
  await noteFits(page, c);
  await shootNote(page, c, "note-needs-you-900");
  await page.setViewportSize({ width: 1440, height: 900 });

  // Shift+Enter adds a line (the box grows, to four lines at most); Enter sends.
  await boxEl.click();
  await page.keyboard.type("No full stop.");
  await page.keyboard.press("Shift+Enter");
  await expect(boxEl).toHaveValue("No full stop.\n");
  await expect.poll(async () => (await boxEl.boundingBox())!.height).toBeGreaterThan(oneLine + 8);
  for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+Enter");
  const tall = (await boxEl.boundingBox())!.height;
  expect(tall).toBeLessThan(oneLine * 4 + 8);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("No full stop.");
  await page.keyboard.press("Enter");

  // The server got the answer as typed, the thread shows it as the user's, and the agent was handed it.
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(1)).toHaveClass(/\buser\b/);
  await expect(lines.nth(1).locator(".ntext")).toHaveText("No full stop.");
  await expect(lines.nth(1).locator(".nwho")).toHaveText("Y");
  expect(posted).toEqual([{ id, body: { text: "No full stop." } }]);
  await expect.poll(async () => (await prompts(rushes)).some((p) => p.includes("No full stop.")), { timeout: 5_000 }).toBe(true);
  await shootNote(page, c, "note-answered-1440");
});

test("while the agent works on an answer, the note says it is with the agent by name (Task 10, 2)", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  const id = await readyToSend(rushes);
  await rushes.setScenario({ turns: [[{ http: { method: "POST", path: "/api/replies", body: { replies: [{ id, reply: "Which end card?" }] } } }, { stop: "end_turn" }], [{ sleep: 4000 }, { stop: "end_turn" }]] });
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.api("POST", "/api/batches", {});
  const c = card(page, id);
  await expect(badgeOf(c)).toHaveText("Needs you", { timeout: 10_000 });
  await replyBox(c).fill("The white one.");
  await replyBox(c).press("Enter");
  // The follow-up turn runs: the note is with Claude Code, by name, and the box still answers it.
  await expect.poll(async () => (await prompts(rushes)).length, { timeout: 5_000 }).toBe(2);
  await expect(badgeOf(c)).toHaveText("With Claude Code");
  await expect(badgeOf(c)).toBeVisible();
  await expect(replyBox(c)).toHaveAttribute("placeholder", "Answer Claude Code");
  expect((await rushes.api("GET", "/api/agent")).status.followUps).toEqual([id]);
  await noteFits(page, c);
  await shootNote(page, c, "note-follow-up-1440");
});

test("working note shows what the agent is doing", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  const id = await readyToSend(rushes);
  await rushes.setScenario({ turns: [[{ http: { method: "POST", path: "/api/agent/working-on", body: { note: id, doing: "Measuring the cut" } } }, { sleep: 5000 }, { stop: "end_turn" }]] });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.api("POST", "/api/batches", {});
  const c = card(page, id);
  await expect(badgeOf(c)).toHaveText("Measuring the cut", { timeout: 10_000 });
  await expect(badgeOf(c)).toHaveClass(/\bworking\b/);
  const spin = badgeOf(c).locator("svg.ic");
  await expect(spin).toBeVisible();
  expect((await spin.boundingBox())!.width).toBeGreaterThanOrEqual(10);
  expect(await badgeOf(c).evaluate((el) => getComputedStyle(el).color)).toBe(await tokenColour(page, "--accent"));
  // The note is with the agent while Send to AI is on: the box is there to add to what it's doing.
  await expect(replyBox(c)).toBeVisible();
  await expect(c).not.toHaveClass(/\bneeds\b/);
  await noteFits(page, c);
  await shootNote(page, c, "note-working-1440");
  await page.setViewportSize({ width: 900, height: 900 });
  await page.getByRole("button", { name: "Show the notes panel · \\" }).click();
  await noteFits(page, c);
  await shootNote(page, c, "note-working-900");
});

test("an answer with no conversation to carry on goes back to to do, with Press Send", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  const id = await readyToSend(rushes);
  await rushes.setScenario({ turns: [[{ http: { method: "POST", path: "/api/replies", body: { replies: [{ id, reply: "Which end card?" }] } } }, { stop: "end_turn" }]] });
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.api("POST", "/api/batches", {});
  const c = card(page, id);
  await expect(badgeOf(c)).toHaveText("Needs you", { timeout: 10_000 });
  // The conversation is dropped (Start a fresh conversation): an answer has nowhere to go now.
  await rushes.api("POST", "/api/agent/fresh", {});
  await replyBox(c).fill("The white one.");
  await replyBox(c).press("Enter");
  // R11: the server keeps the answer, the note goes back to to do, and Activity says to press Send.
  await expect.poll(async () => (await rushes.api("GET", "/api/notes")).notes.map((n: { status: string; batch: string | null }) => [n.status, n.batch]), { timeout: 5_000 }).toEqual([["todo", null]]);
  const { status } = await rushes.api("GET", "/api/agent");
  expect(status.lines.map((l: { text: string }) => l.text)).toContain("Your answer on 'Hold the end card.' is saved. Press Send to hand it to Claude Code.");
  expect(await prompts(rushes)).toHaveLength(1);
  // On the card: no badge or box now, the thread keeps both lines, and Send counts the note again.
  await expect(badgeOf(c)).toHaveCount(0);
  await expect(c.locator(".nreply")).toHaveCount(0);
  await expect(threadOf(c).locator(".ntext")).toHaveText(["Which end card?", "The white one."]);
  await expect(sendBtn(page)).toHaveAccessibleName("Send 1");
});

test("an answer the server refuses says why and keeps what was typed", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  const id = await readyToSend(rushes);
  await rushes.setScenario({ turns: [[{ http: { method: "POST", path: "/api/replies", body: { replies: [{ id, reply: "Longer?" }] } } }, { stop: "end_turn" }]] });
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.api("POST", "/api/batches", {});
  const c = card(page, id);
  await expect(replyBox(c)).toBeVisible({ timeout: 10_000 });
  const long = "x".repeat(4001);
  await replyBox(c).fill(long);
  await replyBox(c).press("Enter");
  await expect(toastEl(page)).toHaveText("An answer is at most 4000 characters");
  await expect(replyBox(c)).toHaveValue(long);
  // Four lines at most, then it scrolls inside itself; the card still fits.
  expect((await replyBox(c).boundingBox())!.height).toBeLessThan(120);
  await noteFits(page, c);
  await shootNote(page, c, "note-refused-1440");
  await expect(threadOf(c).locator(".nline")).toHaveCount(1);
});

test("a note with no agent activity is as it was: no badge, thread or box", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  const id = await readyToSend(rushes);
  await page.goto(rushes.url);
  await videoReady(page);
  const c = card(page, id);
  await expect(c).toBeVisible();
  expect(await c.evaluate((el) => [...el.children].map((e) => e.className))).toEqual(["chk", "nt", "nx"]);
  // Its height is the circle's row and the text's, nothing more.
  const [box, nt, nx] = [(await c.boundingBox())!, (await c.locator(".nt").boundingBox())!, (await c.locator(".nx").boundingBox())!];
  expect(box.y + box.height - (nx.y + nx.height)).toBeLessThanOrEqual(10.5);
  expect(nx.y - (nt.y + nt.height)).toBeLessThanOrEqual(2.5);
});

test("a long thread shows its last three, wraps, and Fixed in v2 goes to the fix", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  const { note } = await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1.5, text: "Title card too short." });
  await rushes.addCut("held title");
  const long = "Held the title card 0.6 s longer and eased the fade so it lands on the downbeat; https://example.com/a-very-long-reference-without-any-spaces-at-all-to-wrap";
  await rushes.api("POST", "/api/replies", { replies: [{ id: note.id, reply: "Longer, or slower?" }] });
  await rushes.api("POST", `/api/notes/${note.id}/replies`, { text: "Longer." });
  await rushes.api("POST", "/api/replies", { replies: [{ id: note.id, reply: "How much?" }] });
  await rushes.api("POST", `/api/notes/${note.id}/replies`, { text: "Half a second." });
  await rushes.api("POST", "/api/replies", { replies: [{ id: note.id, reply: long, status: "done", fixT: 2.1, fixVersion: "v2" }] });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(rushes.url);
  await videoReady(page);
  const c = card(page, note.id);
  // The last three, oldest first, and Show all for the rest.
  await expect(threadOf(c).locator(".ntext")).toHaveText(["How much?", "Half a second.", long]);
  const more = threadOf(c).getByRole("button", { name: "Show all (5)" });
  await expect(more).toBeVisible();
  // The long reply wraps inside the card: several lines, never wider than its column.
  const last = threadOf(c).locator(".nline").last().locator(".ntext");
  expect((await last.boundingBox())!.height).toBeGreaterThan(40);
  // A done note: no box. Its badge goes to the fix.
  await expect(c.locator(".nreply")).toHaveCount(0);
  const fix = badgeOf(c).getByRole("button", { name: "Fixed in v2" });
  await expect(fix).toBeVisible();
  expect(await badgeOf(c).evaluate((el) => getComputedStyle(el).color)).toBe(await tokenColour(page, "--done"));
  await noteFits(page, c);
  await shootNote(page, c, "note-thread-fixed-1440");
  await more.click();
  await expect(threadOf(c).locator(".ntext")).toHaveCount(5);
  await expect(threadOf(c).getByRole("button", { name: /^Show all/ })).toHaveCount(0);
  await noteFits(page, c);
  await shootNote(page, c, "note-thread-all-1440");
  await page.setViewportSize({ width: 900, height: 900 });
  await page.getByRole("button", { name: "Show the notes panel · \\" }).click();
  await noteFits(page, c);
  await shootNote(page, c, "note-thread-all-900");
  await page.setViewportSize({ width: 1440, height: 900 });

  // From v1, Fixed in v2 opens v2 and goes to the fix's time.
  await pickVersion(page, "v1");
  await fix.click();
  await expect(cutButton(page)).toHaveAttribute("data-version", "v2");
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeCloseTo(2.1, 1);
  // On v2 already, it goes to the time.
  await page.locator("video").evaluate((v: HTMLVideoElement) => (v.currentTime = 0));
  await fix.click();
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(2.1, 1);
});

test("the agent's own words on a card show hidden characters as what they are", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  const { note } = await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Too dark." });
  await rushes.api("POST", "/api/replies", { replies: [{ id: note.id, reply: "Lifted it‮evif.\nDone.", status: "done", fixT: 1, fixVersion: "v2‮" }] });
  await page.goto(rushes.url);
  await videoReady(page);
  const c = card(page, note.id);
  await expect(badgeOf(c)).toHaveText("Fixed in v2<U+202E>");
  await expect(badgeOf(c).locator("[dir=auto]")).toHaveCount(1);
  const text = threadOf(c).locator(".ntext");
  await expect(text).toHaveText("Lifted it<U+202E>evif.\nDone.");
  await expect(text.locator(".nhid")).toHaveText("<U+202E>");
  // The reply's two lines stay two lines.
  expect((await text.boundingBox())!.height).toBeGreaterThan(30);
  await noteFits(page, c);
  await shootNote(page, c, "note-hidden-chars-1440");
});

test("a reply box that hides and comes back shows what was kept in full", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [[{ sleep: 15_000 }, { stop: "end_turn" }]] });
  const id = await readyToSend(rushes);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.api("POST", "/api/batches", {});
  const c = card(page, id);
  // Sent, not waiting on you: the box shows only while Send to AI is on.
  await expect(replyBox(c)).toBeVisible({ timeout: 10_000 });
  await replyBox(c).click();
  await page.keyboard.type("One.");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("Two.");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("Three.");
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
  await expect(c.locator(".nreply")).toHaveCount(0);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  const box = replyBox(c);
  await expect(box).toBeVisible();
  await expect(box).toHaveValue("One.\nTwo.\nThree.");
  // All three lines on show: nothing scrolled out of the box.
  const [scroll, client, line] = await box.evaluate((el) => [el.scrollHeight, el.clientHeight, parseFloat(getComputedStyle(el).lineHeight)]);
  expect(scroll).toBeLessThanOrEqual(client);
  expect(client).toBeGreaterThanOrEqual(line * 3);
  await noteFits(page, c);
  await shootNote(page, c, "note-box-back-1440");
});

// ---- task 7: the live strip in Activity, and readable lines ----

const strip = (page: Page): Locator => page.getByRole("tabpanel", { name: "Activity" }).locator(".lstrip");

/** The strip's lines sit inside it, each on one line, cut with an ellipsis instead of overflowing. */
async function stripFits(page: Page): Promise<void> {
  const s = (await strip(page).boundingBox())!;
  const p = (await page.locator(".npanel").boundingBox())!;
  inside(s, p);
  const rows = strip(page).locator(".lsrow");
  for (let i = 0; i < (await rows.count()); i++) {
    const r = rows.nth(i);
    expect((await r.boundingBox())!.height, `row ${i} is one line`).toBeLessThanOrEqual(34);
    const t = r.locator(".lline");
    const over = await t.evaluate((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== "ellipsis");
    expect(over, `row ${i} ellipsises`).toBe(false);
    inside((await t.boundingBox())!, s);
  }
}

test("Activity shows the run live", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  await readyToSend(rushes);
  const heredoc = "python3 - <<'PY'\nimport json, os, sys\nprint('x' * 200)\nPY";
  await rushes.setScenario({
    turns: [[
      { update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file" } },
      { update: { sessionUpdate: "tool_call", toolCallId: "t2", title: "mcp__rushes__rushes_reply" } },
      { update: { sessionUpdate: "tool_call", toolCallId: "t3", title: "mcp.rushes.rushes_working_on" } },
      { update: { sessionUpdate: "tool_call", toolCallId: "t4", title: "ToolSearch" } },
      { update: { sessionUpdate: "tool_call", toolCallId: "t5", title: "Terminal", kind: "execute", status: "pending", rawInput: { command: heredoc } } },
      // Task 10 (3): a command says it ran once it has, not as it is announced.
      { update: { sessionUpdate: "tool_call_update", toolCallId: "t5", status: "completed" } },
      { update: { sessionUpdate: "tool_call", toolCallId: "t6", title: "Edit " + "a very long file name ".repeat(12) + "end" } },
      { sleep: 6000 },
      { stop: "end_turn" },
    ]],
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.api("POST", "/api/batches", {});
  await expect(chip(page)).toHaveText(/Claude Code/, { timeout: 10_000 });
  await panel(page).getByRole("tab", { name: /^Activity/ }).click();
  await expect(strip(page).locator(".lhead")).toHaveText("Claude Code is working", { timeout: 10_000 });
  const lines = strip(page).locator(".lline");
  await expect(lines.filter({ hasText: "Read file" })).toHaveCount(1);
  await expect(lines.filter({ hasText: "Ran a command: python3 - <<'PY'" })).toHaveCount(1);
  // The agent's own Rushes calls and housekeeping are not lines; nothing is a raw tool name or a whole script.
  const texts = await lines.allTextContents();
  expect(texts.join("\n")).not.toMatch(/rushes_|ToolSearch|import json/);
  for (const t of texts) expect(t.length).toBeLessThanOrEqual(120);
  // Newest first, each with its time.
  expect(texts[0]).toMatch(/^Edit /);
  await expect(strip(page).locator(".ltime").first()).toHaveText(/\d\d:\d\d/);
  await stripFits(page);
  await page.screenshot({ path: test.info().outputPath("strip-1440.png") });
  await page.setViewportSize({ width: 900, height: 900 });
  await page.getByRole("button", { name: "Show the notes panel · \\" }).click();
  await panel(page).getByRole("tab", { name: /^Activity/ }).click();
  await expect(strip(page)).toBeVisible();
  await stripFits(page);
  await page.screenshot({ path: test.info().outputPath("strip-900.png") });
});

test("the strip folds into Show the run when the run ends, and a line with a note goes to that note", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  const id = await readyToSend(rushes);
  await rushes.setScenario({
    turns: [[
      { http: { method: "POST", path: "/api/agent/working-on", body: { note: id, doing: "Measuring the cut" } } },
      { update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file" } },
      { sleep: 3000 },
      { stop: "end_turn" },
    ]],
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.api("POST", "/api/batches", {});
  await panel(page).getByRole("tab", { name: /^Activity/ }).click();
  const noted = strip(page).getByRole("button", { name: /Measuring the cut/ });
  await expect(noted).toBeVisible({ timeout: 10_000 });
  await expect(strip(page).getByRole("button", { name: /Read file/ })).toHaveCount(1);
  await noted.click();
  await expect(page.getByRole("tabpanel", { name: "Activity" })).toHaveCount(0);
  await expect(card(page, id)).toBeVisible();
  await expect(card(page, id)).toBeFocused();
  // Once the run ends the strip is one line.
  await panel(page).getByRole("tab", { name: /^Activity/ }).click();
  const show = strip(page).getByRole("button", { name: /^Show the run \(\d+\)$/ });
  await expect(show).toBeVisible({ timeout: 15_000 });
  await expect(strip(page).locator(".lline")).toHaveCount(0);
  expect((await strip(page).boundingBox())!.height).toBeLessThanOrEqual(48);
  await page.screenshot({ path: test.info().outputPath("strip-ended-1440.png") });
  await show.click();
  await expect(strip(page).locator(".lline").first()).toBeVisible();
  await stripFits(page);
});

// ---- the new cut lands (task 8) ----

const cutDot = (page: Page): Locator => cutButton(page).locator(".vnewer");

/** Two rects share no area. */
const apart = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

/** Starts the picture playing (muted, looping so it is still playing when the test looks). */
async function startPlaying(page: Page): Promise<void> {
  await page.locator("video").evaluate((v: HTMLVideoElement) => {
    v.muted = true;
    v.loop = true;
    return v.play();
  });
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
}

/** The cut button's dot lies on the button, whole, and the button is not clipped by the bar. */
async function dotOnButton(page: Page): Promise<void> {
  const d = (await cutDot(page).boundingBox())!;
  const b = (await cutButton(page).boundingBox())!;
  const bar = (await page.locator("header.top").boundingBox())!;
  expect(d.width).toBeGreaterThanOrEqual(6);
  expect(d.x).toBeGreaterThanOrEqual(b.x);
  expect(d.x + d.width).toBeLessThanOrEqual(b.x + b.width);
  expect(d.y).toBeGreaterThanOrEqual(b.y);
  expect(d.y + d.height).toBeLessThanOrEqual(b.y + b.height);
  expect(b.y + b.height).toBeLessThanOrEqual(bar.y + bar.height);
  expect(await page.locator("header.top").evaluate((h) => h.scrollWidth <= h.clientWidth)).toBe(true);
}

test("a new cut switches when nothing plays", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await rushes.addCut("second cut");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(cutButton(page)).toHaveAttribute("data-version", "v2");
  // Opening a project that already has cuts says nothing.
  await page.waitForTimeout(600);
  await expect(toastEl(page)).toHaveCount(0);
  await rushes.addCut("third cut");
  await expect(toastEl(page)).toHaveText("v3 is in");
  await expect(cutButton(page)).toHaveAttribute("data-version", "v3");
  await expect(cutDot(page)).toHaveCount(0);
  await expect(toastEl(page).getByRole("button", { name: "Show" })).toHaveCount(0);
  await expect(toastEl(page)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("newcut-switched-1440.png"), clip: { x: 0, y: 0, width: 1440, height: 120 } });
});

test("a new cut waits while playing", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await rushes.addCut("second cut");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(rushes.url);
  await videoReady(page);
  await startPlaying(page);
  await rushes.addCut("third cut");
  await expect(toastEl(page)).toContainText("v3 is in");
  const show = toastEl(page).getByRole("button", { name: "Show" });
  await expect(show).toBeVisible();
  // The picture is left where it was, and still playing; the Cut menu says there is more.
  await expect(cutButton(page)).toHaveAttribute("data-version", "v2");
  expect(await page.locator("video").evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  await expect(cutDot(page)).toBeVisible();
  await expect(cutButton(page)).toHaveAccessibleDescription("v3 is ready");
  await dotOnButton(page);
  await page.screenshot({ path: test.info().outputPath("newcut-offered-1440.png"), clip: { x: 0, y: 0, width: 1440, height: 120 } });
  // The dot outlives the toast, and pausing doesn't switch the picture behind your back.
  await page.locator("video").evaluate((v: HTMLVideoElement) => v.pause());
  await expect(toastEl(page)).toHaveCount(0, { timeout: 10_000 });
  await expect(cutButton(page)).toHaveAttribute("data-version", "v2");
  await expect(cutDot(page)).toBeVisible();
  // Picking it from the menu is "viewed" too: the dot goes.
  await pickVersion(page, "v3");
  await expect(cutButton(page)).toHaveAttribute("data-version", "v3");
  await expect(cutDot(page)).toHaveCount(0);
});

for (const tab of ["Music", "Voice"] as const) {
  test(`a new cut waits while the ${tab} tab plays, and Show and the dot offer it (I2)`, async ({ page, rushes }) => {
    await rushes.addCut("first cut");
    await rushes.addCut("second cut");
    if (tab === "Music") await rushes.addVariant("music", "Bed", { seconds: 20, freq: 220 });
    else await rushes.addVariant("voice", "Read 1", { seconds: 20, freq: 220, round: "Round 1", video: "hero" });
    await page.setViewportSize({ width: 1440, height: 900 });
    // ?test=1 gives the page window.__rushesAudio, to see the engine play.
    await page.goto(rushes.testUrl());
    await openReviewTab(page, tab);
    const engine = () => page.evaluate(() => (window as unknown as { __rushesAudio: { inspect(): { playing: boolean; media: string[] } | null } }).__rushesAudio.inspect());
    await expect.poll(async () => (await engine())?.media.length ?? 0, { timeout: 10_000 }).toBe(1);
    await expect(cutButton(page)).toHaveAttribute("data-version", "v2");
    const preview = page.locator(".spreview video");
    const before = await preview.evaluate((v: HTMLVideoElement) => v.currentSrc);
    await page.keyboard.press(" ");
    await expect.poll(async () => (await engine())?.playing).toBe(true);
    await rushes.addCut("third cut");
    await expect(toastEl(page)).toContainText("v3 is in");
    await expect(toastEl(page).getByRole("button", { name: "Show" })).toBeVisible();
    // The cut on screen stays, and so does the preview's file, while the sound plays on.
    await expect(cutButton(page)).toHaveAttribute("data-version", "v2");
    expect(await preview.evaluate((v: HTMLVideoElement) => v.currentSrc)).toBe(before);
    expect((await engine())?.playing).toBe(true);
    await expect(cutDot(page)).toBeVisible();
    await dotOnButton(page);
    await page.screenshot({ path: test.info().outputPath(`newcut-offered-${tab.toLowerCase()}-1440.png`), clip: { x: 0, y: 0, width: 1440, height: 120 } });
    // Show goes to it.
    await toastEl(page).getByRole("button", { name: "Show" }).click();
    await expect(cutButton(page)).toHaveAttribute("data-version", "v3");
    await expect(cutDot(page)).toHaveCount(0);
  });
}

test("Show switches to the new cut and clears the dot", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await rushes.addCut("second cut");
  await page.goto(rushes.url);
  await videoReady(page);
  await startPlaying(page);
  await rushes.addCut("third cut");
  await toastEl(page).getByRole("button", { name: "Show" }).click();
  await expect(cutButton(page)).toHaveAttribute("data-version", "v3");
  await expect(cutDot(page)).toHaveCount(0);
  await expect(toastEl(page)).toHaveCount(0);
});

test("a cut for another film says nothing, and switching film says nothing", async ({ page, rushes }) => {
  await rushes.addCut("hero one");
  await rushes.addCut("teaser one", "Teaser");
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.addCut("teaser two", "Teaser");
  await page.waitForTimeout(800);
  await expect(toastEl(page)).toHaveCount(0);
  await expect(cutButton(page)).toHaveAttribute("data-version", "v1");
  await pickFilm(page, "Teaser");
  await videoReady(page);
  await expect(cutButton(page)).toHaveAttribute("data-version", "v2");
  await page.waitForTimeout(600);
  await expect(toastEl(page)).toHaveCount(0);
  await expect(cutDot(page)).toHaveCount(0);
});

for (const width of [1440, 900]) {
  test(`the new-cut toast keeps clear of the agent chip, Send and the Cut menu dot at ${width} px`, async ({ page, startWithAgent }) => {
    const rushes = await startWithAgent({ turns: [[{ sleep: 8000 }, { stop: "end_turn" }]] });
    const note = await readyToSend(rushes);
    await rushes.addCut("second cut");
    await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v2", scope: "point", t: 0.7, text: "Another one." });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(rushes.url);
    await videoReady(page);
    await rushes.api("POST", "/api/batches", {});
    await expect(chip(page)).toBeVisible({ timeout: 10_000 });
    await startPlaying(page);
    await rushes.addCut("third cut");
    const toastBox = async () => (await toastEl(page).boundingBox())!;
    await expect(toastEl(page).getByRole("button", { name: "Show" })).toBeVisible();
    await expect(cutDot(page)).toBeVisible();
    await dotOnButton(page);
    const t = await toastBox();
    expect(t.x).toBeGreaterThanOrEqual(0);
    expect(t.x + t.width).toBeLessThanOrEqual(width);
    // Not over the chip, nor over Send when the panel shows it.
    expect(apart(t, (await chip(page).boundingBox())!)).toBe(true);
    const send = page.locator(".sendbtn");
    if (await send.isVisible()) expect(apart(t, (await send.boundingBox())!)).toBe(true);
    // Nor over the Cut menu's own button.
    expect(apart(t, (await cutButton(page).boundingBox())!)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`newcut-geometry-${width}.png`), clip: { x: 0, y: 0, width, height: 140 } });
    void note;
  });
}

// §32: Send to AI is set up once per Mac. The second project here is a new folder on a new server with the same
// XDG_CONFIG_HOME, as a second project on the same Mac is.
test("set up on one project, a new project's Send goes straight to the agent with no sheet (§32)", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [[{ stop: "end_turn" }], [{ stop: "end_turn" }]] });
  await withNote(rushes, false);
  await page.goto(rushes.url);
  await videoReady(page);
  await sendBtn(page).click();
  await primary(page, "Next").click();
  await primary(page, "Send to Claude Code").click();
  await expect(toastEl(page)).toHaveText(/^(Sent to|Starting) Claude Code$/);
  expect(JSON.parse(await readFile(join(rushes.configDir, "rushes", "agent-defaults.json"), "utf8"))).toEqual({ agent: "claude", permissions: "project-edits" });
  // Project B: a new folder, never set up.
  await rushes.swapProject();
  await withNote(rushes, false);
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(row(page).getByRole("button", { name: "Set up Send to AI" })).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await sendBtn(page).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(toastEl(page)).toHaveText(/^(Sent to|Starting) Claude Code$/);
  expect((await rushes.api("GET", "/api/agent")).status).toMatchObject({ on: true, agent: "claude", asked: true, always: [] });
});

test("Copy a prompt on one project: a new project asks nothing and Send copies a prompt (§32)", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  await withNote(rushes, false);
  await page.goto(rushes.url);
  await videoReady(page);
  await sendBtn(page).click();
  await whoRadio(page, "Copy a prompt").check();
  await primary(page).click();
  await expect(sheet(page)).toHaveCount(0);
  await rushes.swapProject();
  await withNote(rushes, false);
  await page.goto(rushes.url);
  await videoReady(page);
  // As after Copy a prompt on any project: off, with the row as the way back in.
  await expect(who(page)).toHaveText("Copies a prompt for your own chat");
  expect((await rushes.api("GET", "/api/agent")).status).toMatchObject({ on: false, asked: true });
  await sendBtn(page).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(sentPop(page)).toBeVisible();
  expect(await readAgentLog(rushes.agentLog)).toEqual([]);
});

// §33: one permission menu, four rows, the same in the agent menu and the sheet's second step.
const ROWS = ["Manual", "Accept edits", "Auto", "Bypass"];
const BYPASS_WARNING = "Bypass: the agent runs every command and edits any file with nothing asked or checked, .rushes and .git included.";

test("the agent menu shows four permission rows, and picking Bypass shows its warning (§33)", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  await withNote(rushes);
  await page.goto(rushes.url);
  await videoReady(page);
  await row(page).getByRole("button", { name: "Send to AI · Claude Code" }).click();
  const menu = agentMenu(page);
  const radios = menu.getByRole("menuitemradio").filter({ hasNotText: /Signed in|Not signed in/ });
  await expect(radios).toHaveCount(4);
  expect(await radios.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).toEqual(ROWS);
  await expect(menu.getByRole("menuitemradio", { name: "Accept edits" })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByText(/no longer guards \.rushes and \.git/)).toBeVisible();
  await expect(menu.getByText(BYPASS_WARNING, { exact: true })).toHaveCount(0);
  await menu.getByRole("menuitemradio", { name: "Auto" }).click();
  await expect(menu.getByRole("menuitemradio", { name: "Auto" })).toHaveAttribute("aria-checked", "true");
  await expect(who(page)).toHaveText("Auto: Claude Code decides what to ask");
  await menu.getByRole("menuitemradio", { name: "Bypass" }).click();
  await expect(menu.getByText(BYPASS_WARNING, { exact: true })).toBeVisible();
  await expect(who(page)).toHaveText("Bypass: nothing asks, nothing is checked");
  await menuFits(page);
  await shootFoot(page, "menu-bypass-1440");
  expect((await rushes.api("GET", "/api/agent")).status).toMatchObject({ permissions: "bypass" });
  await menu.getByRole("menuitemradio", { name: "Accept edits" }).click();
  await expect(menu.getByText(BYPASS_WARNING, { exact: true })).toHaveCount(0);
});

test("the sheet's second step offers the four rows, Accept edits picked and Bypass last; Bypass warns (§33)", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  await withNote(rushes, false);
  await page.goto(rushes.url);
  await videoReady(page);
  await sendBtn(page).click();
  await primary(page, "Next").click();
  const may = page.getByRole("dialog", { name: "What may Claude Code do without asking?" });
  const radios = may.getByRole("radio");
  await expect(radios).toHaveCount(4);
  expect(await radios.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).toEqual(ROWS);
  await expect(may.getByRole("radio", { name: "Accept edits" })).toBeChecked();
  await expect(may.getByText(BYPASS_WARNING, { exact: true })).toHaveCount(0);
  await may.getByRole("radio", { name: "Bypass" }).check();
  await expect(may.getByText(BYPASS_WARNING, { exact: true })).toBeVisible();
  await sheetFits(page);
  await shootSheet(page, "sheet-may-bypass-1440");
  await may.getByRole("radio", { name: "Auto" }).check();
  await expect(may.getByText(BYPASS_WARNING, { exact: true })).toHaveCount(0);
});

test("Auto chosen on one project is the default: a second project starts in Auto (§33 with §32)", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ modes: ["default", "auto", "read-only", "agent"], turns: [[{ stop: "end_turn" }], [{ stop: "end_turn" }]] });
  await withNote(rushes, false);
  await page.goto(rushes.url);
  await videoReady(page);
  await sendBtn(page).click();
  await primary(page, "Next").click();
  await sheet(page).getByRole("radio", { name: "Auto" }).check();
  await primary(page, "Send to Claude Code").click();
  await expect(toastEl(page)).toHaveText(/^(Sent to|Starting) Claude Code$/);
  expect(JSON.parse(await readFile(join(rushes.configDir, "rushes", "agent-defaults.json"), "utf8"))).toEqual({ agent: "claude", permissions: "auto" });
  await rushes.swapProject();
  await withNote(rushes, false);
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await expect(who(page)).toHaveText(/^Auto: Claude Code decides what to ask/);
  expect((await rushes.api("GET", "/api/agent")).status).toMatchObject({ on: true, agent: "claude", asked: true, permissions: "auto" });
});
