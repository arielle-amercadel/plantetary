import { initialStoredQuestData } from "./quest-defaults";
import { getXpLedgerTotal, isCompletionDateKey, scheduledDaysForQuest } from "./quest-logic";
import { plantCatalog } from "./plant-journal-logic";
import { latestQuestSaveVersion, questStorageKey, readQuestSave } from "./quest-storage";
import type { Quest, QuestListKey, StoredQuestData } from "./quest-types";

/** No write capability is needed or used, including for legacy/invalid saves. */
export type BrowserSaveReader = () => Pick<Storage, "getItem"> | null | undefined;

export type BrowserGardenSummary = {
  level: number;
  totalXp: number;
  quests: { daily: number; personal: number; total: number };
  plants: { discovered: number; pendingGifts: number };
  /** Latest recorded completion date, not an edit timestamp. Null when dates are unknown. */
  lastActivityDate: string | null;
};

export type BrowserSavePreview =
  | { status: "empty" | "unavailable" | "invalid" | "unsupported-version" | "failed" }
  | { status: "newer-version"; schemaVersion: number }
  | {
    status: "ready";
    /** Exact original bytes, retained separately from the in-memory migration. */
    rawText: string;
    data: StoredQuestData;
    upgraded: boolean;
    summary: BrowserGardenSummary;
    hasMeaningfulProgress: boolean;
  };

function questSignature(quest: Quest, list: QuestListKey): string {
  return JSON.stringify([
    quest.id, quest.title, quest.category, quest.difficulty, quest.completed,
    // Compare the effective schedule: older saves can express the same starter recurrence in
    // different ways. Recurrence fields on Personal Quests have never scheduled them.
    list === "daily" ? [...new Set(scheduledDaysForQuest(quest))].sort() : null,
    list === "personal" ? quest.dueDate : null, quest.notes || null,
  ]);
}

function customized(data: StoredQuestData): boolean {
  return (["daily", "personal"] as const).some((list) => {
    const quests = data.questLists[list].map((quest) => questSignature(quest, list)).sort();
    const starter = initialStoredQuestData.questLists[list].map((quest) => questSignature(quest, list)).sort();
    return JSON.stringify(quests) !== JSON.stringify(starter) ||
      JSON.stringify([...data.categoryLists[list]].sort()) !==
      JSON.stringify([...initialStoredQuestData.categoryLists[list]].sort());
  });
}

function previewLevel(totalXp: number): number {
  // Invert the sum of the game's thresholds (100, 150, 200, …) without looping over huge
  // ledgers. Correct the estimate against exact thresholds: sqrt can round a value just below
  // 100 XP up to level 2. Fractional XP is supported by the existing save format.
  let completedLevels = Math.floor((Math.sqrt(9 + 4 * (totalXp / 25)) - 3) / 2);
  // Cloud summaries may receive finite ledgers outside the browser preview's safe-integer limit.
  // At this scale +/- 1 no longer changes the estimate; never enter a non-terminating correction loop.
  if (completedLevels > Number.MAX_SAFE_INTEGER) return completedLevels;
  const threshold = (count: number) => count * (25 * count + 75);
  while (completedLevels > 0 && totalXp < threshold(completedLevels)) completedLevels -= 1;
  while (totalXp >= threshold(completedLevels + 1)) completedLevels += 1;
  return completedLevels + 1;
}

/**
 * Summarizes any garden the same way, for side-by-side comparison (for example, the cloud garden on
 * screen next to the browser garden). Reads nothing and changes nothing.
 */
export function summarizeGarden(data: StoredQuestData): BrowserGardenSummary {
  const totalXp = getXpLedgerTotal(data.completionHistory, data.personalXpByQuestId, data.legacyXpBonus);
  const safeXp = Number.isFinite(totalXp) && totalXp >= 0 ? totalXp : 0;
  const discovered = data.discoveredPlantIds ?? [];
  const catalogIds = new Set(plantCatalog.map((plant) => plant.id));
  return {
    level: previewLevel(safeXp),
    totalXp: safeXp,
    quests: { daily: data.questLists.daily.length, personal: data.questLists.personal.length,
      total: data.questLists.daily.length + data.questLists.personal.length },
    plants: { discovered: discovered.filter((id) => catalogIds.has(id)).length, pendingGifts: (data.pendingPlantGiftIds ?? []).length },
    lastActivityDate: lastActivity(data),
  };
}

function activeHistoryDates(data: StoredQuestData): string[] {
  return Object.entries(data.completionHistory ?? {}).filter(([, snapshot]) => snapshot.completedQuestIds.length > 0 ||
    Object.values(snapshot.xpAwardedByQuestId ?? {}).some((xp) => xp > 0)).map(([date]) => date);
}

function lastActivity(data: StoredQuestData): string | null {
  const personalDates = Object.values(data.personalCompletedOnByQuestId ?? {});
  return [...activeHistoryDates(data), ...personalDates].filter(isCompletionDateKey).sort().at(-1) ?? null;
}

/**
 * Inspects only the browser's garden key. Unlike loadQuestData, never creates backups, repairs the
 * saved value, seeds defaults, or writes migrated data. No profile/reminder keys or cloud calls.
 */
export function inspectBrowserGarden(
  getStorage: BrowserSaveReader = () => typeof window === "undefined" ? null : window.localStorage,
): BrowserSavePreview {
  let rawText: string | null;
  try {
    const storage = getStorage();
    if (!storage) return { status: "unavailable" };
    rawText = storage.getItem(questStorageKey);
  } catch {
    return { status: "unavailable" };
  }
  if (rawText === null) return { status: "empty" };
  let value: unknown;
  try {
    value = JSON.parse(rawText);
  } catch {
    return { status: "invalid" };
  }
  // Check before interpreting or migrating a format this app doesn't understand. Missing/zero
  // versions are supported legacy saves; malformed version tags must not masquerade as legacy.
  const version: unknown = value && typeof value === "object" ? (value as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (version !== undefined) {
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) return { status: "unsupported-version" };
    if (version > latestQuestSaveVersion) return { status: "newer-version", schemaVersion: version };
  }
  try {
    const save = readQuestSave(value);
    if (save.status === "invalid") return { status: "invalid" };
    const { data } = save;
    const totalXp = getXpLedgerTotal(data.completionHistory, data.personalXpByQuestId, data.legacyXpBonus);
    if (!Number.isFinite(totalXp) || totalXp < 0 || totalXp > Number.MAX_SAFE_INTEGER) return { status: "invalid" };
    const activeDates = activeHistoryDates(data);
    const personalDates = Object.values(data.personalCompletedOnByQuestId ?? {});
    const discovered = data.discoveredPlantIds ?? [];
    const pending = data.pendingPlantGiftIds ?? [];
    const hasMeaningfulProgress = totalXp > 0 || activeDates.length > 0 || personalDates.length > 0 ||
      (data.deletedLegacyPersonalCompletionCount ?? 0) > 0 ||
      discovered.some((id) => id !== "fern") || pending.some((id) => id !== "fern") ||
      // A prior visit can already have persisted the legacy migration's automatic Fern as version 5.
      // It is indistinguishable from a manually opened free Fern, so neither alone qualifies.
      customized(data);
    // Unknown discoveries stay in data for preservation, but aren't counted as plants in the summary.
    return { status: "ready", rawText, data, upgraded: save.upgraded, hasMeaningfulProgress, summary: summarizeGarden(data) };
  } catch {
    // An unexpected validator/migration failure is not permission to replace the original.
    return { status: "failed" };
  }
}
