import { describe, expect, it } from "vitest";
import type { CompletionHistory, StoredQuestData } from "../src/app/quest-types";
import {
  getNextPlantProgress,
  getPlantFilterResults,
  getPlantJournalSpread,
  getPlantJournalSpreadCount,
  getPlantThresholdProgress,
  getQualifiedPlantIds,
  mergeDiscoveredPlantIds,
  migratePlantDiscoveries,
  plantCatalog,
} from "../src/app/plant-journal-logic";

function storedData(overrides: Partial<StoredQuestData> = {}): StoredQuestData {
  return {
    schemaVersion: 2,
    questLists: { daily: [], personal: [] },
    categoryLists: { daily: [], personal: [] },
    completionHistory: {},
    personalXpByQuestId: {},
    legacyXpBonus: 0,
    ...overrides,
  };
}

describe("Plant Journal catalog and discovery logic", () => {
  it("keeps the approved IDs, order, thresholds, and known asset mappings", () => {
    expect(plantCatalog.map(({ id, xpThreshold }) => [id, xpThreshold])).toEqual([
      ["fern", 0],
      ["daisy", 25],
      ["cactus", 60],
      ["sunflower", 100],
      ["lavender", 150],
      ["monstera", 225],
      ["moonflower", 325],
      ["golden-bonsai", 450],
    ]);
    expect(plantCatalog.filter((plant) => plant.imageSrc).map((plant) => [plant.name, plant.imageSrc]))
      .toEqual([
        ["Fern", "/plant-fern.png"],
        ["Daisy", "/plant-daisy.png"],
        ["Cactus", "/plant-cactus.png"],
        ["Lavender", "/plant-lavender.png"],
      ]);
  });

  it("qualifies plants exactly at their XP thresholds", () => {
    expect(getQualifiedPlantIds(0)).toEqual(["fern"]);
    expect(getQualifiedPlantIds(24)).toEqual(["fern"]);
    expect(getQualifiedPlantIds(25)).toEqual(["fern", "daisy"]);
    expect(getQualifiedPlantIds(450)).toEqual(plantCatalog.map((plant) => plant.id));
  });

  it("keeps discoveries permanent when XP decreases", () => {
    const discovered = mergeDiscoveredPlantIds([], 150);
    expect(discovered).toEqual(["fern", "daisy", "cactus", "sunflower", "lavender"]);
    expect(mergeDiscoveredPlantIds(discovered, 0)).toBe(discovered);
  });

  it("initializes existing users from their saved XP ledger", () => {
    const history: CompletionHistory = {
      "2026-10-17": {
        scheduledQuestIds: [],
        completedQuestIds: [],
        xpAwardedByQuestId: { oldDailyAward: 100 },
      },
    };
    const data = storedData({ completionHistory: history, personalXpByQuestId: { oldPersonalAward: 50 } });
    const migrated = migratePlantDiscoveries(data);

    expect(migrated.discoveredPlantIds).toEqual(["fern", "daisy", "cactus", "sunflower", "lavender"]);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.completionHistory).toBe(history);
    expect(migrated.personalXpByQuestId).toBe(data.personalXpByQuestId);
    expect(migratePlantDiscoveries(migrated)).toBe(migrated);
  });

  it("preserves saved discoveries and repairs malformed optional discovery data", () => {
    const data = storedData({
      schemaVersion: 4,
      discoveredPlantIds: "bad data" as unknown as string[],
      legacyXpBonus: 60,
    });
    const migrated = migratePlantDiscoveries(data);

    expect(migrated.schemaVersion).toBe(4);
    expect(migrated.discoveredPlantIds).toEqual(["fern", "daisy", "cactus"]);
    expect(migrated.questLists).toBe(data.questLists);
    expect(migrated.categoryLists).toBe(data.categoryLists);
    expect(migrated.legacyXpBonus).toBe(data.legacyXpBonus);

    const saved = migratePlantDiscoveries(storedData({
      discoveredPlantIds: ["daisy", "future-plant"],
      legacyXpBonus: 0,
    }));
    expect(saved.discoveredPlantIds).toContain("daisy");
    expect(saved.discoveredPlantIds).toContain("future-plant");
    expect(saved.discoveredPlantIds).toContain("fern");
  });
});

describe("Plant Journal filters and next discovery", () => {
  it("filters the catalog into all, collected, and locked plants", () => {
    const discovered = ["fern", "cactus"];
    expect(getPlantFilterResults(discovered, "all")).toHaveLength(8);
    expect(getPlantFilterResults(discovered, "collected").map((plant) => plant.id))
      .toEqual(["fern", "cactus"]);
    expect(getPlantFilterResults(discovered, "locked").map((plant) => plant.id))
      .toEqual(["daisy", "sunflower", "lavender", "monstera", "moonflower", "golden-bonsai"]);
  });

  it("reports the next undiscovered threshold and XP progress", () => {
    const next = getNextPlantProgress(50, ["fern", "daisy"]);
    expect(next).toMatchObject({
      plant: { id: "cactus", xpThreshold: 60 },
      xpRemaining: 10,
      progressPercent: 83.33333333333334,
    });
    expect(getPlantThresholdProgress(plantCatalog[2], 30)).toEqual({
      xpRemaining: 30,
      progressPercent: 50,
    });
    expect(getNextPlantProgress(450, plantCatalog.map((plant) => plant.id))).toBeUndefined();
  });

  it("keeps the full All catalog on the first of two spreads in catalog order", () => {
    const spread = getPlantJournalSpread([], "all", 0);
    expect(getPlantJournalSpreadCount([], "all")).toBe(2);
    expect(spread.leftPlants.map((plant) => plant.id)).toEqual([
      "fern", "daisy", "cactus", "sunflower",
    ]);
    expect(spread.rightPlants.map((plant) => plant.id)).toEqual([
      "lavender", "monstera", "moonflower", "golden-bonsai",
    ]);
    expect(getPlantJournalSpread([], "all", 1)).toMatchObject({
      leftPlants: [],
      rightPlants: [],
      currentSpread: 1,
      spreadCount: 2,
    });
    expect(getPlantJournalSpread([], "all", 2).currentSpread).toBe(1);
  });

  it("paginates collected plants by spread without duplicates", () => {
    const discovered = plantCatalog.slice(0, 5).map((plant) => plant.id);
    expect(getPlantJournalSpreadCount(discovered, "collected")).toBe(2);

    const first = getPlantJournalSpread(discovered, "collected", 0);
    expect(first.leftPlants.map((plant) => plant.id)).toEqual(["fern", "daisy", "cactus", "sunflower"]);
    expect(first.rightPlants.map((plant) => plant.id)).toEqual(["lavender"]);

    const allDiscovered = plantCatalog.map((plant) => plant.id);
    expect(getPlantJournalSpreadCount(allDiscovered, "collected")).toBe(2);
    expect(getPlantJournalSpread(allDiscovered, "collected", 0).rightPlants).toHaveLength(4);
  });

  it("flows locked plants left to right and keeps two spreads available", () => {
    const discovered = ["fern", "daisy"];
    expect(getPlantJournalSpreadCount(discovered, "locked")).toBe(2);
    const first = getPlantJournalSpread(discovered, "locked", 0);
    expect(first.leftPlants.map((plant) => plant.id)).toEqual([
      "cactus", "sunflower", "lavender", "monstera",
    ]);
    expect(first.rightPlants.map((plant) => plant.id)).toEqual(["moonflower", "golden-bonsai"]);

    expect(getPlantJournalSpreadCount(["fern", "daisy", "sunflower", "lavender"], "locked")).toBe(2);
    const allLocked = getPlantJournalSpread([], "locked", 0);
    expect(allLocked.leftPlants.map((plant) => plant.id)).toEqual([
      "fern", "daisy", "cactus", "sunflower",
    ]);
    expect(allLocked.rightPlants.map((plant) => plant.id)).toEqual([
      "lavender", "monstera", "moonflower", "golden-bonsai",
    ]);
  });
});
