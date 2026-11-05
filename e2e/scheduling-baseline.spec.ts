import {
  QUEST_SAVE_KEY,
  VALID_BACKUP_KEY,
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
  uncompleteQuest,
} from "./support";
import type { Page } from "@playwright/test";

/**
 * Baseline for Stage 1B: records how saved daily quests behave before they move away from the legacy
 * `schedule` text. Group titles name what each one protects:
 *   [legacy text]  [structured recurrence]  [precedence]  [progress]  [personal]  [saved format]
 * Only [saved format] checks how data is stored, because later steps are expected to change that on
 * purpose. Everything else checks what a user sees and must keep passing through the migration.
 */

const EVERY_DAY = "Text every day";
const MON_WED = "Text Mon Wed";

type Fields = { id?: string; repeatSchedule?: "Every day" | "Selected days"; selectedDays?: string[]; difficulty?: "Easy" | "Medium" | "Hard" };

function daily(title: string, schedule: string, fields: Fields = {}) {
  return {
    id: fields.id ?? title.toLowerCase().replace(/\W+/g, "-"),
    title,
    category: "Wellness",
    schedule,
    difficulty: fields.difficulty ?? ("Easy" as const),
    completed: false,
    ...(fields.repeatSchedule ? { repeatSchedule: fields.repeatSchedule } : {}),
    ...(fields.selectedDays ? { selectedDays: fields.selectedDays } : {}),
  };
}

function seedDaily(page: Page, quests: ReturnType<typeof daily>[]) {
  return seedStorage(page, { [QUEST_SAVE_KEY]: buildSave({ daily: quests }) });
}

function row(page: Page, title: string) {
  return questRow(dailyPanel(page), title);
}

async function savedData(page: Page) {
  return JSON.parse((await readStorage(page, QUEST_SAVE_KEY))!);
}

test.describe("[legacy text] saved quests that rely on schedule text", () => {
  test("an every-day quest appears and can be completed on all seven days", async ({ page }) => {
    await seedDaily(page, [daily(EVERY_DAY, "Every day")]);
    await openApp(page);
    await expect(row(page, EVERY_DAY)).toContainText("Wellness · Every day");

    const days = [
      "Tuesday, October 20", "Wednesday, October 21", "Thursday, October 22",
      "Friday, October 23", "Saturday, October 24", "Sunday, October 25",
    ];
    for (const day of days) {
      await advanceToDay(page, 1, day);
      await expect(row(page, EVERY_DAY)).toBeVisible();
      await expect(page.getByRole("button", { name: `Complete: ${EVERY_DAY}`, exact: true })).toBeEnabled();
    }
  });

  test("a weekday-text quest appears on Home only on its own days", async ({ page }) => {
    await seedDaily(page, [daily(MON_WED, "Mon, Wed")]);

    await openApp(page);
    await expect(row(page, MON_WED)).toContainText("Wellness · Mon, Wed");
    await expect(dailyPanel(page).getByText("0 / 1 done")).toBeVisible();

    await advanceToDay(page, 1, "Tuesday, October 20");
    await expect(row(page, MON_WED)).toHaveCount(0);
    await expect(dailyPanel(page).getByText("0 / 0 done")).toBeVisible();

    await advanceToDay(page, 1, "Wednesday, October 21");
    await expect(row(page, MON_WED)).toBeVisible();

    await advanceToDay(page, 1, "Thursday, October 22");
    await expect(row(page, MON_WED)).toHaveCount(0);
  });

  test("a weekday-text quest stays listed on All Quests, disabled on other days", async ({ page }) => {
    await seedDaily(page, [daily(MON_WED, "Mon, Wed")]);
    await openApp(page);

    await advanceToDay(page, 1, "Tuesday, October 20");
    await openApp(page, "/all-quests");

    await expect(row(page, MON_WED)).toContainText("Wellness · Mon, Wed");
    await expect(page.getByRole("button", { name: `Complete: ${MON_WED}`, exact: true })).toBeDisabled();
    await expect(dailyPanel(page).getByText("0 / 0 done")).toBeVisible();
  });

  test("every-day text is recognized in any case", async ({ page }) => {
    await seedDaily(page, [daily("Lowercase", "every day"), daily("Uppercase", "EVERY DAY")]);

    await openApp(page);
    await advanceToDay(page, 1, "Tuesday, October 20");

    await expect(row(page, "Lowercase")).toBeVisible();
    await expect(row(page, "Uppercase")).toBeVisible();
    await completeQuest(page, "Lowercase");
    await expectHomeXp(page, 5);
  });

  test("unrecognized text leaves a quest listed but unscheduled, without breaking a streak", async ({ page }) => {
    const unknown = "Unknown schedule";
    await seedDaily(page, [daily(EVERY_DAY, "Every day"), daily(unknown, "Daily")]);
    await openApp(page);

    await expect(row(page, unknown)).toHaveCount(0);
    await expect(dailyPanel(page).getByText("0 / 1 done")).toBeVisible();
    await completeQuest(page, EVERY_DAY);
    await expectStreak(page, 1);

    await openApp(page, "/all-quests");
    await expect(row(page, unknown)).toBeVisible();
    await expect(page.getByRole("button", { name: `Complete: ${unknown}`, exact: true })).toBeDisabled();
  });

  test("a text-only quest's schedule still opens correctly in the edit form", async ({ page }) => {
    await seedDaily(page, [daily(EVERY_DAY, "Every day"), daily(MON_WED, "Mon, Wed")]);
    await openApp(page);

    await page.getByRole("button", { name: `Edit ${EVERY_DAY}`, exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Repeat", exact: true })).toContainText("Every day");
    await page.getByRole("link", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/\/$/);

    await page.getByRole("button", { name: `Edit ${MON_WED}`, exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Repeat", exact: true })).toContainText("Selected days");
    await expect(page.getByRole("button", { name: "Mon", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Wed", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Tue", exact: true })).toHaveAttribute("aria-pressed", "false");
  });
});

test.describe("[structured recurrence] saved quests with repeatSchedule", () => {
  test("Every day and Selected days quests follow their recurrence", async ({ page }) => {
    await seedDaily(page, [
      daily("Structured every day", "Every day", { repeatSchedule: "Every day", selectedDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] }),
      daily("Structured Tuesday", "Tue", { repeatSchedule: "Selected days", selectedDays: ["Tue"] }),
    ]);

    await openApp(page);
    await expect(row(page, "Structured every day")).toContainText("Wellness · Every day");
    await expect(row(page, "Structured Tuesday")).toHaveCount(0);

    await advanceToDay(page, 1, "Tuesday, October 20");
    await expect(row(page, "Structured every day")).toBeVisible();
    await expect(row(page, "Structured Tuesday")).toContainText("Wellness · Tue");
  });
});

test.describe("[precedence] when saved scheduling fields disagree", () => {
  test("repeatSchedule Every day beats weekday text, and the row shows the real schedule", async ({ page }) => {
    const title = "Every day over Monday";
    await seedDaily(page, [daily(title, "Mon", { repeatSchedule: "Every day" })]);
    await openApp(page);

    await advanceToDay(page, 1, "Tuesday, October 20");

    await expect(row(page, title)).toContainText("Wellness · Every day");
    await completeQuest(page, title);
    await expectHomeXp(page, 5);
  });

  test("repeatSchedule Selected days beats every-day text, and the row shows the real schedule", async ({ page }) => {
    const title = "Tuesday over every day";
    await seedDaily(page, [daily(title, "Every day", { repeatSchedule: "Selected days", selectedDays: ["Tue"] })]);

    await openApp(page);
    await expect(row(page, title)).toHaveCount(0);

    await advanceToDay(page, 1, "Tuesday, October 20");
    await expect(row(page, title)).toContainText("Wellness · Tue");
    await completeQuest(page, title);
    await expectHomeXp(page, 5);
  });

  test("a day list beats every-day text when repeatSchedule is absent", async ({ page }) => {
    const title = "List over every day";
    await seedDaily(page, [daily(title, "Every day", { selectedDays: ["Tue"] })]);

    await openApp(page);
    await expect(row(page, title)).toHaveCount(0);

    await advanceToDay(page, 1, "Tuesday, October 20");
    await expect(row(page, title)).toBeVisible();
  });

  test("Selected days with no list is never scheduled, even with every-day text", async ({ page }) => {
    const title = "Empty selection";
    await seedDaily(page, [daily(title, "Every day", { repeatSchedule: "Selected days" })]);

    await openApp(page);
    await expect(row(page, title)).toHaveCount(0);

    await openApp(page, "/all-quests");
    await expect(row(page, title)).toContainText("Wellness · No days selected");
    await expect(page.getByRole("button", { name: `Complete: ${title}`, exact: true })).toBeDisabled();
  });
});

test.describe("[progress] completion, rollover, and rewards on text-only quests", () => {
  test("completion survives a reload, and uncompleting reverses it", async ({ page }) => {
    await seedDaily(page, [daily(EVERY_DAY, "Every day"), daily(MON_WED, "Mon, Wed", { difficulty: "Hard" })]);
    await openApp(page);

    await completeQuest(page, EVERY_DAY);
    await completeQuest(page, MON_WED);
    await expectHomeXp(page, 25);
    await expectCompletedToday(page, 2);

    await reloadApp(page);
    await expect(page.getByRole("button", { name: `Mark incomplete: ${EVERY_DAY}`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `Mark incomplete: ${MON_WED}`, exact: true })).toBeVisible();
    await expectHomeXp(page, 25);
    await expect(dailyPanel(page).getByText("2 / 2 done")).toBeVisible();

    await uncompleteQuest(page, MON_WED);
    await expectHomeXp(page, 5);
    await expectCompletedOverall(page, 1);
  });

  test("rollover resets the day and builds the streak across scheduled and unscheduled days", async ({ page }) => {
    await seedDaily(page, [daily(EVERY_DAY, "Every day"), daily(MON_WED, "Mon, Wed")]);
    await openApp(page);

    await completeQuest(page, EVERY_DAY);
    await expectStreak(page, 0);
    await completeQuest(page, MON_WED);
    await expectStreak(page, 1);

    await advanceToDay(page, 1, "Tuesday, October 20");
    await expect(dailyPanel(page).getByText("0 / 1 done")).toBeVisible();
    await expect(page.getByRole("button", { name: `Complete: ${EVERY_DAY}`, exact: true })).toBeVisible();
    await expectStreak(page, 1);
    await completeQuest(page, EVERY_DAY);
    await expectStreak(page, 2);

    await reloadApp(page);
    await expectStreak(page, 2);
    await expectHomeXp(page, 15);
  });

  test("a missed scheduled day ends the streak, and an unscheduled day does not", async ({ page }) => {
    await seedDaily(page, [daily(MON_WED, "Mon, Wed")]);
    await openApp(page);
    await completeQuest(page, MON_WED);
    await expectStreak(page, 1);

    await advanceToDay(page, 1, "Tuesday, October 20");
    await expectStreak(page, 1);

    await advanceToDay(page, 1, "Wednesday, October 21");
    await expectStreak(page, 1);

    await advanceToDay(page, 1, "Thursday, October 22");
    await expectStreak(page, 0);
    await expectHomeXp(page, 5);
  });

  test("an unopened stretch keeps the streak only if nothing scheduled was missed", async ({ page }) => {
    await seedDaily(page, [daily("Text Monday", "Mon")]);
    await openApp(page);
    await completeQuest(page, "Text Monday");

    await advanceToDay(page, 7, "Monday, October 26");
    await expectStreak(page, 1);
    await completeQuest(page, "Text Monday");
    await expectStreak(page, 2);

    await advanceToDay(page, 8, "Tuesday, November 3");
    await expectStreak(page, 0);
  });

  test("past days keep their history and XP under their own dates", async ({ page }) => {
    await seedDaily(page, [daily(EVERY_DAY, "Every day", { difficulty: "Medium" })]);
    await openApp(page);
    await completeQuest(page, EVERY_DAY);

    await advanceToDay(page, 1, "Tuesday, October 20");
    await completeQuest(page, EVERY_DAY);
    await expectHomeXp(page, 20);
    await expectCompletedOverall(page, 2);

    await openApp(page, "/completion-history");
    await expect(historyDateSection(page, "Monday, October 19, 2026")).toContainText("1 completion");
    await expect(historyDateSection(page, "Tuesday, October 20, 2026")).toContainText("1 completion");
    await expect(historyDateSection(page, "Tuesday, October 20, 2026").getByRole("article")).toContainText("+10 XP");
  });

  test("deleting a completed text-only quest keeps its XP and history", async ({ page }) => {
    await seedDaily(page, [daily(EVERY_DAY, "Every day", { difficulty: "Hard" })]);
    await openApp(page);
    await completeQuest(page, EVERY_DAY);

    await deleteQuest(page, EVERY_DAY);
    await reloadApp(page);

    await expectHomeXp(page, 20);
    await openApp(page, "/completion-history");
    await expect(historyCard(page, EVERY_DAY)).toContainText("+20 XP");
  });

  test("XP from text-only quests earns plant gifts as usual", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: buildSave({
        daily: [daily(EVERY_DAY, "Every day", { difficulty: "Hard" }), daily(MON_WED, "Mon, Wed")],
        discoveredPlantIds: ["fern"],
      }),
    });
    await openApp(page);
    await expect(page.getByRole("progressbar", { name: "XP progress toward Daisy" })).toBeVisible();

    await completeQuest(page, EVERY_DAY);
    await completeQuest(page, MON_WED);
    await expectHomeXp(page, 25);

    await expect(page.getByRole("link", { name: "Plant Journal, 1 gift waiting" })).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "XP progress toward Cactus" })).toBeVisible();
    await reloadApp(page);
    await expect(page.getByRole("link", { name: "Plant Journal, 1 gift waiting" })).toBeVisible();
  });

  test("progress already in a save is kept alongside text-only quests", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: JSON.stringify({
        ...JSON.parse(buildSave({
          daily: [daily(EVERY_DAY, "Every day")],
          legacyXpBonus: 12,
          discoveredPlantIds: ["fern", "daisy"],
          pendingPlantGiftIds: ["cactus"],
        })),
        personalXpByQuestId: { "deleted-personal": 20 },
        personalCompletedOnByQuestId: { "deleted-personal": "2026-10-17" },
        completionHistory: {
          "2026-10-17": {
            scheduledQuestIds: [],
            completedQuestIds: [],
            completionDetails: {
              personal: { "deleted-personal": { title: "Old errand", category: "Chores", difficulty: "Hard", questType: "personal" } },
            },
          },
          "2026-10-18": {
            scheduledQuestIds: ["text-every-day"],
            completedQuestIds: ["text-every-day"],
            xpAwardedByQuestId: { "text-every-day": 30 },
            completionDetails: {
              daily: { "text-every-day": { title: "Earlier title", category: "Wellness", difficulty: "Easy", questType: "daily" } },
            },
          },
        },
      }),
    });

    await openApp(page);
    // 30 from the saved daily award, 20 from the personal award, 12 from the bonus.
    await expect(page.getByText("62 / 100 XP", { exact: true }).first()).toBeVisible();
    await expectStreak(page, 1);
    await expectCompletedOverall(page, 2);
    await expect(page.getByRole("link", { name: "Plant Journal, 1 gift waiting" })).toBeVisible();
    await expect(page.getByText("2 of 16 plants discovered")).toBeVisible();

    await completeQuest(page, EVERY_DAY);
    await expectStreak(page, 2);
    await reloadApp(page);
    await expect(page.getByText("67 / 100 XP", { exact: true }).first()).toBeVisible();

    await openApp(page, "/completion-history");
    await page.locator("summary", { hasText: "Sunday, October 18, 2026" }).click();
    await expect(historyCard(page, "Earlier title")).toContainText("+30 XP");
    await page.locator("summary", { hasText: "Saturday, October 17, 2026" }).click();
    await expect(historyCard(page, "Old errand")).toContainText("+20 XP");
  });
});

test.describe("[personal] Personal Quests are independent of daily recurrence", () => {
  test("schedule text on a Personal Quest never hides it, disables it, or affects streaks", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: buildSave({
        daily: [daily(EVERY_DAY, "Every day")],
        personal: [{ id: "p", title: "Personal with text", category: "Study", schedule: "Mon", difficulty: "Easy", completed: false }],
      }),
    });
    await openApp(page);
    await completeQuest(page, EVERY_DAY);
    await expectStreak(page, 1);

    await advanceToDay(page, 1, "Tuesday, October 20");
    const personal = questRow(personalPanel(page), "Personal with text");
    await expect(personal).toBeVisible();
    await expect(page.getByRole("button", { name: "Complete: Personal with text", exact: true })).toBeEnabled();

    await completeQuest(page, "Personal with text");
    await expectStreak(page, 1);
    await expectHomeXp(page, 10);

    const save = await savedData(page);
    expect(save.completionHistory["2026-10-20"].scheduledQuestIds).toEqual(["text-every-day"]);
  });
});

test.describe("[saved format] how the current version stores this data", () => {
  test("daily snapshots record each day's schedule", async ({ page }) => {
    await seedDaily(page, [daily(EVERY_DAY, "Every day"), daily(MON_WED, "Mon, Wed")]);
    await openApp(page);
    await completeQuest(page, EVERY_DAY);

    await advanceToDay(page, 1, "Tuesday, October 20");

    await expect.poll(async () => (await savedData(page)).completionHistory["2026-10-20"]).toEqual({
      scheduledQuestIds: ["text-every-day"],
      completedQuestIds: [],
    });
    const history = (await savedData(page)).completionHistory;
    expect(history["2026-10-19"].scheduledQuestIds).toEqual(["text-every-day", "text-mon-wed"]);
    expect(history["2026-10-19"].completedQuestIds).toEqual(["text-every-day"]);
    expect(history["2026-10-19"].xpAwardedByQuestId).toEqual({ "text-every-day": 5 });
  });

  // Changed on purpose in Stage 1B Steps 3 and 5, which convert saved quests and remove their text.
  test("text-only quests are converted on load, without their text, with the original backed up", async ({ page }) => {
    const original = buildSave({ daily: [daily(EVERY_DAY, "Every day"), daily(MON_WED, "Mon, Wed")] });
    await seedStorage(page, { [QUEST_SAVE_KEY]: original });
    await openApp(page);
    await reloadApp(page);

    const [everyDay, monWed] = (await savedData(page)).questLists.daily;
    expect(everyDay).not.toHaveProperty("schedule");
    expect(everyDay.repeatSchedule).toBe("Every day");
    expect(monWed).not.toHaveProperty("schedule");
    expect(monWed.repeatSchedule).toBe("Selected days");
    expect(monWed.selectedDays).toEqual(["Mon", "Wed"]);
    expect(await readStorage(page, VALID_BACKUP_KEY)).toBe(original);
  });
});
