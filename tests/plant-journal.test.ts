import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompletionHistory, StoredQuestData } from "../src/app/quest-types";
import {
  getNextPlantProgress,
  getPlantCollectionStatus,
  getPlantFilterResults,
  getPlantJournalPage,
  getPlantJournalSpread,
  getPlantJournalSpreadCount,
  getPlantThresholdProgress,
  getQualifiedPlantIds,
  getWaitingGiftsLabel,
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
  it("has sixteen unique IDs and distinct transparent 70px PNG assets", () => {
    expect(plantCatalog).toHaveLength(16);
    expect(new Set(plantCatalog.map(({ id }) => id)).size).toBe(16);
    expect(new Set(plantCatalog.map(({ imageSrc }) => imageSrc)).size).toBe(16);
    const assets = plantCatalog.map(({ id, imageSrc }) => {
      expect(imageSrc).toBe(`/plant-${id}.png`);
      const png = readFileSync(resolve("public", imageSrc!.slice(1)));
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(png.readUInt32BE(16)).toBe(70);
      expect(png.readUInt32BE(20)).toBe(70);
      // PNG truecolor + alpha, or indexed transparency.
      expect(png[25] === 6 || png.includes(Buffer.from("tRNS"))).toBe(true);
      return png.toString("base64");
    });
    expect(new Set(assets).size).toBe(16);
  });

  it.each(plantCatalog.slice(8))("uses the existing gift lifecycle for $name", (plant) => {
    const collected = plantCatalog.filter(({ xpThreshold }) => xpThreshold < plant.xpThreshold).map(({ id }) => id);
    expect(mergePendingPlantGiftIds([], plant.xpThreshold - 1, collected)).toEqual([]);
    expect(getPlantFilterResults(collected, "locked").map(({ id }) => id)).toContain(plant.id);
    const pending = mergePendingPlantGiftIds([], plant.xpThreshold, collected);
    expect(pending).toEqual([plant.id]);
    expect(getPlantFilterResults(collected, "all", pending).map(({ id }) => id)).not.toContain(plant.id);
    expect(mergePendingPlantGiftIds(pending, 0, collected)).toEqual(pending);
    const unwrapped = unwrapPlantGift(collected, pending, plant.id);
    expect(unwrapped.discoveredPlantIds).toEqual([...collected, plant.id]);
    expect(unwrapped.pendingPlantGiftIds).toEqual([]);
    expect(getPlantFilterResults(unwrapped.discoveredPlantIds, "collected").map(({ id }) => id)).toContain(plant.id);
    expect(unwrapPlantGift(unwrapped.discoveredPlantIds, [], plant.id)).toEqual(unwrapped);
  });

  it.each([4, 5])("preserves version %i saves and queues new milestones from saved XP", (schemaVersion) => {
    const originalIds = plantCatalog.slice(0, 8).map(({ id }) => id);
    const saved = storedData({
      schemaVersion,
      discoveredPlantIds: [...originalIds, "future-plant"],
      pendingPlantGiftIds: [],
      starterPlantGiftPending: false,
      legacyXpBonus: 1800,
    });
    const snapshot = JSON.stringify(saved);
    const restored = migratePlantDiscoveries(saved);
    expect(restored.discoveredPlantIds).toEqual(saved.discoveredPlantIds);
    expect(restored.pendingPlantGiftIds).toEqual(plantCatalog.slice(8).map(({ id }) => id));
    expect(restored.completionHistory).toBe(saved.completionHistory);
    expect(restored.personalXpByQuestId).toBe(saved.personalXpByQuestId);
    expect(restored.questLists).toBe(saved.questLists);
    expect(restored.legacyXpBonus).toBe(1800);
    expect(JSON.stringify(saved)).toBe(snapshot);
    expect(migratePlantDiscoveries(restored)).toBe(restored);
  });

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
      ["tulip", 550],
      ["aloe-vera", 675],
      ["hydrangea", 800],
      ["string-of-pearls", 950],
      ["orchid", 1125],
      ["venus-flytrap", 1325],
      ["anthurium", 1550],
      ["calathea", 1800],
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
        ["Tulip", "/plant-tulip.png"],
        ["Aloe Vera", "/plant-aloe-vera.png"],
        ["Hydrangea", "/plant-hydrangea.png"],
        ["String of Pearls", "/plant-string-of-pearls.png"],
        ["Orchid", "/plant-orchid.png"],
        ["Venus Flytrap", "/plant-venus-flytrap.png"],
        ["Anthurium", "/plant-anthurium.png"],
        ["Calathea", "/plant-calathea.png"],
      ]);
  });

  it("qualifies plants exactly at their XP thresholds", () => {
    expect(getQualifiedPlantIds(0)).toEqual([]);
    expect(getQualifiedPlantIds(24)).toEqual([]);
    expect(getQualifiedPlantIds(25)).toEqual(["daisy"]);
    expect(getQualifiedPlantIds(1800)).toEqual(plantCatalog.filter((plant) => plant.id !== "fern").map((plant) => plant.id));
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
    expect(getNextPlantProgress(0, withoutFern, [])?.plant.id).toBe("daisy");
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
    expect(getPlantFilterResults(discovered, "all")).toHaveLength(16);
    expect(getPlantFilterResults(discovered, "collected").map((plant) => plant.id))
      .toEqual(["fern", "cactus"]);
    expect(getPlantFilterResults(discovered, "locked").map((plant) => plant.id))
      .toEqual(plantCatalog.filter(({ id }) => !discovered.includes(id)).map(({ id }) => id));
  });

  it("reports the next undiscovered threshold and XP progress", () => {
    const next = getNextPlantProgress(50, ["fern", "daisy"], []);
    expect(next).toMatchObject({
      plant: { id: "cactus", xpThreshold: 60 },
      xpRemaining: 10,
      progressPercent: 83.33333333333334,
    });
    expect(getPlantThresholdProgress(plantCatalog[2], 30)).toEqual({
      xpRemaining: 30,
      progressPercent: 50,
    });
    expect(getNextPlantProgress(450, plantCatalog.map((plant) => plant.id), [])).toBeUndefined();
  });

  it("does not name an earned gift that is still wrapped as the next plant", () => {
    const discovered = ["fern"];
    const pending = mergePendingPlantGiftIds(undefined, 30, discovered);
    expect(pending).toEqual(["daisy"]);

    expect(getNextPlantProgress(30, discovered, pending)).toMatchObject({
      plant: { id: "cactus", xpThreshold: 60 },
      xpRemaining: 30,
    });

    const unwrapped = unwrapPlantGift(discovered, pending, "daisy");
    expect(getNextPlantProgress(30, unwrapped.discoveredPlantIds, unwrapped.pendingPlantGiftIds)?.plant.id).toBe("cactus");
  });

  describe("collection status", () => {
    const allPlantIds = plantCatalog.map((plant) => plant.id);
    const finalXp = plantCatalog[plantCatalog.length - 1].xpThreshold;
    const allExcept = (...plantIds: string[]) => allPlantIds.filter((id) => !plantIds.includes(id));

    it("reports a waiting gift, not a complete collection, when the final plant is still wrapped", () => {
      const discovered = allExcept("calathea");

      expect(getNextPlantProgress(finalXp, discovered, ["calathea"])).toBeUndefined();
      expect(getPlantCollectionStatus(finalXp, discovered, ["calathea"])).toBe("gifts-waiting");
    });

    it("reports waiting gifts when several remaining plants are all wrapped", () => {
      const pending = ["orchid", "calathea"];

      expect(getPlantCollectionStatus(finalXp, allExcept(...pending), pending)).toBe("gifts-waiting");
    });

    it("reports a waiting gift when the only unopened plant is the starter Fern", () => {
      expect(getPlantCollectionStatus(finalXp, allExcept("fern"), ["fern"])).toBe("gifts-waiting");
    });

    it("reports a complete collection only after the final gift is unwrapped", () => {
      const unwrapped = unwrapPlantGift(allExcept("calathea"), ["calathea"], "calathea");

      expect(unwrapped.pendingPlantGiftIds).toEqual([]);
      expect(getPlantCollectionStatus(finalXp, unwrapped.discoveredPlantIds, unwrapped.pendingPlantGiftIds)).toBe("complete");
    });

    it("stays in progress while a plant is still locked, even if another gift is wrapped", () => {
      expect(getPlantCollectionStatus(30, ["fern"], ["daisy"])).toBe("in-progress");
      expect(getPlantCollectionStatus(0, [], [])).toBe("in-progress");
    });

    it("words the waiting gift label for one or several gifts", () => {
      expect(getWaitingGiftsLabel(1)).toBe("A gift is waiting");
      expect(getWaitingGiftsLabel(2)).toBe("2 gifts are waiting");
    });
  });

  it("keeps all sixteen plants across two spreads in catalog order", () => {
    const spread = getPlantJournalSpread([], "all", 0);
    expect(getPlantJournalSpreadCount([], "all")).toBe(2);
    expect(spread.leftPlants.map((plant) => plant.id)).toEqual([
      "fern", "daisy", "cactus", "sunflower",
    ]);
    expect(spread.rightPlants.map((plant) => plant.id)).toEqual([
      "lavender", "monstera", "moonflower", "golden-bonsai",
    ]);
    expect(getPlantJournalSpread([], "all", 1)).toMatchObject({
      leftPlants: plantCatalog.slice(8, 12),
      rightPlants: plantCatalog.slice(12, 16),
      currentSpread: 1,
      spreadCount: 2,
    });
    expect(getPlantJournalSpread([], "all", 2).currentSpread).toBe(1);
    const second = getPlantJournalSpread([], "all", 1);
    expect([...spread.leftPlants, ...spread.rightPlants, ...second.leftPlants, ...second.rightPlants])
      .toEqual(plantCatalog);
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

  describe("one page at a time (narrow screens)", () => {
    const pagesOf = (discovered: string[], filter: "all" | "collected" | "locked", pending: string[] = []) => {
      const { pageCount } = getPlantJournalPage(discovered, filter, 0, pending);
      return Array.from({ length: pageCount }, (_, index) => getPlantJournalPage(discovered, filter, index, pending));
    };

    it("shows the same plants on each page as the two-page spreads do, in order", () => {
      for (const [discovered, filter] of [
        [[], "all"],
        [plantCatalog.slice(0, 5).map((plant) => plant.id), "collected"],
        [["fern", "daisy"], "locked"],
        [plantCatalog.map((plant) => plant.id), "collected"],
      ] as const) {
        const spreadCount = getPlantJournalSpreadCount([...discovered], filter);
        const spreadPages = Array.from({ length: spreadCount }, (_, index) => getPlantJournalSpread([...discovered], filter, index))
          .flatMap((spread) => [spread.leftPlants, spread.rightPlants]);
        pagesOf([...discovered], filter).forEach((page, index) => {
          expect(page.pageNumber).toBe(index + 1);
          expect(page.plants).toEqual(spreadPages[index]);
        });
      }
    });

    it("counts only pages with plants, and at least one", () => {
      expect(getPlantJournalPage([], "all", 0)).toMatchObject({ pageCount: 4, currentPage: 0, pageNumber: 1 });
      expect(pagesOf([], "all").flatMap((page) => page.plants)).toEqual(plantCatalog);
      // Five collected plants: two pages (4 + 1), never the empty third and fourth pages of the spreads.
      expect(pagesOf(plantCatalog.slice(0, 5).map((plant) => plant.id), "collected").map((page) => page.plants.length)).toEqual([4, 1]);
      // Nothing locked once everything is discovered: one empty page, not zero.
      expect(getPlantJournalPage(plantCatalog.map((plant) => plant.id), "locked", 0)).toMatchObject({ plants: [], pageCount: 1, pageNumber: 1 });
    });

    it("keeps the page in range", () => {
      expect(getPlantJournalPage([], "all", 9)).toMatchObject({ currentPage: 3, pageNumber: 4 });
      expect(getPlantJournalPage([], "all", -2)).toMatchObject({ currentPage: 0, pageNumber: 1 });
      expect(getPlantJournalPage([], "all", Number.NaN)).toMatchObject({ currentPage: 0 });
      expect(getPlantJournalPage([], "all", 1.7)).toMatchObject({ currentPage: 1 });
    });

    it("counts waiting gifts as collected, as the filters do", () => {
      const collected = pagesOf(["fern"], "collected", ["daisy"]).flatMap((page) => page.plants.map((plant) => plant.id));
      expect(collected).toEqual(getPlantFilterResults(["fern"], "collected", ["daisy"]).map((plant) => plant.id));
    });
  });

  it("flows locked plants left to right and keeps two spreads available", () => {
    const discovered = ["fern", "daisy"];
    expect(getPlantJournalSpreadCount(discovered, "locked")).toBe(2);
    const first = getPlantJournalSpread(discovered, "locked", 0);
    expect(first.leftPlants.map((plant) => plant.id)).toEqual([
      "cactus", "sunflower", "lavender", "monstera",
    ]);
    expect(first.rightPlants.map((plant) => plant.id)).toEqual(["moonflower", "golden-bonsai", "tulip", "aloe-vera"]);

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
