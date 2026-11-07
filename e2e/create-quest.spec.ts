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

  test("Home's Add habit link opens the form with only Daily Quest chosen, and the quest survives a reload", async ({ page }) => {
    await openApp(page);
    const link = dailyPanel(page).getByRole("link", { name: "Add habit to Daily Quests", exact: true });
    // The visible label is unchanged. The accessible name starts with it (for speech control) and says which
    // list, which tells it apart from the page's other "Add quest" links.
    await expect(link).toHaveText("Add habit");
    await link.click();

    await expect(page).toHaveURL(/\/quests\/new\?type=daily$/);
    await expect(page.getByRole("button", { name: /Daily Quest/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /Personal Quest/ })).toHaveAttribute("aria-pressed", "false");
    // Only the type: category, schedule and difficulty are still the player's to choose.
    await expect(page.getByRole("combobox", { name: "Category", exact: true })).not.toContainText("Wellness");
    await expect(page.getByRole("combobox", { name: "Repeat", exact: true })).not.toContainText("Every day");
    await expect(page.getByRole("combobox", { name: "Difficulty", exact: true })).not.toContainText("XP");
    await page.getByLabel("Quest title").fill("Quick breathing break");
    await expect(page.getByRole("button", { name: "Save quest" })).toBeDisabled();

    await chooseOption(page, "Category", "Wellness");
    await chooseOption(page, "Repeat", "Every day");
    await chooseOption(page, "Difficulty", "Easy · 5 XP");
    await page.getByRole("button", { name: "Save quest" }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(questRow(dailyPanel(page), "Quick breathing break")).toContainText("Wellness · Every day");
    await reloadApp(page);
    await expect(questRow(dailyPanel(page), "Quick breathing break")).toContainText("+5 XP");
  });

  test("Home's Add quest link opens the form with only Personal Quest chosen", async ({ page }) => {
    await openApp(page);
    const link = personalPanel(page).getByRole("link", { name: "Add quest to Personal Quests", exact: true });
    await expect(link).toHaveText("Add quest");
    await link.click();

    await expect(page).toHaveURL(/\/quests\/new\?type=personal$/);
    await expect(page.getByRole("button", { name: /Personal Quest/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /Daily Quest/ })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("combobox", { name: "Category", exact: true })).not.toContainText("Personal");
    await expect(page.getByRole("button", { name: "Due date", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Repeat", exact: true })).toHaveCount(0);

    await page.getByLabel("Quest title").fill("Return library books");
    await chooseOption(page, "Category", "Chores");
    await chooseOption(page, "Difficulty", "Medium · 10 XP");
    await page.getByRole("button", { name: "Save quest" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(questRow(personalPanel(page), "Return library books")).toContainText("+10 XP");
  });

  test("the chosen type can still be changed, and a missing or unknown type chooses nothing", async ({ page }) => {
    await openApp(page, "/quests/new?type=daily");
    await page.getByRole("button", { name: /Personal Quest/ }).click();
    await expect(page.getByRole("button", { name: /Personal Quest/ })).toHaveAttribute("aria-pressed", "true");

    for (const path of ["/quests/new", "/quests/new?type=habit", "/quests/new?type=Daily", "/quests/new?type="]) {
      await openApp(page, path);
      await expect(page.getByRole("heading", { name: "Create a quest" })).toBeVisible();
      await expect(page.getByRole("button", { name: /Daily Quest/ })).toHaveAttribute("aria-pressed", "false");
      await expect(page.getByRole("button", { name: /Personal Quest/ })).toHaveAttribute("aria-pressed", "false");
    }
  });

  test("editing ignores a type in the address: the quest's own type is kept", async ({ page }) => {
    await openApp(page, "/quests/new?edit=water&type=personal");

    await expect(page.getByRole("heading", { name: "Edit quest" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Daily Quest/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /Personal Quest/ })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByLabel("Quest title")).toHaveValue("Drink a glass of water");
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(questRow(dailyPanel(page), "Drink a glass of water")).toBeVisible();
    await expect(questRow(personalPanel(page), "Drink a glass of water")).toHaveCount(0);
  });

  test("All Quests has no add links, as before", async ({ page }) => {
    await openApp(page, "/all-quests");
    await expect(dailyPanel(page).getByRole("listitem").first()).toBeVisible();
    await expect(page.getByRole("link", { name: /^(Add habit to Daily Quests|Add quest to Personal Quests)$/ })).toHaveCount(0);
  });

  test("the form cannot be saved without the required fields", async ({ page }) => {
    await openApp(page, "/quests/new");
    const save = page.getByRole("button", { name: "Save quest" });

    await expect(save).toBeDisabled();
    await page.getByLabel("Quest title").fill("Incomplete quest");
    await expect(save).toBeDisabled();
  });
});
