import {
  chooseOption,
  completeQuest,
  dailyPanel,
  expect,
  expectHomeXp,
  historyCard,
  openApp,
  personalPanel,
  questRow,
  reloadApp,
  test,
  uncompleteQuest,
} from "./support";
import type { Page } from "@playwright/test";

async function editDifficulty(page: Page, title: string, currentOption: string, newOption: string) {
  await page.getByRole("button", { name: `Edit ${title}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit quest" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Difficulty", exact: true })).toContainText(currentOption);
  await chooseOption(page, "Difficulty", newOption);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe("Edit quest difficulty", () => {
  test("raising a completed Daily Quest's difficulty never changes the XP it earned", async ({ page }) => {
    const title = "Morning skincare";
    await openApp(page);
    await completeQuest(page, title);
    await expectHomeXp(page, 5);

    await editDifficulty(page, title, "Easy · 5 XP", "Hard · 20 XP");

    await expect(questRow(dailyPanel(page), title)).toContainText("+20 XP");
    await expect(page.getByRole("button", { name: `Mark incomplete: ${title}` })).toBeVisible();
    await expectHomeXp(page, 5);

    // Reloading is what used to turn the difficulty change into bonus XP.
    await reloadApp(page);
    await expectHomeXp(page, 5);
    await reloadApp(page);
    await expectHomeXp(page, 5);

    await openApp(page, "/completion-history");
    await expect(historyCard(page, title)).toContainText("+5 XP");
    await expect(historyCard(page, title)).toContainText("Easy");
  });

  test("raising a completed Personal Quest's difficulty never changes the XP it earned", async ({ page }) => {
    const title = "Tidy the desk";
    await openApp(page);
    await completeQuest(page, title);

    await editDifficulty(page, title, "Easy · 5 XP", "Hard · 20 XP");

    await expect(questRow(personalPanel(page), title)).toContainText("+20 XP");
    await expectHomeXp(page, 5);
    await reloadApp(page);
    await expectHomeXp(page, 5);
  });

  test("uncompleting an edited quest removes only what it earned, and completing it again earns the new amount", async ({ page }) => {
    const title = "Morning skincare";
    await openApp(page);
    await completeQuest(page, title);
    await editDifficulty(page, title, "Easy · 5 XP", "Hard · 20 XP");
    await reloadApp(page);

    await uncompleteQuest(page, title);
    await expectHomeXp(page, 0);

    await completeQuest(page, title);
    await expectHomeXp(page, 20);
    await reloadApp(page);
    await expectHomeXp(page, 20);
  });

  test("editing an unfinished quest changes its reward without granting XP", async ({ page }) => {
    const title = "Evening stretch";
    await openApp(page);

    await editDifficulty(page, title, "Easy · 5 XP", "Medium · 10 XP");

    await expect(questRow(dailyPanel(page), title)).toContainText("+10 XP");
    await expectHomeXp(page, 0);
    await reloadApp(page);
    await expect(questRow(dailyPanel(page), title)).toContainText("+10 XP");
    await expectHomeXp(page, 0);
  });
});
