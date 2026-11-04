import {
  DAY_MS,
  QUEST_SAVE_KEY,
  STARTER_DAILY,
  advanceToDay,
  buildSave,
  completeQuest,
  dailyPanel,
  deleteQuest,
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
  readStorage,
  reloadApp,
  seedStorage,
  test,
} from "./support";
import type { Page } from "@playwright/test";

const ALL_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function selectedDaysQuest(title: string, days: string[]) {
  return {
    id: title.toLowerCase().replace(/\s/g, "-"),
    title,
    category: "Wellness",
    schedule: days.join(", "),
    difficulty: "Easy" as const,
    completed: false,
    repeatSchedule: "Selected days" as const,
    selectedDays: days,
  };
}

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

test.describe("Days the app was not opened", () => {
  const MONDAY_QUEST = "Monday class";
  const mondayOnly = selectedDaysQuest(MONDAY_QUEST, ["Mon"]);

  test("a scheduled day that passed unopened ends the streak", async ({ page }) => {
    await openApp(page);
    await completeAllDaily(page);
    await expectStreak(page, 1);

    await advanceToDay(page, 2, "Wednesday, October 21");
    await expectStreak(page, 0);
    await expectHomeXp(page, 25);
  });

  test("an unopened week with nothing scheduled keeps the streak, and the next success adds one", async ({ page }) => {
    await seedStorage(page, { [QUEST_SAVE_KEY]: buildSave({ daily: [mondayOnly] }) });
    await openApp(page);
    await completeQuest(page, MONDAY_QUEST);
    await expectStreak(page, 1);

    await advanceToDay(page, 7, "Monday, October 26");
    // Today is not finished yet, but it cannot break the streak until it ends.
    await expectStreak(page, 1);

    await completeQuest(page, MONDAY_QUEST);
    await expectStreak(page, 2);
    await expectHomeXp(page, 10);
    await expectCompletedOverall(page, 2);

    // The filled-in days carry no completions, so only the two real days appear in history.
    await openApp(page, "/completion-history");
    await expect(page.locator("summary")).toHaveCount(2);
    await expect(historyDateSection(page, "Monday, October 19, 2026")).toContainText("1 completion");
    await expect(historyDateSection(page, "Monday, October 26, 2026")).toContainText("1 completion");
  });

  test("the same gap is filled when it is first seen through a reload", async ({ page }) => {
    await seedStorage(page, { [QUEST_SAVE_KEY]: buildSave({ daily: [mondayOnly] }) });
    await openApp(page);
    await completeQuest(page, MONDAY_QUEST);

    await page.clock.fastForward(7 * DAY_MS);
    await reloadApp(page);

    await expect(page.getByText("Monday, October 26", { exact: true })).toBeVisible();
    await expectStreak(page, 1);
    await reloadApp(page);
    await expectStreak(page, 1);
  });

  test("missing the next scheduled day breaks the streak once that day has ended", async ({ page }) => {
    await seedStorage(page, { [QUEST_SAVE_KEY]: buildSave({ daily: [mondayOnly] }) });
    await openApp(page);
    await completeQuest(page, MONDAY_QUEST);

    await advanceToDay(page, 8, "Tuesday, October 27");

    await expectStreak(page, 0);
    await expectHomeXp(page, 5);
    await expectCompletedOverall(page, 1);
  });

  test("deleting a quest later does not erase a day it was missed", async ({ page }) => {
    const title = "Every day quest";
    await seedStorage(page, { [QUEST_SAVE_KEY]: buildSave({ daily: [selectedDaysQuest(title, ALL_DAYS)] }) });
    await openApp(page);
    await completeQuest(page, title);

    await advanceToDay(page, 2, "Wednesday, October 21");
    await expectStreak(page, 0);

    await deleteQuest(page, title);
    await expectStreak(page, 0);
    await reloadApp(page);
    await expectStreak(page, 0);
  });

  test("a quest deleted right after waking still counts as scheduled on the days before", async ({ page }) => {
    // Changes the date without firing the app's timer, so the delete is the first thing to see the gap.
    const title = "Monday and Thursday";
    await seedStorage(page, { [QUEST_SAVE_KEY]: buildSave({ daily: [selectedDaysQuest(title, ["Mon", "Thu"])] }) });
    await openApp(page);
    await completeQuest(page, title);
    await expectStreak(page, 1);

    await page.clock.setSystemTime("2026-10-23T10:00:00Z");
    await deleteQuest(page, title);
    await page.clock.fastForward("01:00");
    await expect(page.getByText("Friday, October 23", { exact: true })).toBeVisible();

    await expectStreak(page, 0);
  });

  test("a day removed from the schedule before the gap does not count as missed", async ({ page }) => {
    const title = "Monday and Thursday";
    await seedStorage(page, { [QUEST_SAVE_KEY]: buildSave({ daily: [selectedDaysQuest(title, ["Mon", "Thu"])] }) });
    await openApp(page);
    await completeQuest(page, title);

    await page.getByRole("button", { name: `Edit ${title}` }).click();
    await page.getByRole("button", { name: "Thu", exact: true }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/$/);

    await advanceToDay(page, 4, "Friday, October 23");
    await expectStreak(page, 1);
  });

  test("a day added to the schedule before the gap counts as missed", async ({ page }) => {
    await seedStorage(page, { [QUEST_SAVE_KEY]: buildSave({ daily: [mondayOnly] }) });
    await openApp(page);
    await completeQuest(page, MONDAY_QUEST);

    await page.getByRole("button", { name: `Edit ${MONDAY_QUEST}` }).click();
    await page.getByRole("button", { name: "Wed", exact: true }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/$/);

    await advanceToDay(page, 3, "Thursday, October 22");
    await expectStreak(page, 0);
  });

  test("a gap keeps earned XP, waiting gifts, and collected plants", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: buildSave({
        daily: [mondayOnly],
        legacyXpBonus: 30,
        discoveredPlantIds: ["fern"],
        pendingPlantGiftIds: ["daisy"],
      }),
    });
    await openApp(page);
    await expect(page.getByRole("link", { name: "Plant Journal, 1 gift waiting" })).toBeVisible();

    await advanceToDay(page, 7, "Monday, October 26");

    await expectHomeXp(page, 30);
    await expect(page.getByRole("link", { name: "Plant Journal, 1 gift waiting" })).toBeVisible();
    await expect(page.getByText("1 of 16 plants discovered")).toBeVisible();
  });
});

test.describe("Daily Quest checkmarks and today's progress", () => {
  const MONDAY_QUEST = "Monday class";
  const mondayOnly = selectedDaysQuest(MONDAY_QUEST, ["Mon"]);

  test("a quest finished on its day is unchecked and disabled on an unscheduled day", async ({ page }) => {
    await seedStorage(page, { [QUEST_SAVE_KEY]: buildSave({ daily: [mondayOnly] }) });
    await openApp(page);
    await completeQuest(page, MONDAY_QUEST);

    await advanceToDay(page, 1, "Tuesday, October 20");
    await openApp(page, "/all-quests");

    await expect(page.getByRole("button", { name: `Complete: ${MONDAY_QUEST}`, exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Mark incomplete/ })).toHaveCount(0);
    await expect(dailyPanel(page).getByText("0 / 0 done")).toBeVisible();
    await expect(questRow(dailyPanel(page), MONDAY_QUEST)).toContainText("Mon");
  });

  test("the number of past completions never affects an unscheduled day's checkmark", async ({ page }) => {
    const title = "Monday and Tuesday";
    await seedStorage(page, { [QUEST_SAVE_KEY]: buildSave({ daily: [selectedDaysQuest(title, ["Mon", "Tue"])] }) });
    await openApp(page);
    await completeQuest(page, title);
    await advanceToDay(page, 1, "Tuesday, October 20");
    await completeQuest(page, title);

    await advanceToDay(page, 1, "Wednesday, October 21");
    await openApp(page, "/all-quests");

    await expect(page.getByRole("button", { name: `Complete: ${title}`, exact: true })).toBeDisabled();
    await expect(dailyPanel(page).getByText("0 / 0 done")).toBeVisible();
  });

  test("a save with a leftover completed flag shows today's real status and grants no XP", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: buildSave({
        daily: [
          { ...mondayOnly, completed: true },
          { ...selectedDaysQuest("Tuesday class", ["Tue"]), completed: true },
        ],
      }),
    });
    await openApp(page, "/all-quests");

    await expect(page.getByRole("button", { name: `Complete: ${MONDAY_QUEST}`, exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Complete: Tuesday class", exact: true })).toBeDisabled();
    await expect(dailyPanel(page).getByText("0 / 1 done")).toBeVisible();

    await openApp(page);
    await expectHomeXp(page, 0);
    await completeQuest(page, MONDAY_QUEST);
    await expectHomeXp(page, 5);
  });

  test("completing a Daily Quest does not write the old completed flag", async ({ page }) => {
    await seedStorage(page, { [QUEST_SAVE_KEY]: buildSave({ daily: [mondayOnly] }) });
    await openApp(page);

    await completeQuest(page, MONDAY_QUEST);
    await expectHomeXp(page, 5);

    const save = JSON.parse((await readStorage(page, QUEST_SAVE_KEY))!);
    expect(save.questLists.daily[0].completed).toBe(false);
    expect(save.completionHistory["2026-10-19"].completedQuestIds).toEqual(["monday-class"]);
  });

  test("a quest completed today and then rescheduled away stays checked today only", async ({ page }) => {
    await seedStorage(page, { [QUEST_SAVE_KEY]: buildSave({ daily: [mondayOnly] }) });
    await openApp(page);
    await completeQuest(page, MONDAY_QUEST);

    await page.getByRole("button", { name: `Edit ${MONDAY_QUEST}` }).click();
    await page.getByRole("button", { name: "Tue", exact: true }).click();
    await page.getByRole("button", { name: "Mon", exact: true }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expectHomeXp(page, 5);
    await expectStreak(page, 1);

    await openApp(page, "/all-quests");
    await expect(page.getByRole("button", { name: `Mark incomplete: ${MONDAY_QUEST}`, exact: true })).toBeDisabled();
    await expect(dailyPanel(page).getByText("1 / 1 done")).toBeVisible();

    await advanceToDay(page, 1, "Tuesday, October 20");
    await expect(page.getByRole("button", { name: `Complete: ${MONDAY_QUEST}`, exact: true })).toBeEnabled();
    await expect(dailyPanel(page).getByText("0 / 1 done")).toBeVisible();
  });

  test("All Quests counts only today's Daily Quests while still listing the others", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: buildSave({
        daily: [
          mondayOnly,
          selectedDaysQuest("Every day quest", ALL_DAYS),
          selectedDaysQuest("Tuesday class", ["Tue"]),
        ],
      }),
    });
    await openApp(page, "/all-quests");

    await expect(dailyPanel(page).getByRole("listitem")).toHaveCount(3);
    await expect(dailyPanel(page).getByText("0 / 2 done")).toBeVisible();

    await completeQuest(page, MONDAY_QUEST);
    await completeQuest(page, "Every day quest");
    await expect(dailyPanel(page).getByText("2 / 2 done")).toBeVisible();
    await expectStreakOnHome(page, 1);
  });

  test("Personal Quests stay checked on later days and keep their count", async ({ page }) => {
    const title = "Tidy the desk";
    await openApp(page);
    await completeQuest(page, title);

    await advanceToDay(page, 1, "Tuesday, October 20");

    await expect(page.getByRole("button", { name: `Mark incomplete: ${title}`, exact: true })).toBeEnabled();
    await expect(personalPanel(page).getByText("1 / 3 done")).toBeVisible();
    await expectHomeXp(page, 5);

    await reloadApp(page);
    await expect(page.getByRole("button", { name: `Mark incomplete: ${title}`, exact: true })).toBeEnabled();
  });
});

async function expectStreakOnHome(page: Page, days: number) {
  await openApp(page);
  await expectStreak(page, days);
}
