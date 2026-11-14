import { test, expect, videoReady, reviewTab, currentFilm, cutButton, filmButton, pickFilm, openMore, toolButton, transport, sendButton } from "./fixture.js";

// §26 and §27, 5.2: shelving a film from More, the Film menu with its Shelved group, and what a shelved film does and does not do.
type Rushes = Parameters<Parameters<typeof test>[2]>[0]["rushes"];
type Page = import("@playwright/test").Page;

const filmMenu = (page: Page) => page.getByRole("menu", { name: "Films" });
/** The Film menu's films in play (the shelved ones sit in their own group, each with Open and Restore). */
const inPlayRows = (page: Page) => filmMenu(page).locator(":scope > [role=menuitem]");
const moreButton = (page: Page) => page.getByRole("button", { name: "More", exact: true });
async function openFilms(page: Page) {
  if ((await filmMenu(page).count()) === 0) await filmButton(page).click();
  await expect(filmMenu(page)).toBeVisible();
}
async function closeFilms(page: Page) {
  await page.keyboard.press("Escape");
  await expect(filmMenu(page)).toHaveCount(0);
}

async function films(rushes: Rushes, names: string[]) {
  for (const name of names) await rushes.addCut(`${name} cut`, name);
}
const note = (rushes: Rushes, video: string, text: string, t = 0.5) => rushes.api("POST", "/api/notes", { stage: "picture", video, version: "v1", scope: "point", t, text });
async function shelveCurrent(page: Page) {
  await openMore(page);
  await page.getByRole("menuitem", { name: /Shelve film/ }).click();
}

test("More's Shelve names the film you are in, and shelving it moves it to the Film menu's Shelved group, with an Undo", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown", "Teaser"]);
  await page.goto(rushes.url);
  await videoReady(page);
  await openFilms(page);
  await expect(inPlayRows(page)).toHaveCount(3);
  await closeFilms(page);
  await openMore(page);
  await expect(page.getByRole("menuitem", { name: /Shelve film/ })).toContainText("Hero");
  await page.getByRole("menuitem", { name: /Shelve film/ }).click();
  await expect(currentFilm(page)).toHaveText("Cutdown");
  await openFilms(page);
  await expect(inPlayRows(page)).toHaveText([/Cutdown/, /Teaser/]);
  await expect(filmMenu(page)).toContainText("Shelved (1)");
  await closeFilms(page);
  await expect(page.getByRole("status").filter({ hasText: "shelved" })).toBeVisible();
  await page.getByRole("status").getByRole("button", { name: "Undo" }).click();
  await expect(currentFilm(page)).toHaveText("Hero");
  await openFilms(page);
  await expect(inPlayRows(page)).toHaveCount(3);
  await expect(filmMenu(page)).not.toContainText("Shelved");
  expect(((await rushes.api("GET", "/api/state")).project.videos as any[]).every((v) => !v.shelved)).toBe(true);
});

test("a film's row in the Film menu only switches films: there is no button on a row", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await page.goto(rushes.url);
  await videoReady(page);
  await openFilms(page);
  const row = inPlayRows(page).filter({ hasText: "Cutdown" });
  await row.hover();
  await expect(filmMenu(page).getByRole("menuitem")).toHaveCount(2);
  await expect(row.getByRole("button")).toHaveCount(0);
  const before = (await row.boundingBox())!.width;
  await inPlayRows(page).first().hover();
  expect((await row.boundingBox())!.width).toBe(before); // hovering does not change a row's width
});

test("a shelved film's open notes stop counting in Send, and come back on restore", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await note(rushes, "hero", "Hero fix.");
  await note(rushes, "cutdown", "Cutdown fix one.", 0.4);
  await note(rushes, "cutdown", "Cutdown fix two.", 0.6);
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(sendButton(page)).toContainText("3");
  await shelveCurrent(page); // Hero
  await expect(sendButton(page)).toContainText("2");
  await openFilms(page);
  await page.getByRole("menuitem", { name: "Restore Hero" }).click();
  await expect(sendButton(page)).toContainText("3");
});

test("Shift+S shelves the film you are in, and on a shelved film restores it", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await page.goto(rushes.url);
  await videoReady(page);
  await page.keyboard.press("Shift+S");
  await expect(currentFilm(page)).toHaveText("Cutdown");
  await openFilms(page);
  await expect(filmMenu(page)).toContainText("Shelved (1)");
  await page.getByRole("menuitem", { name: "Open Hero" }).click();
  await expect(page.locator(".shbanner")).toContainText("Hero");
  await page.keyboard.press("Shift+S");
  await expect(page.locator(".shbanner")).toHaveCount(0);
  await openFilms(page);
  await expect(filmMenu(page)).not.toContainText("Shelved");
});

test("[ and ] step through the films in play and skip a shelved one", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown", "Teaser"]);
  await rushes.api("PUT", "/api/videos/cutdown/shelve", { shelved: true });
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(currentFilm(page)).toHaveText("Hero");
  await page.keyboard.press("]");
  await expect(currentFilm(page)).toHaveText("Teaser");
  await page.keyboard.press("[");
  await expect(currentFilm(page)).toHaveText("Hero");
});

test("a shelved film opens view-only under a banner, and Restore puts everything back", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await note(rushes, "cutdown", "Cutdown fix.");
  await rushes.api("PUT", "/api/videos/cutdown/shelve", { shelved: true });
  await page.goto(rushes.url);
  await videoReady(page);
  await openFilms(page);
  await expect(filmMenu(page)).toContainText("Cutdown");
  await page.getByRole("menuitem", { name: "Open Cutdown" }).click();
  await videoReady(page);
  const banner = page.locator(".shbanner");
  await expect(banner).toContainText("Shelved");
  await expect(banner).toContainText("Cutdown");
  // Looking and playing are on; marking, noting and locking are off.
  await expect(transport(page).getByRole("button", { name: "Play" })).toBeEnabled();
  await expect(toolButton(page, "Select")).toBeEnabled();
  await expect(toolButton(page, "Note")).toBeDisabled();
  await expect(toolButton(page, "Box")).toBeDisabled();
  await expect(toolButton(page, "Range")).toBeDisabled();
  await expect(toolButton(page, "Grab")).toBeDisabled();
  await expect(page.getByLabel("New note")).toBeHidden();
  await cutButton(page).click();
  await expect(page.getByRole("button", { name: /Lock picture/ })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(moreButton(page)).toBeEnabled();
  // The picture is dimmed, and not once it is restored.
  expect(await page.locator(".framebox").evaluate((el) => getComputedStyle(el).filter)).toContain("grayscale");
  await banner.getByRole("button", { name: "Restore film" }).click();
  await expect.poll(() => page.locator(".framebox").evaluate((el) => getComputedStyle(el).filter)).toBe("none");
  await expect(page.locator(".shbanner")).toHaveCount(0);
  await expect(currentFilm(page)).toHaveText("Cutdown");
  await expect(page.getByLabel("New note")).toBeVisible();
  await expect(toolButton(page, "Box")).toBeEnabled();
});

test("typing a capital S in the note box does not shelve the film", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await page.goto(rushes.url);
  await videoReady(page);
  await page.getByLabel("New note").click();
  await page.keyboard.type("Shift S: Same Sound");
  await expect(page.getByLabel("New note")).toHaveValue("Shift S: Same Sound");
  await openFilms(page);
  await expect(filmMenu(page)).not.toContainText("Shelved");
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

test("a new cut from the agent brings a shelved film back among the films in play", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await rushes.api("PUT", "/api/videos/cutdown/shelve", { shelved: true });
  await page.goto(rushes.url);
  await videoReady(page);
  await openFilms(page);
  await expect(inPlayRows(page)).toHaveText([/Hero/]);
  await closeFilms(page);
  await rushes.addCut("a new cut", "Cutdown");
  await expect.poll(async () => ((await rushes.api("GET", "/api/state")).project.videos as any[]).find((v) => v.id === "cutdown").shelved ?? null).toBeNull();
  await openFilms(page);
  await expect(inPlayRows(page)).toHaveText([/Hero/, /Cutdown/]);
  await expect(filmMenu(page)).not.toContainText("Shelved");
});

test("with every film shelved, Picture says so and points at the Shelved list", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await rushes.api("PUT", "/api/videos/hero/shelve", { shelved: true });
  await rushes.api("PUT", "/api/videos/cutdown/shelve", { shelved: true });
  await page.goto(rushes.url);
  await expect(page.getByText("All films are shelved")).toBeVisible();
  await page.getByRole("button", { name: "Open the Shelved list" }).click();
  await expect(filmMenu(page)).toContainText("Hero");
  await expect(page.getByRole("menuitem", { name: "Open Hero" })).toBeFocused();
  await page.getByRole("menuitem", { name: "Restore Hero" }).click();
  await expect(page.getByText("All films are shelved")).toHaveCount(0);
  await videoReady(page);
});

test("a project with nothing shelved has no Shelved group, and its films are listed as they were", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await page.goto(rushes.url);
  await videoReady(page);
  await openFilms(page);
  await expect(filmMenu(page)).not.toContainText("Shelved");
  await expect(inPlayRows(page)).toHaveText([/^1\s*Hero/, /^2\s*Cutdown/]);
});

test("a one-film project can shelve its film, and the Shelved list brings it back", async ({ page, rushes }) => {
  await films(rushes, ["Hero"]);
  await page.goto(rushes.url);
  await videoReady(page);
  await expect(filmButton(page)).toHaveCount(0); // one film: its name, plain, with no menu
  await expect(currentFilm(page)).toHaveText("Hero");
  await shelveCurrent(page);
  await expect(page.getByText("All films are shelved")).toBeVisible();
  await openFilms(page);
  await page.getByRole("menuitem", { name: "Restore Hero" }).click();
  await videoReady(page);
});

test("the Film menu lists every film in play by number, however many, and the top bar stays one line", async ({ page, rushes }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"];
  await films(rushes, names);
  await page.goto(rushes.url);
  await videoReady(page);
  await openFilms(page);
  await expect(inPlayRows(page)).toHaveText(names.map((n, i) => new RegExp(`^${i + 1}\\s*${n}`)));
  // The last opens from the list, and the bar stays one line.
  await inPlayRows(page).last().click();
  await expect(currentFilm(page)).toHaveText("Hotel");
  expect((await page.locator("header.top").boundingBox())!.height).toBeLessThan(50);
  // Typing a film's number in the open menu goes to it.
  await openFilms(page);
  await page.keyboard.press("3");
  await expect(inPlayRows(page).nth(2)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(currentFilm(page)).toHaveText("Charlie");
});

test("Escape closes the More and Film menus and puts focus back on their button", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown", "Teaser"]);
  await rushes.api("PUT", "/api/videos/teaser/shelve", { shelved: true });
  await page.goto(rushes.url);
  await videoReady(page);
  await openMore(page);
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(moreButton(page)).toBeFocused();
  await openFilms(page);
  await expect(filmMenu(page)).toContainText("Teaser");
  await page.keyboard.press("Escape");
  await expect(filmMenu(page)).toHaveCount(0);
  await expect(filmButton(page)).toBeFocused();
  // Escape with nothing open still closes the shortcuts sheet, as before.
  await page.keyboard.press("?");
  await expect(page.getByRole("heading", { name: "Shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Shortcuts" })).toHaveCount(0);
});

test("the audio tabs are view-only too while a shelved film is open: a note left there would never be counted or sent", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await rushes.addVariant("music", "A · Deep house", { seconds: 4, freq: 220, video: ["Hero", "Cutdown"] });
  await rushes.api("PUT", "/api/videos/cutdown/shelve", { shelved: true });
  await page.goto(rushes.url);
  await videoReady(page);
  await openFilms(page);
  await page.getByRole("menuitem", { name: "Open Cutdown" }).click();
  await videoReady(page);
  const music = reviewTab(page, "Music");
  await expect(music).not.toHaveAttribute("data-locked");
  await music.click();
  await expect(music).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".lane")).toHaveCount(1);
  await expect(page.locator(".shbanner")).toContainText("Cutdown");
  await expect(page.getByLabel("New note")).toBeHidden();
  // Back on a film in play, the box is there.
  await openFilms(page);
  await page.getByRole("menuitem", { name: "Restore Cutdown" }).click();
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
  await expect(currentFilm(page)).toHaveText("Cutdown");
  await page.getByRole("button", { name: "Undo" }).click();
  // The restore failed: Hero is still shelved, and you are still on the film you were moved to, not on a view-only Hero.
  await expect(page.getByText("Could not restore")).toBeVisible();
  await expect(page.locator(".shbanner")).toHaveCount(0);
  await expect(currentFilm(page)).toHaveText("Cutdown");
  expect(((await rushes.api("GET", "/api/state")).project.videos as any[]).find((v) => v.id === "hero").shelved).toBeTruthy();
});

test("the shelved banner is only on the tabs that are view-only", async ({ page, rushes }) => {
  await films(rushes, ["Hero", "Cutdown"]);
  await rushes.api("PUT", "/api/videos/cutdown/shelve", { shelved: true });
  await page.goto(rushes.url);
  await videoReady(page);
  await openFilms(page);
  await page.getByRole("menuitem", { name: "Open Cutdown" }).click();
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
  await pickFilm(page, "Cutdown");
  await expect(currentFilm(page)).toHaveText("Cutdown");
  await expect(page.locator(".shbanner")).toHaveCount(0);
});

// The eleven-film width check that lived here (nothing in the header covered, one row from 1101 px) is desk.spec's
// "at 1100 px / at 1440 px with eleven long-named films the top bar is one line and nothing overlaps".
