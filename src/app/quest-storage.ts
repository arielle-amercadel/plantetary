import type {
  CompletionHistory,
  CompletionSnapshot,
  Quest,
  StoredQuestData,
} from "./quest-types";
import {
  isCompletionDateKey,
  migrateStoredData,
  normalizeCompletionHistoryDetails,
  normalizeSavedQuestLists,
  weekdays,
} from "./quest-logic";
import { migratePlantDiscoveries } from "./plant-journal-logic";

export const questStorageKey = "plantetary-quest-data";
export const validBackupStorageKey = "plantetary-quest-data-backup-v1";
export const invalidBackupStorageKey = "plantetary-quest-data-invalid-backup";

export type QuestStorage = Pick<Storage, "getItem" | "setItem">;
/** Reading `window.localStorage` can itself throw, so storage is fetched where that failure is handled. */
export type GetQuestStorage = () => QuestStorage | undefined;

export type LoadedQuestData = {
  data: StoredQuestData;
  /** False when saving could destroy data that could not be read or backed up. */
  canPersist: boolean;
};

function getBrowserStorage(): QuestStorage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

function isCompletionHistory(value: unknown): value is CompletionHistory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([date, snapshot]) =>
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Boolean(snapshot) && typeof snapshot === "object" &&
    Array.isArray((snapshot as CompletionSnapshot).scheduledQuestIds) &&
    (snapshot as CompletionSnapshot).scheduledQuestIds.every((id) => typeof id === "string") &&
    Array.isArray((snapshot as CompletionSnapshot).completedQuestIds) &&
    (snapshot as CompletionSnapshot).completedQuestIds.every((id) => typeof id === "string"),
  );
}

function normalizePersonalCompletionDates(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  const validEntries = entries.filter(([questId, dateKey]) => questId.length > 0 && isCompletionDateKey(dateKey));
  if (validEntries.length === entries.length) return value as Record<string, string>;
  return validEntries.length > 0 ? Object.fromEntries(validEntries) : undefined;
}

function isValidDeletedLegacyPersonalCompletionCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function preserveRawValueIfAbsent(storage: QuestStorage, backupKey: string, rawValue: string): boolean {
  try {
    if (storage.getItem(backupKey) !== null) return true;
    storage.setItem(backupKey, rawValue);
    return storage.getItem(backupKey) === rawValue;
  } catch {
    return false;
  }
}

function hasValidCoreQuestFields(value: unknown): value is Quest {
  if (typeof value !== "object" || value === null) return false;

  const quest = value as Record<string, unknown>;
  return (
    typeof quest.id === "string" &&
    typeof quest.title === "string" &&
    typeof quest.category === "string" &&
    (quest.difficulty === "Easy" || quest.difficulty === "Medium" || quest.difficulty === "Hard") &&
    typeof quest.completed === "boolean" &&
    (quest.notes === undefined || typeof quest.notes === "string")
  );
}

function isPersonalQuest(value: unknown): value is Quest {
  if (!hasValidCoreQuestFields(value)) return false;

  const quest = value as unknown as Record<string, unknown>;
  return (
    (quest.schedule === undefined || typeof quest.schedule === "string") &&
    (quest.repeatSchedule === undefined ||
      quest.repeatSchedule === "Every day" || quest.repeatSchedule === "Selected days") &&
    (quest.selectedDays === undefined ||
      (Array.isArray(quest.selectedDays) && quest.selectedDays.every((day) => weekdays.includes(day))))
  );
}

function isStoredQuestData(value: unknown): value is StoredQuestData {
  if (typeof value !== "object" || value === null) return false;

  const data = value as Record<string, unknown>;
  const questLists = data.questLists as Record<string, unknown> | undefined;
  const categoryLists = data.categoryLists as Record<string, unknown> | undefined;

  return Boolean(
    questLists &&
      Array.isArray(questLists.daily) &&
      // Bad recurrence or due-date fields on a Daily Quest are recovered on load rather than rejecting the whole save.
      questLists.daily.every(hasValidCoreQuestFields) &&
      Array.isArray(questLists.personal) &&
      // A bad Personal due date is removed on load rather than rejecting the whole save.
      questLists.personal.every(isPersonalQuest) &&
      categoryLists &&
      Array.isArray(categoryLists.daily) &&
      categoryLists.daily.every((category) => typeof category === "string") &&
      Array.isArray(categoryLists.personal) &&
      categoryLists.personal.every((category) => typeof category === "string"),
  );
}

/**
 * Reads the save and upgrades it to the current format. The original text is backed up before
 * anything would replace it; if that backup fails, `canPersist` is false so it is never overwritten.
 */
export function loadQuestData(
  fallbackData: StoredQuestData,
  getStorage: GetQuestStorage = getBrowserStorage,
): LoadedQuestData {
  let canPersist = true;
  let restoredData = fallbackData;

  try {
    const storage = getStorage();
    if (storage) {
      const rawData = storage.getItem(questStorageKey);
      if (rawData !== null) {
        let parsedData: unknown;
        try {
          parsedData = JSON.parse(rawData);
        } catch {
          parsedData = undefined;
        }

        if (isStoredQuestData(parsedData)) {
          const validHistory = parsedData.completionHistory === undefined ||
            isCompletionHistory(parsedData.completionHistory);
          const normalizedCompletionHistory = validHistory && parsedData.completionHistory
            ? normalizeCompletionHistoryDetails(parsedData.completionHistory)
            : parsedData.completionHistory;
          const validPersonalCompletionDates = normalizePersonalCompletionDates(
            parsedData.personalCompletedOnByQuestId,
          );
          const validDeletedLegacyCount = parsedData.deletedLegacyPersonalCompletionCount === undefined ||
            isValidDeletedLegacyPersonalCompletionCount(parsedData.deletedLegacyPersonalCompletionCount)
            ? parsedData.deletedLegacyPersonalCompletionCount
            : undefined;
          const validQuestLists = normalizeSavedQuestLists(parsedData.questLists);
          const optionalFieldsUnchanged =
            validQuestLists === parsedData.questLists &&
            normalizedCompletionHistory === parsedData.completionHistory &&
            validPersonalCompletionDates === parsedData.personalCompletedOnByQuestId &&
            validDeletedLegacyCount === parsedData.deletedLegacyPersonalCompletionCount;
          const validatedData: StoredQuestData = validHistory && optionalFieldsUnchanged
            ? parsedData
            : {
              ...parsedData,
              questLists: validQuestLists,
              completionHistory: validHistory ? normalizedCompletionHistory : undefined,
              personalCompletedOnByQuestId: validPersonalCompletionDates,
              deletedLegacyPersonalCompletionCount: validDeletedLegacyCount,
            };
          const migratedData = migratePlantDiscoveries(migrateStoredData(validatedData));
          if (
            (migratedData !== validatedData || validatedData !== parsedData) &&
            !preserveRawValueIfAbsent(storage, validBackupStorageKey, rawData)
          ) {
            canPersist = false;
            console.error("Plantetary could not back up saved data before migrating it. Changes will not be saved this session.");
          }
          restoredData = migratedData;
        } else if (!preserveRawValueIfAbsent(storage, invalidBackupStorageKey, rawData)) {
          canPersist = false;
          console.error("Plantetary could not back up invalid saved data. Defaults will not overwrite it this session.");
        }
      }
    }
  } catch {
    canPersist = false;
    console.error("Plantetary could not safely access saved data. Changes will not be saved this session.");
  }

  return { data: restoredData, canPersist };
}

/** Writes the whole save, returning false rather than throwing if the browser refuses it. */
export function saveQuestData(
  data: StoredQuestData,
  getStorage: GetQuestStorage = getBrowserStorage,
): boolean {
  try {
    const storage = getStorage();
    if (!storage) return false;
    storage.setItem(questStorageKey, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}
