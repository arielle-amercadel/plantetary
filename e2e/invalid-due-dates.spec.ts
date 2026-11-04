import {
  INVALID_BACKUP_KEY,
  QUEST_SAVE_KEY,
  VALID_BACKUP_KEY,
  advanceToDay,
  buildSave,
  chooseOption,
  completeQuest,
  dailyPanel,
  expect,
  expectCompletedOverall,
  expectHomeXp,
  expectStreak,
  historyCard,
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

const QUEST = "Return library book";

function personalQuest(dueDate: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: "library",
    title: QUEST,
    category: "Study",
    schedule: "",
    difficulty: "Hard",
    completed: false,
    notes: "Second floor",
    dueDate,
    ...overrides,
  };
}

function rawSave(personal: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ ...JSON.parse(buildSave()), questLists: { daily: [], personal }, ...extra });
}

async function savedPersonal(page: Page) {
  const save = JSON.parse((await readStorage(page, QUEST_SAVE_KEY))!);
  return save.questLists.personal as Record<string, unknown>[];
}

function row(page: Page, title = QUEST) {
  return questRow(personalPanel(page), title);
}

test.describe("Invalid saved due dates", () => {
  for (const [description, dueDate] of [
    ["an impossible calendar date", "2026-02-30"],
    ["malformed text", "not-a-date"],
    ["an empty string", ""],
    ["a number", 20261022],
    ["null", null],
    ["an object", { year: 2026 }],
  ] as const) {
    test(`${description} is removed while the quest is kept, with the original backed up`, async ({ page }) => {
      const original = rawSave([personalQuest(dueDate)]);
      await seedStorage(page, { [QUEST_SAVE_KEY]: original });

      await openApp(page);

      // The quest survives with all its details and no deadline, rather than the save being discarded.
      await expect(row(page)).toContainText(QUEST);
      await expect(row(page)).toContainText("Second floor");
      await expect(row(page)).toContainText("Hard");
      await expect(row(page).getByText("Study", { exact: true })).toBeVisible();
      await expect(row(page).getByText("Past Due", { exact: true })).toHaveCount(0);
      await expect(personalPanel(page).getByRole("listitem")).toHaveCount(1);

      expect(await readStorage(page, VALID_BACKUP_KEY)).toBe(original);
      expect(await readStorage(page, INVALID_BACKUP_KEY)).toBeNull();
      await expect.poll(async () => (await savedPersonal(page))[0]).not.toHaveProperty("dueDate");
    });
  }

  test("the correction survives reloading, and the original backup is not replaced", async ({ page }) => {
    const original = rawSave([personalQuest("2026-02-30")]);
    await seedStorage(page, { [QUEST_SAVE_KEY]: original });
    await openApp(page);

    await reloadApp(page);
    await reloadApp(page);

    await expect(row(page).getByText("Study", { exact: true })).toBeVisible();
    expect((await savedPersonal(page))[0]).not.toHaveProperty("dueDate");
    expect(await readStorage(page, VALID_BACKUP_KEY)).toBe(original);
  });

  test("editing and saving a corrected quest does not bring the invalid date back", async ({ page }) => {
    await seedStorage(page, { [QUEST_SAVE_KEY]: rawSave([personalQuest("2026-02-30")]) });
    await openApp(page);

    await page.getByRole("button", { name: `Edit ${QUEST}`, exact: true }).click();
    await expect(page.getByRole("heading", { name: "Edit quest" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Due date", exact: true })).toContainText("Choose a date");
    await chooseOption(page, "Difficulty", "Medium · 10 XP");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/$/);

    await reloadApp(page);
    const [saved] = await savedPersonal(page);
    expect(saved).not.toHaveProperty("dueDate");
    expect(saved.difficulty).toBe("Medium");
  });

  test("a corrected quest can be given a real date", async ({ page }) => {
    await seedStorage(page, { [QUEST_SAVE_KEY]: rawSave([personalQuest("2026-02-30")]) });
    await openApp(page);

    await page.getByRole("button", { name: `Edit ${QUEST}`, exact: true }).click();
    await page.getByRole("button", { name: "Due date", exact: true }).click();
    await page.getByRole("button", { name: "Thursday, October 22, 2026", exact: true }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/$/);

    await reloadApp(page);
    await expect(row(page)).toContainText("Study · Due Oct 22");
    expect((await savedPersonal(page))[0].dueDate).toBe("2026-10-22");
  });

  test("completion status, XP, and history are kept on a corrected quest", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: rawSave([personalQuest("2026-02-30", { completed: true })], {
        personalXpByQuestId: { library: 20 },
        personalCompletedOnByQuestId: { library: "2026-10-18" },
        completionHistory: {
          "2026-10-18": {
            scheduledQuestIds: [],
            completedQuestIds: [],
            completionDetails: {
              personal: { library: { title: QUEST, category: "Study", difficulty: "Hard", questType: "personal" } },
            },
          },
        },
      }),
    });

    await openApp(page);
    await expect(page.getByRole("button", { name: `Mark incomplete: ${QUEST}`, exact: true })).toBeVisible();
    await expectHomeXp(page, 20);
    await expectCompletedOverall(page, 1);

    await reloadApp(page);
    await expectHomeXp(page, 20);

    await openApp(page, "/completion-history");
    await page.locator("summary", { hasText: "Sunday, October 18, 2026" }).click();
    await expect(historyCard(page, QUEST)).toContainText("+20 XP");

    await openApp(page);
    await uncompleteQuest(page, QUEST);
    await expectHomeXp(page, 0);
  });

  test("only the bad date is removed when other quests in the save are fine", async ({ page }) => {
    const original = rawSave([
      personalQuest("2026-10-22", { id: "good", title: "Good date" }),
      personalQuest("2026-02-30", { id: "bad", title: "Bad date" }),
      personalQuest(undefined, { id: "none", title: "No date" }),
    ]);
    await seedStorage(page, { [QUEST_SAVE_KEY]: original });

    await openApp(page);

    await expect(row(page, "Good date")).toContainText("Study · Due Oct 22");
    await expect(row(page, "Bad date").getByText("Study", { exact: true })).toBeVisible();
    await expect(row(page, "No date").getByText("Study", { exact: true })).toBeVisible();

    const saved = await savedPersonal(page);
    expect(saved.map((quest) => quest.id)).toEqual(["good", "bad", "none"]);
    expect(saved[0].dueDate).toBe("2026-10-22");
    expect(saved[1]).not.toHaveProperty("dueDate");
    expect(await readStorage(page, VALID_BACKUP_KEY)).toBe(original);
  });

  test("old schedule text stays untouched on a corrected quest", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: rawSave([personalQuest("2026-02-30", { schedule: "Due Oct 20" })]),
    });

    await openApp(page);

    await expect(row(page).getByText("Study", { exact: true })).toBeVisible();
    await expect.poll(async () => (await savedPersonal(page))[0]).not.toHaveProperty("dueDate");
    expect((await savedPersonal(page))[0].schedule).toBe("Due Oct 20");
  });
});

test.describe("Saves with nothing to correct", () => {
  test("valid dates, undated quests, and old labels are kept, with no backup written", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: rawSave([
        personalQuest("2026-10-22", { id: "good", title: "Good date" }),
        personalQuest(undefined, { id: "none", title: "No date", schedule: "No due date" }),
      ]),
    });

    await openApp(page);
    await reloadApp(page);

    await expect(row(page, "Good date")).toContainText("Study · Due Oct 22");
    const saved = await savedPersonal(page);
    expect(saved[0].dueDate).toBe("2026-10-22");
    expect(saved[1]).not.toHaveProperty("dueDate");
    expect(saved[1].schedule).toBe("No due date");
    expect(await readStorage(page, VALID_BACKUP_KEY)).toBeNull();
  });
});

test.describe("Daily Quests are not affected", () => {
  test("recurrence, streak, and a stray due date are left as they are", async ({ page }) => {
    const title = "Monday and Tuesday";
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: rawSave([personalQuest("2026-02-30")], {
        questLists: {
          daily: [{
            id: "daily",
            title,
            category: "Wellness",
            schedule: "Mon, Tue",
            difficulty: "Easy",
            completed: false,
            repeatSchedule: "Selected days",
            selectedDays: ["Mon", "Tue"],
            dueDate: "2026-02-30",
          }],
          personal: [personalQuest("2026-02-30")],
        },
      }),
    });

    await openApp(page);
    await expect(questRow(dailyPanel(page), title)).toContainText("Wellness · Mon, Tue");
    await completeQuest(page, title);
    await expectStreak(page, 1);

    await advanceToDay(page, 1, "Tuesday, October 20");
    await completeQuest(page, title);
    await expectStreak(page, 2);
    await expectHomeXp(page, 10);

    await advanceToDay(page, 1, "Wednesday, October 21");
    await expect(questRow(dailyPanel(page), title)).toHaveCount(0);
    await expectStreak(page, 2);

    const save = JSON.parse((await readStorage(page, QUEST_SAVE_KEY))!);
    expect(save.questLists.daily[0].dueDate).toBe("2026-02-30");
    expect(save.questLists.daily[0].schedule).toBe("Mon, Tue");
    expect(save.questLists.personal[0]).not.toHaveProperty("dueDate");
  });
});
