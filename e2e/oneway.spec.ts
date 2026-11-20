// §35: the Timeline lists the film's notes from every tab; notes go one way; an Attention item in Activity.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { activity, expect, notesPanel, openActivity, panelTab, test, videoReady } from "./fixture.js";

const card = (page: Page, id: string) => notesPanel(page).locator(`.note[data-note="${id}"]`);
const videoAt = (page: Page) => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime);
const tokenColor = (page: Page, token: string) =>
  page.evaluate((t) => {
    const el = document.createElement("i");
    el.style.color = `var(${t})`;
    document.body.append(el);
    const c = getComputedStyle(el).color;
    el.remove();
    return c;
  }, token);

test("a Voice note shows on the Timeline with its tab label, a take not in use says so, and clicking its time seeks", async ({ page, rushes }) => {
  await rushes.addCut();
  const gerald = await rushes.addVariant("voice", "Gerald", { round: "Round 1 · Voices", seconds: 4, freq: 220 });
  const nora = await rushes.addVariant("voice", "Nora", { round: "Round 1 · Voices", seconds: 4, freq: 330 });
  await rushes.api("PUT", "/api/picks", { video: "hero", lanes: { [gerald.lane.id]: gerald.variant.id } });
  const pic = (await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 0.5, text: "Hold the frame." })).note;
  const inUse = (await rushes.api("POST", "/api/notes", { stage: "voice", video: "hero", on: `${gerald.lane.id}/${gerald.variant.id}`, scope: "point", t: 1.2, text: "Softer here." })).note;
  const notInUse = (await rushes.api("POST", "/api/notes", { stage: "voice", video: "hero", on: `${nora.lane.id}/${nora.variant.id}`, scope: "point", t: 2.5, text: "Too fast." })).note;
  await page.goto(rushes.url);
  await videoReady(page);

  // All three on the Timeline, in time order, each from another tab labelled with it.
  await expect(notesPanel(page).locator(".note")).toHaveCount(3);
  await expect(card(page, pic.id).locator(".on")).toHaveCount(0);
  await expect(card(page, inUse.id).locator(".on")).toHaveText("Voice · Gerald");
  await expect(card(page, notInUse.id).locator(".on")).toHaveText("Voice · Nora (not in use)");
  // The Notes count is the Timeline's own, as before: the picture's note and the one on the take in use.
  await expect(panelTab(page, "Notes")).toHaveText("Notes2");

  // Clicking a note's time seeks the timeline there, in use or not.
  await card(page, notInUse.id).locator("button.t").click();
  await expect.poll(() => videoAt(page)).toBeCloseTo(2.5, 1);
  await card(page, inUse.id).locator("button.t").click();
  await expect.poll(() => videoAt(page)).toBeCloseTo(1.2, 1);

  // The To do filter covers them all.
  await card(page, notInUse.id).locator(".chk").click();
  await notesPanel(page).getByRole("combobox", { name: "Filter notes" }).selectOption({ label: "To do" });
  await expect(card(page, notInUse.id)).toHaveCount(0);
  await expect(card(page, inUse.id)).toBeVisible();
  await notesPanel(page).getByRole("combobox", { name: "Filter notes" }).selectOption({ label: "Done" });
  await expect(card(page, notInUse.id)).toBeVisible();
  await notesPanel(page).getByRole("combobox", { name: "Filter notes" }).selectOption({ label: "All" });

  // On Voice, the list is the tab's own until All tabs is switched on; then the picture's note shows, labelled.
  await page.keyboard.press("3");
  const all = notesPanel(page).getByRole("switch", { name: "All tabs" });
  await expect(all).toHaveAttribute("aria-checked", "false");
  await expect(card(page, pic.id)).toHaveCount(0);
  await all.click();
  await expect(all).toHaveAttribute("aria-checked", "true");
  await expect(card(page, pic.id).locator(".on")).toHaveText("Picture");
  await all.click();
  await expect(card(page, pic.id)).toHaveCount(0);
});

test("no answer box and no question chip anywhere: notes go one way", async ({ page, rushes }) => {
  await rushes.addCut();
  const note = (await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 0.5, text: "Which logo?" })).note;
  await rushes.api("POST", "/api/batches", {});
  await rushes.api("POST", "/api/replies", { replies: [{ id: note.id, reply: "Unlock the keychain, or run elevenlabs auth login?" }] });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(card(page, note.id).locator(".nthread .ntext")).toHaveText("Unlock the keychain, or run elevenlabs auth login?");
  await expect(page.getByRole("textbox", { name: /^Answer / })).toHaveCount(0);
  await expect(page.getByText("Needs you")).toHaveCount(0);
  await expect(page.getByText(/has a question/)).toHaveCount(0);
  // The route for an answer is gone.
  const res = await page.request.post(`${new URL(rushes.url).origin}/api/notes/${note.id}/replies`, { data: { text: "hi" } });
  expect(res.status()).toBe(404);
});

test("an attention item: alert style, the Activity dot in the alert colour, the resume panel on another computer, and Dismiss", async ({ page, rushes }) => {
  await rushes.addCut();
  const note = (await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 0.5, text: "Warmer voice." })).note;
  // A conversation kept for the project, as Send to AI leaves it.
  const agentFile = join(rushes.root, ".rushes", "agent.json");
  const current = JSON.parse(await readFile(agentFile, "utf8").catch(() => '{"schema":1,"rev":0}'));
  const session = "a2973322-28b7-4e44-91b7-8e306bbd4fb6";
  await writeFile(agentFile, JSON.stringify({ ...current, rev: (current.rev ?? 0) + 1, agent: "claude", session: { id: session, agent: "claude", startedAt: "2026-11-19T09:23:34.350Z" } }));
  await rushes.api("POST", "/api/attention", { title: "ElevenLabs sign-in needed on this Mac", note: note.id });
  await page.goto(rushes.url);
  await videoReady(page);

  // The Activity tab's dot is the alert colour while it is open.
  const dot = panelTab(page, "Activity").locator(".cdot");
  await expect(dot).toHaveClass(/\balert\b/);
  expect(await dot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await tokenColor(page, "--over"));
  await expect(panelTab(page, "Activity")).toHaveAccessibleName("Activity (needs your attention)");
  // Nothing new in the top bar.
  await expect(page.locator("header.top").getByText(/attention|sign-in/i)).toHaveCount(0);

  await openActivity(page);
  const item = activity(page).locator("[data-attention]");
  await expect(item).toHaveCount(1);
  await expect(item.locator(".lattn-text")).toHaveText("ElevenLabs sign-in needed on this Mac");
  await expect(item.getByRole("img", { name: "Needs your attention" })).toBeVisible();
  expect(await item.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(await tokenColor(page, "--over"));
  // Not a finished action: no tick, and it says it needs you.
  await expect(item.locator(".lattn-sub")).toHaveText("Needs your attention · back to the agent");
  // Still on the Activity tab: the dot stays the alert colour, it isn't just news.
  await expect(dot).toHaveClass(/\balert\b/);

  // This page was opened without the here key (as a desk reached from another Mac is): the panel with the command.
  await item.locator(".lattn-go").click();
  const panel = item.getByRole("group", { name: "Go back to the agent" });
  await expect(panel.locator("code")).toHaveText(`claude --resume ${session}`);
  // The folder as the server knows it (its real path: /private/var/… on a Mac for /var/…).
  await expect(panel.locator(".lattn-where")).toHaveText(/^Run this on \S+, in \/.+\/My Film$/);
  await expect(panel.getByRole("button", { name: "Copy" })).toBeVisible();

  // Dismiss clears it: an ordinary line now, and the dot is no longer the alert colour.
  await item.getByRole("button", { name: "Dismiss" }).click();
  await expect(activity(page).locator("[data-attention]")).toHaveCount(0);
  await expect(activity(page).getByText("ElevenLabs sign-in needed on this Mac")).toBeVisible();
  await expect(panelTab(page, "Activity").locator(".cdot.alert")).toHaveCount(0);
  await expect(panelTab(page, "Activity")).not.toHaveAccessibleName("Activity (needs your attention)");
});
