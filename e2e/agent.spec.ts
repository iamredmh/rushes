// §28, Send to AI (plan 2): the run's chip in the top bar, and Stop; the Send to AI row above Send and the agent menu;
// the first-Send sheet and what Send does with the answer.
// The agent is the fake (e2e/agentFixture.ts).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { rulesPath } from "../src/server/agent/rules.js";
import { expect, readAgentLog, test, videoReady, type AgentRushes } from "./agentFixture.js";

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
  await expect(menu.getByRole("menuitemradio", { name: "Edit files in this project" })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByText("Always rules", { exact: true })).toBeVisible();
  await expect(menu.getByText("Always for npx hyperframes here", { exact: true })).toBeVisible();
  await expect(menu.getByText("Switch off: Send copies a prompt, as now", { exact: true })).toBeVisible();
  await menuFits(page);
  await shootFoot(page, "menu-open-1440");
  await menu.getByRole("menuitemradio", { name: "Ask me for everything" }).click();
  await expect(menu.getByRole("menuitemradio", { name: "Ask me for everything" })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemradio", { name: "Edit files in this project" })).toHaveAttribute("aria-checked", "false");
  await expect(who(page)).toHaveText("Asks before everything");
  await menu.getByRole("menuitem", { name: "Remove Always for npx hyperframes here" }).click();
  await expect(menu.getByText("No Always rules yet", { exact: true })).toBeVisible();
  await expect(menu.getByText("Always for npx hyperframes here", { exact: true })).toHaveCount(0);
  await shootFoot(page, "menu-after-1440");
  expect(JSON.parse(await readFile(rules, "utf8"))).toEqual({ permissions: "ask-all", always: [] });
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
  // Nothing waits: the sheet sets Send to AI up and sends nothing.
  await setUp.click();
  await primary(page, "Next").click();
  await primary(page, "Send to Claude Code").click();
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
  await expect.poll(focused).toBe("menuitemradio: Ask me for everything");
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

test("off: Send opens the old dialog", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
  await withNote(rushes, false);
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
  await expect(may.getByRole("radio", { name: "Edit files in this project" })).toBeChecked();
  await expect(may.getByRole("radio", { name: "Ask me for everything" })).not.toBeChecked();
  await expect.poll(() => focusedName(page)).toBe("radio: Edit files in this project");
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
  // The note is with the agent, and the agent was handed the batch. (Its "With Claude Code" badge is task 6's.)
  await expect(panel(page).locator(".note .chk")).toHaveAccessibleName("With your agent · Mark done");
  await expect(panel(page).locator(".note .chk")).toBeVisible();
  await expect.poll(async () => (await readAgentLog(rushes.agentLog)).some((m) => m.method === "session/prompt"), { timeout: 10_000 }).toBe(true);
  await expect(row(page).getByRole("button", { name: "Send to AI · Claude Code" })).toBeVisible();
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

test("not signed in falls back to the dialog with Set up", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] }, { agents: [{ id: "claude", installed: true, signedIn: false }, { id: "codex", installed: true, signedIn: true }] });
  await rushes.addCut("first cut");
  // Set up while Claude Code was signed in (the setup route refuses it now), then signed out.
  await writeFile(join(rushes.root, ".rushes", "agent.json"), JSON.stringify({ schema: 1, rev: 1, on: true, agent: "claude", session: null, asked: true }));
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
  await expect.poll(() => focusedName(page)).toBe("radio: Edit files in this project");
  await page.keyboard.press("ArrowDown");
  await expect(sheet(page).getByRole("radio", { name: "Ask me for everything" })).toBeChecked();
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
