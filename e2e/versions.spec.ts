import { expect, test } from "./fixture.js";

test("Assets › Cuts shows a cut's short label, not its whole note (§22.4)", async ({ page, rushes }) => {
  await rushes.addCut("v1: first pass; each zoomed request types itself out; crowd on a wider oval");
  await page.goto(rushes.url);
  await page.getByRole("tab", { name: /Assets/ }).click();
  await expect(page.locator(".aheader h2")).toContainText("Cuts");
  await expect(page.locator(".shot-meta .asub").first()).toHaveText("first pass");
});
