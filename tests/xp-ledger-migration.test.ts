import { describe, expect, it } from "vitest";
import { getQuestXp, getXpLedgerTotal, migrateStoredData } from "../src/app/quest-logic";
import type { CompletionSnapshot, Quest, StoredQuestData } from "../src/app/quest-types";

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
