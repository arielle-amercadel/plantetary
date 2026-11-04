import { expect, test } from "@playwright/test";

test("Home page loads", async ({ page }) => {
  const response = await page.goto("/");

  expect(response?.ok()).toBe(true);
  await expect(page).toHaveTitle(/Plantetary/);
  await expect(
    page.getByRole("heading", { level: 1, name: "A little progress, a little magic." }),
  ).toBeVisible();
});
