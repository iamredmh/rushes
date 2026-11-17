// §28, Send to AI (plan 2): the run's chip in the top bar, and Stop. The agent is the fake (e2e/agentFixture.ts).
import type { Locator, Page } from "@playwright/test";
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
