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

export const browserResetStorageKey = "plantetary-browser-reset";
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
  problem?: "backup-failed" | "storage";
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

/** The save format this version of Plantetary writes: what the upgrades below produce for any save. */
export const latestQuestSaveVersion = migratePlantDiscoveries(migrateStoredData({
  questLists: { daily: [], personal: [] },
  categoryLists: { daily: [], personal: [] },
})).schemaVersion ?? 0;

/**
 * - `valid`: the save can be played. `data` is in the current format.
 *   - `upgraded`: `data` differs from what was stored (an older format, or bad fields were recovered),
 *     so the stored original should be backed up before anything replaces it.
 *   - `newerVersion`: the save's format is newer than this version of Plantetary. It is still read,
 *     and its version number is kept, as browser storage always has.
 * - `invalid`: not a save this app can use. It must be kept, never replaced by defaults unseen.
 */
export type QuestSaveReadResult =
  | { status: "valid"; data: StoredQuestData; upgraded: boolean; newerVersion: boolean }
  | { status: "invalid" };

/**
 * Validates a save and upgrades it to the current format, without reading or writing any storage, so
 * browser and cloud saves follow exactly the same rules. The value given is never modified.
 *
 * It only throws because of a bug. Callers must treat that as a failed load, never as an invalid save,
 * so a save that couldn't be checked is never replaced.
 */
export function readQuestSave(value: unknown): QuestSaveReadResult {
  if (!isStoredQuestData(value)) return { status: "invalid" };

  const validHistory = value.completionHistory === undefined ||
    isCompletionHistory(value.completionHistory);
  const normalizedCompletionHistory = validHistory && value.completionHistory
    ? normalizeCompletionHistoryDetails(value.completionHistory)
    : value.completionHistory;
  const validPersonalCompletionDates = normalizePersonalCompletionDates(
    value.personalCompletedOnByQuestId,
  );
  const validDeletedLegacyCount = value.deletedLegacyPersonalCompletionCount === undefined ||
    isValidDeletedLegacyPersonalCompletionCount(value.deletedLegacyPersonalCompletionCount)
    ? value.deletedLegacyPersonalCompletionCount
    : undefined;
  const validQuestLists = normalizeSavedQuestLists(value.questLists);
  const optionalFieldsUnchanged =
    validQuestLists === value.questLists &&
    normalizedCompletionHistory === value.completionHistory &&
    validPersonalCompletionDates === value.personalCompletedOnByQuestId &&
    validDeletedLegacyCount === value.deletedLegacyPersonalCompletionCount;
  const validatedData: StoredQuestData = validHistory && optionalFieldsUnchanged
    ? value
    : {
      ...value,
      questLists: validQuestLists,
      completionHistory: validHistory ? normalizedCompletionHistory : undefined,
      personalCompletedOnByQuestId: validPersonalCompletionDates,
      deletedLegacyPersonalCompletionCount: validDeletedLegacyCount,
    };
  const migratedData = migratePlantDiscoveries(migrateStoredData(validatedData));

  return {
    status: "valid",
    data: migratedData,
    upgraded: migratedData !== validatedData || validatedData !== value,
    newerVersion: typeof value.schemaVersion === "number" && value.schemaVersion > latestQuestSaveVersion,
  };
}

/** `readQuestSave` for saved text. Text that isn't JSON is an invalid save. */
export function readQuestSaveText(text: string): QuestSaveReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "invalid" };
  }
  return readQuestSave(parsed);
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
  let problem: LoadedQuestData["problem"];
  let restoredData = fallbackData;

  try {
    const storage = getStorage();
    if (storage) {
      const rawData = storage.getItem(questStorageKey);
      if (rawData !== null) {
        const save = readQuestSaveText(rawData);
        if (save.status === "valid") {
          if (save.upgraded && !preserveRawValueIfAbsent(storage, validBackupStorageKey, rawData)) {
            canPersist = false;
            problem = "backup-failed";
            console.error("Plantetary could not back up saved data before migrating it. Changes will not be saved this session.");
          }
          restoredData = save.data;
        } else if (!preserveRawValueIfAbsent(storage, invalidBackupStorageKey, rawData)) {
          canPersist = false;
          problem = "backup-failed";
          console.error("Plantetary could not back up invalid saved data. Defaults will not overwrite it this session.");
        }
      }
    }
  } catch {
    canPersist = false;
    problem = "storage";
    console.error("Plantetary could not safely access saved data. Changes will not be saved this session.");
  }

  return { data: restoredData, canPersist, ...(problem ? { problem } : {}) };
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
