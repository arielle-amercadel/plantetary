import {
  QUEST_SAVE_KEY,
  buildSave,
  completeQuest,
  dailyPanel,
  expect,
  expectHomeXp,
  expectStreak,
  historyDateSection,
  openApp,
  questRow,
  readStorage,
  reloadApp,
  seedStorage,
  test,
} from "./support";
import type { Page } from "@playwright/test";

/**
 * Daily rollover in Los Angeles, where the local date differs from the UTC date for part of each day.
 * The other browser tests run in UTC, so these would catch code using the wrong date.
 */

// 11:50 PM on Monday, October 19 in Los Angeles, which is already Tuesday in UTC.
const LATE_MONDAY = "2026-10-20T06:50:00Z";
// 11:50 PM on Saturday, October 31, the night before clocks go back an hour.
const LATE_SATURDAY_BEFORE_CLOCK_CHANGE = "2026-11-01T06:50:00Z";

const MONDAY_QUEST = "Monday quest";
const TUESDAY_QUEST = "Tuesday quest";
const EVERY_DAY_QUEST = "Every day quest";

function quest(title: string, recurrence: { repeatSchedule?: "Every day" | "Selected days"; selectedDays?: string[]; schedule?: string }) {
  return {
    id: title.toLowerCase().replace(/\W+/g, "-"),
    title,
    category: "Wellness",
    difficulty: "Easy" as const,
    completed: false,
    ...recurrence,
  };
}

const QUESTS = [
  quest(MONDAY_QUEST, { repeatSchedule: "Selected days", selectedDays: ["Mon"] }),
  quest(TUESDAY_QUEST, { schedule: "Tue" }),
  quest(EVERY_DAY_QUEST, { schedule: "Every day" }),
];

function row(page: Page, title: string) {
  return questRow(dailyPanel(page), title);
}

async function start(page: Page, moment: string, quests = QUESTS) {
  await page.clock.setSystemTime(moment);
  await seedStorage(page, { [QUEST_SAVE_KEY]: buildSave({ daily: quests }) });
  await openApp(page);
}

async function history(page: Page) {
  return JSON.parse((await readStorage(page, QUEST_SAVE_KEY))!).completionHistory;
}

test.describe("Daily rollover in Los Angeles", () => {
  test.use({ timezoneId: "America/Los_Angeles" });

  test("late on Monday it is still Monday, even though it is already Tuesday in UTC", async ({ page }) => {
    await start(page, LATE_MONDAY);

    await expect(page.getByText("Monday, October 19", { exact: true })).toBeVisible();
    await expect(row(page, MONDAY_QUEST)).toBeVisible();
    await expect(row(page, EVERY_DAY_QUEST)).toBeVisible();
    await expect(row(page, TUESDAY_QUEST)).toHaveCount(0);

    await expect.poll(async () => Object.keys(await history(page))).toEqual(["2026-10-19"]);
  });

  test("local midnight moves quests to the next weekday, and keeps history on the right day", async ({ page }) => {
    await start(page, LATE_MONDAY);
    await completeQuest(page, MONDAY_QUEST);
    await completeQuest(page, EVERY_DAY_QUEST);
    await expectStreak(page, 1);
    await expectHomeXp(page, 10);

    // From 11:50 PM to 12:05 AM.
    await page.clock.fastForward("15:00");
    await expect(page.getByText("Tuesday, October 20", { exact: true })).toBeVisible();

    await expect(row(page, MONDAY_QUEST)).toHaveCount(0);
    await expect(row(page, TUESDAY_QUEST)).toBeVisible();
    await expect(page.getByRole("button", { name: `Complete: ${EVERY_DAY_QUEST}`, exact: true })).toBeEnabled();
    await expect(dailyPanel(page).getByText("0 / 2 done")).toBeVisible();
    await expectStreak(page, 1);
    await expectHomeXp(page, 10);

    await completeQuest(page, TUESDAY_QUEST);
    await completeQuest(page, EVERY_DAY_QUEST);
    await expectStreak(page, 2);
    await expectHomeXp(page, 20);

    const days = await history(page);
    expect(days["2026-10-19"].scheduledQuestIds).toEqual(["monday-quest", "every-day-quest"]);
    expect(days["2026-10-19"].completedQuestIds).toEqual(["monday-quest", "every-day-quest"]);
    expect(days["2026-10-20"].scheduledQuestIds).toEqual(["tuesday-quest", "every-day-quest"]);

    await openApp(page, "/completion-history");
    await expect(historyDateSection(page, "Monday, October 19, 2026")).toContainText("2 completions");
    await expect(historyDateSection(page, "Tuesday, October 20, 2026")).toContainText("2 completions");
  });

  test("a quest finished just before local midnight counts for that day after a reload", async ({ page }) => {
    await start(page, LATE_MONDAY);
    await completeQuest(page, EVERY_DAY_QUEST);
    await completeQuest(page, MONDAY_QUEST);

    await page.clock.fastForward("15:00");
    await reloadApp(page);

    await expect(page.getByText("Tuesday, October 20", { exact: true })).toBeVisible();
    await expectStreak(page, 1);
    await expect(page.getByRole("button", { name: `Complete: ${EVERY_DAY_QUEST}`, exact: true })).toBeVisible();
    expect((await history(page))["2026-10-19"].completedQuestIds).toEqual(["every-day-quest", "monday-quest"]);
  });

  test("a missed local day ends the streak, and a day with nothing scheduled does not", async ({ page }) => {
    await start(page, LATE_MONDAY, [QUESTS[0]]);
    await completeQuest(page, MONDAY_QUEST);
    await expectStreak(page, 1);

    // Tuesday has nothing scheduled.
    await page.clock.fastForward("15:00");
    await expect(page.getByText("Tuesday, October 20", { exact: true })).toBeVisible();
    await expect(row(page, MONDAY_QUEST)).toHaveCount(0);
    await expectStreak(page, 1);

    // Next Monday is scheduled and arrives first, so it cannot break the streak until it ends.
    await page.clock.fastForward(6 * 24 * 60 * 60 * 1000);
    await expect(page.getByText("Monday, October 26", { exact: true })).toBeVisible();
    await expect(row(page, MONDAY_QUEST)).toBeVisible();
    await expectStreak(page, 1);

    await page.clock.fastForward(24 * 60 * 60 * 1000);
    await expect(page.getByText("Tuesday, October 27", { exact: true })).toBeVisible();
    await expectStreak(page, 0);
    await expectHomeXp(page, 5);
  });

  test("the change to standard time neither skips nor repeats a day", async ({ page }) => {
    await start(page, LATE_SATURDAY_BEFORE_CLOCK_CHANGE, [QUESTS[2]]);
    await expect(page.getByText("Saturday, October 31", { exact: true })).toBeVisible();
    await completeQuest(page, EVERY_DAY_QUEST);

    await page.clock.fastForward("15:00");
    await expect(page.getByText("Sunday, November 1", { exact: true })).toBeVisible();
    await completeQuest(page, EVERY_DAY_QUEST);
    await expectStreak(page, 2);

    // Sunday, November 1 lasts 25 hours here, so 24 hours later is still that day.
    await page.clock.fastForward(24 * 60 * 60 * 1000);
    await expect(page.getByText("Sunday, November 1", { exact: true })).toBeVisible();

    await page.clock.fastForward(60 * 60 * 1000);
    await expect(page.getByText("Monday, November 2", { exact: true })).toBeVisible();
    await completeQuest(page, EVERY_DAY_QUEST);
    await expectStreak(page, 3);

    const days = await history(page);
    expect(Object.keys(days).sort()).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
  });
});
