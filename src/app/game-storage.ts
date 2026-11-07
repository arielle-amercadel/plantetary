import type { StoredQuestData } from "./quest-types";
import { inspectBrowserGarden, type BrowserSavePreview } from "./browser-save-preview";
import {
  questStorageKey,
  loadQuestData,
  saveQuestData,
  type GetQuestStorage,
  type QuestStorage,
} from "./quest-storage";

/**
 * Where the game save lives: this browser (`createBrowserGameStorage`) or the player's account
 * (`createCloudGameStorage` in cloud-game-storage.ts). Every call is asynchronous, so the store doesn't
 * need to know which.
 */
export type GameStorage = {
  load: (fallbackData: StoredQuestData) => Promise<GameStorageLoadResult>;
  /** Resolves with what happened, rather than rejecting, when the save could not be written. */
  save: (data: StoredQuestData) => Promise<GameSaveResult>;
};

/**
 * Why storage couldn't be used. Only some come from each kind of storage.
 *
 * - `storage`: the browser refused to store the save (for example, it's full or blocked).
 * - `network`: the server couldn't be reached. Trying again later may work.
 * - `server`: the server failed or was too busy. Trying again later may work.
 * - `signed-out`: the server no longer accepts this sign-in (for example, it expired).
 * - `denied`: the database's access rules refused the request.
 * - `too-large`: the save is larger than storage accepts (10 MB in the cloud).
 * - `rejected`: the database refused this data for another reason (a check it failed).
 * - `identity-changed`: the signed-in account is no longer the one this storage belongs to.
 * - `invalid-save`: the stored save isn't one this app can use. It's kept, never replaced.
 * - `newer-version`: the stored save was made by a newer version of Plantetary. It's shown, never replaced.
 * - `backup-failed`: an older save couldn't be backed up before its upgrade, so it's never replaced.
 * - `not-loaded`: a save was attempted before a successful load, so nothing was written blindly.
 * - `server-outdated`: the database doesn't have a function this needs yet (for example, a migration that
 *   hasn't been applied). The server refused the call before running anything, so nothing was written.
 * - `unknown`: anything else.
 */
export type GameStorageProblem =
  | "storage"
  | "network"
  | "server"
  | "signed-out"
  | "denied"
  | "too-large"
  | "rejected"
  | "identity-changed"
  | "invalid-save"
  | "newer-version"
  | "backup-failed"
  | "not-loaded"
  | "server-outdated"
  | "unknown";

export type GameStorageLoadResult =
  | {
    status: "ready";
    data: StoredQuestData;
    /** The exact text in storage when it was read, or null if there was no save yet. */
    storedText: string | null;
  }
  | {
    /**
     * Cloud storage only: this account has no save yet. Nothing is created until the player chooses to
     * start one; until then the session treats this like a failed load, so nothing is written.
     */
    status: "empty";
    data: StoredQuestData;
  }
  | {
    /** Storage could not be read, or the save could not be backed up before it was upgraded. */
    status: "failed";
    /** What to show this session. It must never be saved, because a real save may be underneath. */
    data: StoredQuestData;
    /** Why, when the adapter knows. */
    problem?: GameStorageProblem;
  };

/**
 * - `saved`: storage now holds this data.
 * - `failed`: nothing was written. Storage still holds what it held before, so trying again is safe.
 * - `conflict`: storage was changed somewhere else (another tab or device) since it was loaded. Nothing
 *   was overwritten, and nothing will be: every later save reports the same conflict until the save is
 *   loaded again. `backup` says whether this unsaved data was kept as a backup copy; when it's `failed`,
 *   it exists only on this screen.
 */
export type GameSaveResult =
  | { status: "saved" }
  | { status: "failed"; problem: GameStorageProblem }
  | { status: "conflict"; backup: "saved" | "failed" };

export type StorageStatus = "loading" | "ready" | "failed";

function getBrowserStorage(): QuestStorage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/** Keeps the existing `localStorage` keys and save format, so current browser saves load unchanged. */
export type BrowserGameStorage = GameStorage & {
  /** Read-only preview: never runs the browser loader's backup/persistence path. */
  inspect: () => Promise<BrowserSavePreview>;
};

export function createBrowserGameStorage(getStorage: GetQuestStorage = getBrowserStorage): BrowserGameStorage {
  return {
    async inspect() {
      return inspectBrowserGarden(getStorage);
    },
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
      return saveQuestData(data, getStorage) ? { status: "saved" } : { status: "failed", problem: "storage" };
    },
  };
}
