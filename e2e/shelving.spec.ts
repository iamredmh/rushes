import { test, expect, videoReady } from "./fixture.js";

// §26: shelving a film from the Film menu, the +N list, the Shelved list, and what a shelved film does and does not do.
type Rushes = Parameters<Parameters<typeof test>[2]>[0]["rushes"];
type Page = import("@playwright/test").Page;

const pack = (page: Page) => page.getByRole("navigation", { name: "Films" });
const filmMenuButton = (page: Page) => page.getByRole("button", { name: "Film actions" });
const shelvedButton = (page: Page) => page.getByRole("button", { name: /^Shelved \(\d+\)/ });
const sendButton = (page: Page) => page.getByRole("button", { name: /Send to agent/ });
const moreButton = (page: Page) => page.getByRole("button", { name: /more films/ });

async function films(rushes: Rushes, names: string[]) {
  for (const name of names) await rushes.addCut(`${name} cut`, name);
}
const note = (rushes: Rushes, video: string, text: string, t = 0.5) => rushes.api("POST", "/api/notes", { stage: "picture", video, version: "v1", scope: "point", t, text });
async function shelveCurrent(page: Page) {
  await filmMenuButton(page).click();
  await page.getByRole("menuitem", { name: /Shelve film/ }).click();
}

test("the Film menu is headed by the film you are in, and shelving it closes the bar up, with an Undo", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown", "Teaser"]);
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(pack(page).getByRole("button")).toHaveCount(3);
  await filmMenuButton(page).click();
  await expect(page.getByRole("menu")).toContainText("Hero");
  await page.getByRole("menuitem", { name: /Shelve film/ }).click();
  await expect(pack(page).getByRole("button", { name: /Hero/ })).toHaveCount(0);
  await expect(pack(page).getByRole("button", { name: /Cutdown/ })).toHaveAttribute("aria-pressed", "true");
  await expect(shelvedButton(page)).toHaveText(/Shelved \(1\)/);
  await expect(page.getByRole("status").filter({ hasText: "shelved" })).toBeVisible();
  await page.getByRole("status").getByRole("button", { name: "Undo" }).click();
  await expect(pack(page).getByRole("button", { name: /Hero/ })).toBeVisible();
  await expect(shelvedButton(page)).toHaveCount(0);
  expect(((await rushes.api("GET", "/api/state")).project.videos as any[]).every((v) => !v.shelved)).toBe(true);
});

test("pills only switch films: there is no button on a pill", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await page.goto(rushes.url);
  await videoReady(page);
  const pill = pack(page).getByRole("button", { name: /Cutdown/ });
  await pill.hover();
  await expect(pack(page).getByRole("button")).toHaveCount(2);
  const before = (await pill.boundingBox())!.width;
  await page.mouse.move(0, 400);
  expect((await pill.boundingBox())!.width).toBe(before); // hovering does not change a pill's width
});

test("a shelved film's open notes stop counting in Send to agent, and come back on restore", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await note(rushes, "hero", "Hero fix.");
  await note(rushes, "cutdown", "Cutdown fix one.", 0.4);
  await note(rushes, "cutdown", "Cutdown fix two.", 0.6);
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(sendButton(page)).toContainText("3");
  await shelveCurrent(page); // Hero
  await expect(sendButton(page)).toContainText("2");
  await shelvedButton(page).click();
  await page.getByRole("button", { name: "Restore Hero" }).click();
  await expect(sendButton(page)).toContainText("3");
});

test("Shift+S shelves the film you are in, and on a shelved film restores it", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await page.goto(rushes.url);
  await videoReady(page);
  await page.keyboard.press("Shift+S");
  await expect(shelvedButton(page)).toHaveText(/Shelved \(1\)/);
  await shelvedButton(page).click();
  await page.getByRole("button", { name: "Open Hero" }).click();
  await expect(page.locator(".shbanner")).toContainText("Hero");
  await page.keyboard.press("Shift+S");
  await expect(shelvedButton(page)).toHaveCount(0);
  await expect(page.locator(".shbanner")).toHaveCount(0);
});

test("[ and ] step through the films in play and skip a shelved one", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown", "Teaser"]);
  await rushes.api("PUT", "/api/videos/cutdown/shelve", { shelved: true });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(pack(page).getByRole("button", { name: /Hero/ })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("]");
  await expect(pack(page).getByRole("button", { name: /Teaser/ })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("[");
  await expect(pack(page).getByRole("button", { name: /Hero/ })).toHaveAttribute("aria-pressed", "true");
});

test("a shelved film opens view-only under a banner, and Restore puts everything back", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await note(rushes, "cutdown", "Cutdown fix.");
  await rushes.api("PUT", "/api/videos/cutdown/shelve", { shelved: true });
  await page.goto(rushes.url);
  await videoReady(page);
  await shelvedButton(page).click();
  await expect(page.locator(".fpmenu")).toContainText("Cutdown");
  await page.getByRole("button", { name: "Open Cutdown" }).click();
  await videoReady(page);
  const banner = page.locator(".shbanner");
  await expect(banner).toContainText("Shelved");
  await expect(banner).toContainText("Cutdown");
  // Looking and playing are on; marking, noting and locking are off.
  await expect(page.getByRole("button", { name: "Play" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Draw a box" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Set in point" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Grab frame" })).toBeDisabled();
  await expect(page.getByLabel("New note")).toBeHidden();
  await expect(page.getByRole("button", { name: /Lock picture/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Film actions" })).toBeEnabled();
  // The picture is dimmed, and not once it is restored.
  expect(await page.locator(".framebox").evaluate((el) => getComputedStyle(el).filter)).toContain("grayscale");
  await banner.getByRole("button", { name: "Restore film" }).click();
  await expect.poll(() => page.locator(".framebox").evaluate((el) => getComputedStyle(el).filter)).toBe("none");
  await expect(page.locator(".shbanner")).toHaveCount(0);
  await expect(pack(page).getByRole("button", { name: /Cutdown/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("New note")).toBeVisible();
  await expect(page.getByRole("button", { name: "Draw a box" })).toBeEnabled();
});

test("typing a capital S in the note box does not shelve the film", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await page.goto(rushes.url);
  await videoReady(page);
  await page.getByLabel("New note").click();
  await page.keyboard.type("Shift S: Same Sound");
  await expect(page.getByLabel("New note")).toHaveValue("Shift S: Same Sound");
  await expect(shelvedButton(page)).toHaveCount(0);
  expect(((await rushes.api("GET", "/api/state")).project.videos as any[]).every((v) => !v.shelved)).toBe(true);
});

test("shelving is refused while a note on the film is half-typed", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await page.goto(rushes.url);
  await videoReady(page);
  await page.getByLabel("New note").fill("Half a thought");
  await shelveCurrent(page);
  await expect(page.getByRole("status").filter({ hasText: "Add or clear your note on Hero first" })).toBeVisible();
  expect(((await rushes.api("GET", "/api/state")).project.videos as any[]).every((v) => !v.shelved)).toBe(true);
});

test("a new cut from the agent brings a shelved film back into the bar", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await rushes.api("PUT", "/api/videos/cutdown/shelve", { shelved: true });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(pack(page).getByRole("button", { name: /Cutdown/ })).toHaveCount(0);
  await rushes.addCut("a new cut", "Cutdown");
  await expect(pack(page).getByRole("button", { name: /Cutdown/ })).toBeVisible();
  await expect(shelvedButton(page)).toHaveCount(0);
});

test("with every film shelved, Picture says so and points at the Shelved list", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await rushes.api("PUT", "/api/videos/hero/shelve", { shelved: true });
  await rushes.api("PUT", "/api/videos/cutdown/shelve", { shelved: true });
  await page.goto(rushes.url);
  await expect(page.getByText("All films are shelved")).toBeVisible();
  await page.getByRole("button", { name: "Open the Shelved list" }).click();
  await expect(page.locator(".fpmenu")).toContainText("Hero");
  await page.getByRole("button", { name: "Restore Hero" }).click();
  await expect(page.getByText("All films are shelved")).toHaveCount(0);
  await videoReady(page);
});

test("a project with nothing shelved has no Shelved button and no +N, and its pills are as they were", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(shelvedButton(page)).toHaveCount(0);
  await expect(moreButton(page)).toHaveCount(0);
  await expect(pack(page).getByRole("button")).toHaveCount(2);
});

test("a one-film project can shelve its film, and the Shelved list brings it back", async ({ page, rushes }) => {
  await films(rushes, ["Hero"]);
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(pack(page)).toHaveCount(0); // one film: the crumb, as before
  await shelveCurrent(page);
  await expect(page.getByText("All films are shelved")).toBeVisible();
  await shelvedButton(page).click();
  await page.getByRole("button", { name: "Restore Hero" }).click();
  await videoReady(page);
});

test("films that do not fit fold into +N, the current film stays a pill, and the header does not wrap", async ({ page, rushes }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await films(rushes, ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"]);
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(moreButton(page)).toBeVisible();
  const shown = await pack(page).getByRole("button").count();
  expect(shown).toBeLessThan(8 + 1); // some are folded
  expect((await page.locator("header.head").boundingBox())!.height).toBeLessThan(90); // one row
  // The film you open from the list becomes a pill, and the bar stays one row.
  await moreButton(page).click();
  const rows = page.locator(".fpmenu").getByRole("button");
  const last = rows.last();
  const name = (await last.innerText()).replace(/^\d+\s*/, "").trim();
  await last.click();
  await expect(pack(page).getByRole("button", { name: new RegExp(name) })).toHaveAttribute("aria-pressed", "true");
  expect((await page.locator("header.head").boundingBox())!.height).toBeLessThan(90);
  // A wide window shows them all again, with no +N.
  await page.setViewportSize({ width: 1900, height: 800 });
  await expect(moreButton(page)).toHaveCount(0);
  await expect(pack(page).getByRole("button")).toHaveCount(8);
});

test("Escape closes the Film menu and the lists and puts focus back on their button", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown", "Teaser"]);
  await rushes.api("PUT", "/api/videos/teaser/shelve", { shelved: true });
  await page.goto(rushes.url);
  await videoReady(page);
  await filmMenuButton(page).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(filmMenuButton(page)).toBeFocused();
  await shelvedButton(page).click();
  await expect(page.locator(".fpmenu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".fpmenu")).toHaveCount(0);
  await expect(shelvedButton(page)).toBeFocused();
  // Escape with nothing open still closes the shortcuts sheet, as before.
  await page.keyboard.press("?");
  await expect(page.getByRole("heading", { name: "Shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Shortcuts" })).toHaveCount(0);
});

test("the audio tabs are view-only too while a shelved film is open: a note left there would never be counted or sent", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await rushes.addVariant("music", "A · Deep house", { seconds: 4, freq: 220 });
  await rushes.api("PUT", "/api/videos/cutdown/shelve", { shelved: true });
  await page.goto(rushes.url);
  await videoReady(page);
  await shelvedButton(page).click();
  await page.getByRole("button", { name: "Open Cutdown" }).click();
  await videoReady(page);
  const music = page.getByRole("tab", { name: /Music/ });
  await expect(music).not.toHaveAttribute("data-locked");
  await music.click();
  await expect(music).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".lane")).toHaveCount(1);
  await expect(page.locator(".shbanner")).toContainText("Cutdown");
  await expect(page.getByLabel("New note")).toBeHidden();
  // Back on a film in play, the box is there.
  await shelvedButton(page).click();
  await page.getByRole("button", { name: "Restore Cutdown" }).click();
  await expect(page.getByLabel("New note")).toBeVisible();
});

test("holding Shift+S shelves one film, not every film the key repeat lands on", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown", "Teaser"]);
  await page.goto(rushes.url);
  await videoReady(page);
  const shelvedCount = async () => ((await rushes.api("GET", "/api/state")).project.videos as any[]).filter((v) => v.shelved).length;
  await page.keyboard.down("Shift");
  await page.keyboard.down("S");
  await page.keyboard.down("S");
  await page.keyboard.down("S");
  await page.keyboard.up("S");
  await page.keyboard.up("Shift");
  await expect.poll(shelvedCount).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(400);
  expect(await shelvedCount()).toBe(1);
});

test("Undo goes back to the film only when the restore worked", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown", "Teaser"]);
  await page.goto(rushes.url);
  await videoReady(page);
  await page.route("**/api/videos/hero/shelve", (route) => {
    if (route.request().postDataJSON()?.shelved === false) {
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal", message: "Could not restore" }) });
    }
    return route.continue();
  });
  await shelveCurrent(page);
  await expect(pack(page).getByRole("button", { name: /Cutdown/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Undo" }).click();
  // The restore failed: Hero is still shelved, and you are still on the film you were moved to, not on a view-only Hero.
  await expect(page.getByText("Could not restore")).toBeVisible();
  await expect(page.locator(".shbanner")).toHaveCount(0);
  await expect(pack(page).getByRole("button", { name: /Cutdown/ })).toHaveAttribute("aria-pressed", "true");
  expect(((await rushes.api("GET", "/api/state")).project.videos as any[]).find((v) => v.id === "hero").shelved).toBeTruthy();
});

test("the shelved banner is only on the tabs that are view-only", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await rushes.api("PUT", "/api/videos/cutdown/shelve", { shelved: true });
  await page.goto(rushes.url);
  await videoReady(page);
  await shelvedButton(page).click();
  await page.getByRole("button", { name: "Open Cutdown" }).click();
  await videoReady(page);
  await expect(page.locator(".shbanner")).toBeVisible();
  // Assets has nothing read-only about it.
  await page.keyboard.press("8");
  await expect(page.locator(".shbanner")).toHaveCount(0);
  await page.keyboard.press("2");
  await expect(page.locator(".shbanner")).toBeVisible();
});

test("a film shelved from another window does not strand the note you were typing on it", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown", "Teaser"]);
  await page.goto(rushes.url);
  await videoReady(page);
  await page.getByLabel("New note").click();
  await page.keyboard.type("Half a thought");
  await rushes.api("PUT", "/api/videos/hero/shelve", { shelved: true });
  await expect(page.locator(".shbanner")).toBeVisible();
  // The box is hidden on a shelved film, so it no longer holds you here: switching films works.
  await pack(page).getByRole("button", { name: /Cutdown/ }).click();
  await expect(pack(page).getByRole("button", { name: /Cutdown/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".shbanner")).toHaveCount(0);
});
