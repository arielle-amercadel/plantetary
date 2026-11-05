import {
  STARTER_DAILY,
  VALID_BACKUP_KEY,
  INVALID_BACKUP_KEY,
  QUEST_SAVE_KEY,
  advanceToDay,
  chooseOption,
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
  readStorage,
  reloadApp,
  test,
  uncompleteQuest,
} from "./support";
import type { Page } from "@playwright/test";

const ALL_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const QUICK = "Quick habit";

type SavedQuest = Record<string, unknown>;

async function savedDaily(page: Page, title: string): Promise<SavedQuest> {
  const save = JSON.parse((await readStorage(page, QUEST_SAVE_KEY))!);
  return (save.questLists.daily as SavedQuest[]).find((quest) => quest.title === title)!;
}

function expectExplicitEveryDay(quest: SavedQuest) {
  expect(quest.repeatSchedule).toBe("Every day");
  expect(quest.selectedDays).toEqual(ALL_DAYS);
  expect(quest.schedule).toBe("Every day");
}

async function quickAddDaily(page: Page, title = QUICK, difficulty?: "Easy" | "Medium" | "Hard") {
  const panel = dailyPanel(page);
  await panel.getByRole("button", { name: "Add habit" }).click();
  await panel.getByLabel("New quest name").fill(title);
  if (difficulty) await panel.getByLabel("Quest difficulty").selectOption(difficulty);
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await expect(questRow(panel, title)).toBeVisible();
}

test.describe("Starter Daily Quests", () => {
  test("save explicit recurrence alongside the legacy text, and keep their labels", async ({ page }) => {
    await openApp(page);

    for (const title of STARTER_DAILY) {
      await expect(questRow(dailyPanel(page), title)).toContainText("Every day");
      expectExplicitEveryDay(await savedDaily(page, title));
    }
  });

  test("a fresh install writes no backup, including after reloading", async ({ page }) => {
    await openApp(page);
    await reloadApp(page);
    await reloadApp(page);

    expect(await readStorage(page, VALID_BACKUP_KEY)).toBeNull();
    expect(await readStorage(page, INVALID_BACKUP_KEY)).toBeNull();
    for (const title of STARTER_DAILY) expectExplicitEveryDay(await savedDaily(page, title));
  });

  test("completion, rollover, streak, XP, and history are unchanged", async ({ page }) => {
    await openApp(page);
    for (const title of STARTER_DAILY) await completeQuest(page, title);
    await expectHomeXp(page, 25);
    await expectStreak(page, 1);
    await expectCompletedToday(page, 4);

    await reloadApp(page);
    await expectHomeXp(page, 25);
    await expectStreak(page, 1);

    await advanceToDay(page, 1, "Tuesday, October 20");
    await expect(dailyPanel(page).getByText("0 / 4 done")).toBeVisible();
    await expectStreak(page, 1);
    await expectCompletedToday(page, 0);
    await expectHomeXp(page, 25);

    for (const title of STARTER_DAILY) await completeQuest(page, title);
    await expectStreak(page, 2);
    await expectHomeXp(page, 50);
    await expectCompletedOverall(page, 8);

    await openApp(page, "/completion-history");
    await expect(historyDateSection(page, "Monday, October 19, 2026")).toContainText("4 completions");
    await expect(historyDateSection(page, "Tuesday, October 20, 2026")).toContainText("4 completions");
  });

  test("editing one keeps its recurrence and streak", async ({ page }) => {
    const title = STARTER_DAILY[1];
    await openApp(page);
    await completeQuest(page, title);

    await page.getByRole("button", { name: `Edit ${title}`, exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Repeat", exact: true })).toContainText("Every day");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/$/);

    expectExplicitEveryDay(await savedDaily(page, title));
    await expect(page.getByRole("button", { name: `Mark incomplete: ${title}`, exact: true })).toBeVisible();
    await expectHomeXp(page, 5);
  });
});

test.describe("Quick-add Daily Quests", () => {
  test("save explicit recurrence alongside the legacy text, and survive a reload", async ({ page }) => {
    await openApp(page);
    await quickAddDaily(page);

    await expect(questRow(dailyPanel(page), QUICK)).toContainText("Wellness · Every day");
    expectExplicitEveryDay(await savedDaily(page, QUICK));

    await reloadApp(page);
    await expect(questRow(dailyPanel(page), QUICK)).toContainText("Wellness · Every day");
    expectExplicitEveryDay(await savedDaily(page, QUICK));
    expect(await readStorage(page, VALID_BACKUP_KEY)).toBeNull();
  });

  test("appear every day, with completion, streak, XP, and history unchanged", async ({ page }) => {
    await openApp(page);
    for (const title of STARTER_DAILY) await completeQuest(page, title);
    await quickAddDaily(page, QUICK, "Hard");

    // A quest added after finishing the day is part of today, so today is unfinished until it is done.
    await expectStreak(page, 0);
    await completeQuest(page, QUICK);
    await expectStreak(page, 1);
    await expectHomeXp(page, 45);

    await advanceToDay(page, 1, "Tuesday, October 20");
    await expect(questRow(dailyPanel(page), QUICK)).toBeVisible();
    await expect(page.getByRole("button", { name: `Complete: ${QUICK}`, exact: true })).toBeEnabled();
    await expect(dailyPanel(page).getByText("0 / 5 done")).toBeVisible();
    await completeQuest(page, QUICK);
    await expectHomeXp(page, 65);
    await uncompleteQuest(page, QUICK);
    await expectHomeXp(page, 45);

    await openApp(page, "/completion-history");
    await expect(historyDateSection(page, "Monday, October 19, 2026")).toContainText("5 completions");
    await historyDateSection(page, "Monday, October 19, 2026").locator("summary").click();
    await expect(historyCard(page, QUICK)).toContainText("+20 XP");
  });

  test("can be moved to selected days through the form", async ({ page }) => {
    await openApp(page);
    await quickAddDaily(page);

    await page.getByRole("button", { name: `Edit ${QUICK}`, exact: true }).click();
    await chooseOption(page, "Repeat", "Selected days");
    await page.getByRole("button", { name: "Mon", exact: true }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/$/);

    await expect(questRow(dailyPanel(page), QUICK)).toContainText("Wellness · Mon");
    const saved = await savedDaily(page, QUICK);
    expect(saved.repeatSchedule).toBe("Selected days");
    expect(saved.selectedDays).toEqual(["Mon"]);

    await advanceToDay(page, 1, "Tuesday, October 20");
    await expect(questRow(dailyPanel(page), QUICK)).toHaveCount(0);
  });

  test("do not change Personal quick-add quests", async ({ page }) => {
    const title = "Quick errand";
    await openApp(page);

    const panel = personalPanel(page);
    await panel.getByRole("button", { name: "Add quest" }).click();
    await panel.getByLabel("New quest name").fill(title);
    await panel.getByRole("button", { name: "Add", exact: true }).click();
    await expect(questRow(panel, title).getByText("Personal", { exact: true })).toBeVisible();

    const save = JSON.parse((await readStorage(page, QUEST_SAVE_KEY))!);
    const saved = (save.questLists.personal as SavedQuest[]).find((quest) => quest.title === title)!;
    expect(saved.schedule).toBe("");
    expect(saved).not.toHaveProperty("repeatSchedule");
    expect(saved).not.toHaveProperty("selectedDays");
    expect(saved).not.toHaveProperty("dueDate");
  });
});

test.describe("Full-form Daily Quests", () => {
  const TITLE = "Form habit";

  test("every-day creation saves the same shape as starter and quick-add quests", async ({ page }) => {
    await openApp(page, "/quests/new");
    await page.getByRole("button", { name: /Daily Quest/ }).click();
    await page.getByLabel("Quest title").fill(TITLE);
    await chooseOption(page, "Category", "Wellness");
    await chooseOption(page, "Repeat", "Every day");
    await chooseOption(page, "Difficulty", "Easy · 5 XP");
    await page.getByRole("button", { name: "Save quest" }).click();
    await expect(page).toHaveURL(/\/$/);

    expectExplicitEveryDay(await savedDaily(page, TITLE));
    await expect(questRow(dailyPanel(page), TITLE)).toContainText("Wellness · Every day");
    await completeQuest(page, TITLE);
    await expectHomeXp(page, 5);
  });

  test("selected-days creation and editing still save the chosen days", async ({ page }) => {
    await openApp(page, "/quests/new");
    await page.getByRole("button", { name: /Daily Quest/ }).click();
    await page.getByLabel("Quest title").fill(TITLE);
    await chooseOption(page, "Category", "Wellness");
    await chooseOption(page, "Repeat", "Selected days");
    await page.getByRole("button", { name: "Mon", exact: true }).click();
    await page.getByRole("button", { name: "Thu", exact: true }).click();
    await chooseOption(page, "Difficulty", "Medium · 10 XP");
    await page.getByRole("button", { name: "Save quest" }).click();
    await expect(page).toHaveURL(/\/$/);

    let saved = await savedDaily(page, TITLE);
    expect(saved.repeatSchedule).toBe("Selected days");
    expect(saved.selectedDays).toEqual(["Mon", "Thu"]);
    expect(saved.schedule).toBe("Mon, Thu");

    await page.getByRole("button", { name: `Edit ${TITLE}`, exact: true }).click();
    await chooseOption(page, "Repeat", "Every day");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/$/);

    saved = await savedDaily(page, TITLE);
    expectExplicitEveryDay(saved);
    await expect(questRow(dailyPanel(page), TITLE)).toContainText("Wellness · Every day");
  });
});
