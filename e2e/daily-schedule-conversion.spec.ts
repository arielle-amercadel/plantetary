import {
  INVALID_BACKUP_KEY,
  QUEST_SAVE_KEY,
  VALID_BACKUP_KEY,
  advanceToDay,
  buildSave,
  completeQuest,
  dailyPanel,
  expect,
  expectCompletedOverall,
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

const ALL_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const EVERY_DAY = "Text every day";
const MON_WED = "Text Mon Wed";

type Fields = Record<string, unknown>;

function dailyQuest(title: string, fields: Fields = {}) {
  return {
    id: title.toLowerCase().replace(/\W+/g, "-"),
    title,
    category: "Wellness",
    difficulty: "Easy",
    completed: false,
    ...fields,
  };
}

function rawSave(daily: unknown[], extra: Fields = {}) {
  return JSON.stringify({ ...JSON.parse(buildSave()), questLists: { daily, personal: [] }, ...extra });
}

function row(page: Page, title: string) {
  return questRow(dailyPanel(page), title);
}

async function saved(page: Page) {
  return JSON.parse((await readStorage(page, QUEST_SAVE_KEY))!);
}

async function savedDaily(page: Page, title: string): Promise<Fields> {
  return ((await saved(page)).questLists.daily as Fields[]).find((quest) => quest.title === title)!;
}

test.describe("Converting saved daily schedules on load", () => {
  test("text-only quests gain explicit recurrence, lose their text, and back up the original", async ({ page }) => {
    const original = rawSave([
      dailyQuest(EVERY_DAY, { schedule: "Every day" }),
      dailyQuest("Lowercase", { schedule: "every day" }),
      dailyQuest(MON_WED, { schedule: "Mon, Wed" }),
    ]);
    await seedStorage(page, { [QUEST_SAVE_KEY]: original });

    await openApp(page);
    await expect(row(page, EVERY_DAY)).toContainText("Wellness · Every day");
    await expect(row(page, "Lowercase")).toContainText("Wellness · Every day");
    await expect(row(page, MON_WED)).toContainText("Wellness · Mon, Wed");

    await expect.poll(async () => (await savedDaily(page, EVERY_DAY)).repeatSchedule).toBe("Every day");
    expect((await savedDaily(page, EVERY_DAY)).selectedDays).toEqual(ALL_DAYS);
    expect(await savedDaily(page, EVERY_DAY)).not.toHaveProperty("schedule");
    expect((await savedDaily(page, "Lowercase")).repeatSchedule).toBe("Every day");
    expect((await savedDaily(page, MON_WED)).repeatSchedule).toBe("Selected days");
    expect((await savedDaily(page, MON_WED)).selectedDays).toEqual(["Mon", "Wed"]);
    expect(await savedDaily(page, MON_WED)).not.toHaveProperty("schedule");

    expect(await readStorage(page, VALID_BACKUP_KEY)).toBe(original);
    expect(await readStorage(page, INVALID_BACKUP_KEY)).toBeNull();
  });

  test("a clean, already-structured save is not changed or backed up", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: rawSave([
        dailyQuest("Clean every day", { repeatSchedule: "Every day", selectedDays: ALL_DAYS }),
        dailyQuest("Clean selected", { repeatSchedule: "Selected days", selectedDays: ["Wed", "Mon"] }),
      ]),
    });

    await openApp(page);
    const afterFirstLoad = JSON.stringify((await saved(page)).questLists);
    await reloadApp(page);
    await reloadApp(page);

    expect(await readStorage(page, VALID_BACKUP_KEY)).toBeNull();
    expect((await savedDaily(page, "Clean selected")).selectedDays).toEqual(["Wed", "Mon"]);
    expect(JSON.stringify((await saved(page)).questLists)).toBe(afterFirstLoad);
  });

  test("converting happens once, and later loads neither change the quests nor replace the backup", async ({ page }) => {
    const original = rawSave([dailyQuest(MON_WED, { schedule: "Mon, Wed" })]);
    await seedStorage(page, { [QUEST_SAVE_KEY]: original });
    await openApp(page);
    await expect.poll(async () => (await savedDaily(page, MON_WED)).repeatSchedule).toBe("Selected days");
    const afterFirstLoad = JSON.stringify((await saved(page)).questLists);

    await reloadApp(page);
    await reloadApp(page);

    expect(JSON.stringify((await saved(page)).questLists)).toBe(afterFirstLoad);
    expect(await readStorage(page, VALID_BACKUP_KEY)).toBe(original);
  });

  test("unknown text stays unscheduled, is removed, and shows No days selected", async ({ page }) => {
    const title = "Unknown schedule";
    await seedStorage(page, { [QUEST_SAVE_KEY]: rawSave([dailyQuest(title, { schedule: "Daily" })]) });

    await openApp(page);
    await expect(row(page, title)).toHaveCount(0);

    await openApp(page, "/all-quests");
    await expect(row(page, title)).toContainText("Wellness · No days selected");
    await expect(page.getByRole("button", { name: `Complete: ${title}`, exact: true })).toBeDisabled();

    const quest = await savedDaily(page, title);
    expect(quest.repeatSchedule).toBe("Selected days");
    expect(quest.selectedDays).toEqual([]);
    expect(quest).not.toHaveProperty("schedule");
  });

  test("conflicting fields keep their real schedule, and rows show that schedule", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: rawSave([
        dailyQuest("Every day over Mon", { schedule: "Mon", repeatSchedule: "Every day" }),
        dailyQuest("Tuesday over text", { schedule: "Every day", repeatSchedule: "Selected days", selectedDays: ["Tue"] }),
        dailyQuest("Explicitly no days", { schedule: "Every day", repeatSchedule: "Selected days", selectedDays: [] }),
      ]),
    });

    await openApp(page);
    await expect(row(page, "Every day over Mon")).toContainText("Wellness · Every day");
    await expect(row(page, "Tuesday over text")).toHaveCount(0);
    await expect(row(page, "Explicitly no days")).toHaveCount(0);

    await advanceToDay(page, 1, "Tuesday, October 20");
    await expect(row(page, "Every day over Mon")).toContainText("Wellness · Every day");
    await expect(row(page, "Tuesday over text")).toContainText("Wellness · Tue");
    await expect(row(page, "Explicitly no days")).toHaveCount(0);

    await openApp(page, "/all-quests");
    await expect(row(page, "Explicitly no days")).toContainText("Wellness · No days selected");

    expect((await savedDaily(page, "Every day over Mon")).selectedDays).toEqual(ALL_DAYS);
    expect((await savedDaily(page, "Explicitly no days")).selectedDays).toEqual([]);
  });
});

test.describe("Recovering malformed saved recurrence", () => {
  for (const [description, fields, expectedDays] of [
    ["an unknown repeatSchedule, recovering from text", { repeatSchedule: "Weekly", schedule: "Every day" }, ALL_DAYS],
    ["a wrong-type repeatSchedule", { repeatSchedule: 5, schedule: "Mon" }, ["Mon"]],
    ["invalid weekday entries", { repeatSchedule: "Selected days", selectedDays: ["Mon", "Funday", 7], schedule: "Mon" }, ["Mon"]],
    ["a malformed weekday list", { selectedDays: "Mon", schedule: "Mon" }, ["Mon"]],
    ["a wrong-type schedule with valid recurrence", { schedule: 42, repeatSchedule: "Selected days", selectedDays: ["Mon"] }, ["Mon"]],
  ] as const) {
    test(`${description} keeps the save and backs up the original`, async ({ page }) => {
      const title = "Recovered quest";
      const original = rawSave([dailyQuest(title, { difficulty: "Hard", notes: "A note", ...fields })]);
      await seedStorage(page, { [QUEST_SAVE_KEY]: original });

      await openApp(page);

      await expect(row(page, title)).toContainText("Hard");
      await expect(row(page, title)).toContainText("A note");
      await expect(page.getByText("Tidy the desk")).toHaveCount(0);
      await expect.poll(async () => (await savedDaily(page, title)).selectedDays).toEqual(expectedDays);
      expect(await readStorage(page, VALID_BACKUP_KEY)).toBe(original);
      expect(await readStorage(page, INVALID_BACKUP_KEY)).toBeNull();

      await completeQuest(page, title);
      await expectHomeXp(page, 20);
      await reloadApp(page);
      await expectHomeXp(page, 20);
    });
  }

  test("a quest with valid recurrence and no schedule field is already clean", async ({ page }) => {
    const title = "Recovered quest";
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: rawSave([dailyQuest(title, { difficulty: "Hard", notes: "A note", repeatSchedule: "Selected days", selectedDays: ["Mon"] })]),
    });

    await openApp(page);

    await expect(row(page, title)).toContainText("A note");
    await completeQuest(page, title);
    await expectHomeXp(page, 20);
    await reloadApp(page);
    await expectHomeXp(page, 20);
    expect((await savedDaily(page, title)).selectedDays).toEqual(["Mon"]);
    expect(await readStorage(page, VALID_BACKUP_KEY)).toBeNull();
    expect(await readStorage(page, INVALID_BACKUP_KEY)).toBeNull();
  });

  test("fields with nothing usable leave the quest listed but unscheduled, with no crash", async ({ page }) => {
    const noSchedule = "No schedule at all";
    const wrongType = "Wrong type schedule";
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: rawSave([
        dailyQuest(noSchedule),
        dailyQuest(wrongType, { schedule: 42, repeatSchedule: "Weekly", selectedDays: {} }),
        dailyQuest("Healthy quest", { schedule: "Every day" }),
      ]),
    });

    await openApp(page);
    await expect(row(page, "Healthy quest")).toBeVisible();
    await expect(row(page, noSchedule)).toHaveCount(0);

    await openApp(page, "/all-quests");
    await expect(row(page, noSchedule)).toContainText("Wellness · No days selected");
    await expect(row(page, wrongType)).toContainText("Wellness · No days selected");
    await expect(page.getByRole("button", { name: `Complete: ${noSchedule}`, exact: true })).toBeDisabled();
    expect(await savedDaily(page, wrongType)).not.toHaveProperty("schedule");
    expect((await savedDaily(page, wrongType)).selectedDays).toEqual([]);
  });

  test("a bad schedule on one quest leaves the rest of the save intact", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: rawSave(
        [dailyQuest("Bad", { repeatSchedule: "Weekly", schedule: "Every day" }), dailyQuest("Good", { schedule: "Every day" })],
        { legacyXpBonus: 12, discoveredPlantIds: ["fern"] },
      ),
    });

    await openApp(page);

    await expect(row(page, "Bad")).toBeVisible();
    await expect(row(page, "Good")).toBeVisible();
    await expectHomeXp(page, 12);
    await expect(page.getByText("1 of 16 plants discovered")).toBeVisible();
  });

  for (const [description, quest] of [
    ["a missing title", { id: "a", category: "C", difficulty: "Easy", completed: false, schedule: "Every day" }],
    ["a bad difficulty", { id: "a", title: "T", category: "C", difficulty: "Impossible", completed: false, schedule: "Every day" }],
    ["a wrong-type completed flag", { id: "a", title: "T", category: "C", difficulty: "Easy", completed: "yes", schedule: "Every day" }],
    ["wrong-type notes", { id: "a", title: "T", category: "C", difficulty: "Easy", completed: false, schedule: "Every day", notes: 7 }],
  ] as const) {
    test(`a Daily Quest with ${description} is still treated as a corrupted save`, async ({ page }) => {
      const original = rawSave([quest]);
      await seedStorage(page, { [QUEST_SAVE_KEY]: original });

      await openApp(page);

      await expect(dailyPanel(page).getByText("0 / 4 done")).toBeVisible();
      expect(await readStorage(page, INVALID_BACKUP_KEY)).toBe(original);
    });
  }

  test("unreadable saves are still recovered through the invalid-save backup", async ({ page }) => {
    await seedStorage(page, { [QUEST_SAVE_KEY]: "{not valid json" });

    await openApp(page);

    await expect(dailyPanel(page).getByText("0 / 4 done")).toBeVisible();
    expect(await readStorage(page, INVALID_BACKUP_KEY)).toBe("{not valid json");
    expect(await readStorage(page, VALID_BACKUP_KEY)).toBeNull();
  });
});

test.describe("Stray due dates on saved Daily Quests", () => {
  for (const [description, dueDate] of [
    ["a valid date", "2026-10-22"],
    ["an impossible date", "2026-02-30"],
    ["malformed text", "not-a-date"],
    ["an empty string", ""],
    ["a number", 123],
    ["null", null],
    ["an object", { year: 2026 }],
  ] as const) {
    test(`${description} is removed, keeping the quest and the rest of the save`, async ({ page }) => {
      const title = "Daily with a date";
      const original = rawSave(
        [dailyQuest(title, { difficulty: "Hard", notes: "A note", repeatSchedule: "Every day", selectedDays: ALL_DAYS, dueDate })],
        { legacyXpBonus: 12, discoveredPlantIds: ["fern"] },
      );
      await seedStorage(page, { [QUEST_SAVE_KEY]: original });

      await openApp(page);

      await expect(row(page, title)).toContainText("Wellness · Every day");
      await expect(row(page, title)).toContainText("A note");
      await expect(row(page, title)).not.toContainText("Due");
      await expect(page.getByText("Tidy the desk")).toHaveCount(0);
      await expectHomeXp(page, 12);
      await expect.poll(async () => savedDaily(page, title)).not.toHaveProperty("dueDate");
      expect(await readStorage(page, VALID_BACKUP_KEY)).toBe(original);
      expect(await readStorage(page, INVALID_BACKUP_KEY)).toBeNull();

      await completeQuest(page, title);
      await reloadApp(page);
      await expectHomeXp(page, 32);
      expect(await savedDaily(page, title)).not.toHaveProperty("dueDate");
      expect(await readStorage(page, VALID_BACKUP_KEY)).toBe(original);
    });
  }

  test("editing a cleaned quest does not bring the date back", async ({ page }) => {
    const title = "Daily with a date";
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: rawSave([dailyQuest(title, { repeatSchedule: "Every day", selectedDays: ALL_DAYS, dueDate: "2026-10-22" })]),
    });
    await openApp(page);

    await page.getByRole("button", { name: `Edit ${title}`, exact: true }).click();
    await expect(page.getByRole("button", { name: "Due date", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/$/);

    await reloadApp(page);
    expect(await savedDaily(page, title)).not.toHaveProperty("dueDate");
  });
});

test.describe("Old and new saves both load", () => {
  test("a save in the new format loads with no conversion or backup", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: JSON.stringify({
        ...JSON.parse(buildSave()),
        questLists: {
          daily: [dailyQuest(MON_WED, { repeatSchedule: "Selected days", selectedDays: ["Mon", "Wed"] })],
          personal: [
            { id: "dated", title: "Has a date", category: "Study", difficulty: "Easy", completed: false, dueDate: "2026-10-22" },
            { id: "undated", title: "Has no date", category: "Study", difficulty: "Easy", completed: false },
          ],
        },
      }),
    });

    await openApp(page);

    await expect(row(page, MON_WED)).toContainText("Wellness · Mon, Wed");
    await expect(questRow(personalPanel(page), "Has a date")).toContainText("Study · Due Oct 22");
    await expect(questRow(personalPanel(page), "Has no date").getByText("Study", { exact: true })).toBeVisible();
    await completeQuest(page, MON_WED);
    await expectStreak(page, 1);
    await reloadApp(page);
    await expectStreak(page, 1);
    expect(await readStorage(page, VALID_BACKUP_KEY)).toBeNull();
    expect(await readStorage(page, INVALID_BACKUP_KEY)).toBeNull();
  });

  test("a save mixing old and new quests ends up entirely in the new format", async ({ page }) => {
    const original = JSON.stringify({
      ...JSON.parse(buildSave()),
      questLists: {
        daily: [
          dailyQuest("Old daily", { schedule: "Every day" }),
          dailyQuest("New daily", { repeatSchedule: "Selected days", selectedDays: ["Mon"] }),
        ],
        personal: [
          { id: "old", title: "Old personal", category: "Study", schedule: "Due Oct 20", difficulty: "Easy", completed: false },
          { id: "new", title: "New personal", category: "Study", difficulty: "Easy", completed: false, dueDate: "2026-10-22" },
        ],
      },
    });
    await seedStorage(page, { [QUEST_SAVE_KEY]: original });

    await openApp(page);
    await expect(row(page, "Old daily")).toBeVisible();
    await expect(row(page, "New daily")).toBeVisible();
    await expect(questRow(personalPanel(page), "New personal")).toContainText("Study · Due Oct 22");

    await expect.poll(async () => JSON.stringify((await saved(page)).questLists)).not.toContain("schedule\":");
    expect(await readStorage(page, VALID_BACKUP_KEY)).toBe(original);
    const lists = (await saved(page)).questLists;
    expect(lists.daily.map((quest: Fields) => quest.repeatSchedule)).toEqual(["Every day", "Selected days"]);
    expect(lists.personal[1].dueDate).toBe("2026-10-22");
  });
});

test.describe("Personal Quests during conversion", () => {
  test("a malformed Personal due date and old recurrence text are handled together", async ({ page }) => {
    const title = "Personal with bad date";
    const original = JSON.stringify({
      ...JSON.parse(buildSave()),
      questLists: {
        daily: [dailyQuest(EVERY_DAY, { schedule: "Every day" })],
        personal: [
          { id: "bad", title, category: "Study", schedule: "Due today", difficulty: "Easy", completed: false, dueDate: "2026-02-30" },
          { id: "good", title: "Personal with date", category: "Study", schedule: "", difficulty: "Easy", completed: false, dueDate: "2026-10-22" },
        ],
      },
    });
    await seedStorage(page, { [QUEST_SAVE_KEY]: original });

    await openApp(page);

    await expect(questRow(personalPanel(page), title).getByText("Study", { exact: true })).toBeVisible();
    await expect(questRow(personalPanel(page), "Personal with date")).toContainText("Study · Due Oct 22");
    await expect(row(page, EVERY_DAY)).toBeVisible();

    await expect.poll(async () => (await savedDaily(page, EVERY_DAY)).repeatSchedule).toBe("Every day");
    const [bad, good] = (await saved(page)).questLists.personal as Fields[];
    expect(bad).not.toHaveProperty("dueDate");
    expect(bad).not.toHaveProperty("schedule");
    expect(bad).not.toHaveProperty("repeatSchedule");
    expect(bad).not.toHaveProperty("selectedDays");
    expect(good.dueDate).toBe("2026-10-22");
    expect(good).not.toHaveProperty("schedule");
    expect(good).not.toHaveProperty("repeatSchedule");
    expect(await readStorage(page, VALID_BACKUP_KEY)).toBe(original);
  });

  test("a wrong-type Personal schedule is still treated as a corrupted save", async ({ page }) => {
    const original = JSON.stringify({
      ...JSON.parse(buildSave()),
      questLists: {
        daily: [],
        personal: [{ id: "p", title: "T", category: "C", schedule: 42, difficulty: "Easy", completed: false }],
      },
    });
    await seedStorage(page, { [QUEST_SAVE_KEY]: original });

    await openApp(page);

    await expect(personalPanel(page).getByText("0 / 3 done")).toBeVisible();
    expect(await readStorage(page, INVALID_BACKUP_KEY)).toBe(original);
  });

  test("malformed Personal recurrence fields are still treated as a corrupted save", async ({ page }) => {
    const original = JSON.stringify({
      ...JSON.parse(buildSave()),
      questLists: {
        daily: [],
        personal: [{ id: "p", title: "T", category: "C", schedule: "", difficulty: "Easy", completed: false, repeatSchedule: "Weekly" }],
      },
    });
    await seedStorage(page, { [QUEST_SAVE_KEY]: original });

    await openApp(page);

    await expect(personalPanel(page).getByText("0 / 3 done")).toBeVisible();
    expect(await readStorage(page, INVALID_BACKUP_KEY)).toBe(original);
  });
});

test.describe("Progress after conversion", () => {
  test("completion, reload, rollover, snapshots, and streaks work on converted quests", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: rawSave([
        dailyQuest(EVERY_DAY, { schedule: "Every day" }),
        dailyQuest(MON_WED, { schedule: "Mon, Wed", difficulty: "Medium" }),
      ]),
    });
    await openApp(page);

    await completeQuest(page, EVERY_DAY);
    await completeQuest(page, MON_WED);
    await expectHomeXp(page, 15);
    await expectStreak(page, 1);

    await reloadApp(page);
    await expect(page.getByRole("button", { name: `Mark incomplete: ${MON_WED}`, exact: true })).toBeVisible();
    await expectHomeXp(page, 15);

    await advanceToDay(page, 1, "Tuesday, October 20");
    await expect(row(page, MON_WED)).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Complete: ${EVERY_DAY}`, exact: true })).toBeVisible();
    await expectStreak(page, 1);
    await completeQuest(page, EVERY_DAY);
    await expectStreak(page, 2);

    await expect.poll(async () => (await saved(page)).completionHistory["2026-10-20"].completedQuestIds).toEqual(["text-every-day"]);
    const history = (await saved(page)).completionHistory;
    expect(history["2026-10-19"].scheduledQuestIds).toEqual(["text-every-day", "text-mon-wed"]);
    expect(history["2026-10-20"].scheduledQuestIds).toEqual(["text-every-day"]);
    expect(history["2026-10-19"].xpAwardedByQuestId).toEqual({ "text-every-day": 5, "text-mon-wed": 10 });

    await uncompleteQuest(page, EVERY_DAY);
    await expectHomeXp(page, 15);
  });

  test("an unopened stretch fills days from the converted schedule", async ({ page }) => {
    await seedStorage(page, { [QUEST_SAVE_KEY]: rawSave([dailyQuest("Text Monday", { schedule: "Mon" })]) });
    await openApp(page);
    await completeQuest(page, "Text Monday");

    await advanceToDay(page, 7, "Monday, October 26");
    await expectStreak(page, 1);

    const history = (await saved(page)).completionHistory;
    expect(history["2026-10-22"].scheduledQuestIds).toEqual([]);
    expect(history["2026-10-26"].scheduledQuestIds).toEqual(["text-monday"]);
  });

  test("progress already in the save is kept exactly through conversion", async ({ page }) => {
    const details = { title: "Earlier title", category: "Wellness", difficulty: "Easy", questType: "daily" };
    const previousDay = {
      scheduledQuestIds: ["text-every-day"],
      completedQuestIds: ["text-every-day"],
      xpAwardedByQuestId: { "text-every-day": 30 },
      completionDetails: { daily: { "text-every-day": details } },
    };
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: rawSave([dailyQuest(EVERY_DAY, { schedule: "Every day" })], {
        legacyXpBonus: 12,
        personalXpByQuestId: { "deleted-personal": 20 },
        personalCompletedOnByQuestId: { "deleted-personal": "2026-10-17" },
        discoveredPlantIds: ["fern", "daisy"],
        pendingPlantGiftIds: ["cactus"],
        completionHistory: {
          "2026-10-17": {
            scheduledQuestIds: [],
            completedQuestIds: [],
            completionDetails: {
              personal: { "deleted-personal": { title: "Old errand", category: "Chores", difficulty: "Hard", questType: "personal" } },
            },
          },
          "2026-10-18": previousDay,
        },
      }),
    });

    await openApp(page);

    await expect(page.getByText("62 / 100 XP", { exact: true }).first()).toBeVisible();
    await expectStreak(page, 1);
    await expectCompletedOverall(page, 2);
    await expect(page.getByRole("link", { name: "Plant Journal, 1 gift waiting" })).toBeVisible();
    await expect(page.getByText("2 of 16 plants discovered")).toBeVisible();

    const save = await saved(page);
    expect(save.completionHistory["2026-10-18"]).toEqual(previousDay);
    expect(save.legacyXpBonus).toBe(12);
    expect(save.personalXpByQuestId).toEqual({ "deleted-personal": 20 });
    expect(save.discoveredPlantIds).toEqual(["fern", "daisy"]);

    await openApp(page, "/completion-history");
    await historyDateSection(page, "Sunday, October 18, 2026").locator("summary").click();
    await expect(historyCard(page, "Earlier title")).toContainText("+30 XP");
  });

  test("XP on converted quests earns plant gifts as usual", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: rawSave(
        [dailyQuest(EVERY_DAY, { schedule: "Every day", difficulty: "Hard" }), dailyQuest(MON_WED, { schedule: "Mon, Wed" })],
        { discoveredPlantIds: ["fern"] },
      ),
    });
    await openApp(page);

    await completeQuest(page, EVERY_DAY);
    await completeQuest(page, MON_WED);
    await expectHomeXp(page, 25);

    await expect(page.getByRole("link", { name: "Plant Journal, 1 gift waiting" })).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "XP progress toward Cactus" })).toBeVisible();
    await reloadApp(page);
    await expect(page.getByRole("link", { name: "Plant Journal, 1 gift waiting" })).toBeVisible();
  });

  test("the form opens each quest with its real schedule, not its old text", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: rawSave([
        dailyQuest("Every day with stale text", { schedule: "Mon", repeatSchedule: "Every day" }),
        dailyQuest("Tuesday with stale text", { schedule: "Every day", repeatSchedule: "Selected days", selectedDays: ["Tue"] }),
      ]),
    });
    await openApp(page, "/all-quests");
    const preview = page.getByRole("region", { name: "Quest preview" }).locator(".quest-preview-schedule");

    await page.getByRole("button", { name: "Edit Every day with stale text", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Repeat", exact: true })).toContainText("Every day");
    await expect(preview).toHaveText("Every day · resets at midnight");

    await openApp(page, "/all-quests");
    await page.getByRole("button", { name: "Edit Tuesday with stale text", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Repeat", exact: true })).toContainText("Selected days");
    await expect(page.getByRole("button", { name: "Tue", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Mon", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(preview).toHaveText("Tue · resets at midnight");

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/$/);
    const saved = await savedDaily(page, "Tuesday with stale text");
    expect(saved.selectedDays).toEqual(["Tue"]);
    expect(saved.repeatSchedule).toBe("Selected days");
    expect(saved).not.toHaveProperty("schedule");
  });

  test("an unscheduled quest can be repaired by choosing days", async ({ page }) => {
    const title = "Unknown schedule";
    await seedStorage(page, { [QUEST_SAVE_KEY]: rawSave([dailyQuest(title, { schedule: "Daily" })]) });
    await openApp(page, "/all-quests");

    await page.getByRole("button", { name: `Edit ${title}`, exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Repeat", exact: true })).toContainText("Selected days");
    const save = page.getByRole("button", { name: "Save changes" });
    await expect(save).toBeDisabled();

    await page.getByRole("button", { name: "Mon", exact: true }).click();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page).toHaveURL(/\/$/);

    await expect(row(page, title)).toContainText("Wellness · Mon");
    await completeQuest(page, title);
    await expectHomeXp(page, 5);
    await reloadApp(page);
    await expect(row(page, title)).toContainText("Wellness · Mon");
    expect((await savedDaily(page, title)).selectedDays).toEqual(["Mon"]);
  });

  test("a Personal Quest with old schedule text gains no recurrence when edited", async ({ page }) => {
    const title = "Personal with old text";
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: JSON.stringify({
        ...JSON.parse(buildSave()),
        questLists: {
          daily: [],
          personal: [{ id: "p", title, category: "Study", schedule: "Every day", difficulty: "Easy", completed: false }],
        },
      }),
    });
    await openApp(page);

    await page.getByRole("button", { name: `Edit ${title}`, exact: true }).click();
    await expect(page.getByRole("heading", { name: "Edit quest" })).toBeVisible();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/$/);

    await expect(questRow(personalPanel(page), title).getByText("Study", { exact: true })).toBeVisible();
    const [quest] = (await saved(page)).questLists.personal as Fields[];
    expect(quest).not.toHaveProperty("repeatSchedule");
    expect(quest).not.toHaveProperty("selectedDays");
  });

  test("a converted quest opens correctly in the edit form and keeps its schedule when saved", async ({ page }) => {
    await seedStorage(page, { [QUEST_SAVE_KEY]: rawSave([dailyQuest(MON_WED, { schedule: "Mon, Wed" })]) });
    await openApp(page);

    await page.getByRole("button", { name: `Edit ${MON_WED}`, exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Repeat", exact: true })).toContainText("Selected days");
    await expect(page.getByRole("button", { name: "Mon", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Tue", exact: true })).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/$/);

    await expect(row(page, MON_WED)).toContainText("Wellness · Mon, Wed");
    expect((await savedDaily(page, MON_WED)).selectedDays).toEqual(["Mon", "Wed"]);
  });
});
