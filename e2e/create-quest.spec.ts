import {
  chooseOption,
  dailyPanel,
  expect,
  openApp,
  personalPanel,
  questRow,
  reloadApp,
  test,
} from "./support";

test.describe("Create quest", () => {
  test("a Daily Quest from the form appears on Home and survives a reload", async ({ page }) => {
    await openApp(page, "/quests/new");

    await page.getByRole("button", { name: /Daily Quest/ }).click();
    await page.getByLabel("Quest title").fill("Water the ferns");
    await chooseOption(page, "Category", "Wellness");
    await chooseOption(page, "Repeat", "Every day");
    await chooseOption(page, "Difficulty", "Hard · 20 XP");
    await page.getByLabel("Notes").fill("Use the small can");
    await page.getByRole("button", { name: "Save quest" }).click();

    await expect(page).toHaveURL(/\/$/);
    const row = questRow(dailyPanel(page), "Water the ferns");
    const expectQuestDetails = async () => {
      await expect(row).toContainText("Wellness");
      await expect(row).toContainText("Every day");
      await expect(row).toContainText("Hard");
      await expect(row).toContainText("+20 XP");
      await expect(row).toContainText("Use the small can");
      await expect(dailyPanel(page).getByText("0 / 5 done")).toBeVisible();
    };
    await expectQuestDetails();

    await reloadApp(page);
    await expectQuestDetails();
  });

  test("a Personal Quest keeps its custom category and calendar due date after a reload", async ({ page }) => {
    await openApp(page, "/quests/new");

    await page.getByRole("button", { name: /Personal Quest/ }).click();
    await page.getByLabel("Quest title").fill("Repot the monstera");
    await chooseOption(page, "Category", "Create custom category...");
    await page.getByRole("textbox", { name: "Category name" }).fill("Garden");
    await page.getByRole("button", { name: "Due date", exact: true }).click();
    await page.getByRole("button", { name: "Thursday, October 22, 2026" }).click();
    await chooseOption(page, "Difficulty", "Medium · 10 XP");
    await page.getByRole("button", { name: "Save quest" }).click();

    await expect(page).toHaveURL(/\/$/);
    const row = questRow(personalPanel(page), "Repot the monstera");
    await expect(row).toContainText("Garden");
    await expect(row).toContainText("Due Oct 22");
    await expect(row).toContainText("+10 XP");

    await reloadApp(page);
    await expect(row).toContainText("Garden");
    await expect(row).toContainText("Due Oct 22");

    // The custom category is saved for reuse, not just on this quest.
    await openApp(page, "/quests/new");
    await page.getByRole("button", { name: /Personal Quest/ }).click();
    await page.getByRole("combobox", { name: "Category", exact: true }).click();
    await expect(page.getByRole("option", { name: "Garden", exact: true })).toBeVisible();
  });

  test("a Daily Quest for other days is listed on All Quests but not on Home today", async ({ page }) => {
    await openApp(page, "/quests/new");

    await page.getByRole("button", { name: /Daily Quest/ }).click();
    await page.getByLabel("Quest title").fill("Tuesday yoga");
    await chooseOption(page, "Category", "Wellness");
    await chooseOption(page, "Repeat", "Selected days");
    await page.getByRole("button", { name: "Tue", exact: true }).click();
    await chooseOption(page, "Difficulty", "Easy · 5 XP");
    await page.getByRole("button", { name: "Save quest" }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(questRow(dailyPanel(page), "Tuesday yoga")).toHaveCount(0);

    await openApp(page, "/all-quests");
    await expect(questRow(dailyPanel(page), "Tuesday yoga")).toContainText("Tue");
    await expect(page.getByRole("button", { name: "Complete: Tuesday yoga" })).toBeDisabled();
  });

  test("the quick-add form on Home creates a quest that survives a reload", async ({ page }) => {
    await openApp(page);

    await page.getByRole("button", { name: "Add habit" }).click();
    await page.getByLabel("New quest name").fill("Quick breathing break");
    await page.getByRole("button", { name: "Add", exact: true }).click();

    await expect(questRow(dailyPanel(page), "Quick breathing break")).toBeVisible();
    await reloadApp(page);
    await expect(questRow(dailyPanel(page), "Quick breathing break")).toContainText("+5 XP");
  });

  test("the form cannot be saved without the required fields", async ({ page }) => {
    await openApp(page, "/quests/new");
    const save = page.getByRole("button", { name: "Save quest" });

    await expect(save).toBeDisabled();
    await page.getByLabel("Quest title").fill("Incomplete quest");
    await expect(save).toBeDisabled();
  });
});
