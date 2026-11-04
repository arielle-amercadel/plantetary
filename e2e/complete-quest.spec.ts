import {
  completeQuest,
  dailyPanel,
  expect,
  expectCompletedOverall,
  expectCompletedToday,
  expectHomeXp,
  historyCard,
  historyDateSection,
  openApp,
  personalPanel,
  reloadApp,
  test,
  uncompleteQuest,
} from "./support";

test.describe("Complete and uncomplete quests", () => {
  test("a Daily Quest adds XP and history, keeps them after a reload, and removes them when uncompleted", async ({ page }) => {
    const title = "Read for 20 minutes";
    await openApp(page);

    await completeQuest(page, title);
    await expectHomeXp(page, 10);
    await expectCompletedToday(page, 1);
    await expectCompletedOverall(page, 1);
    await expect(dailyPanel(page).getByText("1 / 4 done")).toBeVisible();

    await openApp(page, "/completion-history");
    const section = historyDateSection(page, "Monday, October 19, 2026");
    await expect(section).toContainText("1 completion");
    await expect(historyCard(page, title)).toContainText("+10 XP");

    await openApp(page);
    await reloadApp(page);
    await expect(page.getByRole("button", { name: `Mark incomplete: ${title}` })).toBeVisible();
    await expectHomeXp(page, 10);

    await uncompleteQuest(page, title);
    await expectHomeXp(page, 0);
    await expectCompletedToday(page, 0);
    await expectCompletedOverall(page, 0);
    await expect(dailyPanel(page).getByText("0 / 4 done")).toBeVisible();

    await openApp(page, "/completion-history");
    await expect(page.getByRole("heading", { name: "Your story is just beginning" })).toBeVisible();
    await expect(historyCard(page, title)).toHaveCount(0);
  });

  test("a Personal Quest adds XP and history, keeps them after a reload, and removes them when uncompleted", async ({ page }) => {
    const title = "Finish portfolio moodboard";
    await openApp(page);

    await completeQuest(page, title);
    await expectHomeXp(page, 20);
    await expect(personalPanel(page).getByText("1 / 3 done")).toBeVisible();

    await reloadApp(page);
    await expect(page.getByRole("button", { name: `Mark incomplete: ${title}` })).toBeVisible();
    await expectHomeXp(page, 20);
    await expectCompletedToday(page, 1);

    await openApp(page, "/completion-history");
    await expect(historyCard(page, title)).toContainText("+20 XP");

    await openApp(page);
    await uncompleteQuest(page, title);
    await expectHomeXp(page, 0);
    await reloadApp(page);
    await expectHomeXp(page, 0);
    await expect(page.getByRole("button", { name: `Complete: ${title}` })).toBeVisible();

    await openApp(page, "/completion-history");
    await expect(historyCard(page, title)).toHaveCount(0);
  });

  test("each difficulty earns its own XP and they add up", async ({ page }) => {
    await openApp(page);

    await completeQuest(page, "Drink a glass of water");
    await expectHomeXp(page, 5);
    await completeQuest(page, "Read for 20 minutes");
    await expectHomeXp(page, 15);
    await completeQuest(page, "Finish portfolio moodboard");
    await expectHomeXp(page, 35);
    await expectCompletedToday(page, 3);

    await uncompleteQuest(page, "Read for 20 minutes");
    await expectHomeXp(page, 25);
    await expectCompletedToday(page, 2);
  });

  test("completing a quest from All Quests updates Home", async ({ page }) => {
    await openApp(page, "/all-quests");
    await completeQuest(page, "Tidy the desk");

    await openApp(page);
    await expect(page.getByRole("button", { name: "Mark incomplete: Tidy the desk" })).toBeVisible();
    await expectHomeXp(page, 5);
  });
});
