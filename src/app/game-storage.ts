import type { StoredQuestData } from "./quest-types";
import {
  questStorageKey,
  loadQuestData,
  saveQuestData,
  type GetQuestStorage,
  type QuestStorage,
} from "./quest-storage";

/**
 * Where the game save lives. Browser storage is the only adapter today; a cloud adapter can be
 * added later without changing the store, because every call is asynchronous.
 */
export type GameStorage = {
  load: (fallbackData: StoredQuestData) => Promise<GameStorageLoadResult>;
  /** Resolves false, rather than rejecting, when the save could not be written. */
  save: (data: StoredQuestData) => Promise<boolean>;
};

export type GameStorageLoadResult =
  | {
    status: "ready";
    data: StoredQuestData;
    /** The exact text in storage when it was read, or null if there was no save yet. */
    storedText: string | null;
  }
  | {
    /** Storage could not be read, or the save could not be backed up before it was upgraded. */
    status: "failed";
    /** What to show this session. It must never be saved, because a real save may be underneath. */
    data: StoredQuestData;
  };

export type StorageStatus = "loading" | "ready" | "failed";

function getBrowserStorage(): QuestStorage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/** Keeps the existing `localStorage` keys and save format, so current browser saves load unchanged. */
export function createBrowserGameStorage(getStorage: GetQuestStorage = getBrowserStorage): GameStorage {
  return {
    async load(fallbackData) {
      const { data, canPersist } = loadQuestData(fallbackData, getStorage);
      if (!canPersist) return { status: "failed", data };

      try {
        const storage = getStorage();
        if (!storage) return { status: "failed", data };
        return { status: "ready", data, storedText: storage.getItem(questStorageKey) };
      } catch {
        console.error("Plantetary could not safely access saved data. Changes will not be saved this session.");
        return { status: "failed", data };
      }
    },
    async save(data) {
      return saveQuestData(data, getStorage);
    },
  };
}
