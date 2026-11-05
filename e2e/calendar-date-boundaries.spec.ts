import {
  QUEST_SAVE_KEY,
  buildSave,
  chooseOption,
  expect,
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
const JANUARY_1_0001 = "Monday, January 1, 1";
const DECEMBER_31_9999 = "Friday, December 31, 9999";

function seedDueDate(page: Page, dueDate?: string) {
  return seedStorage(page, {
    [QUEST_SAVE_KEY]: buildSave({
      personal: [{
        id: "library",
        title: QUEST,
        category: "Study",
        difficulty: "Easy",
        completed: false,
        ...(dueDate ? { dueDate } : {}),
      }],
    }),
  });
}

async function openCalendarForEdit(page: Page) {
  await openApp(page);
  await page.getByRole("button", { name: `Edit ${QUEST}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit quest" })).toBeVisible();
  await page.getByRole("button", { name: "Due date", exact: true }).click();
  await expect(calendar(page)).toBeVisible();
}

function calendar(page: Page) {
  return page.getByRole("dialog");
}

function previousMonth(page: Page) {
  return page.getByRole("button", { name: "Previous month" });
}

function nextMonth(page: Page) {
  return page.getByRole("button", { name: "Next month" });
}

function monthHeading(page: Page) {
  return calendar(page).getByRole("heading", { level: 2 });
}

async function saveEdit(page: Page) {
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function savedDueDate(page: Page) {
  const save = JSON.parse((await readStorage(page, QUEST_SAVE_KEY))!);
  return (save.questLists.personal as { title: string; dueDate?: string }[])
    .find((quest) => quest.title === QUEST)!.dueDate;
}

test.describe("Earliest supported calendar month", () => {
  test("Previous month stops at January 0001, and its first day can be saved", async ({ page }) => {
    await seedDueDate(page, "0001-02-15");
    await openCalendarForEdit(page);

    await expect(monthHeading(page)).toHaveText("February 1");
    await previousMonth(page).click();
    await expect(monthHeading(page)).toHaveText("January 1");
    await expect(previousMonth(page)).toBeDisabled();
    await expect(nextMonth(page)).toBeEnabled();

    await page.getByRole("button", { name: JANUARY_1_0001, exact: true }).click();
    await saveEdit(page);
    await reloadApp(page);

    expect(await savedDueDate(page)).toBe("0001-01-01");
    await expect(questRow(personalPanel(page), QUEST)).toContainText("Due Jan 1, 1");
  });

  test("the keyboard cannot leave January 0001", async ({ page }) => {
    await seedDueDate(page, "0001-01-01");
    await openCalendarForEdit(page);
    const firstDay = page.getByRole("button", { name: JANUARY_1_0001, exact: true });
    await expect(firstDay).toBeFocused();

    for (const key of ["ArrowLeft", "ArrowUp", "Home", "PageUp", "Shift+PageUp"]) {
      await page.keyboard.press(key);
      await expect(monthHeading(page), key).toHaveText("January 1");
      await expect(firstDay, key).toBeFocused();
    }
  });

  test("Page Up from inside January 0001 lands on its first day", async ({ page }) => {
    await seedDueDate(page, "0001-01-15");
    await openCalendarForEdit(page);

    await page.keyboard.press("PageUp");

    await expect(monthHeading(page)).toHaveText("January 1");
    await expect(page.getByRole("button", { name: JANUARY_1_0001, exact: true })).toBeFocused();
  });
});

test.describe("Latest supported calendar month", () => {
  test("Next month stops at December 9999, and its last day can be saved", async ({ page }) => {
    await seedDueDate(page, "9999-11-15");
    await openCalendarForEdit(page);

    await expect(monthHeading(page)).toHaveText("November 9999");
    await nextMonth(page).click();
    await expect(monthHeading(page)).toHaveText("December 9999");
    await expect(nextMonth(page)).toBeDisabled();
    await expect(previousMonth(page)).toBeEnabled();

    await page.getByRole("button", { name: DECEMBER_31_9999, exact: true }).click();
    await saveEdit(page);
    await reloadApp(page);

    expect(await savedDueDate(page)).toBe("9999-12-31");
    await expect(questRow(personalPanel(page), QUEST)).toContainText("Due Dec 31, 9999");
  });

  test("the January 10000 cells in the December 9999 grid cannot be selected", async ({ page }) => {
    await seedDueDate(page, "9999-12-15");
    await openCalendarForEdit(page);

    for (const dateKey of ["10000-01-01", "10000-01-02"]) {
      await expect(page.locator(`[id="quest-due-date-day-${dateKey}"]`)).toBeDisabled();
    }
    await expect(page.getByRole("button", { name: DECEMBER_31_9999, exact: true })).toBeEnabled();

    await page.locator('[id="quest-due-date-day-10000-01-01"]').dispatchEvent("click");
    await page.keyboard.press("Escape");
    await saveEdit(page);

    expect(await savedDueDate(page)).toBe("9999-12-15");
  });

  test("the keyboard cannot leave December 9999", async ({ page }) => {
    await seedDueDate(page, "9999-12-31");
    await openCalendarForEdit(page);
    const lastDay = page.getByRole("button", { name: DECEMBER_31_9999, exact: true });
    await expect(lastDay).toBeFocused();

    for (const key of ["ArrowRight", "ArrowDown", "End", "PageDown", "Shift+PageDown"]) {
      await page.keyboard.press(key);
      await expect(monthHeading(page), key).toHaveText("December 9999");
      await expect(lastDay, key).toBeFocused();
    }
  });

  test("moving a week past the end of December 9999 lands on its last day", async ({ page }) => {
    await seedDueDate(page, "9999-12-28");
    await openCalendarForEdit(page);

    await page.keyboard.press("ArrowDown");

    await expect(page.getByRole("button", { name: DECEMBER_31_9999, exact: true })).toBeFocused();
  });
});

test.describe("Due dates that stay allowed", () => {
  test("a date at the boundary can be cleared and saved empty", async ({ page }) => {
    await seedDueDate(page, "0001-01-01");
    await openCalendarForEdit(page);

    await page.getByRole("button", { name: "Clear date" }).click();
    await saveEdit(page);
    await reloadApp(page);

    expect(await savedDueDate(page)).toBeUndefined();
    await expect(questRow(personalPanel(page), QUEST)).not.toContainText("Due ");
  });

  test("a new Personal Quest can still be saved with no due date", async ({ page }) => {
    await seedDueDate(page);
    await openApp(page, "/quests/new");
    await page.getByRole("button", { name: /Personal Quest/ }).click();
    await page.getByLabel("Quest title").fill("No date quest");
    await chooseOption(page, "Category", "Study");
    await chooseOption(page, "Difficulty", "Easy · 5 XP");

    await expect(page.getByRole("button", { name: "Save quest" })).toBeEnabled();
    await page.getByRole("button", { name: "Save quest" }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(questRow(personalPanel(page), "No date quest")).toBeVisible();
  });

  test("months around a leap day still turn normally", async ({ page }) => {
    await seedDueDate(page, "2024-02-29");
    await openCalendarForEdit(page);

    await expect(monthHeading(page)).toHaveText("February 2024");
    await nextMonth(page).click();
    await expect(monthHeading(page)).toHaveText("March 2024");
    await previousMonth(page).click();
    await expect(monthHeading(page)).toHaveText("February 2024");
    await expect(page.getByRole("button", { name: "Thursday, February 29, 2024", exact: true })).toBeEnabled();
    await expect(previousMonth(page)).toBeEnabled();
    await expect(nextMonth(page)).toBeEnabled();
  });
});
