import { describe, expect, it } from "vitest";
import { migratePlantDiscoveries } from "../src/app/plant-journal-logic";
import {
  getQuestXp,
  getXpLedgerTotal,
  migrateStoredData,
  recordPersonalXpAward,
  reversePersonalXpAward,
  toggleDailyQuestCompletion,
  updateQuestInLists,
} from "../src/app/quest-logic";
import type {
  CompletionSnapshot,
  Difficulty,
  Quest,
  QuestListKey,
  QuestLists,
  StoredQuestData,
} from "../src/app/quest-types";

function quest(id: string, difficulty: Quest["difficulty"], completed: boolean): Quest {
  return {
    id,
    title: id,
    category: "Wellness",
    schedule: "Every day",
    difficulty,
    completed,
  };
}

function snapshot(scheduledQuestIds: string[], completedQuestIds: string[]): CompletionSnapshot {
  return { scheduledQuestIds, completedQuestIds };
}

function oldXpTotal(data: StoredQuestData): number {
  return [...data.questLists.daily, ...data.questLists.personal]
    .filter((item) => item.completed)
    .reduce((total, item) => total + getQuestXp(item.difficulty), 0);
}

function updateQuestListCompletion(lists: QuestLists, list: QuestListKey, completed: boolean): QuestLists {
  return { ...lists, [list]: lists[list].map((item) => ({ ...item, completed })) };
}

function makeLegacyData(): StoredQuestData {
  return {
    questLists: {
      daily: [quest("daily", "Medium", true), quest("other-daily", "Hard", false)],
      personal: [quest("personal", "Hard", true), quest("unfinished", "Easy", false)],
    },
    categoryLists: {
      daily: ["Wellness"],
      personal: ["Projects"],
    },
    completionHistory: {
      "2026-10-18": snapshot(["daily", "deleted-daily"], ["daily", "deleted-daily"]),
      "2026-10-19": snapshot(["daily"], ["daily"]),
    },
  };
}

describe("stored XP ledger migration", () => {
  it("backfills legacy awards, preserves saved data, and is idempotent", () => {
    const legacy = makeLegacyData();
    const oldTotal = oldXpTotal(legacy);
    const migrated = migrateStoredData(legacy);

    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.questLists).toBe(legacy.questLists);
    expect(migrated.categoryLists).toBe(legacy.categoryLists);
    expect(migrated.completionHistory?.["2026-10-18"]).toMatchObject({
      scheduledQuestIds: ["daily", "deleted-daily"],
      completedQuestIds: ["daily", "deleted-daily"],
      xpAwardedByQuestId: { daily: 10 },
    });
    expect(migrated.completionHistory?.["2026-10-19"]?.xpAwardedByQuestId).toEqual({ daily: 10 });
    expect(migrated.personalXpByQuestId).toEqual({ personal: 20 });
    expect(getXpLedgerTotal(
      migrated.completionHistory,
      migrated.personalXpByQuestId,
      migrated.legacyXpBonus,
    )).toBe(40);
    expect(getXpLedgerTotal(
      migrated.completionHistory,
      migrated.personalXpByQuestId,
      migrated.legacyXpBonus,
    )).toBeGreaterThanOrEqual(oldTotal);
    expect(migrateStoredData(migrated)).toBe(migrated);
  });

  it("uses a legacy XP bonus when backfilled ledgers do not account for the old total", () => {
    const legacy: StoredQuestData = {
      questLists: {
        daily: [quest("daily", "Hard", true)],
        personal: [],
      },
      categoryLists: { daily: [], personal: [] },
      completionHistory: {},
    };
    const migrated = migrateStoredData(legacy);

    expect(migrated.legacyXpBonus).toBe(oldXpTotal(legacy));
    expect(getXpLedgerTotal(
      migrated.completionHistory,
      migrated.personalXpByQuestId,
      migrated.legacyXpBonus,
    )).toBe(oldXpTotal(legacy));
  });

  it("repairs malformed optional ledger fields without rejecting quest data", () => {
    const malformed = {
      ...makeLegacyData(),
      legacyXpBonus: Number.NaN,
      personalXpByQuestId: { personal: -4, obsolete: Number.NaN },
      completionHistory: {
        "2026-10-18": {
          ...snapshot(["daily"], ["daily"]),
          xpAwardedByQuestId: { daily: -2, obsolete: Number.NaN },
        },
      },
    } as StoredQuestData;
    const migrated = migrateStoredData(malformed);

    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.questLists).toBe(malformed.questLists);
    expect(migrated.categoryLists).toBe(malformed.categoryLists);
    expect(migrated.completionHistory?.["2026-10-18"]?.xpAwardedByQuestId).toEqual({ daily: 10 });
    expect(migrated.personalXpByQuestId).toEqual({ personal: 20 });
    expect(Number.isFinite(migrated.legacyXpBonus)).toBe(true);
  });

  it("repairs zero individual awards while preserving other awards and a zero legacy bonus", () => {
    const data: StoredQuestData = {
      ...makeLegacyData(),
      schemaVersion: 2,
      legacyXpBonus: 0,
      completionHistory: {
        "2026-10-19": {
          ...snapshot(["daily", "other-daily"], ["daily", "other-daily"]),
          xpAwardedByQuestId: { daily: 0, "other-daily": 13 },
        },
      },
    };

    const migrated = migrateStoredData(data);

    expect(migrated.completionHistory?.["2026-10-19"]?.xpAwardedByQuestId).toEqual({
      daily: 10,
      "other-daily": 13,
    });
    expect(migrated.legacyXpBonus).toBe(0);
    expect(migrateStoredData(migrated)).toBe(migrated);
  });

  it("does not downgrade schema version 2 or newer", () => {
    const versionThree: StoredQuestData = {
      ...makeLegacyData(),
      schemaVersion: 3,
      legacyXpBonus: 7,
      personalXpByQuestId: { deletedQuest: 15 },
    };
    const migrated = migrateStoredData(versionThree);

    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.personalXpByQuestId).toEqual({ personal: 20, deletedQuest: 15 });
    expect(migrated.legacyXpBonus).toBe(7);
  });

  it("safely rebuilds missing optional ledger fields", () => {
    const missing = makeLegacyData();
    const migrated = migrateStoredData(missing);

    expect(migrated.personalXpByQuestId).toEqual({ personal: 20 });
    expect(migrated.completionHistory?.["2026-10-18"]?.xpAwardedByQuestId).toEqual({ daily: 10 });
  });
});

describe("XP after editing a completed quest and reloading", () => {
  const dateKey = "2026-10-19";

  function currentSave(overrides: Partial<StoredQuestData>): StoredQuestData {
    return {
      schemaVersion: 5,
      questLists: { daily: [], personal: [] },
      categoryLists: { daily: [], personal: [] },
      legacyXpBonus: 0,
      ...overrides,
    };
  }

  // The store restores saves from JSON and runs both migrations on every page load.
  function reload(data: StoredQuestData): StoredQuestData {
    return migratePlantDiscoveries(migrateStoredData(JSON.parse(JSON.stringify(data)) as StoredQuestData));
  }

  function totalXp(data: StoredQuestData): number {
    return getXpLedgerTotal(data.completionHistory, data.personalXpByQuestId, data.legacyXpBonus);
  }

  function completedPersonalSave(): StoredQuestData {
    return currentSave({
      questLists: { daily: [], personal: [quest("personal", "Easy", true)] },
      personalXpByQuestId: recordPersonalXpAward(undefined, "personal", "Easy"),
    });
  }

  function completedDailySave(): StoredQuestData {
    return currentSave({
      questLists: { daily: [quest("daily", "Easy", true)], personal: [] },
      completionHistory: toggleDailyQuestCompletion(
        { [dateKey]: snapshot(["daily"], []) },
        dateKey,
        "daily",
        "Easy",
      ),
    });
  }

  function editDifficulty(
    data: StoredQuestData,
    list: QuestListKey,
    questId: string,
    difficulty: Difficulty,
  ): StoredQuestData {
    return { ...data, questLists: updateQuestInLists(data.questLists, list, questId, { difficulty }) };
  }

  it("keeps earned XP when a completed personal quest is edited to a higher difficulty", () => {
    const edited = editDifficulty(completedPersonalSave(), "personal", "personal", "Hard");
    const reloaded = reload(edited);

    expect(totalXp(reloaded)).toBe(5);
    expect(reloaded.legacyXpBonus).toBe(0);
    expect(reloaded.personalXpByQuestId).toEqual({ personal: 5 });
  });

  it("keeps earned XP when a completed daily quest is edited to a higher difficulty", () => {
    const edited = editDifficulty(completedDailySave(), "daily", "daily", "Hard");
    const reloaded = reload(edited);

    expect(totalXp(reloaded)).toBe(5);
    expect(reloaded.legacyXpBonus).toBe(0);
    expect(reloaded.completionHistory?.[dateKey]?.xpAwardedByQuestId).toEqual({ daily: 5 });
  });

  it("does not change XP across repeated reloads", () => {
    const once = reload(editDifficulty(completedPersonalSave(), "personal", "personal", "Hard"));
    const twice = reload(once);
    const thrice = reload(twice);

    expect(totalXp(once)).toBe(5);
    expect(totalXp(twice)).toBe(5);
    expect(totalXp(thrice)).toBe(5);
  });

  it("removes only the XP originally earned when an edited quest is uncompleted", () => {
    const reloaded = reload(editDifficulty(completedPersonalSave(), "personal", "personal", "Hard"));
    const uncompleted: StoredQuestData = {
      ...reloaded,
      questLists: updateQuestListCompletion(reloaded.questLists, "personal", false),
      personalXpByQuestId: reversePersonalXpAward(reloaded.personalXpByQuestId, "personal"),
    };

    expect(totalXp(reload(uncompleted))).toBe(0);
  });

  it("earns the new difficulty's XP when an edited quest is completed again", () => {
    const edited = reload(editDifficulty(completedPersonalSave(), "personal", "personal", "Hard"));
    const uncompleted = reversePersonalXpAward(edited.personalXpByQuestId, "personal");
    const recompleted: StoredQuestData = {
      ...edited,
      personalXpByQuestId: recordPersonalXpAward(uncompleted, "personal", "Hard"),
    };

    expect(totalXp(reload(recompleted))).toBe(20);
  });

  it("preserves an existing legacy XP bonus without recalculating it", () => {
    const save = editDifficulty(
      { ...completedPersonalSave(), legacyXpBonus: 7 },
      "personal",
      "personal",
      "Hard",
    );
    const reloaded = reload(save);

    expect(reloaded.legacyXpBonus).toBe(7);
    expect(totalXp(reloaded)).toBe(12);
    expect(totalXp(reload(reloaded))).toBe(12);
  });

  it("migrates a genuine pre-ledger save only once", () => {
    const preLedgerSave: StoredQuestData = {
      questLists: { daily: [quest("daily", "Hard", true)], personal: [] },
      categoryLists: { daily: [], personal: [] },
      completionHistory: {},
    };
    const migrated = reload(preLedgerSave);

    expect(migrated.schemaVersion).toBeGreaterThanOrEqual(2);
    expect(migrated.legacyXpBonus).toBe(20);
    expect(totalXp(migrated)).toBe(20);

    const edited = editDifficulty(migrated, "daily", "daily", "Easy");
    const reloaded = reload(reload(edited));

    expect(reloaded.legacyXpBonus).toBe(20);
    expect(totalXp(reloaded)).toBe(20);
  });
});
