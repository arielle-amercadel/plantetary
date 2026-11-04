import {
  QUEST_SAVE_KEY,
  STARTER_DAILY,
  advanceToDay,
  buildSave,
  completeQuest,
  dailyPanel,
  expect,
  expectHomeXp,
  openApp,
  personalPanel,
  questRow,
  reloadApp,
  seedStorage,
  test,
  uncompleteQuest,
} from "./support";
import type { Page } from "@playwright/test";

const DUE_QUEST = "Return library book";

function personalQuest(overrides: { title?: string; id?: string; dueDate?: string; schedule?: string } = {}) {
  return {
    id: overrides.id ?? "library",
    title: overrides.title ?? DUE_QUEST,
    category: "Study",
    schedule: overrides.schedule ?? "",
    difficulty: "Easy" as const,
    completed: false,
    ...(overrides.dueDate ? { dueDate: overrides.dueDate } : {}),
  };
}

function seedPersonal(page: Page, quests: ReturnType<typeof personalQuest>[]) {
  return seedStorage(page, { [QUEST_SAVE_KEY]: buildSave({ personal: quests }) });
}

function dueQuestRow(page: Page, title = DUE_QUEST) {
  return questRow(personalPanel(page), title);
}

function pastDueBadge(page: Page, title = DUE_QUEST) {
  return dueQuestRow(page, title).getByText("Past Due", { exact: true });
}

/** Matches the whole category line, so a separator or leftover label after the category would fail. */
function categoryLineWithoutDate(page: Page, category: string, title = DUE_QUEST) {
  return dueQuestRow(page, title).getByText(category, { exact: true });
}

test.describe("Due-date labels on quest rows", () => {
  test("a date this week shows its formatted date on Home and All Quests, and after a reload", async ({ page }) => {
    await seedPersonal(page, [personalQuest({ dueDate: "2026-10-22" })]);

    await openApp(page);
    await expect(dueQuestRow(page)).toContainText("Study · Due Oct 22");

    await reloadApp(page);
    await expect(dueQuestRow(page)).toContainText("Study · Due Oct 22");

    await openApp(page, "/all-quests");
    await expect(dueQuestRow(page)).toContainText("Study · Due Oct 22");
  });

  test("today, tomorrow, and another year use their own wording", async ({ page }) => {
    await seedPersonal(page, [
      personalQuest({ id: "today", title: "Due on Monday", dueDate: "2026-10-19" }),
      personalQuest({ id: "tomorrow", title: "Due on Tuesday", dueDate: "2026-10-20" }),
      personalQuest({ id: "next-year", title: "Due next year", dueDate: "2027-01-05" }),
    ]);

    await openApp(page);

    await expect(dueQuestRow(page, "Due on Monday")).toContainText("Study · Due today");
    await expect(dueQuestRow(page, "Due on Tuesday")).toContainText("Study · Due tomorrow");
    await expect(dueQuestRow(page, "Due next year")).toContainText("Study · Due Jan 5, 2027");
  });

  test("the saved schedule text is ignored in favor of the real date", async ({ page }) => {
    await seedPersonal(page, [personalQuest({ dueDate: "2026-10-22", schedule: "Due Oct 20" })]);

    await openApp(page);

    await expect(dueQuestRow(page)).toContainText("Due Oct 22");
    await expect(dueQuestRow(page)).not.toContainText("Due Oct 20");
  });

  test("a quest without a due date shows only its category, on Home and All Quests", async ({ page }) => {
    await seedPersonal(page, [personalQuest()]);

    await openApp(page);
    await expect(categoryLineWithoutDate(page, "Study")).toBeVisible();
    await expect(pastDueBadge(page)).toHaveCount(0);

    await openApp(page, "/all-quests");
    await expect(categoryLineWithoutDate(page, "Study")).toBeVisible();
  });

  test("old saved labels do not appear on a quest with no real date", async ({ page }) => {
    await seedPersonal(page, [
      personalQuest({ id: "a", title: "Old due today", schedule: "Due today" }),
      personalQuest({ id: "b", title: "Old fixed date", schedule: "Due Oct 20" }),
      personalQuest({ id: "c", title: "Old no date", schedule: "No due date" }),
    ]);

    await openApp(page);

    for (const title of ["Old due today", "Old fixed date", "Old no date"]) {
      await expect(categoryLineWithoutDate(page, "Study", title)).toBeVisible();
    }
  });

  test("the label changes as days pass, without a reload", async ({ page }) => {
    await seedPersonal(page, [personalQuest({ dueDate: "2026-10-21" })]);

    await openApp(page);
    await expect(dueQuestRow(page)).toContainText("Due Oct 21");
    await expect(pastDueBadge(page)).toHaveCount(0);

    await advanceToDay(page, 1, "Tuesday, October 20");
    await expect(dueQuestRow(page)).toContainText("Due tomorrow");
    await expect(pastDueBadge(page)).toHaveCount(0);

    await advanceToDay(page, 1, "Wednesday, October 21");
    await expect(dueQuestRow(page)).toContainText("Due today");
    await expect(pastDueBadge(page)).toHaveCount(0);

    await advanceToDay(page, 1, "Thursday, October 22");
    await expect(dueQuestRow(page)).toContainText("Due Oct 21");
    await expect(pastDueBadge(page)).toBeVisible();
  });

  test("the label also changes on All Quests without a reload", async ({ page }) => {
    await seedPersonal(page, [personalQuest({ dueDate: "2026-10-20" })]);

    await openApp(page, "/all-quests");
    await expect(dueQuestRow(page)).toContainText("Due tomorrow");

    await advanceToDay(page, 1, "Tuesday, October 20");
    await expect(dueQuestRow(page)).toContainText("Due today");
  });

  test("a past-due quest shows its date and the Past Due badge", async ({ page }) => {
    await seedPersonal(page, [personalQuest({ dueDate: "2026-10-15" })]);

    await openApp(page);

    await expect(dueQuestRow(page)).toContainText("Study · Due Oct 15");
    await expect(pastDueBadge(page)).toBeVisible();
  });

  test("completing a past-due quest removes the badge but keeps the date", async ({ page }) => {
    await seedPersonal(page, [personalQuest({ dueDate: "2026-10-15" })]);
    await openApp(page);
    await expect(pastDueBadge(page)).toBeVisible();

    await completeQuest(page, DUE_QUEST);
    await expect(pastDueBadge(page)).toHaveCount(0);
    await expect(dueQuestRow(page)).toContainText("Due Oct 15");
    await expectHomeXp(page, 5);

    await reloadApp(page);
    await expect(pastDueBadge(page)).toHaveCount(0);

    await uncompleteQuest(page, DUE_QUEST);
    await expect(pastDueBadge(page)).toBeVisible();
    await expectHomeXp(page, 0);
  });

  test("Daily Quests keep their schedule labels and ignore any due date", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: buildSave({
        daily: [
          {
            id: "every",
            title: "Every day quest",
            category: "Wellness",
            schedule: "Every day",
            difficulty: "Easy",
            completed: false,
            repeatSchedule: "Every day",
            dueDate: "2026-10-15",
          },
          {
            id: "some",
            title: "Selected days quest",
            category: "Wellness",
            schedule: "Mon, Wed",
            difficulty: "Easy",
            completed: false,
            repeatSchedule: "Selected days",
            selectedDays: ["Mon", "Wed"],
          },
        ],
      }),
    });

    await openApp(page);
    const everyDay = questRow(dailyPanel(page), "Every day quest");
    await expect(everyDay).toContainText("Wellness · Every day");
    await expect(everyDay).not.toContainText("Due");
    await expect(everyDay.getByText("Past Due", { exact: true })).toHaveCount(0);
    await expect(questRow(dailyPanel(page), "Selected days quest")).toContainText("Wellness · Mon, Wed");

    await openApp(page, "/all-quests");
    await expect(questRow(dailyPanel(page), "Every day quest")).toContainText("Wellness · Every day");
  });

  test("starter Daily Quests keep showing Every day", async ({ page }) => {
    await openApp(page);

    for (const title of STARTER_DAILY) {
      await expect(questRow(dailyPanel(page), title)).toContainText("Every day");
    }
  });
});

test.describe("Due-date labels use the device's local date", () => {
  // This moment is still Monday in Los Angeles but already Tuesday in Auckland.
  const MOMENT = "2026-10-20T06:30:00Z";

  test.describe("west of Greenwich", () => {
    test.use({ timezoneId: "America/Los_Angeles" });

    test("labels follow the local Monday night", async ({ page }) => {
      await page.clock.setSystemTime(MOMENT);
      await seedPersonal(page, [
        personalQuest({ id: "mon", title: "Due Monday", dueDate: "2026-10-19" }),
        personalQuest({ id: "tue", title: "Due Tuesday", dueDate: "2026-10-20" }),
        personalQuest({ id: "nov", title: "Due November", dueDate: "2026-11-01" }),
      ]);

      await openApp(page);

      await expect(page.getByText("Monday, October 19", { exact: true })).toBeVisible();
      await expect(dueQuestRow(page, "Due Monday")).toContainText("Due today");
      await expect(pastDueBadge(page, "Due Monday")).toHaveCount(0);
      await expect(dueQuestRow(page, "Due Tuesday")).toContainText("Due tomorrow");
      await expect(dueQuestRow(page, "Due November")).toContainText("Due Nov 1");
    });
  });

  test.describe("east of Greenwich", () => {
    test.use({ timezoneId: "Pacific/Auckland" });

    test("labels follow the local Tuesday", async ({ page }) => {
      await page.clock.setSystemTime(MOMENT);
      await seedPersonal(page, [
        personalQuest({ id: "mon", title: "Due Monday", dueDate: "2026-10-19" }),
        personalQuest({ id: "tue", title: "Due Tuesday", dueDate: "2026-10-20" }),
      ]);

      await openApp(page);

      await expect(page.getByText("Tuesday, October 20", { exact: true })).toBeVisible();
      await expect(dueQuestRow(page, "Due Monday")).toContainText("Due Oct 19");
      await expect(pastDueBadge(page, "Due Monday")).toBeVisible();
      await expect(dueQuestRow(page, "Due Tuesday")).toContainText("Due today");
    });
  });
});
