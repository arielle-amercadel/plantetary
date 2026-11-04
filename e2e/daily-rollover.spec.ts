import {
  QUEST_SAVE_KEY,
  STARTER_DAILY,
  advanceToDay,
  buildSave,
  completeQuest,
  dailyPanel,
  expect,
  expectCompletedOverall,
  expectCompletedToday,
  expectHomeXp,
  expectStreak,
  historyCard,
  historyDateSection,
  openApp,
  personalPanel,
  questRow,
  reloadApp,
  seedStorage,
  test,
} from "./support";
import type { Page } from "@playwright/test";

async function completeAllDaily(page: Page) {
  for (const title of STARTER_DAILY) await completeQuest(page, title);
}

test.describe("Daily rollover and streaks", () => {
  test("a new day resets Daily Quests, keeps XP, and builds the streak", async ({ page }) => {
    await openApp(page);
    await expect(page.getByText("Monday, October 19", { exact: true })).toBeVisible();
    await completeAllDaily(page);
    await expectHomeXp(page, 25);
    await expectStreak(page, 1);

    await advanceToDay(page, 1, "Tuesday, October 20");

    await expect(dailyPanel(page).getByText("0 / 4 done")).toBeVisible();
    await expect(page.getByRole("button", { name: `Complete: ${STARTER_DAILY[0]}` })).toBeVisible();
    await expectHomeXp(page, 25);
    await expectCompletedToday(page, 0);
    await expectCompletedOverall(page, 4);
    // An unfinished today does not break the streak yet.
    await expectStreak(page, 1);

    await completeAllDaily(page);
    await expectHomeXp(page, 50);
    await expectCompletedToday(page, 4);
    await expectCompletedOverall(page, 8);
    await expectStreak(page, 2);

    await reloadApp(page);
    await expect(page.getByText("Tuesday, October 20", { exact: true })).toBeVisible();
    await expectHomeXp(page, 50);
    await expectStreak(page, 2);
  });

  test("the new day also applies when the page is reloaded after midnight", async ({ page }) => {
    await openApp(page);
    await completeAllDaily(page);

    await page.clock.fastForward(24 * 60 * 60 * 1000);
    await reloadApp(page);

    await expect(page.getByText("Tuesday, October 20", { exact: true })).toBeVisible();
    await expect(dailyPanel(page).getByText("0 / 4 done")).toBeVisible();
    await expectHomeXp(page, 25);
    await expectStreak(page, 1);
  });

  test("a quest completed just before midnight is recorded on that day", async ({ page }) => {
    const title = STARTER_DAILY[0];
    await openApp(page);

    // From 10:00 to 23:59 on Monday.
    await page.clock.fastForward("13:59:00");
    await expect(page.getByText("Monday, October 19", { exact: true })).toBeVisible();
    await completeQuest(page, title);

    await page.clock.fastForward("02:00");
    await expect(page.getByText("Tuesday, October 20", { exact: true })).toBeVisible();
    await expectCompletedToday(page, 0);
    await expectCompletedOverall(page, 1);

    await openApp(page, "/completion-history");
    await expect(historyDateSection(page, "Monday, October 19, 2026")).toContainText("1 completion");
    await expect(historyDateSection(page, "Tuesday, October 20, 2026")).toHaveCount(0);
  });

  test("a day left unfinished ends the streak but keeps its XP and history", async ({ page }) => {
    await openApp(page);
    await completeAllDaily(page);
    await expectStreak(page, 1);

    await advanceToDay(page, 1, "Tuesday, October 20");
    await completeQuest(page, STARTER_DAILY[0]);
    await expectHomeXp(page, 30);

    await advanceToDay(page, 1, "Wednesday, October 21");
    await expectStreak(page, 0);
    await expectHomeXp(page, 30);
    await expectCompletedOverall(page, 5);

    await openApp(page, "/completion-history");
    await expect(historyDateSection(page, "Tuesday, October 20, 2026")).toContainText("1 completion");
    await expect(historyDateSection(page, "Monday, October 19, 2026")).toContainText("4 completions");
  });

  test("past days stay in history under their own dates", async ({ page }) => {
    const title = STARTER_DAILY[2];
    await openApp(page);
    await completeQuest(page, title);

    await advanceToDay(page, 1, "Tuesday, October 20");
    await completeQuest(page, title);

    await openApp(page, "/completion-history");
    const today = historyDateSection(page, "Tuesday, October 20, 2026");
    const yesterday = historyDateSection(page, "Monday, October 19, 2026");

    await expect(today.getByRole("article")).toBeVisible();
    await expect(yesterday.getByRole("article")).toBeHidden();
    await yesterday.locator("summary").click();
    await expect(yesterday.getByRole("article")).toBeVisible();
    await expect(historyCard(page, title)).toHaveCount(2);
  });

  test("a selected-days quest can only be completed on its scheduled day", async ({ page }) => {
    const title = "Tuesday yoga";
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: buildSave({
        daily: [{
          id: "yoga",
          title,
          category: "Wellness",
          schedule: "Tue",
          difficulty: "Medium",
          completed: false,
          repeatSchedule: "Selected days",
          selectedDays: ["Tue"],
        }],
      }),
    });
    await openApp(page);
    await expect(questRow(dailyPanel(page), title)).toHaveCount(0);

    await advanceToDay(page, 1, "Tuesday, October 20");
    await completeQuest(page, title);
    await expectHomeXp(page, 10);
    await expectStreak(page, 1);

    await advanceToDay(page, 1, "Wednesday, October 21");
    await expect(questRow(dailyPanel(page), title)).toHaveCount(0);
    await expectHomeXp(page, 10);
    // Wednesday has nothing scheduled, so it neither adds to nor breaks the streak.
    await expectStreak(page, 1);
  });

  test("a Personal Quest becomes past due only after its due date", async ({ page }) => {
    const title = "Return library book";
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: buildSave({
        personal: [{
          id: "library",
          title,
          category: "Study",
          schedule: "Due Oct 19",
          difficulty: "Easy",
          completed: false,
          dueDate: "2026-10-19",
        }],
      }),
    });
    await openApp(page);
    await expect(questRow(personalPanel(page), title)).not.toContainText("Past Due");

    await advanceToDay(page, 1, "Tuesday, October 20");
    await expect(questRow(personalPanel(page), title)).toContainText("Past Due");
  });
});

test.describe("Current rule: streaks need the app opened each day", () => {
  // The app only records a day when it is open that day, and a day with no record ends the streak.
  // This documents today's behavior so the Supabase work does not change it by accident.
  test("a day the app was never opened ends the streak", async ({ page }) => {
    await openApp(page);
    await completeAllDaily(page);
    await expectStreak(page, 1);

    await advanceToDay(page, 2, "Wednesday, October 21");
    await expectStreak(page, 0);
    await expectHomeXp(page, 25);
  });
});
