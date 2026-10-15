import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { test, expect } from "./fixture.js";

// §25: the Visuals tab: stills and carousels, one page at a time, marked up region by region.

function crc32(b: Buffer): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
/** A real, solid-colour png a browser can draw. */
function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

type Rushes = Parameters<Parameters<typeof test>[2]>[0]["rushes"];
async function pic(rushes: Rushes, rel: string, w: number, h: number, rgb: [number, number, number]) {
  await mkdir(join(rushes.root, rel, ".."), { recursive: true });
  await writeFile(join(rushes.root, rel), solidPng(w, h, rgb));
}

/** A 6-page carousel (4:5) and a still in two ratios (4:5 and 16:9). */
async function withVisuals(rushes: Rushes) {
  for (let i = 1; i <= 6; i++) await pic(rushes, `visuals/launch/p${i}.png`, 108, 135, [40 * i, 90, 160]);
  await pic(rushes, "visuals/launch/p3-v2.png", 108, 135, [20, 200, 90]);
  await pic(rushes, "visuals/quote-4x5.png", 108, 135, [120, 60, 160]);
  await pic(rushes, "visuals/quote-16x9.png", 160, 90, [160, 60, 120]);
  await rushes.api("POST", "/api/visuals", { name: "Launch carousel", pages: [1, 2, 3, 4, 5, 6].map((i) => ({ files: [`visuals/launch/p${i}.png`] })) });
  await rushes.api("POST", "/api/visuals", { visual: "launch-carousel", label: "Greener page 3", pages: [{ n: 3, files: ["visuals/launch/p3-v2.png"] }] });
  await rushes.api("POST", "/api/visuals", { name: "Quote still", pages: [{ files: ["visuals/quote-4x5.png", "visuals/quote-16x9.png"] }] });
}

const section = (page: import("@playwright/test").Page, id: string) => page.locator(`.vz[data-visual="${id}"]`);
const frame = (page: import("@playwright/test").Page, id: string) => page.locator(`.vzframe[data-frame="${id}"]`);
const notesJson = async (rushes: Rushes) => (await rushes.api("GET", "/api/notes?stage=visuals")).notes as any[];

async function openVisuals(page: import("@playwright/test").Page, rushes: Rushes) {
  await page.goto(rushes.url);
  await page.getByRole("tab", { name: /Visuals/ }).click();
  await expect(section(page, "launch-carousel")).toBeVisible();
}

/** Drag across part of the current visual's frame (fractions of the frame). */
async function drag(page: import("@playwright/test").Page, id: string, from: [number, number], to: [number, number]) {
  const box = (await frame(page, id).boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ((from[0] + to[0]) / 2), box.y + box.height * ((from[1] + to[1]) / 2), { steps: 4 });
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 4 });
  await page.mouse.up();
}

test("Visuals is a locked tab with a prompt until a visual is registered, then opens", async ({ page, rushes }) => {
  await page.goto(rushes.url);
  const tab = page.getByRole("tab", { name: /Visuals/ });
  await expect(tab).toHaveAttribute("data-locked", "true");
  await tab.click();
  await expect(page.getByLabel("Prompt for your agent")).toHaveValue(/rushes_add_visual/);
  await withVisuals(rushes);
  await expect(tab).not.toHaveAttribute("data-locked", "true");
  await tab.click();
  await expect(section(page, "launch-carousel")).toBeVisible();
});

test("key 7 opens Visuals and key 8 opens Assets", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await page.goto(rushes.url);
  await page.keyboard.press("7");
  await expect(page.getByRole("tab", { name: /Visuals/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("8");
  await expect(page.getByRole("tab", { name: /Assets/ })).toHaveAttribute("aria-selected", "true");
});

test("scrolling makes the visual in the middle the current one, and the composer and notes column follow", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await rushes.api("POST", "/api/notes", { stage: "visuals", scope: "whole", version: "v2", on: "launch-carousel/3", format: "4x5", box: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, text: "Headline too long." });
  await rushes.api("POST", "/api/notes", { stage: "visuals", scope: "whole", version: "v1", on: "quote-still/1", format: "4x5", pin: { x: 0.5, y: 0.5 }, text: "What is this circle?" });
  await openVisuals(page, rushes);
  await expect(section(page, "launch-carousel")).toHaveClass(/cur/);
  await expect(page.locator(".vztarget")).toContainText("Adding to");
  await expect(page.locator(".vztarget")).toContainText("Launch carousel · page 1 · 4:5 · v2");
  await expect(page.locator('.vzgrp[data-grp="launch-carousel"]')).toHaveClass(/cur/);
  await expect(page.locator('.vzgrp[data-grp="quote-still"]')).not.toHaveClass(/cur/);
  await section(page, "quote-still").scrollIntoViewIfNeeded();
  await page.locator(".vzscroll").evaluate((el) => el.scrollTo({ top: (el.querySelector('[data-visual="quote-still"]') as HTMLElement).offsetTop, behavior: "instant" }));
  await expect(section(page, "quote-still")).toHaveClass(/cur/);
  await expect(page.locator(".vztarget")).toContainText("Quote still · 4:5 · v1");
  await expect(page.locator('.vzgrp[data-grp="quote-still"]')).toHaveClass(/cur/);
  await expect(section(page, "launch-carousel")).not.toHaveClass(/cur/);
});

test("the composer always names the visual in the middle of the screen, however far or in which order you scroll", async ({ page, rushes }) => {
  // Eight visuals, as a real project has, some with newer versions: the composer's target is the one in the middle, at its newest.
  for (let i = 1; i <= 8; i++) await pic(rushes, `visuals/v${i}.png`, 108, 135, [30 * i, 90, 160]);
  await pic(rushes, "visuals/v-new.png", 108, 135, [20, 200, 90]);
  for (let i = 1; i <= 8; i++) await rushes.api("POST", "/api/visuals", { name: `Post ${i}`, pages: [{ files: [`visuals/v${i}.png`] }] });
  for (const id of ["post-3", "post-7"]) await rushes.api("POST", "/api/visuals", { visual: id, label: "Newer", pages: [{ n: 1, files: ["visuals/v-new.png"] }] });
  await page.goto(rushes.url);
  await page.getByRole("tab", { name: /Visuals/ }).click();
  await expect(section(page, "post-1")).toBeVisible();
  const state = () =>
    page.evaluate(() => {
      const sc = document.querySelector<HTMLElement>(".vzscroll")!;
      const line = sc.getBoundingClientRect().top + sc.clientHeight / 2;
      const inMiddle = [...sc.querySelectorAll<HTMLElement>(".vz")].find((e) => e.getBoundingClientRect().top <= line && line < e.getBoundingClientRect().bottom);
      return { middle: inMiddle?.querySelector("h2")?.textContent?.trim() ?? "", target: document.querySelector(".vztarget b")?.textContent ?? "" };
    });
  const jump = (index: number, nudge = 0) =>
    page.evaluate(async ([k, n]) => {
      const sc = document.querySelector<HTMLElement>(".vzscroll")!;
      const el = sc.querySelectorAll<HTMLElement>(".vz")[k as number];
      sc.style.scrollBehavior = "auto";
      // The scroll position that puts the middle of the scroll area at the middle of that visual (+ a nudge).
      const top = sc.scrollTop + (el.getBoundingClientRect().top + el.offsetHeight / 2 - (sc.getBoundingClientRect().top + sc.clientHeight / 2)) + (n as number);
      sc.scrollTo({ top, behavior: "instant" });
      await new Promise((r) => setTimeout(r, 250));
    }, [index, nudge] as const);
  // Far jumps, back-and-forth, and parking the line right on a boundary between two visuals before settling.
  for (const [k, nudge] of [[3, 0], [6, 0], [1, 0], [6, 0], [5, 0], [7, 0], [2, 0], [6, 368], [6, 0], [2, -368], [2, 0], [4, 0], [0, 0]] as const) {
    await jump(k, nudge);
    await jump(k);
    const { middle, target } = await state();
    expect(middle).not.toBe("");
    expect(target, `after jumping to visual ${k + 1}`).toContain(middle);
  }
  // The version in the target is the one on screen: Post 7 has a newer version.
  await jump(6);
  await expect.poll(async () => (await state()).target).toContain("v2");
});

test("a version registered while you are looking back at an older one brings you to the newest", async ({ page, rushes }) => {
  for (let i = 1; i <= 3; i++) await pic(rushes, `visuals/s-v${i}.png`, 108, 135, [60 * i, 90, 160]);
  await rushes.api("POST", "/api/visuals", { name: "Scanner", pages: [{ files: ["visuals/s-v1.png"] }] });
  await rushes.api("POST", "/api/notes", { stage: "visuals", scope: "whole", version: "v1", on: "scanner/1", format: "4x5", text: "Remove the QR code." });
  await rushes.api("POST", "/api/visuals", { visual: "scanner", label: "QR gone", pages: [{ n: 1, files: ["visuals/s-v2.png"] }] });
  await page.goto(rushes.url);
  await page.getByRole("tab", { name: /Visuals/ }).click();
  await expect(section(page, "scanner")).toBeVisible();
  await expect(section(page, "scanner").locator(".vzchip").first()).toHaveText("v2");
  // Open the old note to see where it was: that looks back at v1, and says so.
  await page.locator(".vznote", { hasText: "Remove the QR code." }).click();
  await expect(page.locator(".vzbanner")).toContainText("Viewing v1");
  // The agent registers v3: you are taken to it, not left on v1.
  await rushes.api("POST", "/api/visuals", { visual: "scanner", label: "Cleaner", pages: [{ n: 1, files: ["visuals/s-v3.png"] }] });
  await expect(page.locator(".vzbanner")).toHaveCount(0);
  await expect(section(page, "scanner").locator(".vzchip").first()).toHaveText("v3");
  await expect(page.locator(".vztarget")).toContainText("v3");
});

test("Return submits the note, Shift+Return is a new line, and Cmd+Return still submits", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await openVisuals(page, rushes);
  const box = page.getByLabel("Note text");
  await box.click();
  await box.fill("First line");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("second line");
  await expect(box).toHaveValue("First line\nsecond line");
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
  await expect.poll(async () => (await notesJson(rushes)).length).toBe(1);
  expect((await notesJson(rushes))[0]).toMatchObject({ stage: "visuals", scope: "whole", text: "First line\nsecond line" });
  // An empty box does nothing on Return; Cmd+Return still adds.
  await page.keyboard.press("Enter");
  await box.fill("Third");
  await page.keyboard.press("Meta+Enter");
  await expect.poll(async () => (await notesJson(rushes)).length).toBe(2);
});

test("dragging draws a region, a click drops a point, and Add note saves them on the right page, ratio and version", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await openVisuals(page, rushes);
  await page.getByRole("button", { name: "Page 4" }).click();
  await expect(page.locator(".vztarget")).toContainText("page 4");
  await drag(page, "launch-carousel", [0.1, 0.2], [0.5, 0.4]);
  await expect(page.locator(".vzbox.draft")).toBeVisible();
  await expect(page.getByLabel("Note text")).toBeFocused();
  await page.getByLabel("Note text").fill("Shorten the headline.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.locator(".vzbox:not(.draft)")).toHaveCount(1);
  await frame(page, "launch-carousel").click({ position: { x: 20, y: 100 } });
  await expect(page.locator(".vzpin.draft")).toBeVisible();
  await page.getByLabel("Note text").fill("Logo touches the edge.");
  await page.keyboard.press("Meta+Enter");
  await expect(page.locator(".vzpin:not(.draft)")).toHaveCount(1);
  const notes = await notesJson(rushes);
  expect(notes).toHaveLength(2);
  expect(notes[0]).toMatchObject({ stage: "visuals", on: "launch-carousel/4", version: "v2", format: "4x5", scope: "whole", text: "Shorten the headline." });
  expect(notes[0].box.w).toBeGreaterThan(0.3);
  expect(notes[1]).toMatchObject({ on: "launch-carousel/4", format: "4x5", box: null, text: "Logo touches the edge." });
  expect(notes[1].pin.x).toBeGreaterThan(0);
});

test("a whole-image note applies to every ratio, or just the one in view", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await openVisuals(page, rushes);
  await page.locator(".vzscroll").evaluate((el) => el.scrollTo({ top: (el.querySelector('[data-visual="quote-still"]') as HTMLElement).offsetTop, behavior: "instant" }));
  await expect(section(page, "quote-still")).toHaveClass(/cur/);
  await page.getByRole("button", { name: "Whole image", exact: true }).click();
  await page.getByLabel("Note text").fill("Feels flat.");
  await page.getByRole("button", { name: "Add note" }).click();
  await page.getByRole("button", { name: "Whole image", exact: true }).click();
  await page.getByRole("checkbox", { name: /Just 4:5/ }).check();
  await page.getByLabel("Note text").fill("Only for portrait.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect.poll(async () => (await notesJson(rushes)).map((n) => n.format)).toEqual([null, "4x5"]);
});

test("a draft stays on the visual it began on, and a new mark elsewhere is refused while it has words", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await openVisuals(page, rushes);
  await drag(page, "launch-carousel", [0.1, 0.2], [0.5, 0.4]);
  await page.getByLabel("Note text").fill("Half-written thought");
  await page.locator(".vzscroll").evaluate((el) => el.scrollTo({ top: (el.querySelector('[data-visual="quote-still"]') as HTMLElement).offsetTop, behavior: "instant" }));
  await expect(section(page, "quote-still")).toHaveClass(/cur/);
  await expect(page.locator(".vztarget")).toContainText("Draft for");
  await expect(page.locator(".vztarget")).toContainText("Launch carousel · page 1 · 4:5 · v2");
  await expect(page.getByLabel("Note text")).toHaveValue("Half-written thought");
  await drag(page, "quote-still", [0.2, 0.2], [0.6, 0.5]);
  await expect(page.locator(".toast")).toContainText("Finish or discard your draft on Launch carousel first.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect.poll(async () => (await notesJson(rushes)).map((n) => n.on)).toEqual(["launch-carousel/1"]);
});

/** Waits until the Visuals scroll area has stopped moving (a smooth scroll in flight is not a place to click from). */
const scrollSettled = (page: import("@playwright/test").Page) =>
  page.locator(".vzscroll").evaluate(
    (el) =>
      new Promise<void>((done) => {
        let last = -1;
        let still = 0;
        const frame = () => {
          still = el.scrollTop === last ? still + 1 : 0;
          last = el.scrollTop;
          if (still >= 6) done();
          else requestAnimationFrame(frame);
        };
        frame();
      }),
  );

test("clicking a faded note scrolls to its visual and shows its page, ratio and version with the box", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await rushes.api("POST", "/api/notes", { stage: "visuals", scope: "whole", version: "v2", on: "launch-carousel/5", format: "4x5", box: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, text: "Fix page five." });
  await rushes.api("POST", "/api/notes", { stage: "visuals", scope: "whole", version: "v1", on: "quote-still/1", format: "16x9", box: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, text: "Wide crop is tight." });
  await openVisuals(page, rushes);
  await expect(section(page, "launch-carousel")).toHaveClass(/cur/);
  await page.locator('.vznote', { hasText: "Wide crop is tight." }).click();
  await expect(section(page, "quote-still")).toHaveClass(/cur/);
  await expect(section(page, "quote-still").getByRole("button", { name: "16:9" })).toHaveAttribute("aria-pressed", "true");
  await expect(section(page, "quote-still").locator(".vzbox")).toHaveCount(1);
  await scrollSettled(page);
  await page.locator('.vznote', { hasText: "Fix page five." }).click();
  await expect(section(page, "launch-carousel")).toHaveClass(/cur/);
  await expect(section(page, "launch-carousel").locator('.vzcount')).toContainText("05 / 06");
});

test("ratio chips and the version chip change what is shown, and an older version cannot be marked", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await openVisuals(page, rushes);
  const img = frame(page, "launch-carousel").locator("img");
  await page.getByRole("button", { name: "Page 3" }).click();
  await expect(img).toHaveAttribute("src", /p3-v2\.png/);
  await section(page, "launch-carousel").getByRole("button", { name: /^v2/ }).click();
  await page.getByRole("menuitem", { name: /v1/ }).click();
  await expect(img).toHaveAttribute("src", /p3\.png/);
  await expect(section(page, "launch-carousel").locator(".vzbanner")).toContainText("Viewing v1, an older version");
  await drag(page, "launch-carousel", [0.1, 0.2], [0.5, 0.4]);
  await expect(page.locator(".toast")).toContainText("You're looking at v1");
  await expect(page.locator(".vzbox.draft")).toHaveCount(0);
});

test("the page strip, Previous and Next, the count and the arrow keys move through a carousel", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await openVisuals(page, rushes);
  const count = section(page, "launch-carousel").locator(".vzcount");
  await expect(count).toContainText("01 / 06");
  await section(page, "launch-carousel").getByRole("button", { name: "Next page" }).click();
  await expect(count).toContainText("02 / 06");
  await page.keyboard.press("ArrowRight");
  await expect(count).toContainText("03 / 06");
  await page.keyboard.press("ArrowLeft");
  await expect(count).toContainText("02 / 06");
  await expect(section(page, "launch-carousel").getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-current", "true");
  await expect(section(page, "launch-carousel").getByRole("button", { name: "Previous page" })).toBeEnabled();
  await page.getByRole("button", { name: "Page 1" }).click();
  await expect(section(page, "launch-carousel").getByRole("button", { name: "Previous page" })).toBeDisabled();
});

test("Full screen shows the page large with its boxes and cannot mark; Escape closes it", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await rushes.api("POST", "/api/notes", { stage: "visuals", scope: "whole", version: "v2", on: "launch-carousel/1", format: "4x5", box: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, text: "A box." });
  await openVisuals(page, rushes);
  await section(page, "launch-carousel").getByRole("button", { name: "Full screen" }).click();
  const dialog = page.getByRole("dialog", { name: "Full screen" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".vzbox")).toHaveCount(1);
  const box = (await dialog.locator(".vzframe").boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 90, { steps: 4 });
  await page.mouse.up();
  await expect(dialog.locator(".vzbox.draft")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByText("02 / 06")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(section(page, "launch-carousel").locator(".vzcount")).toContainText("02 / 06");
});

test("the done tick closes a note and reopens it, and Send to agent sends the Visuals notes", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await rushes.api("POST", "/api/notes", { stage: "visuals", scope: "whole", version: "v2", on: "launch-carousel/1", format: "4x5", box: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, text: "First." });
  await rushes.api("POST", "/api/notes", { stage: "visuals", scope: "whole", version: "v2", on: "launch-carousel/2", format: null, text: "Second." });
  await openVisuals(page, rushes);
  await expect(page.getByRole("button", { name: /Send to agent/ })).toContainText("2");
  await page.locator(".vznote", { hasText: "First." }).getByRole("button", { name: "Mark done" }).click();
  await expect.poll(async () => (await notesJson(rushes)).find((n) => n.text === "First.").status).toBe("done");
  await expect(page.getByRole("button", { name: /Send to agent/ })).toContainText("1");
  await page.getByRole("button", { name: /Send to agent/ }).click();
  const dialog = page.getByRole("dialog", { name: "Sent to agent" });
  await expect(dialog).toContainText("rushes_add_visual");
  expect(await readFile(join(rushes.root, ".rushes", "batches.json"), "utf8")).toContain('"stage": "visuals"');
});

test("an agent's reply shows under its note, with a way to see the version that fixes it", async ({ page, rushes }) => {
  await withVisuals(rushes);
  const { note } = await rushes.api("POST", "/api/notes", { stage: "visuals", scope: "whole", version: "v1", on: "launch-carousel/3", format: "4x5", box: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, text: "Too grey." });
  await rushes.api("POST", "/api/replies", { replies: [{ id: note.id, reply: "Greener in v2.", fixVersion: "v2" }] });
  await openVisuals(page, rushes);
  const row = page.locator(".vznote", { hasText: "Too grey." });
  await expect(row).toContainText("Greener in v2.");
  await expect(row).toContainText("from v1");
  await row.getByRole("button", { name: "Show in v2" }).click();
  await expect(section(page, "launch-carousel").locator(".vzcount")).toContainText("03 / 06");
  await expect(section(page, "launch-carousel").getByRole("button", { name: /^v2/ })).toBeVisible();
  await expect(frame(page, "launch-carousel").locator("img")).toHaveAttribute("src", /p3-v2\.png/);
});

test("a page that cannot load says so, and a whole-image note still works", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await page.route((url) => url.pathname.endsWith("/media") && url.searchParams.get("path") === "visuals/launch/p1.png", (route) => route.fulfill({ status: 404, body: "no" }));
  await openVisuals(page, rushes);
  await expect(frame(page, "launch-carousel")).toContainText("Can't load page 1");
  await page.getByRole("button", { name: "Whole image", exact: true }).click();
  await page.getByLabel("Note text").fill("Image is missing.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect.poll(async () => (await notesJson(rushes)).length).toBe(1);
});

// Review (whole branch): the target line names where the note will go, on this visual or any other page of it.
test("a whole-image draft started on one page says so after you turn to another page, and saves there", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await openVisuals(page, rushes);
  await page.getByLabel("Note text").fill("About the first page");
  await page.getByRole("button", { name: "Page 3" }).click();
  await expect(frame(page, "launch-carousel").locator("img")).toHaveAttribute("src", /p3-v2\.png/);
  await expect(page.locator(".vztarget")).toContainText("Draft for");
  await expect(page.locator(".vztarget")).toContainText("page 1");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect.poll(async () => (await notesJson(rushes)).map((n) => n.on)).toEqual(["launch-carousel/1"]);
});

test("a note cannot be added while looking at an older version, whichever way it was started", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await openVisuals(page, rushes);
  await section(page, "launch-carousel").getByRole("button", { name: /^v2/ }).click();
  await page.getByRole("menuitem", { name: /v1/ }).click();
  await page.getByLabel("Note text").fill("Typed while looking at v1");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.locator(".toast")).toContainText("This note is for v1, an older version");
  expect(await notesJson(rushes)).toHaveLength(0);
});

test("a version registered while you are looking at the newest is the one you are looking at next, even after paging", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await openVisuals(page, rushes);
  await page.getByRole("button", { name: "Page 3" }).click();
  await pic(rushes, "visuals/launch/p3-v3.png", 108, 135, [200, 40, 40]);
  await rushes.api("POST", "/api/visuals", { visual: "launch-carousel", label: "Redder", pages: [{ n: 3, files: ["visuals/launch/p3-v3.png"] }] });
  await expect(section(page, "launch-carousel").getByRole("button", { name: /^v3/ })).toBeVisible();
  await expect(frame(page, "launch-carousel").locator("img")).toHaveAttribute("src", /p3-v3\.png/);
  await expect(section(page, "launch-carousel").locator(".vzbanner")).toHaveCount(0);
  await drag(page, "launch-carousel", [0.1, 0.2], [0.5, 0.4]);
  await expect(page.locator(".vzbox.draft")).toHaveCount(1);
});

// Deferred minors from the whole-branch review.
test("a drag started on another page of the same visual is drawn while it is dragged, and saves on that page", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await openVisuals(page, rushes);
  await drag(page, "launch-carousel", [0.1, 0.2], [0.5, 0.4]); // a leftover mark with no words, on page 1
  await page.getByRole("button", { name: "Page 3" }).click();
  await expect(frame(page, "launch-carousel").locator("img")).toHaveAttribute("src", /p3-v2\.png/);
  const box = (await frame(page, "launch-carousel").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 4 });
  await expect(page.locator(".vzbox.draft")).toHaveCount(1); // visible mid-drag
  await page.mouse.up();
  await page.getByLabel("Note text").fill("On page three");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect.poll(async () => (await notesJson(rushes)).map((n) => n.on)).toEqual(["launch-carousel/3"]);
});

test("a drag the browser cancels stops drawing and puts the draft back as it was", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await openVisuals(page, rushes);
  const f = frame(page, "launch-carousel");
  const box = (await f.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4, { steps: 4 });
  await expect(page.locator(".vzbox.draft")).toHaveCount(1);
  await f.evaluate((el) => el.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true })));
  await expect(page.locator(".vzbox.draft")).toHaveCount(0);
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8, { steps: 4 }); // the old gesture must not draw any more
  await expect(page.locator(".vzbox.draft")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator(".vzbox.draft")).toHaveCount(0);
});

test("Add note saves one note however quickly it is pressed twice", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await openVisuals(page, rushes);
  await page.route("**/api/notes", async (route) => {
    if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  await page.getByLabel("Note text").fill("Only once please");
  await page.getByRole("button", { name: "Add note" }).dblclick();
  await expect.poll(async () => (await notesJson(rushes)).length).toBeGreaterThan(0);
  await page.waitForTimeout(800);
  expect((await notesJson(rushes)).map((n) => n.text)).toEqual(["Only once please"]);
});

test("the page strip loads its pictures lazily, since each is the full-size file", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await openVisuals(page, rushes);
  const thumbs = section(page, "launch-carousel").locator(".vzth img");
  expect(await thumbs.count()).toBeGreaterThan(1);
  for (const img of await thumbs.all()) await expect(img).toHaveAttribute("loading", "lazy");
});

test("the empty notes column says only that there are none, and the controls follow the Visuals conventions", async ({ page, rushes }) => {
  await withVisuals(rushes);
  await openVisuals(page, rushes);
  await expect(page.locator(".vzempty")).toHaveText("No notes yet.");
  // Page buttons keep their shape: a vz class, and the same size they have always had.
  const next = page.getByRole("button", { name: "Next page" });
  await expect(next).toHaveClass(/vzpill/);
  expect(await next.evaluate((el) => { const s = getComputedStyle(el); return [s.height, s.borderTopLeftRadius, s.fontSize]; })).toEqual(["36px", "999px", "15px"]);
  // The plain page buttons are quiet (secondary text colour, medium weight), as they were when a shared class styled them.
  const quiet = page.getByRole("button", { name: "Full screen" }).first();
  expect(
    await quiet.evaluate((el) => {
      const probe = document.createElement("i");
      probe.style.color = "var(--text-2)";
      document.body.append(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      const s = getComputedStyle(el);
      return [s.color === want, s.fontWeight];
    }),
  ).toEqual([true, "500"]);
  // The done tick is an icon button, so it has a tooltip like the others.
  await rushes.api("POST", "/api/notes", { stage: "visuals", scope: "whole", version: "v2", on: "launch-carousel/1", format: "4x5", box: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, text: "Headline too long." });
  await expect(page.locator(".vztick").first()).toHaveAttribute("data-tip", "Mark done");
  // Small print is no smaller than 13px, as elsewhere in the dashboard.
  for (const sel of [".vznote .tag", ".vzkind", ".vzpgh", ".vzghead .here", ".vztarget .lbl"]) {
    const px = await page.locator(sel).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(px, sel).toBeGreaterThanOrEqual(13);
  }
});
