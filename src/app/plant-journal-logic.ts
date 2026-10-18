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
  { id: "sunflower", name: "Sunflower", xpThreshold: 100 },
  { id: "lavender", name: "Lavender", xpThreshold: 150, imageSrc: "/plant-lavender.png" },
  { id: "monstera", name: "Monstera", xpThreshold: 225 },
  { id: "moonflower", name: "Moonflower", xpThreshold: 325 },
  { id: "golden-bonsai", name: "Golden Bonsai", xpThreshold: 450 },
];

export function getQualifiedPlantIds(totalXp: number): string[] {
  return plantCatalog
    .filter((plant) => totalXp >= plant.xpThreshold)
    .map((plant) => plant.id);
}

export function mergeDiscoveredPlantIds(
  discoveredPlantIds: string[] | undefined,
  totalXp: number,
): string[] {
  const discovered = new Set(discoveredPlantIds ?? []);
  for (const plantId of getQualifiedPlantIds(totalXp)) discovered.add(plantId);
  const ids = [...discovered];
  return discoveredPlantIds && ids.length === discoveredPlantIds.length &&
    ids.every((id, index) => id === discoveredPlantIds[index])
    ? discoveredPlantIds
    : ids;
}

export function getPlantFilterResults(
  discoveredPlantIds: string[],
  filter: PlantFilter,
): Plant[] {
  if (filter === "all") return plantCatalog;
  const discovered = new Set(discoveredPlantIds);
  return plantCatalog.filter((plant) =>
    filter === "collected" ? discovered.has(plant.id) : !discovered.has(plant.id),
  );
}

export function getPlantJournalSpreadCount(
  discoveredPlantIds: string[],
  filter: PlantFilter,
): number {
  const plantCount = getPlantFilterResults(discoveredPlantIds, filter).length;
  const spreadsNeeded = Math.ceil(plantCount / 8);

  return Math.max(2, spreadsNeeded);
}

export function getPlantJournalSpread(
  discoveredPlantIds: string[],
  filter: PlantFilter,
  spreadIndex: number,
) {
  const plants = getPlantFilterResults(discoveredPlantIds, filter);
  const spreadCount = getPlantJournalSpreadCount(discoveredPlantIds, filter);
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

export function getNextPlantProgress(totalXp: number, discoveredPlantIds: string[]) {
  const discovered = new Set(discoveredPlantIds);
  const plant = plantCatalog.find((item) => !discovered.has(item.id));
  if (!plant) return undefined;

  return { plant, ...getPlantThresholdProgress(plant, totalXp) };
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
  const targetVersion = Math.max(3, currentVersion);
  const rawDiscoveries: unknown = data.discoveredPlantIds;
  const validDiscoveries = Array.isArray(rawDiscoveries)
    ? rawDiscoveries.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const totalXp = getXpLedgerTotal(
    data.completionHistory,
    data.personalXpByQuestId,
    data.legacyXpBonus,
  );
  const discoveredPlantIds = mergeDiscoveredPlantIds(validDiscoveries, totalXp);
  const discoveriesUnchanged = Array.isArray(rawDiscoveries) &&
    rawDiscoveries.length === discoveredPlantIds.length &&
    rawDiscoveries.every((id, index) => id === discoveredPlantIds[index]);

  if (
    currentVersion >= 3 &&
    targetVersion === data.schemaVersion &&
    discoveriesUnchanged
  ) return data;

  return { ...data, schemaVersion: targetVersion, discoveredPlantIds };
}
