import { describe, expect, it } from "vitest";
import {
  getCompletionHistoryCardText,
  getCompletionHistoryView,
  normalizeCompletionHistoryDetails,
  recordCompletionDetails,
  removeCompletionDetails,
  toggleDailyQuestCompletionWithDetails,
} from "../src/app/quest-logic";
import type { CompletionHistory, Quest } from "../src/app/quest-types";

const yesterday = "2026-10-17";
const today = "2026-10-18";

function quest(overrides: Partial<Quest> = {}): Quest {
  return {
    id: "quest-1",
    title: "Water the fern",
    category: "Wellness",
    schedule: "Every day",
    difficulty: "Medium",
    completed: false,
    ...overrides,
  };
}

describe("completion history", () => {
  it("orders non-empty dates newest first and puts daily cards before personal cards", () => {
    const history: CompletionHistory = {
      [yesterday]: {
        scheduledQuestIds: ["older-daily"],
        completedQuestIds: ["older-daily"],
      },
      [today]: {
        scheduledQuestIds: ["daily", "unfinished"],
        completedQuestIds: ["daily", "orphan"],
        completionDetails: {
          daily: { daily: { title: "Daily note", category: "Care", difficulty: "Easy", questType: "daily" } },
          personal: { personal: { title: "Personal note", category: "Study", difficulty: "Hard", questType: "personal" } },
        },
      },
      "2026-10-16": { scheduledQuestIds: ["not-done"], completedQuestIds: [] },
    };
    const view = getCompletionHistoryView(
      history,
      { personal: today },
      { personal: 20 },
      [],
    );

    expect(view.sections.map((section) => section.dateKey)).toEqual([today, yesterday]);
    expect(view.sections[0].daily.map((item) => item.questId)).toEqual(["daily"]);
    expect(view.sections[0].personal.map((item) => item.questId)).toEqual(["personal"]);
    expect(view.sections[0].completionCount).toBe(2);
    expect(view.sections[1].completionCount).toBe(1);
  });

  it("groups Personal completions by their recorded date and omits empty dates", () => {
    const view = getCompletionHistoryView(
      {
        [yesterday]: { scheduledQuestIds: [], completedQuestIds: [] },
        [today]: { scheduledQuestIds: [], completedQuestIds: [] },
      },
      { personal: yesterday },
      undefined,
      [],
    );

    expect(view.sections).toHaveLength(1);
    expect(view.sections[0].dateKey).toBe(yesterday);
    expect(view.sections[0].personal[0].questId).toBe("personal");
    expect(view.sections[0].daily).toEqual([]);
  });

  it("uses saved details and ledger XP for deleted quests without consulting current quest data", () => {
    const history: CompletionHistory = {
      [today]: {
        scheduledQuestIds: ["deleted-daily"],
        completedQuestIds: ["deleted-daily"],
        xpAwardedByQuestId: { "deleted-daily": 10, unrelated: 99 },
        completionDetails: {
          daily: { "deleted-daily": { title: "Old title", category: "Old category", difficulty: "Medium", questType: "daily" } },
          personal: { orphaned: { title: "Ignore this", category: "Other", difficulty: "Easy", questType: "personal" } },
        },
      },
    };
    const view = getCompletionHistoryView(history, undefined, undefined, []);

    expect(view.sections[0].daily).toEqual([{
      questId: "deleted-daily",
      questType: "daily",
      details: { title: "Old title", category: "Old category", difficulty: "Medium", questType: "daily" },
      xp: 10,
    }]);
  });

  it("uses current Daily details only for exact ID matches when historical details are missing", () => {
    const history: CompletionHistory = {
      [today]: {
        scheduledQuestIds: ["reading", "water", "same-title-different-id"],
        completedQuestIds: ["reading", "water", "same-title-different-id"],
        xpAwardedByQuestId: { reading: 5, water: 10, "same-title-different-id": 5 },
        completionDetails: {
          daily: {
            water: { title: "Historical water title", category: "Old category", difficulty: "Hard", questType: "daily" },
          },
        },
      },
    };
    const currentDailyQuests = [
      quest({ id: "water", title: "Drink a glass of water", category: "Wellness", difficulty: "Easy" }),
      quest({ id: "different-id", title: "Same title", category: "Wellness", difficulty: "Easy" }),
      quest({ id: "same-title-different-id", title: "Current other quest", category: "Care", difficulty: "Medium" }),
    ];

    const view = getCompletionHistoryView(history, undefined, undefined, [], 0, currentDailyQuests);
    const [reading, water, other] = view.sections[0].daily;

    expect(water).toMatchObject({
      questId: "water",
      details: { title: "Historical water title", category: "Old category", difficulty: "Hard" },
    });
    expect(water.detailsSource).toBeUndefined();
    expect(getCompletionHistoryCardText(reading)).toEqual({
      title: "Daily Quest",
      description: "Original quest details were not saved for this older completion.",
    });
    expect(reading.xp).toBe(5);
    expect(other).toMatchObject({
      questId: "same-title-different-id",
      details: { title: "Current other quest", category: "Care", difficulty: "Medium", questType: "daily" },
      detailsSource: "current",
      xp: 5,
    });
    expect(getCompletionHistoryCardText(other)).toEqual({
      title: "Current other quest",
      description: "Current quest details — historical details unavailable · Care · Medium",
    });
    expect(history[today].completionDetails?.daily?.water?.title).toBe("Historical water title");
  });

  it("shows safe fallback details for old completions and uses only saved XP awards", () => {
    const view = getCompletionHistoryView(
      { [today]: { scheduledQuestIds: ["old-daily"], completedQuestIds: ["old-daily"] } },
      { oldPersonal: today },
      { oldPersonal: 0, orphanXp: 50 },
      [],
    );

    expect(view.sections[0].daily[0]).toEqual({ questId: "old-daily", questType: "daily" });
    expect(view.sections[0].personal[0]).toEqual({ questId: "oldPersonal", questType: "personal" });
    expect(view.sections[0].completionCount).toBe(2);
  });

  it("treats the reading quest on October 17 like any other quest and date", () => {
    const history: CompletionHistory = {
      "2026-10-17": { scheduledQuestIds: ["reading"], completedQuestIds: ["reading"] },
      "2026-10-18": { scheduledQuestIds: ["reading"], completedQuestIds: ["reading"] },
    };
    const currentQuest = quest({ id: "reading", title: "A different current title", category: "Current category", difficulty: "Hard" });
    const view = getCompletionHistoryView(history, undefined, undefined, [], 0, [currentQuest]);
    const october17Reading = view.sections.find((section) => section.dateKey === "2026-10-17")?.daily[0];
    const october18Reading = view.sections.find((section) => section.dateKey === "2026-10-18")?.daily[0];

    expect(october17Reading).toEqual({
      questId: "reading",
      questType: "daily",
      details: { title: "A different current title", category: "Current category", difficulty: "Hard", questType: "daily" },
      detailsSource: "current",
    });
    expect(october17Reading).toEqual(october18Reading);
    expect(getCompletionHistoryCardText(october17Reading!)).toEqual({
      title: "A different current title",
      description: "Current quest details — historical details unavailable · Current category · Hard",
    });

    const deletedQuestView = getCompletionHistoryView(history, undefined, undefined, [], 0, []);
    const deletedOctober17Reading = deletedQuestView.sections.find((section) => section.dateKey === "2026-10-17")?.daily[0];

    expect(deletedOctober17Reading).toEqual({ questId: "reading", questType: "daily" });
    expect(getCompletionHistoryCardText(deletedOctober17Reading!)).toEqual({
      title: "Daily Quest",
      description: "Original quest details were not saved for this older completion.",
    });
  });

  it("uses visible fallbacks for empty saved text and strips stray Markdown heading markers", () => {
    expect(getCompletionHistoryCardText({ questId: "old", questType: "daily" })).toEqual({
      title: "Daily Quest",
      description: "Original quest details were not saved for this older completion.",
    });
    expect(getCompletionHistoryCardText({
      questId: "malformed",
      questType: "personal",
      details: { title: "###   ", category: "## Wellness", difficulty: "Medium", questType: "personal" },
    })).toEqual({
      title: "Personal Quest",
      description: "Wellness · Medium · Original quest title was not saved for this completion.",
    });
    expect(getCompletionHistoryCardText({
      questId: "saved",
      questType: "daily",
      details: { title: "## Water the plants", category: "### Care", difficulty: "Easy", questType: "daily" },
    })).toEqual({ title: "Water the plants", description: "Care · Easy" });
  });

  it("records completion-time details and removes active Daily details when unchecked", () => {
    const dailyQuest = quest();
    const history: CompletionHistory = {
      [today]: {
        scheduledQuestIds: [dailyQuest.id],
        completedQuestIds: [],
        xpAwardedByQuestId: { other: 5 },
        completionDetails: {
          daily: { other: { title: "Other", category: "Care", difficulty: "Easy", questType: "daily" } },
        },
      },
    };
    const completed = toggleDailyQuestCompletionWithDetails(history, today, dailyQuest);
    const editedQuest = quest({ title: "Edited later", category: "Changed", difficulty: "Hard" });
    const unchecked = toggleDailyQuestCompletionWithDetails(completed, today, editedQuest);

    expect(completed[today].completionDetails?.daily?.[dailyQuest.id]).toEqual({
      title: "Water the fern", category: "Wellness", difficulty: "Medium", questType: "daily",
    });
    expect(completed[today].xpAwardedByQuestId).toEqual({ other: 5, [dailyQuest.id]: 10 });
    expect(unchecked[today].completedQuestIds).toEqual([]);
    expect(unchecked[today].completionDetails?.daily?.[dailyQuest.id]).toBeUndefined();
    expect(unchecked[today].completionDetails?.daily?.other).toBeDefined();
    expect(unchecked[today].xpAwardedByQuestId).toEqual({ other: 5 });
  });

  it("associates Personal details with their completion date and removes them on uncheck", () => {
    const personalQuest = quest({ id: "personal-1", schedule: "No due date" });
    const completed = recordCompletionDetails({}, yesterday, "personal", personalQuest);
    const view = getCompletionHistoryView(completed, { [personalQuest.id]: yesterday }, undefined, []);
    const unchecked = removeCompletionDetails(completed, "personal", personalQuest.id, yesterday);

    expect(view.sections[0].personal[0].details?.title).toBe("Water the fern");
    expect(unchecked[yesterday].completionDetails).toBeUndefined();
    expect(unchecked[yesterday].scheduledQuestIds).toEqual([]);
    expect(unchecked[yesterday].completedQuestIds).toEqual([]);
    expect(getCompletionHistoryView(unchecked, undefined, undefined, []).sections).toEqual([]);
  });

  it("shows undated legacy Personal completions without inventing a date or historical details", () => {
    const legacyQuest = quest({ id: "legacy", completed: true, title: "Current edited title" });
    const view = getCompletionHistoryView(
      {},
      undefined,
      { legacy: 5 },
      [legacyQuest],
      2,
    );

    expect(view.sections).toEqual([]);
    expect(view.earlier.completionCount).toBe(3);
    expect(view.earlier.items).toEqual([{ questId: "legacy", questType: "personal", xp: 5 }]);
    expect(view.earlier.unidentifiableCount).toBe(2);
  });

  it("drops malformed optional details without changing valid snapshot or XP data", () => {
    const history = {
      [today]: {
        scheduledQuestIds: ["daily"],
        completedQuestIds: ["daily"],
        xpAwardedByQuestId: { daily: 5 },
        completionDetails: {
          daily: {
            daily: { title: "Valid", category: "Care", difficulty: "Easy", questType: "daily" },
            malformed: { title: 4, category: "Care", difficulty: "Easy", questType: "daily" },
          },
          unexpected: "invalid",
        },
        unrelatedSnapshotField: "preserved",
      },
    } as unknown as CompletionHistory;
    const normalized = normalizeCompletionHistoryDetails(history);

    expect(normalized[today].completionDetails).toEqual({
      daily: { daily: { title: "Valid", category: "Care", difficulty: "Easy", questType: "daily" } },
    });
    expect(normalized[today].scheduledQuestIds).toEqual(["daily"]);
    expect(normalized[today].completedQuestIds).toEqual(["daily"]);
    expect(normalized[today].xpAwardedByQuestId).toEqual({ daily: 5 });
    expect((normalized[today] as CompletionHistory[typeof today] & { unrelatedSnapshotField: string }).unrelatedSnapshotField)
      .toBe("preserved");
  });

  it("ignores malformed or orphan XP values instead of changing the saved XP ledger", () => {
    const view = getCompletionHistoryView(
      { [today]: { scheduledQuestIds: ["daily"], completedQuestIds: ["daily"], xpAwardedByQuestId: { daily: 0 } } },
      undefined,
      { personal: -10 },
      [],
    );

    expect(view.sections[0].daily[0].xp).toBeUndefined();
    expect(view.sections[0].completionCount).toBe(1);
  });
});
