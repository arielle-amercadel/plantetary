import {
  QUEST_SAVE_KEY,
  buildSave,
  chooseOption,
  completeQuest,
  dailyPanel,
  expect,
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
} from "./support";
import type { Page } from "@playwright/test";

const QUEST = "Return library book";
const MONDAY_19 = "Monday, October 19, 2026";
const TUESDAY_20 = "Tuesday, October 20, 2026";
const THURSDAY_22 = "Thursday, October 22, 2026";
const FRIDAY_30 = "Friday, October 30, 2026";

function previewDateLine(page: Page) {
  return page.getByRole("region", { name: "Quest preview" }).locator(".quest-preview-schedule");
}

async function pickDate(page: Page, date: string) {
  await page.getByRole("button", { name: "Due date", exact: true }).click();
  await page.getByRole("button", { name: date, exact: true }).click();
}

async function clearDate(page: Page) {
  await page.getByRole("button", { name: "Due date", exact: true }).click();
  await page.getByRole("button", { name: "Clear date" }).click();
}

async function startPersonalQuest(page: Page, title = QUEST) {
  await openApp(page, "/quests/new");
  await page.getByRole("button", { name: /Personal Quest/ }).click();
  await page.getByLabel("Quest title").fill(title);
  await chooseOption(page, "Category", "Study");
  await chooseOption(page, "Difficulty", "Easy · 5 XP");
}

async function saveNewQuest(page: Page) {
  await page.getByRole("button", { name: "Save quest" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function openEdit(page: Page, title = QUEST) {
  await page.getByRole("button", { name: `Edit ${title}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit quest" })).toBeVisible();
}

async function saveEdit(page: Page) {
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function savedQuest(page: Page, list: "daily" | "personal", title = QUEST) {
  const save = JSON.parse((await readStorage(page, QUEST_SAVE_KEY))!);
  return (save.questLists[list] as Record<string, unknown>[]).find((quest) => quest.title === title)!;
}

function row(page: Page, title = QUEST) {
  return questRow(personalPanel(page), title);
}

function seedPersonal(page: Page, overrides: { schedule?: string; dueDate?: string } = {}) {
  return seedStorage(page, {
    [QUEST_SAVE_KEY]: buildSave({
      personal: [{
        id: "library",
        title: QUEST,
        category: "Study",
        schedule: overrides.schedule ?? "",
        difficulty: "Easy",
        completed: false,
        ...(overrides.dueDate ? { dueDate: overrides.dueDate } : {}),
      }],
    }),
  });
}

test.describe("Creating a Personal Quest", () => {
  test("a selected date is saved as a real date, with no saved label", async ({ page }) => {
    await startPersonalQuest(page);
    await pickDate(page, THURSDAY_22);
    await expect(previewDateLine(page)).toHaveText("Due Oct 22");
    await saveNewQuest(page);

    await expect(row(page)).toContainText("Study · Due Oct 22");
    const saved = await savedQuest(page, "personal");
    expect(saved.dueDate).toBe("2026-10-22");
    expect(saved).not.toHaveProperty("schedule");

    await reloadApp(page);
    await expect(row(page)).toContainText("Study · Due Oct 22");
  });

  test("leaving the date empty saves no date and previews No due date", async ({ page }) => {
    await startPersonalQuest(page);
    await expect(previewDateLine(page)).toHaveText("No due date");
    await saveNewQuest(page);

    await expect(row(page).getByText("Study", { exact: true })).toBeVisible();
    const saved = await savedQuest(page, "personal");
    expect(saved).not.toHaveProperty("dueDate");
    expect(saved).not.toHaveProperty("schedule");

    await reloadApp(page);
    await expect(row(page).getByText("Study", { exact: true })).toBeVisible();
  });

  test("clearing a date before saving leaves no date", async ({ page }) => {
    await startPersonalQuest(page);
    await pickDate(page, THURSDAY_22);
    await clearDate(page);
    await expect(previewDateLine(page)).toHaveText("No due date");
    await saveNewQuest(page);

    expect(await savedQuest(page, "personal")).not.toHaveProperty("dueDate");
  });
});

test.describe("The form preview matches quest rows", () => {
  for (const [name, date, label] of [
    ["today", MONDAY_19, "Due today"],
    ["tomorrow", TUESDAY_20, "Due tomorrow"],
    ["a future date", THURSDAY_22, "Due Oct 22"],
  ] as const) {
    test(`for ${name}`, async ({ page }) => {
      await startPersonalQuest(page);
      await pickDate(page, date);
      await expect(previewDateLine(page)).toHaveText(label);

      await saveNewQuest(page);
      await expect(row(page)).toContainText(`Study · ${label}`);

      await openEdit(page);
      await expect(previewDateLine(page)).toHaveText(label);
    });
  }

  test("for a past date, and for another year", async ({ page }) => {
    await startPersonalQuest(page);
    await pickDate(page, "Thursday, October 15, 2026");
    await expect(previewDateLine(page)).toHaveText("Due Oct 15");
    await saveNewQuest(page);
    await expect(row(page)).toContainText("Study · Due Oct 15");
    await expect(row(page).getByText("Past Due", { exact: true })).toBeVisible();

    await openEdit(page);
    await page.getByRole("button", { name: "Due date", exact: true }).click();
    for (let month = 0; month < 3; month += 1) await page.getByRole("button", { name: "Next month" }).click();
    await page.getByRole("button", { name: "Tuesday, January 5, 2027", exact: true }).click();
    await expect(previewDateLine(page)).toHaveText("Due Jan 5, 2027");
    await saveEdit(page);
    await expect(row(page)).toContainText("Study · Due Jan 5, 2027");
  });
});

test.describe("Editing a Personal Quest's date", () => {
  test("an undated quest previews No due date, never a blank line", async ({ page }) => {
    await seedPersonal(page);
    await openApp(page);

    await openEdit(page);

    await expect(previewDateLine(page)).toHaveText("No due date");
  });

  test("a date can be added, and survives a reload", async ({ page }) => {
    await seedPersonal(page);
    await openApp(page);

    await openEdit(page);
    await pickDate(page, THURSDAY_22);
    await expect(previewDateLine(page)).toHaveText("Due Oct 22");
    await saveEdit(page);

    await expect(row(page)).toContainText("Study · Due Oct 22");
    await reloadApp(page);
    await expect(row(page)).toContainText("Study · Due Oct 22");
    const saved = await savedQuest(page, "personal");
    expect(saved.dueDate).toBe("2026-10-22");
    expect(saved).not.toHaveProperty("schedule");
  });

  test("a date can be changed, and survives a reload", async ({ page }) => {
    await seedPersonal(page, { dueDate: "2026-10-22" });
    await openApp(page);

    await openEdit(page);
    await expect(previewDateLine(page)).toHaveText("Due Oct 22");
    await pickDate(page, FRIDAY_30);
    await expect(previewDateLine(page)).toHaveText("Due Oct 30");
    await saveEdit(page);

    await reloadApp(page);
    await expect(row(page)).toContainText("Study · Due Oct 30");
    expect((await savedQuest(page, "personal")).dueDate).toBe("2026-10-30");
  });

  test("a date can be cleared, which removes it from the saved quest", async ({ page }) => {
    await seedPersonal(page, { dueDate: "2026-10-15" });
    await openApp(page);
    await expect(row(page).getByText("Past Due", { exact: true })).toBeVisible();

    await openEdit(page);
    await clearDate(page);
    await expect(previewDateLine(page)).toHaveText("No due date");
    await saveEdit(page);

    await expect(row(page).getByText("Study", { exact: true })).toBeVisible();
    await expect(row(page).getByText("Past Due", { exact: true })).toHaveCount(0);

    await reloadApp(page);
    await expect(row(page).getByText("Study", { exact: true })).toBeVisible();
    const saved = await savedQuest(page, "personal");
    expect(saved).not.toHaveProperty("dueDate");
    expect(saved).not.toHaveProperty("schedule");

    await openEdit(page);
    await expect(previewDateLine(page)).toHaveText("No due date");
  });

  for (const oldLabel of ["Due today", "Due Oct 20", "No due date"]) {
    test(`an old saved "${oldLabel}" label does not resurface, and is removed from the saved quest`, async ({ page }) => {
      await seedPersonal(page, { schedule: oldLabel });
      await openApp(page);

      await openEdit(page);
      await expect(previewDateLine(page)).toHaveText("No due date");
      await saveEdit(page);

      const saved = await savedQuest(page, "personal");
      expect(saved).not.toHaveProperty("schedule");
      expect(saved).not.toHaveProperty("dueDate");
      await expect(row(page).getByText("Study", { exact: true })).toBeVisible();
    });
  }

  test("a real date wins over an old saved label that disagrees with it", async ({ page }) => {
    await seedPersonal(page, { schedule: "Due Oct 20", dueDate: "2026-10-22" });
    await openApp(page);

    await openEdit(page);
    await expect(previewDateLine(page)).toHaveText("Due Oct 22");
    await saveEdit(page);

    const saved = await savedQuest(page, "personal");
    expect(saved).not.toHaveProperty("schedule");
    expect(saved.dueDate).toBe("2026-10-22");
  });

  test("editing a date keeps the XP and history of a completed quest", async ({ page }) => {
    await seedPersonal(page);
    await openApp(page);
    await completeQuest(page, QUEST);
    await expectHomeXp(page, 5);

    await openEdit(page);
    await pickDate(page, THURSDAY_22);
    await saveEdit(page);

    await expect(page.getByRole("button", { name: `Mark incomplete: ${QUEST}`, exact: true })).toBeVisible();
    await expectHomeXp(page, 5);
    await reloadApp(page);
    await expectHomeXp(page, 5);

    await openApp(page, "/completion-history");
    await expect(historyCard(page, QUEST)).toContainText("+5 XP");
  });
});

test.describe("Daily Quests in the form", () => {
  const TITLE = "Morning walk";

  async function startDailyQuest(page: Page) {
    await openApp(page, "/quests/new");
    await page.getByRole("button", { name: /Daily Quest/ }).click();
    await page.getByLabel("Quest title").fill(TITLE);
    await chooseOption(page, "Category", "Wellness");
    await chooseOption(page, "Difficulty", "Easy · 5 XP");
  }

  test("an every-day quest keeps its preview, saved schedule, and streak", async ({ page }) => {
    await startDailyQuest(page);
    await chooseOption(page, "Repeat", "Every day");
    await expect(previewDateLine(page)).toHaveText("Every day · resets at midnight");
    await expect(page.getByRole("button", { name: "Due date", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Save quest" }).click();
    await expect(page).toHaveURL(/\/$/);

    const saved = await savedQuest(page, "daily", TITLE);
    expect(saved).not.toHaveProperty("schedule");
    expect(saved.repeatSchedule).toBe("Every day");
    expect(saved).not.toHaveProperty("dueDate");
    await expect(questRow(dailyPanel(page), TITLE)).toContainText("Wellness · Every day");

    await reloadApp(page);
    await completeQuest(page, TITLE);
    await expectHomeXp(page, 5);
  });

  test("a selected-days quest keeps its preview and saved schedule, including when edited", async ({ page }) => {
    await startDailyQuest(page);
    await chooseOption(page, "Repeat", "Selected days");
    await expect(previewDateLine(page)).toHaveText("Choose days · resets at midnight");
    await page.getByRole("button", { name: "Mon", exact: true }).click();
    await page.getByRole("button", { name: "Wed", exact: true }).click();
    await expect(previewDateLine(page)).toHaveText("Mon, Wed · resets at midnight");
    await page.getByRole("button", { name: "Save quest" }).click();
    await expect(page).toHaveURL(/\/$/);

    const saved = await savedQuest(page, "daily", TITLE);
    expect(saved).not.toHaveProperty("schedule");
    expect(saved.selectedDays).toEqual(["Mon", "Wed"]);
    expect(saved).not.toHaveProperty("dueDate");
    await expect(questRow(dailyPanel(page), TITLE)).toContainText("Wellness · Mon, Wed");

    await openEdit(page, TITLE);
    await expect(previewDateLine(page)).toHaveText("Mon, Wed · resets at midnight");
    await page.getByRole("button", { name: "Fri", exact: true }).click();
    await saveEdit(page);
    const edited = await savedQuest(page, "daily", TITLE);
    expect(edited.selectedDays).toEqual(["Mon", "Wed", "Fri"]);
    expect(edited).not.toHaveProperty("schedule");
  });

  test("editing a starter Daily Quest keeps its schedule and streak", async ({ page }) => {
    const starter = "Morning skincare";
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: buildSave({
        daily: [{ id: "skin", title: starter, category: "Wellness", schedule: "Every day", difficulty: "Easy", completed: false }],
      }),
    });
    await openApp(page);
    await completeQuest(page, starter);
    await expectStreak(page, 1);

    await openEdit(page, starter);
    await expect(previewDateLine(page)).toHaveText("Every day · resets at midnight");
    await saveEdit(page);

    await expect(questRow(dailyPanel(page), starter)).toContainText("Wellness · Every day");
    await expectStreak(page, 1);
    const edited = await savedQuest(page, "daily", starter);
    expect(edited.repeatSchedule).toBe("Every day");
    expect(edited).not.toHaveProperty("schedule");
  });
});
