import {
  STARTER_DAILY,
  completeQuest,
  dailyPanel,
  deleteQuest,
  expect,
  expectCompletedOverall,
  expectCompletedToday,
  expectHomeXp,
  expectStreak,
  historyCard,
  openApp,
  personalPanel,
  questRow,
  reloadApp,
  test,
} from "./support";

test.describe("Delete quest", () => {
  test("an unfinished quest is removed for good and leaves no history or XP", async ({ page }) => {
    const title = "Evening stretch";
    await openApp(page);

    await deleteQuest(page, title);
    await expect(dailyPanel(page).getByText("0 / 3 done")).toBeVisible();

    await reloadApp(page);
    await expect(questRow(dailyPanel(page), title)).toHaveCount(0);
    await expectHomeXp(page, 0);

    await openApp(page, "/all-quests");
    await expect(questRow(dailyPanel(page), title)).toHaveCount(0);
    await openApp(page, "/completion-history");
    await expect(page.getByRole("heading", { name: "Your story is just beginning" })).toBeVisible();
  });

  test("a completed Personal Quest leaves the list but keeps its XP and history", async ({ page }) => {
    const title = "Finish portfolio moodboard";
    await openApp(page);
    await completeQuest(page, title);

    await deleteQuest(page, title);
    await expect(questRow(personalPanel(page), title)).toHaveCount(0);
    await expectHomeXp(page, 20);
    await expectCompletedOverall(page, 1);

    await reloadApp(page);
    await expect(questRow(personalPanel(page), title)).toHaveCount(0);
    await expectHomeXp(page, 20);
    await expectCompletedOverall(page, 1);

    await openApp(page, "/completion-history");
    await expect(historyCard(page, title)).toContainText("+20 XP");
  });

  test("a completed Daily Quest leaves the list but keeps its XP and history", async ({ page }) => {
    const title = "Read for 20 minutes";
    await openApp(page);
    await completeQuest(page, title);

    await deleteQuest(page, title);
    await expect(questRow(dailyPanel(page), title)).toHaveCount(0);
    await expectHomeXp(page, 10);
    await expectCompletedToday(page, 1);

    await reloadApp(page);
    await expect(questRow(dailyPanel(page), title)).toHaveCount(0);
    await expectHomeXp(page, 10);

    await openApp(page, "/completion-history");
    await expect(historyCard(page, title)).toContainText("+10 XP");
  });

  test("deleting today's last unfinished Daily Quest lets today count toward the streak", async ({ page }) => {
    await openApp(page);
    const [lastQuest, ...others] = STARTER_DAILY;
    for (const title of others) await completeQuest(page, title);
    await expectStreak(page, 0);

    await deleteQuest(page, lastQuest);
    await expectStreak(page, 1);

    await reloadApp(page);
    await expectStreak(page, 1);
  });
});
