import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStreakValues, getXpLedgerTotal } from "../src/app/quest-logic";
import {
  invalidBackupStorageKey,
  loadQuestData,
  questStorageKey,
  saveQuestData,
  validBackupStorageKey,
} from "../src/app/quest-storage";
import type { QuestStorage } from "../src/app/quest-storage";
import type { Quest, StoredQuestData } from "../src/app/quest-types";
import { resetPlantetaryStorage } from "../src/app/settings-logic";

type FakeStorage = QuestStorage & {
  values: Map<string, string>;
  removeItem: (key: string) => void;
};

function createStorage(
  initialValues: Record<string, string> = {},
  failingWrites: (key: string) => boolean = () => false,
): FakeStorage {
  const values = new Map(Object.entries(initialValues));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (failingWrites(key)) throw new Error("Storage is full");
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

const dailyQuest: Quest = {
  id: "water",
  title: "Drink a glass of water",
  category: "Wellness",
  repeatSchedule: "Every day",
  selectedDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  difficulty: "Easy",
  completed: false,
};

const personalQuest: Quest = {
  id: "biology",
  title: "Review biology notes",
  category: "Study",
  dueDate: "2026-12-01",
  notes: "Chapters 1 to 3",
  difficulty: "Hard",
  completed: true,
};

const fallbackData: StoredQuestData = {
  schemaVersion: 5,
  questLists: { daily: [], personal: [] },
  categoryLists: { daily: ["Fallback"], personal: [] },
};

/** A save from before XP and plants were tracked: old enough that loading must upgrade it. */
const legacySave = {
  questLists: { daily: [dailyQuest], personal: [personalQuest] },
  categoryLists: { daily: ["Wellness"], personal: ["Study"] },
};

/** A save in the current format, with every kind of progress the app keeps. */
function createCurrentSave(): StoredQuestData {
  return {
    schemaVersion: 5,
    questLists: { daily: [dailyQuest], personal: [personalQuest] },
    categoryLists: { daily: ["Wellness", "Custom"], personal: ["Study"] },
    completionHistory: {
      "2026-11-02": {
        scheduledQuestIds: ["water"],
        completedQuestIds: ["water"],
        xpAwardedByQuestId: { water: 5 },
      },
      "2026-11-03": {
        scheduledQuestIds: ["water"],
        completedQuestIds: ["water"],
        xpAwardedByQuestId: { water: 5 },
      },
      "2026-11-04": { scheduledQuestIds: ["water"], completedQuestIds: [] },
    },
    personalXpByQuestId: { biology: 20 },
    personalCompletedOnByQuestId: { biology: "2026-11-03" },
    deletedLegacyPersonalCompletionCount: 2,
    legacyXpBonus: 15,
    discoveredPlantIds: ["fern"],
    // Daisy unlocks at 25 XP and this save has 45, so a correct save has her gift waiting.
    pendingPlantGiftIds: ["daisy"],
    starterPlantGiftPending: false,
  };
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("loadQuestData when nothing can be restored", () => {
  it("returns the fallback and writes nothing for a first-time visitor", () => {
    const storage = createStorage();

    const result = loadQuestData(fallbackData, () => storage);

    expect(result.data).toBe(fallbackData);
    expect(result.canPersist).toBe(true);
    expect(storage.values.size).toBe(0);
  });

  it("returns the fallback when no storage exists, as on the server", () => {
    const result = loadQuestData(fallbackData, () => undefined);

    expect(result).toEqual({ data: fallbackData, canPersist: true });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("blocks saving when the browser refuses access to storage", () => {
    const result = loadQuestData(fallbackData, () => {
      throw new Error("Access denied");
    });

    expect(result.data).toBe(fallbackData);
    expect(result.canPersist).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      "Plantetary could not safely access saved data. Changes will not be saved this session.",
    );
  });

  it("blocks saving when reading the save fails", () => {
    const storage = createStorage();
    storage.getItem = () => {
      throw new Error("Read failed");
    };

    const result = loadQuestData(fallbackData, () => storage);

    expect(result.data).toBe(fallbackData);
    expect(result.canPersist).toBe(false);
  });
});

describe("loadQuestData with a current save", () => {
  it("restores all progress without changing it or making a backup", () => {
    const save = createCurrentSave();
    const raw = JSON.stringify(save);
    const storage = createStorage({ [questStorageKey]: raw });

    const result = loadQuestData(fallbackData, () => storage);

    expect(result.data).toEqual(save);
    expect(result.canPersist).toBe(true);
    expect(storage.values.get(questStorageKey)).toBe(raw);
    expect(storage.values.has(validBackupStorageKey)).toBe(false);
    expect(storage.values.has(invalidBackupStorageKey)).toBe(false);
  });

  it("keeps the XP total and streaks that are calculated from the save", () => {
    const storage = createStorage({ [questStorageKey]: JSON.stringify(createCurrentSave()) });

    const { data } = loadQuestData(fallbackData, () => storage);

    expect(getXpLedgerTotal(data.completionHistory, data.personalXpByQuestId, data.legacyXpBonus)).toBe(45);
    expect(getStreakValues(data.completionHistory ?? {}, "2026-11-04")).toEqual({
      currentStreak: 2,
      longestStreak: 2,
    });
  });
});

describe("loadQuestData with an old save", () => {
  it("upgrades it, keeps its XP, and backs up the original text", () => {
    const raw = JSON.stringify(legacySave);
    const storage = createStorage({ [questStorageKey]: raw });

    const result = loadQuestData(fallbackData, () => storage);

    expect(result.canPersist).toBe(true);
    expect(result.data.schemaVersion).toBe(5);
    expect(result.data.questLists.personal[0]).toMatchObject({ id: "biology", completed: true });
    expect(result.data.personalXpByQuestId).toEqual({ biology: 20 });
    expect(result.data.discoveredPlantIds).toContain("fern");
    expect(storage.values.get(validBackupStorageKey)).toBe(raw);
    expect(storage.values.get(questStorageKey)).toBe(raw);
  });

  it("does not replace the first backup on later upgrades", () => {
    const storage = createStorage({
      [questStorageKey]: JSON.stringify(legacySave),
      [validBackupStorageKey]: "earliest backup",
    });

    const result = loadQuestData(fallbackData, () => storage);

    expect(result.canPersist).toBe(true);
    expect(storage.values.get(validBackupStorageKey)).toBe("earliest backup");
  });

  it("shows the upgraded data but blocks saving when the backup fails", () => {
    const raw = JSON.stringify(legacySave);
    const storage = createStorage({ [questStorageKey]: raw }, (key) => key === validBackupStorageKey);

    const result = loadQuestData(fallbackData, () => storage);

    expect(result.canPersist).toBe(false);
    expect(result.data.personalXpByQuestId).toEqual({ biology: 20 });
    expect(storage.values.get(questStorageKey)).toBe(raw);
    expect(consoleError).toHaveBeenCalledWith(
      "Plantetary could not back up saved data before migrating it. Changes will not be saved this session.",
    );
  });

  it("blocks saving when a backup write appears to work but does not stick", () => {
    const storage = createStorage({ [questStorageKey]: JSON.stringify(legacySave) });
    const setItem = storage.setItem;
    storage.setItem = (key, value) => setItem(key, key === validBackupStorageKey ? "truncated" : value);

    expect(loadQuestData(fallbackData, () => storage).canPersist).toBe(false);
  });

  it("gives the same result when its upgraded form is saved and loaded again", () => {
    const storage = createStorage({ [questStorageKey]: JSON.stringify(legacySave) });
    const upgraded = loadQuestData(fallbackData, () => storage).data;
    saveQuestData(upgraded, () => storage);
    storage.values.delete(validBackupStorageKey);

    const reloaded = loadQuestData(fallbackData, () => storage);

    expect(reloaded.data).toEqual(JSON.parse(JSON.stringify(upgraded)));
    expect(storage.values.has(validBackupStorageKey)).toBe(false);
  });
});

describe("loadQuestData recovering bad fields", () => {
  function loadWith(overrides: Record<string, unknown>) {
    const raw = JSON.stringify({ ...createCurrentSave(), ...overrides });
    const storage = createStorage({ [questStorageKey]: raw });
    return { raw, storage, result: loadQuestData(fallbackData, () => storage) };
  }

  it("drops malformed completion history but keeps the quests", () => {
    const { raw, storage, result } = loadWith({
      completionHistory: { "not-a-date": { scheduledQuestIds: [], completedQuestIds: [] } },
    });

    expect(result.data.completionHistory).toBeUndefined();
    expect(result.data.questLists.personal[0].id).toBe("biology");
    expect(result.canPersist).toBe(true);
    expect(storage.values.get(validBackupStorageKey)).toBe(raw);
  });

  it("removes only the invalid personal completion dates", () => {
    const { result } = loadWith({
      personalCompletedOnByQuestId: { biology: "2026-11-03", desk: "yesterday" },
    });

    expect(result.data.personalCompletedOnByQuestId).toEqual({ biology: "2026-11-03" });
  });

  it("drops an invalid deleted-quest count", () => {
    const { result } = loadWith({ deletedLegacyPersonalCompletionCount: -1 });

    expect(result.data.deletedLegacyPersonalCompletionCount).toBeUndefined();
  });

  it("removes a bad personal due date but keeps the quest", () => {
    const { raw, storage, result } = loadWith({
      questLists: { daily: [dailyQuest], personal: [{ ...personalQuest, dueDate: "Today" }] },
    });

    expect(result.data.questLists.personal[0].id).toBe("biology");
    expect(result.data.questLists.personal[0].dueDate).toBeUndefined();
    expect(storage.values.get(validBackupStorageKey)).toBe(raw);
  });

  it("leaves a daily quest with an unusable schedule unscheduled instead of rejecting the save", () => {
    const { result } = loadWith({
      questLists: {
        daily: [{ ...dailyQuest, repeatSchedule: "Sometimes", selectedDays: ["Funday"] }],
        personal: [personalQuest],
      },
    });

    expect(result.data.questLists.daily[0].id).toBe("water");
    expect(result.data.questLists.daily[0].repeatSchedule).toBe("Selected days");
    expect(result.data.questLists.daily[0].selectedDays).toEqual([]);
  });
});

describe("loadQuestData with an unusable save", () => {
  const corruptSaves: Array<[string, string]> = [
    ["text that is not JSON", "{not json"],
    ["a JSON value that is not an object", "42"],
    ["missing quest lists", JSON.stringify({ categoryLists: legacySave.categoryLists })],
    ["missing category lists", JSON.stringify({ questLists: legacySave.questLists })],
    ["a quest with an unknown difficulty", JSON.stringify({
      ...legacySave,
      questLists: { daily: [{ ...dailyQuest, difficulty: "Impossible" }], personal: [] },
    })],
    ["a personal quest with invalid weekdays", JSON.stringify({
      ...legacySave,
      questLists: { daily: [], personal: [{ ...personalQuest, selectedDays: ["Funday"] }] },
    })],
    ["a non-text category", JSON.stringify({
      ...legacySave,
      categoryLists: { daily: [1], personal: [] },
    })],
  ];

  it.each(corruptSaves)("falls back and backs up %s", (_label, raw) => {
    const storage = createStorage({ [questStorageKey]: raw });

    const result = loadQuestData(fallbackData, () => storage);

    expect(result.data).toBe(fallbackData);
    expect(result.canPersist).toBe(true);
    expect(storage.values.get(invalidBackupStorageKey)).toBe(raw);
    expect(storage.values.get(questStorageKey)).toBe(raw);
    expect(storage.values.has(validBackupStorageKey)).toBe(false);
  });

  it("does not replace an existing invalid backup", () => {
    const storage = createStorage({
      [questStorageKey]: "{not json",
      [invalidBackupStorageKey]: "earliest invalid save",
    });

    const result = loadQuestData(fallbackData, () => storage);

    expect(result.canPersist).toBe(true);
    expect(storage.values.get(invalidBackupStorageKey)).toBe("earliest invalid save");
  });

  it("blocks saving when the unusable save cannot be backed up", () => {
    const storage = createStorage({ [questStorageKey]: "{not json" }, () => true);

    const result = loadQuestData(fallbackData, () => storage);

    expect(result.data).toBe(fallbackData);
    expect(result.canPersist).toBe(false);
    expect(storage.values.get(questStorageKey)).toBe("{not json");
    expect(consoleError).toHaveBeenCalledWith(
      "Plantetary could not back up invalid saved data. Defaults will not overwrite it this session.",
    );
  });
});

describe("saveQuestData", () => {
  it("writes the whole save as JSON under the existing key", () => {
    const save = createCurrentSave();
    const storage = createStorage();

    expect(saveQuestData(save, () => storage)).toBe(true);
    expect(storage.values.get(questStorageKey)).toBe(JSON.stringify(save));
    expect(storage.values.size).toBe(1);
  });

  it("round-trips every field through load", () => {
    const save = createCurrentSave();
    const storage = createStorage();
    saveQuestData(save, () => storage);

    expect(loadQuestData(fallbackData, () => storage).data).toEqual(save);
  });

  it("returns false instead of throwing when storage is full", () => {
    const storage = createStorage({}, () => true);

    expect(saveQuestData(createCurrentSave(), () => storage)).toBe(false);
  });

  it("returns false instead of throwing when storage is blocked or missing", () => {
    expect(saveQuestData(createCurrentSave(), () => {
      throw new Error("Access denied");
    })).toBe(false);
    expect(saveQuestData(createCurrentSave(), () => undefined)).toBe(false);
  });
});

describe("default browser storage", () => {
  it("loads from and saves to window.localStorage", () => {
    const localStorage = createStorage({ [questStorageKey]: JSON.stringify(createCurrentSave()) });
    vi.stubGlobal("window", { localStorage });

    const { data } = loadQuestData(fallbackData);
    saveQuestData({ ...data, legacyXpBonus: 99 });

    expect(data.legacyXpBonus).toBe(15);
    expect(JSON.parse(localStorage.values.get(questStorageKey) ?? "{}").legacyXpBonus).toBe(99);
  });

  it("treats a page without window as having no storage", () => {
    expect(loadQuestData(fallbackData)).toEqual({ data: fallbackData, canPersist: true });
    expect(saveQuestData(createCurrentSave())).toBe(false);
  });
});

describe("storage keys", () => {
  it("are all cleared by the Settings reset", () => {
    const storage = createStorage({
      [questStorageKey]: "save",
      [validBackupStorageKey]: "backup",
      [invalidBackupStorageKey]: "invalid backup",
    });

    expect(resetPlantetaryStorage(storage, true)).toBe(true);
    expect(storage.values.size).toBe(0);
  });
});
