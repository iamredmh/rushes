import { access, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, videoReady } from "./fixture.js";

const CLIP = fileURLToPath(new URL("./fixtures/clip.mp4", import.meta.url));
// A 1x1 transparent PNG, reused for every screenshot the library tests need on disk: its
// content never matters to these tests, only its name and that it's a valid PNG.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

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
  // The test clip is 30fps, so frame 60 is 00m02.00s.
  expect(notes[0]).toMatchObject({ scope: "range", t: 1, tOut: 2, grab: "screenshots/hero_v1_00m02.00s_f60.png" });
  expect(notes[0].box.x).toBeCloseTo(0.25, 1);
  expect(notes[0].box.w).toBeCloseTo(0.5, 1);
  await access(join(rushes.root, "screenshots", "hero_v1_00m02.00s_f60.png"));
});

test("a box on a vertical cut is measured against the picture, not the 16:9 frame", async ({ page, rushes }) => {
  await rushes.addVerticalCut();
  await page.goto(rushes.url);
  await videoReady(page);
  // The frame must fit itself to the 9:16 cut, not stay letterboxed inside 16:9.
  const frame = (await page.locator(".frame").boundingBox())!;
  expect(frame.width / frame.height).toBeLessThan(1);
  expect(frame.width / frame.height).toBeCloseTo(360 / 640, 1);
  await page.keyboard.press("b");
  const overlay = (await page.locator(".overlay").boundingBox())!;
  // A few pixels in from the exact corner, clear of the frame's own rounded corner.
  await page.mouse.move(overlay.x + 6, overlay.y + 6);
  await page.mouse.down();
  await page.mouse.move(overlay.x + overlay.width * 0.5, overlay.y + overlay.height * 0.5, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press("n");
  await page.keyboard.type("Box on a vertical cut.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(1);
  const { notes } = await rushes.api("GET", "/api/notes?stage=picture");
  const close = (v: number, exp: number) => expect(Math.abs(v - exp)).toBeLessThanOrEqual(0.02);
  close(notes[0].box.x, 0);
  close(notes[0].box.y, 0);
  close(notes[0].box.w, 0.5);
  close(notes[0].box.h, 0.5);
});

test("a new cut mid-review waits for a click instead of dropping pending marks", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("i");
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("o");
  await page.keyboard.press("b");
  const frame = (await page.locator(".overlay").boundingBox())!;
  await page.mouse.move(frame.x + frame.width * 0.25, frame.y + frame.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width * 0.75, frame.y + frame.height * 0.75, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".comp .chipx", { hasText: "Box" })).toBeVisible();
  await page.getByLabel("New note").fill("Still deciding what this is about.");
  await rushes.addCut("tighter cut");
  await expect(page.locator(".chipx.go")).toContainText("v2 ready");
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v1");
  // The marks made before the cut arrived are all still there.
  await expect(page.locator(".bar .chipx")).toContainText("0:01.00–0:02.00");
  await expect(page.locator(".comp .chipx", { hasText: "Box" })).toBeVisible();
  expect(await page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(2, 2);
  // A second cut while still holding: the chip names the newest one.
  await rushes.addCut("tighter still");
  await expect(page.locator(".chipx.go")).toContainText("v3 ready");
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v1");
  await page.getByLabel("New note").press("Enter");
  await expect(page.locator(".note")).toHaveCount(1);
  const { notes } = await rushes.api("GET", "/api/notes?stage=picture");
  expect(notes[0]).toMatchObject({ version: "v1", scope: "range", t: 1, tOut: 2 });
  expect(notes[0].box.x).toBeCloseTo(0.25, 1);
  expect(notes[0].box.w).toBeCloseTo(0.5, 1);
  // The chip stays up rather than auto-switching once the pending work clears.
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v1");
  await expect(page.locator(".chipx.go")).toContainText("v3 ready");
  await page.locator(".chipx.go").click();
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v3");
  await expect(page.locator(".chipx.go")).not.toBeVisible();
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

test("a script edit still waiting to save is kept when the agent replaces the script", async ({ page, rushes }) => {
  await rushes.api("PUT", "/api/script", { sections: [{ id: "s1", start: 0, end: 13, current: "First line." }] });
  await page.goto(rushes.url);
  const box = page.getByLabel("Your version of s1");
  await box.fill("First line, edited.");
  // Within the save delay, the agent replaces the whole script, so the row disappears.
  await rushes.api("PUT", "/api/script", { replace: true, sections: [{ id: "s9", start: 0, end: 13, current: "Brand new script." }] });
  // The pending save is flushed, and since s1 is gone it fails visibly instead of silently.
  await expect(page.getByRole("status")).toContainText("Couldn't save S1");
});

test("a note the server rejects stays in the box and says why", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  const long = "x".repeat(4001);
  await page.getByLabel("New note").fill(long);
  await page.getByLabel("New note").press("Enter");
  await expect(page.getByRole("status")).toContainText("Couldn't add the note");
  await expect(page.getByLabel("New note")).toHaveValue(long);
  await expect(page.locator(".note")).toHaveCount(0);
});

test("every project has its own address and title", async ({ page, rushes }) => {
  await page.goto(rushes.url);
  await expect(page).toHaveURL(/\/p\/[a-z2-9]{8}\/$/);
  await expect(page).toHaveTitle("My Film · Rushes");
  const id = new URL(rushes.url).pathname.match(/\/p\/([a-z2-9]{8})\//)![1];
  await expect(page.locator(".pid")).toHaveText(id);
});

test("a pack shows a pill per film, and each film remembers where you were", async ({ page, rushes }) => {
  await rushes.addCut("hero cut");
  await rushes.addCut("cutdown cut", "Cutdown");
  await page.goto(rushes.url);
  await videoReady(page);
  const pack = page.getByRole("navigation", { name: "Films" });
  await expect(pack.getByRole("button")).toHaveCount(2);
  await expect(pack.getByRole("button", { name: /Hero/ })).toHaveAttribute("aria-pressed", "true");
  for (let i = 0; i < 15; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Timecode")).toContainText("0:00.50");
  await page.keyboard.press("]");
  await expect(pack.getByRole("button", { name: /Cutdown/ })).toHaveAttribute("aria-pressed", "true");
  await videoReady(page);
  await expect(page.getByLabel("Timecode")).toContainText("0:00.00");
  await page.keyboard.press("[");
  await expect(pack.getByRole("button", { name: /Hero/ })).toHaveAttribute("aria-pressed", "true");
  await videoReady(page);
  await expect(page.getByLabel("Timecode")).toContainText("0:00.50");
});

test("a film's restored playhead is used once on return, not reapplied when you pick another version", async ({ page, rushes }) => {
  await rushes.addCut("hero cut");
  await rushes.addCut("hero recut");
  await rushes.addCut("cutdown cut", "Cutdown");
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v2");
  for (let i = 0; i < 15; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Timecode")).toContainText("0:00.50");
  await page.keyboard.press("]");
  await videoReady(page);
  await page.keyboard.press("[");
  await videoReady(page);
  await expect(page.getByLabel("Timecode")).toContainText("0:00.50");
  // The restore point was for coming back to the film, not for every cut on it: picking
  // another version now must start at 0, not reuse 0:00.50 a second time.
  await page.getByRole("combobox", { name: "Version" }).selectOption("v1");
  await videoReady(page);
  await expect(page.getByLabel("Timecode")).toContainText("0:00.00");
});

test("switching films with a note half-typed is refused, and the note is kept", async ({ page, rushes }) => {
  await rushes.addCut("hero cut");
  await rushes.addCut("cutdown cut", "Cutdown");
  await page.goto(rushes.url);
  await videoReady(page);
  await page.getByLabel("New note").fill("Still deciding what this is about.");
  await page.getByRole("navigation", { name: "Films" }).getByRole("button", { name: /Cutdown/ }).click();
  await expect(page.getByRole("status")).toHaveText("Add or clear your note on Hero first");
  await expect(page.getByRole("navigation", { name: "Films" }).getByRole("button", { name: /Hero/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("New note")).toHaveValue("Still deciding what this is about.");
});

test("tooltips in the header open below their button, inside the window", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  for (const name of [/Lock picture at v1/, /Keyboard shortcuts/]) {
    const button = page.getByRole("button", { name });
    await button.hover();
    const tip = await button.evaluate((el) => {
      const after = getComputedStyle(el, "::after");
      const box = el.getBoundingClientRect();
      // The tooltip's top edge, from the pseudo-element's computed top (in px, relative to the button).
      return { top: box.top + parseFloat(after.top), buttonBottom: box.bottom, content: after.content };
    });
    expect(tip.content).not.toBe("none");
    expect(tip.top).toBeGreaterThanOrEqual(tip.buttonBottom);
  }
});

test("a locked picture opens on the locked cut", async ({ page, rushes }) => {
  const { version: v1 } = await rushes.addCut("first cut");
  await rushes.addCut("second cut");
  await rushes.api("PUT", "/api/videos/Hero/lock", { version: v1.id });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v1");
  const lockBtn = page.getByRole("button", { name: "Picture locked at v1 · unlock" });
  await expect(lockBtn).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".chipx.go")).toContainText("v2 ready");
  await lockBtn.click();
  await expect.poll(async () => (await rushes.api("GET", "/api/state")).project.videos[0].lockedVersion).toBeNull();
});

test("choosing the newest cut by hand on a locked film doesn't snap back to the lock", async ({ page, rushes }) => {
  const { version: v1 } = await rushes.addCut("first cut");
  await rushes.addCut("second cut");
  await rushes.api("PUT", "/api/videos/Hero/lock", { version: v1.id });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v1");
  await page.getByRole("combobox", { name: "Version" }).selectOption("v2");
  await videoReady(page);
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v2");
  const { project } = await rushes.api("GET", "/api/state");
  expect(project.videos[0].lockedVersion).toBe("v1");
});

test("the lock button names the locked cut even while viewing a newer one", async ({ page, rushes }) => {
  const { version: v1 } = await rushes.addCut("first cut");
  await rushes.addCut("second cut");
  await rushes.api("PUT", "/api/videos/Hero/lock", { version: v1.id });
  await page.goto(rushes.url);
  await videoReady(page);
  await page.getByRole("combobox", { name: "Version" }).selectOption("v2");
  await videoReady(page);
  await expect(page.getByRole("button", { name: "Picture locked at v1 · unlock" })).toHaveAttribute("aria-pressed", "true");
});

test("a version pin left over from peeking at a cut doesn't block the next one from following, once unlocked", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await rushes.api("PUT", "/api/videos/Hero/lock", { version: "v1" });
  await page.goto(rushes.url);
  await videoReady(page);
  await rushes.addCut("second cut"); // v2, arrives while locked at v1
  await expect(page.locator(".chipx.go")).toContainText("v2 ready");
  await page.locator(".chipx.go").click(); // peek at v2 without unlocking: a version pin
  await videoReady(page);
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v2");
  await page.getByRole("button", { name: /unlock/ }).click();
  await expect.poll(async () => (await rushes.api("GET", "/api/state")).project.videos[0].lockedVersion).toBeNull();
  await rushes.addCut("third cut"); // v3, now unlocked: the stale v2 pin must not swallow this
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v3");
});

test("switching films pauses the one playing, and its playhead is remembered even mid-play", async ({ page, rushes }) => {
  await rushes.addCut("hero cut");
  await rushes.addCut("cutdown cut", "Cutdown");
  await page.goto(rushes.url);
  await videoReady(page);
  const pack = page.getByRole("navigation", { name: "Films" });
  await page.keyboard.press(" ");
  await page.waitForTimeout(600);
  await page.keyboard.press("]");
  await expect(pack.getByRole("button", { name: /Cutdown/ })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("[");
  await expect(pack.getByRole("button", { name: /Hero/ })).toHaveAttribute("aria-pressed", "true");
  await videoReady(page);
  const tc = (await page.getByLabel("Timecode").textContent())!;
  const [mm, ss] = tc.split("/")[0]!.trim().split(":");
  const seconds = Number(mm) * 60 + Number(ss);
  expect(seconds).toBeGreaterThanOrEqual(0.4);
  expect(await page.locator("video").evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});

test("the shot strip names each shot, follows the playhead, and notes record their shot", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.api("PUT", "/api/videos/hero/shots", {
    shots: [
      { name: "Title card", start: 0, tag: "establish" },
      { name: "Window rises in", start: 1.7, tag: "reveal" },
      { name: "Wide, cursor enters", start: 2.8 },
    ],
  });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(page.locator(".shot")).toHaveCount(3);
  await expect(page.locator(".shot").nth(0)).toHaveAttribute("aria-current", "true");
  await page.locator(".shot").nth(1).click();
  await expect(page.getByLabel("Timecode")).toContainText("0:01.70");
  await expect(page.locator(".shot").nth(1)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("n");
  await page.keyboard.type("Nice reveal here.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note .shotref")).toHaveText("Shot 02 · Window rises in");
  const { notes } = await rushes.api("GET", "/api/notes?stage=picture");
  expect(notes[0].shot).toEqual({ n: 2, name: "Window rises in" });
  await expect(page.locator(".track .tick")).toHaveCount(2);
});

test("clicking a shot that starts between frames lands a note in that shot, not the one before it", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.api("PUT", "/api/videos/hero/shots", { shots: [{ name: "A", start: 0 }, { name: "B", start: 1.71 }] });
  await page.goto(rushes.url);
  await videoReady(page);
  await page.locator(".shot").nth(1).click();
  // 1.71s falls between frames at 30fps; the seek must land in B's frame, not snap back
  // to the frame before its start, which the strip would still (wrongly) call A's.
  await expect(page.getByLabel("Timecode")).toContainText("0:01.73");
  await expect(page.locator(".shot").nth(1)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("n");
  await page.keyboard.type("Landed in B.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note .shotref")).toHaveText("Shot 02 · B");
  const { notes } = await rushes.api("GET", "/api/notes?stage=picture");
  expect(notes[0].shot).toEqual({ n: 2, name: "B" });
});

test("a cut whose first shot starts after a lead-in gets a tick at every shot, and no current shot before it", async ({ page, rushes }) => {
  await rushes.addCut();
  await rushes.api("PUT", "/api/videos/hero/shots", { shots: [{ name: "Logo", start: 0.5 }, { name: "Hero", start: 2 }] });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(page.locator(".track .tick")).toHaveCount(2);
  await expect(page.locator(".shot[aria-current='true']")).toHaveCount(0);
  // Keys still work once the listener is bound only once: N focuses the note box, I sets In.
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Timecode")).toContainText("0:01.00");
  await expect(page.locator(".shot").nth(0)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("n");
  await expect(page.getByLabel("New note")).toBeFocused();
});

test("a tab left open after its project stops never writes into the project that takes its port", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  await page.keyboard.press("n");
  await page.getByLabel("New note").fill("Still here when it reconnects.");

  await rushes.swapProject();

  await expect(page.locator(".banner.lost")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".banner.lost")).toHaveAttribute("role", "alert");
  await expect(page.locator(".banner.lost")).toContainText("isn't running here any more");
  await expect(page.getByLabel("New note")).toBeVisible();
  await expect(page.getByLabel("New note")).toBeEnabled();

  await page.getByLabel("New note").press("Enter");
  await expect(page.getByLabel("New note")).toHaveValue("Still here when it reconnects.");

  const { notes } = await rushes.api("GET", "/api/notes");
  expect(notes).toEqual([]);
});

test("a grabbed frame is saved as a screenshot and shows up in Assets with its actions", async ({ page, rushes, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("g");
  await expect(page.getByRole("status")).toHaveText("Saved to screenshots/hero_v1_00m01.00s_f30.png");

  await expect(page.getByRole("tab", { name: /Assets/ })).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("7");
  const tile = page.locator(".shot-tile");
  await expect(tile).toHaveCount(1);
  await expect(tile.locator("img")).toBeVisible();
  const dl = tile.getByRole("link", { name: "Download" });
  await expect(dl).toHaveAttribute("href", /download=1/);
  await expect(tile.getByRole("button", { name: "Save as…" })).toBeVisible();

  await tile.getByRole("button", { name: /Show in Finder|Show in Explorer|Open folder/ }).click();
  await expect(page.getByRole("status")).toBeHidden();

  await tile.getByRole("button", { name: "Copy path" }).click();
  await expect(page.getByRole("status")).toHaveText("Path copied");
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  const { assets } = await rushes.api("GET", "/api/assets");
  expect(clipboard).toBe(assets[0].abs);
});

test("the lightbox moves focus to Close, traps Tab inside itself, and returns focus on close", async ({ page, rushes, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  await page.keyboard.press("g");
  await expect(page.getByRole("status")).toContainText("Saved to screenshots/");
  await page.keyboard.press("7");
  const thumb = page.getByRole("button", { name: /full size/ });
  await thumb.click();

  const dialog = page.getByRole("dialog");
  const close = dialog.getByRole("button", { name: "Close" });
  await expect(close).toBeFocused();

  // Tab from the last control (Close) wraps round to the first.
  await page.keyboard.press("Tab");
  const download = dialog.getByRole("link", { name: "Download" });
  await expect(download).toBeFocused();

  // Shift+Tab from the first control wraps back to Close.
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(thumb).toBeFocused();
});

test("a grab alone doesn't stop you switching films", async ({ page, rushes }) => {
  await rushes.addCut("hero cut");
  await rushes.addCut("cutdown cut", "Cutdown");
  await page.goto(rushes.url);
  await videoReady(page);
  await page.keyboard.press("g");
  await expect(page.getByRole("status")).toContainText("Saved to screenshots/");
  await page.keyboard.press("]");
  const pack = page.getByRole("navigation", { name: "Films" });
  await expect(pack.getByRole("button", { name: /Cutdown/ })).toHaveAttribute("aria-pressed", "true");
  await videoReady(page);
  await page.keyboard.press("[");
  await expect(pack.getByRole("button", { name: /Hero/ })).toHaveAttribute("aria-pressed", "true");
  await videoReady(page);
  await page.keyboard.press("n");
  await page.keyboard.type("Kept the grab after switching films.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(1);
  const { notes } = await rushes.api("GET", "/api/notes?stage=picture");
  expect(notes[0].grab).toMatch(/^screenshots\/hero_v1_/);
});

test("a deleted file is marked missing in Assets", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  await rm(join(rushes.root, "renders", "hero_v1.mp4"));
  await page.reload();
  await expect(page.getByRole("tab", { name: /Assets/ })).toHaveAttribute("aria-disabled", "false");
  await page.getByRole("tab", { name: /Assets/ }).click();
  // The library's Cuts folder defaults to a poster-frame grid (§16.1); switch to the list view
  // to get back the plain row this test is about.
  await page.getByRole("button", { name: "List view" }).click();
  // The row itself isn't interactive, so it carries no aria-disabled -- just the "missing"
  // class for its own styling. The controls inside it are what AT and :hover see as disabled.
  const row = page.locator(".arow", { hasText: "hero_v1.mp4" });
  await expect(row).toHaveClass(/missing/);
  await expect(row.getByRole("link", { name: "Download" })).toHaveAttribute("aria-disabled", "true");
});

test("the disabled Send to agent button on Assets still shows its tooltip", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  await page.keyboard.press("7");
  const button = page.getByRole("button", { name: "Send to agent" });
  await expect(button).toBeDisabled();
  // A disabled control must still show its tooltip on hover: `pointer-events: none` on the
  // dimmed look would stop :hover (and so the tooltip) firing at all. The tooltip fades in
  // over 0.12s (styles.css), so poll for it rather than reading the mid-transition value.
  await button.hover();
  await expect.poll(() => button.evaluate((el) => Number(getComputedStyle(el, "::after").opacity))).toBe(1);
  const pointerEvents = await button.evaluate((el) => getComputedStyle(el).pointerEvents);
  expect(pointerEvents).not.toBe("none");
});

test("a late grab doesn't attach to the wrong film", async ({ page, rushes }) => {
  await rushes.addCut("hero cut");
  await rushes.addCut("cutdown cut", "Cutdown");
  await page.goto(rushes.url);
  await videoReady(page);

  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/grabs", async (route) => {
    await gate;
    await route.continue();
  });

  await page.keyboard.press("g");
  // Switch films before the grab's POST resolves.
  await page.keyboard.press("]");
  const pack = page.getByRole("navigation", { name: "Films" });
  await expect(pack.getByRole("button", { name: /Cutdown/ })).toHaveAttribute("aria-pressed", "true");
  await videoReady(page);

  release();
  await expect(page.getByRole("status")).toContainText("Saved to screenshots/");

  // The late grab must never attach to Cutdown's note box: it was taken on Hero.
  await expect(page.locator(".comp .chipx", { hasText: "Frame" })).toHaveCount(0);

  await page.keyboard.press("[");
  await videoReady(page);
  // Nor does it retroactively attach back on Hero on return: nothing was watching to carry
  // it across the switch, so a grab that arrives after you've moved on is dropped from the
  // "attach to the next note" convenience entirely. The file itself is still saved to disk
  // (and still shows up in Assets) regardless.
  await expect(page.locator(".comp .chipx", { hasText: "Frame" })).toHaveCount(0);
});

test("a late grab doesn't attach to a newer cut of the same film", async ({ page, rushes }) => {
  await rushes.addCut("first cut");
  await page.goto(rushes.url);
  await videoReady(page);

  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/grabs", async (route) => {
    await gate;
    await route.continue();
  });

  await page.keyboard.press("g");
  // A new cut on the same film lands before the grab's POST resolves. Nothing's pending (a
  // grab alone doesn't count), so the player follows it straight away -- no held chip, just
  // a new version prop under the same mounted Picture instance.
  await rushes.addCut("tighter cut");
  await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("v2");

  release();
  await expect(page.getByRole("status")).toContainText("Saved to screenshots/");

  // The late grab was taken against v1; it must never attach to v2's note box.
  await expect(page.locator(".comp .chipx", { hasText: "Frame" })).toHaveCount(0);
});

test("a grab belongs to one film, never the next one you switch to", async ({ page, rushes }) => {
  await rushes.addCut("hero cut");
  await rushes.addCut("cutdown cut", "Cutdown");
  await page.goto(rushes.url);
  await videoReady(page);

  const pack = page.getByRole("navigation", { name: "Films" });
  const chip = page.locator(".comp .chipx", { hasText: "Frame" });
  const goTo = async (key: string, name: RegExp) => {
    await page.keyboard.press(key);
    await expect(pack.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
    await videoReady(page);
  };

  await page.keyboard.press("g");
  await expect(page.getByRole("status")).toContainText("Saved to screenshots/");

  // G on Hero, then ], [, ]: Cutdown never shows Hero's chip, and Hero keeps its own.
  await goTo("]", /Cutdown/);
  await expect(chip).toHaveCount(0);
  await goTo("[", /Hero/);
  await expect(chip).toHaveCount(1);
  await goTo("]", /Cutdown/);
  await expect(chip).toHaveCount(0);

  // Submitting the note on Hero clears its grab; it doesn't come back on a later return.
  await goTo("[", /Hero/);
  await page.keyboard.press("n");
  await page.keyboard.type("Attached the grab before switching away.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(1);
  await page.keyboard.press("Escape");

  await goTo("]", /Cutdown/);
  await goTo("[", /Hero/);
  await expect(chip).toHaveCount(0);
});

test("a grab survives leaving the Picture tab and coming back", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);

  const chip = page.locator(".comp .chipx", { hasText: "Frame" });
  await page.keyboard.press("g");
  await expect(page.getByRole("status")).toContainText("Saved to screenshots/");

  await page.keyboard.press("7");
  await expect(page.getByRole("tab", { name: /Assets/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("2");
  await videoReady(page);
  await expect(chip).toHaveCount(1);

  await page.keyboard.press("n");
  await page.keyboard.type("Still has the grab after a tab round trip.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".note")).toHaveCount(1);
  await page.keyboard.press("Escape");

  await page.keyboard.press("7");
  await page.keyboard.press("2");
  await videoReady(page);
  await expect(chip).toHaveCount(0);
});

test("the note box's send button stays inside the box, empty and grown with text", async ({ page, rushes }) => {
  await rushes.addCut();
  await page.goto(rushes.url);
  await videoReady(page);
  const input = page.getByLabel("New note");
  const send = page.getByRole("button", { name: "Add note" });

  const expectSendInsideInput = async () => {
    const inputBox = (await input.boundingBox())!;
    const sendBox = (await send.boundingBox())!;
    expect(sendBox.x + sendBox.width).toBeLessThanOrEqual(inputBox.x + inputBox.width - 4);
    expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(inputBox.y + inputBox.height - 4);
  };

  await expectSendInsideInput();
  await input.fill("Line one\nLine two\nLine three\nLine four\nLine five");
  await expectSendInsideInput();
});

// ---- Plan 2d, Task 2: the Assets library (§16) ----

test("the library has a folder sidebar with counts, and ↑/↓ moves between folders", async ({ page, rushes }) => {
  await mkdir(join(rushes.root, "screenshots"), { recursive: true });
  await writeFile(join(rushes.root, "screenshots", "hero_v1_00m00.00s_f1.png"), TINY_PNG);
  await writeFile(join(rushes.root, "screenshots", "hero_v1_00m01.00s_f30.png"), TINY_PNG);
  await rushes.addCut();
  await writeFile(join(rushes.root, "script.md"), "# Title\n");
  await writeFile(join(rushes.root, "image.png"), TINY_PNG);
  await rushes.api("POST", "/api/files", { file: "image.png", kind: "image" });

  await page.goto(rushes.url);
  await expect(page.getByRole("tab", { name: /Assets/ })).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("7");

  const sidebar = page.getByRole("navigation", { name: "Folders" });
  const screenshots = sidebar.getByRole("button", { name: /Screenshots/ });
  const cuts = sidebar.getByRole("button", { name: /Cuts/ });
  const docs = sidebar.getByRole("button", { name: /Scripts & docs/ });
  const images = sidebar.getByRole("button", { name: /Images/ });
  const exports_ = sidebar.getByRole("button", { name: /Exports/ });

  await expect(screenshots).toBeVisible();
  await expect(screenshots.locator(".count")).toHaveText("2");
  await expect(cuts).toBeVisible();
  await expect(cuts.locator(".count")).toHaveText("1");
  await expect(docs).toBeVisible();
  await expect(docs.locator(".count")).toHaveText("1");
  await expect(images).toBeVisible();
  await expect(images.locator(".count")).toHaveText("1");
  // Exports always shows, even with nothing in it yet.
  await expect(exports_).toBeVisible();
  await expect(exports_.locator(".count")).toHaveText("0");
  // Empty folders (no voiceover, music, sfx, captions, delivery or edit files registered) never show.
  await expect(sidebar.getByRole("button", { name: /Voiceover/ })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: /^Music/ })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: /Sound effects/ })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: /Captions/ })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: /Delivery/ })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: /Edit files/ })).toHaveCount(0);

  // Screenshots sorts first, and is already selected.
  await expect(screenshots).toHaveAttribute("aria-current", "true");
  await screenshots.focus();
  await page.keyboard.press("ArrowDown");
  await expect(cuts).toHaveAttribute("aria-current", "true");
  await expect(screenshots).not.toHaveAttribute("aria-current", "true");
  await expect(page.locator(".aheader h2")).toContainText("Cuts");
  await page.keyboard.press("ArrowUp");
  await expect(screenshots).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".aheader h2")).toContainText("Screenshots");
});

test("search and the film filter narrow the screenshots", async ({ page, rushes }) => {
  await rushes.addCut("", "Hero");
  await rushes.addCut("", "Cutdown");
  await page.goto(rushes.url);
  await videoReady(page);
  await page.keyboard.press("g");
  await expect(page.getByRole("status")).toContainText("Saved to screenshots/");
  await page.keyboard.press("]");
  await videoReady(page);
  await page.keyboard.press("g");
  await expect(page.getByRole("status")).toContainText("Saved to screenshots/");

  await page.keyboard.press("7");
  await expect(page.locator(".shot-tile")).toHaveCount(2);

  const search = page.getByRole("searchbox", { name: "Search" });
  await search.fill("hero");
  await expect(page.locator(".shot-tile")).toHaveCount(1);
  await search.fill("");
  await expect(page.locator(".shot-tile")).toHaveCount(2);

  const film = page.getByRole("combobox", { name: "Film" });
  await film.selectOption({ label: "Cutdown" });
  await expect(page.locator(".shot-tile")).toHaveCount(1);
  await film.selectOption({ label: "All films" });
  await expect(page.locator(".shot-tile")).toHaveCount(2);
});

test("a script previews as Markdown, safely", async ({ page, rushes }) => {
  await writeFile(join(rushes.root, "script.md"), "# Title\n\nSome text with <script>alert(1)</script> in it.\n");
  await page.goto(rushes.url);
  await expect(page.getByRole("tab", { name: /Assets/ })).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("7");

  // The title itself is the select control (I3), not the whole row.
  await page.locator(".arow.previewable", { hasText: "script.md" }).getByRole("button", { name: "script.md" }).click();
  const preview = page.locator(".apreview");
  await expect(preview.locator("h1")).toHaveText("Title");
  await expect(preview).toContainText("<script>alert(1)</script>");
  // The literal text renders -- never a real <script> element inside the preview.
  await expect(preview.locator("script")).toHaveCount(0);
});

test("keyboard users can trigger a preview row's actions and select it (I3)", async ({ page, rushes, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await writeFile(join(rushes.root, "brief.md"), "# Brief\n");
  await writeFile(join(rushes.root, "notes.md"), "# Notes\n");

  await page.goto(rushes.url);
  await expect(page.getByRole("tab", { name: /Assets/ })).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("7");
  await expect(page.locator(".aheader h2")).toContainText("Scripts & docs");

  // "brief.md" sorts first and previews by default; its Copy-path button must fire on a keyboard
  // Enter the same as a click does (the old row-level keydown handler ate this).
  const briefRow = page.locator(".arow.previewable", { hasText: "brief.md" });
  await briefRow.getByRole("button", { name: "Copy path" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Path copied");

  // The title is its own select control: Tab to "notes.md" and press Enter to preview it.
  const notesSelect = page.locator(".arow.previewable", { hasText: "notes.md" }).getByRole("button", { name: "notes.md" });
  await notesSelect.focus();
  await page.keyboard.press("Enter");
  await expect(notesSelect).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".apreview h1")).toHaveText("Notes");
});

test("audio plays inline, one at a time, and stops when you leave the folder", async ({ page, rushes }) => {
  await copyFile(CLIP, join(rushes.root, "bed-a.mp4"));
  await copyFile(CLIP, join(rushes.root, "bed-b.mp4"));
  await rushes.api("POST", "/api/variants", { stage: "music", name: "Bed A", file: "bed-a.mp4" });
  await rushes.api("POST", "/api/variants", { stage: "music", name: "Bed B", file: "bed-b.mp4" });

  await page.goto(rushes.url);
  await expect(page.getByRole("tab", { name: /Assets/ })).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("7");
  await expect(page.locator(".aheader h2")).toContainText("Music");
  // A list-only folder never offers the grid/list toggle (I5) -- Music's tiles would be
  // non-images under an <img>, and the Play button would vanish into the broken grid.
  await expect(page.locator('.seg[aria-label="View"]')).toHaveCount(0);

  const rows = page.locator(".arow");
  await expect(rows).toHaveCount(2);
  const audio = page.locator("audio");
  // Row order depends on modified time (Newest is the default sort), which isn't something to
  // pin a test to -- just use whichever row comes first. The accessible name is stable
  // ("Play <name>") regardless of state (M4); aria-pressed, not a swapped label, says whether
  // it's currently playing.
  const playA = rows.nth(0).getByRole("button", { name: /^Play / });
  const playB = rows.nth(1).getByRole("button", { name: /^Play / });

  await playA.click();
  await expect.poll(() => audio.evaluate((el) => (el as HTMLAudioElement).paused)).toBe(false);
  await expect(playA).toHaveAttribute("aria-pressed", "true");

  // Only one plays at a time: starting the second row's playback takes over the one shared player.
  await playB.click();
  await expect(playA).toHaveAttribute("aria-pressed", "false");
  await expect(playB).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => audio.evaluate((el) => (el as HTMLAudioElement).paused)).toBe(false);

  // Leaving the folder stops it.
  await page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: /Exports/ }).click();
  await expect.poll(() => audio.evaluate((el) => (el as HTMLAudioElement).paused)).toBe(true);
});

test("audio stops when you switch tabs (Assets → Picture and back)", async ({ page, rushes }) => {
  await rushes.addCut();
  await copyFile(CLIP, join(rushes.root, "bed.mp4"));
  await rushes.api("POST", "/api/variants", { stage: "music", name: "Bed", file: "bed.mp4" });

  await page.goto(rushes.url);
  await videoReady(page);
  await page.keyboard.press("7");
  // A cut also exists (to unlock Picture), so Cuts -- not Music -- is the default folder.
  await page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: /^Music/ }).click();
  await expect(page.locator(".aheader h2")).toContainText("Music");
  await page.getByRole("button", { name: "Play Bed" }).click();
  await expect.poll(() => page.locator("audio").evaluate((el) => (el as HTMLAudioElement).paused)).toBe(false);

  // Assets unmounts entirely on a tab switch, taking the shared <audio> element with it --
  // there's nothing left in the DOM that could keep playing.
  await page.keyboard.press("2");
  await videoReady(page);
  await expect(page.locator("audio")).toHaveCount(0);

  // Back on Assets, Music gets a fresh player that never auto-resumes. (Cuts is the default
  // folder again -- the selection isn't remembered across a tab round trip -- so select Music.)
  await page.keyboard.press("7");
  await page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: /^Music/ }).click();
  await expect(page.locator(".aheader h2")).toContainText("Music");
  await expect(page.locator("audio")).toHaveCount(1);
  await expect.poll(() => page.locator("audio").evaluate((el) => (el as HTMLAudioElement).paused)).toBe(true);
});

test("a rejected play() resets the row and shows a toast, instead of claiming to be playing (M4)", async ({ page, rushes }) => {
  await copyFile(CLIP, join(rushes.root, "bed.mp4"));
  await rushes.api("POST", "/api/variants", { stage: "music", name: "Bed", file: "bed.mp4" });

  // Forces every play() to reject, standing in for a browser blocking it or a bad file -- real
  // media playback has nothing reliable to fail on in a test environment otherwise.
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = () => Promise.reject(new Error("blocked"));
  });

  await page.goto(rushes.url);
  await expect(page.getByRole("tab", { name: /Assets/ })).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("7");
  await expect(page.locator(".aheader h2")).toContainText("Music");

  const playBed = page.getByRole("button", { name: "Play Bed" });
  await playBed.click();
  await expect(page.getByRole("status")).toContainText("Couldn't play");
  await expect(playBed).toHaveAttribute("aria-pressed", "false");
});

test("Open is offered for a doc and not for an unsafe file, and Export notes adds a file to Exports", async ({ page, rushes }) => {
  await writeFile(join(rushes.root, "brief.md"), "# Brief\n");
  await writeFile(join(rushes.root, "x.command"), "#!/bin/sh\necho hi\n");
  await rushes.api("POST", "/api/files", { file: "x.command", kind: "edit" });

  await page.goto(rushes.url);
  await expect(page.getByRole("tab", { name: /Assets/ })).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("7");

  // Scripts & docs sorts before Edit files, so it's already selected.
  await expect(page.locator(".aheader h2")).toContainText("Scripts & docs");
  const docRow = page.locator(".arow", { hasText: "brief.md" });
  await expect(docRow.getByRole("button", { name: "Open" })).toBeVisible();

  const sidebar = page.getByRole("navigation", { name: "Folders" });
  await sidebar.getByRole("button", { name: /Edit files/ }).click();
  const editRow = page.locator(".arow", { hasText: "x.command" });
  await expect(editRow).toBeVisible();
  await expect(editRow.getByRole("button", { name: "Open" })).toHaveCount(0);

  await sidebar.getByRole("button", { name: /Exports/ }).click();
  await expect(page.locator(".aheader h2")).toContainText("Exports");
  await expect(page.locator(".arow")).toHaveCount(0);
  await page.getByRole("button", { name: "Export notes" }).click();
  await expect(page.getByRole("status")).toContainText("Saved to exports/");
  await expect(page.locator(".arow")).toHaveCount(1);
  await expect(page.locator(".arow")).toContainText("-notes-");
});

test("a file dropped into the project root appears once something refreshes Assets (I7)", async ({ page, rushes }) => {
  await writeFile(join(rushes.root, "existing.md"), "# Existing\n");
  await page.goto(rushes.url);
  await expect(page.getByRole("tab", { name: /Assets/ })).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("7");
  await expect(page.locator(".aheader h2")).toContainText("Scripts & docs");
  await expect(page.locator(".arow")).toHaveCount(1);

  // The watcher only covers .rushes/, so a new root file needs one of I7's own triggers. Written
  // only after the first render, so it's genuinely new to this tab, not just loaded late.
  await writeFile(join(rushes.root, "notes2.md"), "# Notes 2\n");

  // Switching folders and back is one of those triggers (Exports always shows, so it's always
  // there to switch to).
  const sidebar = page.getByRole("navigation", { name: "Folders" });
  await sidebar.getByRole("button", { name: /Exports/ }).click();
  await sidebar.getByRole("button", { name: /Scripts & docs/ }).click();
  await expect(page.locator(".arow")).toHaveCount(2);
  // Order isn't asserted here: the default sort is newest-first, so it depends on mtime.
  await expect(page.locator(".arow", { hasText: "existing.md" })).toHaveCount(1);
  await expect(page.locator(".arow", { hasText: "notes2.md" })).toHaveCount(1);
});

test("200 screenshots stay usable", async ({ page, rushes }) => {
  await mkdir(join(rushes.root, "screenshots"), { recursive: true });
  await Promise.all(
    Array.from({ length: 200 }, (_, i) => writeFile(join(rushes.root, "screenshots", `hero_v1_00m00.00s_f${i}.png`), TINY_PNG)),
  );
  await page.goto(rushes.url);
  await expect(page.getByRole("tab", { name: /Assets/ })).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("7");
  await expect(page.locator(".shot-tile")).toHaveCount(200);

  const search = page.getByRole("searchbox", { name: "Search" });
  await search.fill("f199");
  await expect(page.locator(".shot-tile")).toHaveCount(1);
});

test("Cuts posters are lazy: not every tile loads a video before you scroll (I6)", async ({ page, rushes }) => {
  // 40 versions of the same film, all pointing at one reused clip file.
  await copyFile(CLIP, join(rushes.root, "renders", "hero.mp4"));
  for (let i = 0; i < 40; i++) {
    await rushes.api("POST", "/api/versions", { video: "Hero", file: "renders/hero.mp4" });
  }
  await page.goto(rushes.url);
  await expect(page.getByRole("tab", { name: /Assets/ })).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("7");
  await expect(page.locator(".aheader h2")).toContainText("Cuts");

  const tiles = page.locator(".shot-tile");
  await expect(tiles).toHaveCount(40);
  // Every tile mounts a <video> element, but only the ones near the viewport get a src (§16.1 /
  // I6) -- loading metadata for all 40 at once is exactly what this rule exists to prevent.
  await expect(page.locator(".shot-tile video")).toHaveCount(40);
  const withSrc = await page.locator(".shot-tile video[src]").count();
  expect(withSrc).toBeLessThan(40);
});
