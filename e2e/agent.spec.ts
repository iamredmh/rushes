// §28, Send to AI (plan 2): the run's chip in the top bar, and Stop; the Send to AI row above Send and the agent menu.
// The agent is the fake (e2e/agentFixture.ts).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { rulesPath } from "../src/server/agent/rules.js";
import { expect, test, videoReady, type AgentRushes } from "./agentFixture.js";

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

/** The row, Send and the who-line are on screen, inside the foot, one above the other with no overlap; nothing spills. */
async function footFits(page: Page): Promise<void> {
  const f = (await foot(page).boundingBox())!;
  const boxes = [(await row(page).boundingBox())!, (await sendBtn(page).boundingBox())!, (await who(page).boundingBox())!];
  for (const b of boxes) {
    expect(b.width).toBeGreaterThan(40);
    expect(b.height).toBeGreaterThan(8);
    inside(b, f);
  }
  expect(overlap(boxes[0], boxes[1])).toBe(false);
  expect(overlap(boxes[1], boxes[2])).toBe(false);
  expect(overlap(boxes[0], boxes[2])).toBe(false);
  // Row above Send above the who-line.
  expect(boxes[0].y + boxes[0].height).toBeLessThanOrEqual(boxes[1].y + 0.5);
  expect(boxes[1].y + boxes[1].height).toBeLessThanOrEqual(boxes[2].y + 0.5);
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

test("Set up Send to AI opens the agent menu, and picking an agent turns it on", async ({ page, startWithAgent }) => {
  const rushes = await startWithAgent({ turns: [] });
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
  const menu = agentMenu(page);
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: /Claude Code/ })).toHaveAttribute("aria-checked", "false");
  await menu.getByRole("menuitemradio", { name: /Claude Code/ }).click();
  await expect(menu).toHaveCount(0);
  await expect(row(page).getByRole("button", { name: "Send to AI · Claude Code" })).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await expect(who(page)).toHaveText("Edits files in this project, asks before commands");
  expect((await rushes.api("GET", "/api/agent")).status).toMatchObject({ on: true, agent: "claude" });
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
