import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, videoReady } from "./fixture.js";

test("tabs stay locked until the project has something, then unlock live", async ({ page, rushes }) => {
  await page.goto(rushes.url);
  await expect(page.getByRole("tab", { name: /Picture/ })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText("Nothing to review in Picture yet")).toBeVisible();
  await rushes.addCut("first cut");
  // No reload: the server's change event unlocks the tab.
  await expect(page.getByRole("tab", { name: /Picture/ })).toHaveAttribute("aria-disabled", "false");
  await page.getByRole("tab", { name: /Picture/ }).click();
  await videoReady(page);
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v1");
});

test("a note at the playhead is saved and survives a reload", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  for (let i = 0; i < 15; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Timecode")).toContainText("0:00.50");
  await page.keyboard.press("n");
  await page.keyboard.type("Logo lands a beat early.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(1);
  await expect(page.locator(".note .t")).toHaveText("0:00.50");
  await page.reload();
  await expect(page.locator(".note .nx")).toHaveText("Logo lands a beat early.");
  const { notes } = await rushes.api("GET", "/api/notes?stage=picture");
  expect(notes[0]).toMatchObject({ scope: "point", t: 0.5, frame: 15, version: "v1", video: "hero", by: "user" });
});

test("In and Out make a range note, with a frame grab and a box attached", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("i");
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("o");
  await expect(page.locator(".bar .chipx")).toContainText("0:01.00–0:02.00");
  await page.keyboard.press("g");
  await expect(page.locator(".comp .chipx", { hasText: "Frame 60" })).toBeVisible();
  await page.keyboard.press("b");
  const frame = (await page.locator(".overlay").boundingBox())!;
  await page.mouse.move(frame.x + frame.width * 0.25, frame.y + frame.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width * 0.75, frame.y + frame.height * 0.75, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".comp .chipx", { hasText: "Box" })).toBeVisible();
  // Finishing the box must not start playback.
  expect(await page.locator("video").evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await page.keyboard.press("n");
  await page.keyboard.type("This scene is too fast.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note .t")).toHaveText("0:01.00–0:02.00");
  await expect(page.locator(".note img.thumb")).toBeVisible();
  const { notes } = await rushes.api("GET", "/api/notes?stage=picture");
  expect(notes[0]).toMatchObject({ scope: "range", t: 1, tOut: 2, grab: ".rushes/grabs/hero_v1_f60.png" });
  expect(notes[0].box.x).toBeCloseTo(0.25, 1);
  expect(notes[0].box.w).toBeCloseTo(0.5, 1);
  await access(join(rushes.root, ".rushes", "grabs", "hero_v1_f60.png"));
});

test("an agent's reply appears live, and ticking the circle marks a note done", async ({ page, rushes }) => {
  await rushes.addCut();
  const { note } = await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Too dark." });
  await page.goto(rushes.url);
  await expect(page.locator(".note")).toHaveCount(1);
  await rushes.api("POST", "/api/replies", { replies: [{ id: note.id, reply: "Lifted the shadows.", status: "done" }] });
  await expect(page.locator(".note .rp")).toHaveText("Lifted the shadows.");
  await expect(page.locator(".note")).toHaveClass(/done/);
  await page.getByRole("button", { name: "Reopen" }).click();
  await expect(page.locator(".note")).not.toHaveClass(/done/);
  const { notes } = await rushes.api("GET", "/api/notes");
  expect(notes[0].status).toBe("todo");
});

test("a note fixed in the newer cut shows where it landed and where it came from", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  const { note } = await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1.5, text: "Title card too short." });
  await rushes.addCut("held title");
  await rushes.api("POST", "/api/replies", { replies: [{ id: note.id, reply: "Held 0.6 s longer.", status: "done", fixT: 2.1, fixVersion: "v2" }] });
  await page.goto(rushes.url);
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v2");
  await expect(page.locator(".note .t")).toHaveText("0:02.10");
  await expect(page.locator(".note .from")).toHaveText("from v1 at 0:01.50");
});

test("script edits are saved, marked as changed, and can be reverted", async ({ page, rushes }) => {
  await rushes.api("PUT", "/api/script", { sections: [{ start: 0, end: 13, current: "Your work lives on one laptop." }] });
  await page.goto(rushes.url);
  await expect(page.getByRole("tab", { name: /Script/ })).toHaveAttribute("aria-selected", "true");
  const box = page.getByLabel("Your version of s1");
  await box.fill("Your work lives on one machine.");
  await expect(page.locator(".srow")).toHaveClass(/changed/);
  await expect.poll(async () => (await rushes.api("GET", "/api/script")).script.sections[0].proposed).toBe("Your work lives on one machine.");
  await page.getByRole("button", { name: "Flag" }).click();
  await expect.poll(async () => (await rushes.api("GET", "/api/script")).script.sections[0].status).toBe("flagged");
  await page.getByRole("button", { name: "Revert" }).click();
  await expect(box).toHaveValue("Your work lives on one laptop.");
  await expect.poll(async () => (await rushes.api("GET", "/api/script")).script.sections[0].proposed).toBe(null);
});

test("Send to agent batches this tab's open notes and shows the prompt to paste", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.api("POST", "/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Too dark." });
  await page.goto(rushes.url);
  await expect(page.getByRole("button", { name: /Send to agent/ })).toContainText("1");
  await page.getByRole("button", { name: /Send to agent/ }).click();
  await expect(page.getByRole("dialog", { name: "Sent to agent" })).toContainText("picture batch b_1");
  const { batch } = await rushes.api("GET", "/api/batches/latest");
  expect(batch.noteIds).toHaveLength(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Send to agent/ }).click();
  await expect(page.getByRole("status")).toHaveText("Nothing open on Picture to send");
});

test("a tab that isn't built yet says so instead of showing an empty page", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.api("POST", "/api/variants", { stage: "music", name: "Deep house", file: "renders/hero_v1.mp4" });
  await page.goto(rushes.url);
  await page.getByRole("tab", { name: /Music/ }).click();
  await expect(page.getByText("This tab arrives in the next release", { exact: false })).toBeVisible();
});

test("a cut the browser can't play says so instead of showing a black frame", async ({ page, rushes }) => {
  await writeFile(join(rushes.root, "renders", "prores.mov"), Buffer.alloc(4096, 1));
  await rushes.api("POST", "/api/versions", { video: "Hero", file: "renders/prores.mov" });
  await page.goto(rushes.url);
  await expect(page.getByText("This file won't play in a browser", { exact: false })).toBeVisible();
});

test("an agent's change doesn't overwrite a line you're still typing", async ({ page, rushes }) => {
  await rushes.api("PUT", "/api/script", { sections: [{ id: "s1", start: 0, end: 13, current: "First line." }] });
  await page.goto(rushes.url);
  const box = page.getByLabel("Your version of s1");
  await box.click();
  await box.press("End");
  await page.keyboard.type(" Still typing");
  await rushes.api("PUT", "/api/script", { sections: [{ id: "s1", start: 0, end: 13, current: "The agent's new line." }] });
  await expect(page.locator(".srow .cur")).toHaveText("The agent's new line.");
  await expect(box).toHaveValue("First line. Still typing");
});

test("a broken hand edit shows a banner naming the file", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  await writeFile(join(rushes.root, ".rushes", "picks.json"), "{ broken");
  await expect(page.getByText("picks.json has an error", { exact: false })).toBeVisible();
});
