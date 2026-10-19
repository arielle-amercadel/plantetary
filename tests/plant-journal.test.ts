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
  mergePendingPlantGiftIds,
  migratePlantDiscoveries,
  plantCatalog,
  unwrapStarterFern,
  unwrapPlantGift,
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
        ["Sunflower", "/plant-sunflower.png"],
        ["Lavender", "/plant-lavender.png"],
        ["Monstera", "/plant-monstera.png"],
        ["Moonflower", "/plant-moonflower.png"],
        ["Golden Bonsai", "/plant-golden-bonsai.png"],
      ]);
  });

  it("qualifies plants exactly at their XP thresholds", () => {
    expect(getQualifiedPlantIds(0)).toEqual([]);
    expect(getQualifiedPlantIds(24)).toEqual([]);
    expect(getQualifiedPlantIds(25)).toEqual(["daisy"]);
    expect(getQualifiedPlantIds(450)).toEqual(plantCatalog.filter((plant) => plant.id !== "fern").map((plant) => plant.id));
    for (const plant of plantCatalog.filter((item) => item.id !== "fern")) {
      expect(getQualifiedPlantIds(plant.xpThreshold)).toContain(plant.id);
      expect(getQualifiedPlantIds(plant.xpThreshold - 1)).not.toContain(plant.id);
    }
  });

  it("creates milestone gifts without collecting them and preserves them when XP decreases", () => {
    const discovered: string[] = ["fern"];
    const pending = mergePendingPlantGiftIds([], 25, discovered);
    expect(pending).toEqual(["daisy"]);
    expect(discovered).toEqual(["fern"]);
    expect(mergePendingPlantGiftIds(pending, 0, discovered)).toEqual(pending);
  });

  it("keeps Fern out of XP discoveries and lets the starter gift add Fern only once", () => {
    const withoutFern = mergeDiscoveredPlantIds([]);
    const unwrapped = unwrapStarterFern(withoutFern);

    expect(withoutFern).not.toContain("fern");
    expect(unwrapped).toEqual(["fern"]);
    expect(unwrapStarterFern(unwrapped)).toBe(unwrapped);
    expect(getNextPlantProgress(0, withoutFern)?.plant.id).toBe("daisy");
  });

  it("hides every pending gift plant from collection filters until unwrapped", () => {
    expect(getPlantFilterResults([], "all", ["fern", "daisy"]).map((plant) => plant.id)).not.toContain("fern");
    expect(getPlantFilterResults([], "all", ["fern", "daisy"]).map((plant) => plant.id)).not.toContain("daisy");
    expect(getPlantFilterResults([], "locked", ["fern", "daisy"]).map((plant) => plant.id)).not.toContain("daisy");
    expect(getPlantFilterResults([], "collected", ["fern", "daisy"])).toEqual([]);
    expect(getPlantFilterResults(["fern"], "collected").map((plant) => plant.id)).toEqual(["fern"]);
  });

  it("unwraps each earned plant independently and does not award it twice", () => {
    const afterDaisy = unwrapPlantGift(["fern"], ["daisy", "cactus"], "daisy");
    expect(afterDaisy).toEqual({ discoveredPlantIds: ["fern", "daisy"], pendingPlantGiftIds: ["cactus"] });
    expect(unwrapPlantGift(afterDaisy.discoveredPlantIds, afterDaisy.pendingPlantGiftIds, "daisy"))
      .toEqual(afterDaisy);
    expect(unwrapPlantGift(afterDaisy.discoveredPlantIds, afterDaisy.pendingPlantGiftIds, "cactus"))
      .toEqual({ discoveredPlantIds: ["fern", "daisy", "cactus"], pendingPlantGiftIds: [] });
  });

  it("queues every qualifying milestone and reports the remaining next milestone", () => {
    const waiting = mergePendingPlantGiftIds([], 150, ["fern"]);
    expect(waiting).toEqual([
      "daisy", "cactus", "sunflower", "lavender",
    ]);
    expect(waiting.length).toBe(4);
    expect(mergePendingPlantGiftIds(["daisy"], 25, ["fern"])).toEqual(["daisy"]);
    expect(getNextPlantProgress(25, ["fern"], ["daisy"])?.plant.id).toBe("cactus");
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
    expect(migrated.starterPlantGiftPending).toBe(false);
    expect(migrated.schemaVersion).toBe(5);
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

    expect(migrated.schemaVersion).toBe(5);
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

  it("keeps an explicitly pending Fern gift unopened through migration", () => {
    const data = storedData({
      schemaVersion: 3,
      discoveredPlantIds: [],
      starterPlantGiftPending: true,
    });
    const migrated = migratePlantDiscoveries(data);

    expect(migrated.starterPlantGiftPending).toBe(true);
    expect(migrated.discoveredPlantIds).not.toContain("fern");
    expect(migrated.pendingPlantGiftIds).toEqual(["fern"]);
    expect(migratePlantDiscoveries(migrated)).toBe(migrated);
  });

  it("persists an unwrapped Fern across serialization and discovery migration", () => {
    const unwrapped = storedData({
      schemaVersion: 4,
      discoveredPlantIds: unwrapStarterFern([]),
      starterPlantGiftPending: false,
    });
    const restored = JSON.parse(JSON.stringify(unwrapped)) as StoredQuestData;
    const migrated = migratePlantDiscoveries(restored);

    expect(migrated.starterPlantGiftPending).toBe(false);
    expect(migrated.discoveredPlantIds).toContain("fern");
    expect(migratePlantDiscoveries(migrated)).toBe(migrated);
  });

  it("restores pending gifts independently from collected plants and saved XP", () => {
    const saved = storedData({
      schemaVersion: 5,
      discoveredPlantIds: ["fern"],
      pendingPlantGiftIds: ["daisy"],
      starterPlantGiftPending: false,
      completionHistory: {},
    });
    const restored = migratePlantDiscoveries(JSON.parse(JSON.stringify(saved)) as StoredQuestData);
    expect(restored.discoveredPlantIds).toEqual(["fern"]);
    expect(restored.pendingPlantGiftIds).toEqual(["daisy"]);
    expect(restored.starterPlantGiftPending).toBe(false);
    expect(migratePlantDiscoveries(restored)).toBe(restored);
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
