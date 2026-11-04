import {
  STARTER_DAILY,
  STARTER_PERSONAL,
  dailyPanel,
  expect,
  expectCompletedOverall,
  expectCompletedToday,
  expectHomeXp,
  expectStreak,
  openApp,
  personalPanel,
  questRow,
  test,
} from "./support";

test.describe("Fresh start", () => {
  test("a new user sees the starter quests with no progress", async ({ page }) => {
    await openApp(page);

    await expect(dailyPanel(page).getByRole("listitem")).toHaveCount(STARTER_DAILY.length);
    for (const title of STARTER_DAILY) await expect(questRow(dailyPanel(page), title)).toBeVisible();
    await expect(personalPanel(page).getByRole("listitem")).toHaveCount(STARTER_PERSONAL.length);
    for (const title of STARTER_PERSONAL) await expect(questRow(personalPanel(page), title)).toBeVisible();

    await expectHomeXp(page, 0);
    await expectCompletedToday(page, 0);
    await expectCompletedOverall(page, 0);
    await expectStreak(page, 0);
    await expect(dailyPanel(page).getByText("0 / 4 done")).toBeVisible();
    await expect(personalPanel(page).getByText("0 / 3 done")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Mark incomplete/ })).toHaveCount(0);
  });

  test("a new user starts with an empty history and only the starter gift", async ({ page }) => {
    await openApp(page);

    await expect(page.getByText("0 of 16 plants discovered")).toBeVisible();
    await expect(page.getByRole("link", { name: "Plant Journal, 1 gift waiting" })).toBeVisible();

    await openApp(page, "/completion-history");
    await expect(page.getByRole("heading", { name: "Your story is just beginning" })).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(0);
  });
});
