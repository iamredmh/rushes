import { access, rm, writeFile } from "node:fs/promises";
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
  const row = page.locator(".arow", { hasText: "hero_v1.mp4" });
  await expect(row).toHaveAttribute("aria-disabled", "true");
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
