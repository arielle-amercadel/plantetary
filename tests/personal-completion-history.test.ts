import { describe, expect, it } from "vitest";
import { initialQuestLists } from "../src/app/quest-store";
import {
  getCompletionHistoryView,
  getLocalDateKey,
  getXpLedgerTotal,
  migrateStoredData,
  recordCompletionDetails,
  recordPersonalCompletionDate,
  recordPersonalXpAward,
} from "../src/app/quest-logic";
import type { CompletionHistory, Quest, StoredQuestData } from "../src/app/quest-types";

describe("Personal Quest completion history and XP", () => {
  it("records a new Personal completion on its local completion date with details and XP", () => {
    const completedAt = new Date(2026, 9, 18, 23, 45);
    const dateKey = getLocalDateKey(completedAt);
    const quest: Quest = {
      id: "tidy-desk",
      title: "Tidy the desk",
      category: "Chores",
      schedule: "No due date",
      difficulty: "Easy",
      completed: false,
    };
    const history: CompletionHistory = {
      [dateKey]: { scheduledQuestIds: [], completedQuestIds: [] },
    };
    const datedHistory = recordCompletionDetails(history, dateKey, "personal", quest);
    const personalCompletedOnByQuestId = recordPersonalCompletionDate(undefined, quest.id, dateKey);
    const personalXpByQuestId = recordPersonalXpAward(undefined, quest.id, quest.difficulty);

    // The store persists these same fields together in plantetary-quest-data.
    const restored = JSON.parse(JSON.stringify({
      completionHistory: datedHistory,
      personalCompletedOnByQuestId,
      personalXpByQuestId,
    })) as {
      completionHistory: CompletionHistory;
      personalCompletedOnByQuestId: Record<string, string>;
      personalXpByQuestId: Record<string, number>;
    };
    const view = getCompletionHistoryView(
      restored.completionHistory,
      restored.personalCompletedOnByQuestId,
      restored.personalXpByQuestId,
      [{ ...quest, completed: true }],
    );

    expect(dateKey).toBe("2026-10-18");
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0].dateKey).toBe("2026-10-18");
    expect(view.sections[0].personal[0]).toMatchObject({
      questId: "tidy-desk",
      xp: 5,
      details: {
        title: "Tidy the desk",
        category: "Chores",
        difficulty: "Easy",
        questType: "personal",
      },
    });
    expect(view.earlier.completionCount).toBe(0);
    expect(getXpLedgerTotal({}, restored.personalXpByQuestId)).toBe(5);
  });

  it("keeps a genuinely undated legacy completion under Earlier Completions", () => {
    const legacyQuest: Quest = {
      id: "legacy-personal",
      title: "Old task",
      category: "Personal",
      schedule: "No due date",
      difficulty: "Easy",
      completed: true,
    };
    const view = getCompletionHistoryView({}, undefined, { [legacyQuest.id]: 5 }, [legacyQuest]);

    expect(view.sections).toEqual([]);
    expect(view.earlier.items).toMatchObject([{ questId: "legacy-personal", xp: 5 }]);
    expect(view.earlier.completionCount).toBe(1);
  });

  it("starts a fresh install or reset with no completed seed quests or seed XP", () => {
    const freshData: StoredQuestData = {
      questLists: initialQuestLists,
      categoryLists: { daily: ["Wellness"], personal: ["Chores"] },
    };
    const migratedFreshData = migrateStoredData(freshData);

    expect(migratedFreshData.questLists.daily.every((quest) => !quest.completed)).toBe(true);
    expect(migratedFreshData.questLists.personal.every((quest) => !quest.completed)).toBe(true);
    expect(getXpLedgerTotal(
      migratedFreshData.completionHistory,
      migratedFreshData.personalXpByQuestId,
      migratedFreshData.legacyXpBonus,
    )).toBe(0);
    expect(getCompletionHistoryView(
      migratedFreshData.completionHistory,
      migratedFreshData.personalCompletedOnByQuestId,
      migratedFreshData.personalXpByQuestId,
      migratedFreshData.questLists.personal,
    ).earlier.completionCount).toBe(0);
  });
});
