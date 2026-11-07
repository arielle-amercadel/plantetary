import type { StoredQuestData } from "./quest-types";
import { getXpLedgerTotal } from "./quest-logic";

export type Plant = {
  id: string;
  name: string;
  xpThreshold: number;
  imageSrc?: string;
};

export type PlantFilter = "all" | "collected" | "locked";

export const plantCatalog: Plant[] = [
  { id: "fern", name: "Fern", xpThreshold: 0, imageSrc: "/plant-fern.png" },
  { id: "daisy", name: "Daisy", xpThreshold: 25, imageSrc: "/plant-daisy.png" },
  { id: "cactus", name: "Cactus", xpThreshold: 60, imageSrc: "/plant-cactus.png" },
  { id: "sunflower", name: "Sunflower", xpThreshold: 100, imageSrc: "/plant-sunflower.png" },
  { id: "lavender", name: "Lavender", xpThreshold: 150, imageSrc: "/plant-lavender.png" },
  { id: "monstera", name: "Monstera", xpThreshold: 225, imageSrc: "/plant-monstera.png" },
  { id: "moonflower", name: "Moonflower", xpThreshold: 325, imageSrc: "/plant-moonflower.png" },
  { id: "golden-bonsai", name: "Golden Bonsai", xpThreshold: 450, imageSrc: "/plant-golden-bonsai.png" },
  { id: "tulip", name: "Tulip", xpThreshold: 550, imageSrc: "/plant-tulip.png" },
  { id: "aloe-vera", name: "Aloe Vera", xpThreshold: 675, imageSrc: "/plant-aloe-vera.png" },
  { id: "hydrangea", name: "Hydrangea", xpThreshold: 800, imageSrc: "/plant-hydrangea.png" },
  { id: "string-of-pearls", name: "String of Pearls", xpThreshold: 950, imageSrc: "/plant-string-of-pearls.png" },
  { id: "orchid", name: "Orchid", xpThreshold: 1125, imageSrc: "/plant-orchid.png" },
  { id: "venus-flytrap", name: "Venus Flytrap", xpThreshold: 1325, imageSrc: "/plant-venus-flytrap.png" },
  { id: "anthurium", name: "Anthurium", xpThreshold: 1550, imageSrc: "/plant-anthurium.png" },
  { id: "calathea", name: "Calathea", xpThreshold: 1800, imageSrc: "/plant-calathea.png" },
];

export function getQualifiedPlantIds(totalXp: number): string[] {
  return plantCatalog
    .filter((plant) => plant.id !== "fern" && totalXp >= plant.xpThreshold)
    .map((plant) => plant.id);
}

export function unwrapStarterFern(discoveredPlantIds: string[]): string[] {
  return discoveredPlantIds.includes("fern") ? discoveredPlantIds : [...discoveredPlantIds, "fern"];
}

export function mergeDiscoveredPlantIds(discoveredPlantIds: string[] | undefined): string[] {
  return discoveredPlantIds ?? [];
}

export function mergePendingPlantGiftIds(
  pendingPlantGiftIds: string[] | undefined,
  totalXp: number,
  discoveredPlantIds: string[],
): string[] {
  const discovered = new Set(discoveredPlantIds);
  const pending = new Set(pendingPlantGiftIds ?? []);
  for (const plantId of getQualifiedPlantIds(totalXp)) {
    if (!discovered.has(plantId)) pending.add(plantId);
  }
  for (const plantId of discovered) pending.delete(plantId);
  return plantCatalog.map(({ id }) => id).filter((id) => pending.has(id));
}

export function unwrapPlantGift(
  discoveredPlantIds: string[],
  pendingPlantGiftIds: string[],
  plantId: string,
): { discoveredPlantIds: string[]; pendingPlantGiftIds: string[] } {
  if (!pendingPlantGiftIds.includes(plantId)) {
    return { discoveredPlantIds, pendingPlantGiftIds };
  }
  return {
    discoveredPlantIds: discoveredPlantIds.includes(plantId)
      ? discoveredPlantIds
      : [...discoveredPlantIds, plantId],
    pendingPlantGiftIds: pendingPlantGiftIds.filter((id) => id !== plantId),
  };
}

export function getPlantFilterResults(
  discoveredPlantIds: string[],
  filter: PlantFilter,
  pendingPlantGiftIds: string[] = [],
): Plant[] {
  const pending = new Set(pendingPlantGiftIds);
  const catalog = plantCatalog.filter((plant) => !pending.has(plant.id));
  if (filter === "all") return catalog;
  const discovered = new Set(discoveredPlantIds);
  return catalog.filter((plant) =>
    filter === "collected" ? discovered.has(plant.id) : !discovered.has(plant.id),
  );
}

export function getPlantJournalSpreadCount(
  discoveredPlantIds: string[],
  filter: PlantFilter,
  pendingPlantGiftIds: string[] = [],
): number {
  const plantCount = getPlantFilterResults(discoveredPlantIds, filter, pendingPlantGiftIds).length;
  const spreadsNeeded = Math.ceil(plantCount / 8);

  return Math.max(2, spreadsNeeded);
}

export function getPlantJournalSpread(
  discoveredPlantIds: string[],
  filter: PlantFilter,
  spreadIndex: number,
  pendingPlantGiftIds: string[] = [],
) {
  const plants = getPlantFilterResults(discoveredPlantIds, filter, pendingPlantGiftIds);
  const spreadCount = getPlantJournalSpreadCount(discoveredPlantIds, filter, pendingPlantGiftIds);
  const currentSpread = Math.max(0, Math.min(spreadIndex, spreadCount - 1));

  const plantsPerSpread = 8;
  const plantsPerPage = 4;
  const start = currentSpread * plantsPerSpread;
  return {
    leftPlants: plants.slice(start, start + plantsPerPage),
    rightPlants: plants.slice(start + plantsPerPage, start + plantsPerSpread),
    currentSpread,
    spreadCount,
  };
}

/**
 * One page of the journal, for screens too narrow for a two-page spread. Pages hold the same plants as
 * the spread's pages do (page 1 is the first spread's left page, page 2 its right page, and so on), but
 * only pages with plants are counted, so a short filter never pages through empty ones. At least one page.
 */
export function getPlantJournalPage(
  discoveredPlantIds: string[],
  filter: PlantFilter,
  pageIndex: number,
  pendingPlantGiftIds: string[] = [],
) {
  const plants = getPlantFilterResults(discoveredPlantIds, filter, pendingPlantGiftIds);
  const plantsPerPage = 4;
  const pageCount = Math.max(1, Math.ceil(plants.length / plantsPerPage));
  const currentPage = Math.max(0, Math.min(Math.trunc(pageIndex) || 0, pageCount - 1));
  const start = currentPage * plantsPerPage;
  return {
    plants: plants.slice(start, start + plantsPerPage),
    currentPage,
    pageCount,
    pageNumber: currentPage + 1,
  };
}

export function getNextPlantProgress(totalXp: number, discoveredPlantIds: string[], pendingPlantGiftIds: string[]) {
  const discovered = new Set(discoveredPlantIds);
  const pending = new Set(pendingPlantGiftIds);
  const plant = plantCatalog.find((item) => item.id !== "fern" && !discovered.has(item.id) && !pending.has(item.id));
  if (!plant) return undefined;

  return { plant, ...getPlantThresholdProgress(plant, totalXp) };
}

export type PlantCollectionStatus = "in-progress" | "gifts-waiting" | "complete";

export function getPlantCollectionStatus(
  totalXp: number,
  discoveredPlantIds: string[],
  pendingPlantGiftIds: string[],
): PlantCollectionStatus {
  if (getNextPlantProgress(totalXp, discoveredPlantIds, pendingPlantGiftIds)) return "in-progress";
  return pendingPlantGiftIds.length > 0 ? "gifts-waiting" : "complete";
}

export function getWaitingGiftsLabel(giftCount: number): string {
  return giftCount === 1 ? "A gift is waiting" : `${giftCount} gifts are waiting`;
}

export function getPlantThresholdProgress(plant: Plant, totalXp: number) {
  const xpRemaining = Math.max(0, plant.xpThreshold - totalXp);
  const progressPercent = plant.xpThreshold === 0
    ? 100
    : Math.max(0, Math.min(100, (totalXp / plant.xpThreshold) * 100));
  return { xpRemaining, progressPercent };
}

export function migratePlantDiscoveries(data: StoredQuestData): StoredQuestData {
  const currentVersion = typeof data.schemaVersion === "number" && Number.isFinite(data.schemaVersion)
    ? data.schemaVersion
    : 0;
  const targetVersion = Math.max(5, currentVersion);
  const rawDiscoveries: unknown = data.discoveredPlantIds;
  const validDiscoveries = Array.isArray(rawDiscoveries)
    ? rawDiscoveries.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  // Older saves implicitly received Fern because its previous XP threshold was zero.
  // A save without this field is an existing user's save, so preserve that collection.
  const hasGiftLedger = Array.isArray(data.pendingPlantGiftIds);
  const starterPlantGiftPending = data.starterPlantGiftPending === true;
  const savedDiscoveries = new Set(validDiscoveries);
  const totalXp = getXpLedgerTotal(
    data.completionHistory,
    data.personalXpByQuestId,
    data.legacyXpBonus,
  );
  let pendingIds = Array.isArray(data.pendingPlantGiftIds)
    ? data.pendingPlantGiftIds.filter((id): id is string => typeof id === "string" && plantCatalog.some((plant) => plant.id === id))
    : [];

  if (currentVersion < 5) {
    // Before gift tracking, the original milestones (through 450 XP) were immediately
    // collected. Preserve those discoveries; expansion plants still arrive as gifts.
    for (const plant of plantCatalog) {
      if (plant.id !== "fern" && plant.xpThreshold <= 450 && totalXp >= plant.xpThreshold) {
        savedDiscoveries.add(plant.id);
      }
    }
    if (starterPlantGiftPending) {
      savedDiscoveries.delete("fern");
      pendingIds = [...new Set([...pendingIds, "fern"] )];
    } else {
      savedDiscoveries.add("fern");
    }
  } else if (starterPlantGiftPending && !hasGiftLedger) {
    // Compatibility with the first Fern-only gift schema.
    savedDiscoveries.delete("fern");
    pendingIds = [...new Set([...pendingIds, "fern"] )];
  }

  pendingIds = mergePendingPlantGiftIds(pendingIds, totalXp, [...savedDiscoveries]);
  const discoveredPlantIds = [
    ...plantCatalog.map(({ id }) => id).filter((id) => savedDiscoveries.has(id)),
    ...[...savedDiscoveries].filter((id) => !plantCatalog.some((plant) => plant.id === id)),
  ];
  const nextStarterPending = pendingIds.includes("fern");
  const discoveriesUnchanged = Array.isArray(rawDiscoveries) &&
    rawDiscoveries.length === discoveredPlantIds.length &&
    rawDiscoveries.every((id, index) => id === discoveredPlantIds[index]);

  if (
    currentVersion >= 5 &&
    targetVersion === data.schemaVersion &&
    discoveriesUnchanged &&
    data.starterPlantGiftPending === nextStarterPending &&
    Array.isArray(data.pendingPlantGiftIds) &&
    data.pendingPlantGiftIds.length === pendingIds.length &&
    data.pendingPlantGiftIds.every((id, index) => id === pendingIds[index])
  ) return data;

  return {
    ...data,
    schemaVersion: targetVersion,
    discoveredPlantIds,
    pendingPlantGiftIds: pendingIds,
    starterPlantGiftPending: nextStarterPending,
  };
}
