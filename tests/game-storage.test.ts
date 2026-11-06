import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import legacyFixture from "../e2e/fixtures/main-legacy-save.json";
import { createGameDataSession } from "../src/app/game-data-session";
import { createBrowserGameStorage, type GameStorage, type GameStorageLoadResult } from "../src/app/game-storage";
import { getCompletedOverallCounts, getLevelProgress, getStreakValues, getXpLedgerTotal } from "../src/app/quest-logic";
import {
  invalidBackupStorageKey,
  loadQuestData,
  questStorageKey,
  validBackupStorageKey,
  type QuestStorage,
} from "../src/app/quest-storage";
import type { StoredQuestData } from "../src/app/quest-types";

type FakeStorage = QuestStorage & { values: Map<string, string>; writes: string[] };

function createStorage(
  initialValues: Record<string, string> = {},
  failingWrites: (key: string) => boolean = () => false,
): FakeStorage {
  const values = new Map(Object.entries(initialValues));
  const writes: string[] = [];
  return {
    values,
    writes,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (failingWrites(key)) throw new Error("Storage is full");
      writes.push(key);
      values.set(key, value);
    },
  };
}

const fallbackData: StoredQuestData = {
  schemaVersion: 5,
  questLists: { daily: [], personal: [] },
  categoryLists: { daily: ["Fallback"], personal: [] },
};

/**
 * A save in the current format, so loading it needs no upgrade. It is the real old save after the
 * existing loader has upgraded it, which is exactly what the app writes back.
 */
function createCurrentSave(): StoredQuestData {
  const legacyStorage = createStorage({ [questStorageKey]: JSON.stringify(legacyFixture.save) });
  return JSON.parse(JSON.stringify(loadQuestData(fallbackData, () => legacyStorage).data));
}

/** A storage adapter whose load and save finish only when the test says so. */
function createControlledStorage() {
  const saves: StoredQuestData[] = [];
  const pendingSaves: Array<(saved: boolean) => void> = [];
  let finishLoad: (result: GameStorageLoadResult) => void = () => {};
  let failLoad: (error: Error) => void = () => {};
  const storage: GameStorage = {
    load: vi.fn(() => new Promise<GameStorageLoadResult>((resolve, reject) => {
      finishLoad = resolve;
      failLoad = reject;
    })),
    save: vi.fn((data: StoredQuestData) => {
      saves.push(data);
      return new Promise<boolean>((resolve) => pendingSaves.push(resolve));
    }),
  };
  return {
    storage,
    saves,
    finishLoad: (result: GameStorageLoadResult) => finishLoad(result),
    failLoad: (error: Error) => failLoad(error),
    finishNextSave: async (saved = true) => {
      pendingSaves.shift()?.(saved);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function withXp(data: StoredQuestData, xp: number): StoredQuestData {
  return { ...data, legacyXpBonus: xp };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("browser game storage", () => {
  it("loads a current save exactly as stored, using the existing key", async () => {
    const savedText = JSON.stringify(createCurrentSave());
    const storage = createStorage({ [questStorageKey]: savedText });

    const result = await createBrowserGameStorage(() => storage).load(fallbackData);

    expect(result).toEqual({ status: "ready", data: createCurrentSave(), storedText: savedText });
    expect(storage.writes).toEqual([]);
  });

  it("is ready with the fallback for a first-time visitor", async () => {
    const storage = createStorage();

    const result = await createBrowserGameStorage(() => storage).load(fallbackData);

    expect(result).toEqual({ status: "ready", data: fallbackData, storedText: null });
    expect(storage.writes).toEqual([]);
  });

  it("upgrades an old save and backs up its original text first", async () => {
    const originalText = JSON.stringify(legacyFixture.save);
    const storage = createStorage({ [questStorageKey]: originalText });

    const result = await createBrowserGameStorage(() => storage).load(fallbackData);

    expect(result.status).toBe("ready");
    expect(result.data.schemaVersion).toBeGreaterThan(0);
    expect(storage.values.get(validBackupStorageKey)).toBe(originalText);
    // Loading never rewrites the save itself.
    expect(storage.values.get(questStorageKey)).toBe(originalText);
  });

  it("fails, and leaves the save alone, when an old save can't be backed up before upgrading", async () => {
    const originalText = JSON.stringify(legacyFixture.save);
    const storage = createStorage({ [questStorageKey]: originalText }, (key) => key === validBackupStorageKey);

    const result = await createBrowserGameStorage(() => storage).load(fallbackData);

    expect(result.status).toBe("failed");
    expect(storage.values.get(questStorageKey)).toBe(originalText);
  });

  it("fails when browser storage can't be opened", async () => {
    const result = await createBrowserGameStorage(() => {
      throw new Error("SecurityError");
    }).load(fallbackData);

    expect(result).toEqual({ status: "failed", data: fallbackData });
  });

  it("fails when there is no browser storage", async () => {
    const result = await createBrowserGameStorage(() => undefined).load(fallbackData);

    expect(result.status).toBe("failed");
  });

  it("keeps an unreadable save in its backup key, as before", async () => {
    const storage = createStorage({ [questStorageKey]: "{not json" });

    const result = await createBrowserGameStorage(() => storage).load(fallbackData);

    expect(result).toEqual({ status: "ready", data: fallbackData, storedText: "{not json" });
    expect(storage.values.get(invalidBackupStorageKey)).toBe("{not json");
  });

  it("fails when an unreadable save can't be backed up", async () => {
    const storage = createStorage({ [questStorageKey]: "{not json" }, (key) => key === invalidBackupStorageKey);

    const result = await createBrowserGameStorage(() => storage).load(fallbackData);

    expect(result.status).toBe("failed");
    expect(storage.values.get(questStorageKey)).toBe("{not json");
  });

  it("saves to the existing key in the existing format, and reports a refused write", async () => {
    const storage = createStorage();
    const gameStorage = createBrowserGameStorage(() => storage);

    await expect(gameStorage.save(createCurrentSave())).resolves.toBe(true);
    expect(storage.values.get(questStorageKey)).toBe(JSON.stringify(createCurrentSave()));

    const fullStorage = createStorage({}, () => true);
    await expect(createBrowserGameStorage(() => fullStorage).save(createCurrentSave())).resolves.toBe(false);
  });
});

describe("game data session: loading states and write protection", () => {
  it("starts in loading and blocks every write until loading finishes", async () => {
    const controlled = createControlledStorage();
    const session = createGameDataSession(controlled.storage);

    expect(session.status).toBe("loading");
    const loading = session.load(fallbackData);
    expect(session.requestSave(fallbackData)).toBe("blocked");
    expect(session.status).toBe("loading");

    controlled.finishLoad({ status: "ready", data: createCurrentSave(), storedText: null });
    await expect(loading).resolves.toEqual({ status: "ready", data: createCurrentSave() });
    expect(session.status).toBe("ready");
    expect(controlled.saves).toEqual([]);
  });

  it("blocks every write after a failed load, so starter data never replaces a real save", async () => {
    const storage = createStorage({ [questStorageKey]: JSON.stringify(legacyFixture.save) }, (key) => key === validBackupStorageKey);
    const session = createGameDataSession(createBrowserGameStorage(() => storage));

    const outcome = await session.load(fallbackData);

    expect(outcome.status).toBe("failed");
    expect(session.status).toBe("failed");
    expect(session.requestSave(fallbackData)).toBe("blocked");
    expect(session.requestSave(withXp(outcome.data, 999))).toBe("blocked");
    expect(storage.values.get(questStorageKey)).toBe(JSON.stringify(legacyFixture.save));
  });

  it("treats a load that throws as failed and shows the fallback", async () => {
    const controlled = createControlledStorage();
    const session = createGameDataSession(controlled.storage);

    const loading = session.load(fallbackData);
    controlled.failLoad(new Error("network down"));

    await expect(loading).resolves.toEqual({ status: "failed", data: fallbackData });
    expect(session.requestSave(fallbackData)).toBe("blocked");
    expect(controlled.storage.save).not.toHaveBeenCalled();
  });

  it("loads only once, even if asked twice as React does in development", async () => {
    const controlled = createControlledStorage();
    const session = createGameDataSession(controlled.storage);

    const first = session.load(fallbackData);
    const second = session.load(fallbackData);
    controlled.finishLoad({ status: "ready", data: fallbackData, storedText: null });

    expect(second).toBe(first);
    expect(controlled.storage.load).toHaveBeenCalledTimes(1);
  });
});

describe("game data session: unchanged saves", () => {
  it("doesn't rewrite a current save that loaded without changes", async () => {
    const storage = createStorage({ [questStorageKey]: JSON.stringify(createCurrentSave()) });
    const session = createGameDataSession(createBrowserGameStorage(() => storage));

    const { data } = await session.load(fallbackData);

    expect(session.requestSave(data)).toBe("unchanged");
    expect(session.requestSave(createCurrentSave())).toBe("unchanged");
    expect(storage.writes).toEqual([]);
  });

  it("writes a change once, then skips repeats of it", async () => {
    const storage = createStorage({ [questStorageKey]: JSON.stringify(createCurrentSave()) });
    const session = createGameDataSession(createBrowserGameStorage(() => storage));
    await session.load(fallbackData);

    expect(session.requestSave(withXp(createCurrentSave(), 10))).toBe("saving");
    await session.whenIdle();
    expect(session.requestSave(withXp(createCurrentSave(), 10))).toBe("unchanged");

    expect(storage.writes).toEqual([questStorageKey]);
    expect(storage.values.get(questStorageKey)).toBe(JSON.stringify(withXp(createCurrentSave(), 10)));
  });

  it("writes the first save for a first-time visitor, as before", async () => {
    const storage = createStorage();
    const session = createGameDataSession(createBrowserGameStorage(() => storage));
    const { data } = await session.load(fallbackData);

    expect(session.requestSave(data)).toBe("saving");
    await session.whenIdle();

    expect(storage.values.get(questStorageKey)).toBe(JSON.stringify(fallbackData));
  });

  it("writes the browser save synchronously, so a change survives an immediate reload", async () => {
    const storage = createStorage();
    const session = createGameDataSession(createBrowserGameStorage(() => storage));
    await session.load(fallbackData);

    session.requestSave(withXp(fallbackData, 5));

    // No await: the write already happened.
    expect(storage.values.get(questStorageKey)).toBe(JSON.stringify(withXp(fallbackData, 5)));
  });
});

describe("game data session: save failures and ordering", () => {
  it("keeps trying after a refused write instead of treating the data as saved", async () => {
    let refuse = true;
    const storage = createStorage({}, () => refuse);
    const session = createGameDataSession(createBrowserGameStorage(() => storage));
    await session.load(fallbackData);

    expect(session.requestSave(withXp(fallbackData, 5))).toBe("saving");
    await session.whenIdle();
    expect(console.error).toHaveBeenCalled();
    expect(storage.values.has(questStorageKey)).toBe(false);

    refuse = false;
    expect(session.requestSave(withXp(fallbackData, 5))).toBe("saving");
    await session.whenIdle();
    expect(storage.values.get(questStorageKey)).toBe(JSON.stringify(withXp(fallbackData, 5)));
  });

  it("treats a save that throws like a refused write", async () => {
    const storage: GameStorage = {
      load: async () => ({ status: "ready", data: fallbackData, storedText: null }),
      save: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const session = createGameDataSession(storage);
    await session.load(fallbackData);

    session.requestSave(withXp(fallbackData, 1));
    await session.whenIdle();
    expect(session.requestSave(withXp(fallbackData, 1))).toBe("saving");
    await session.whenIdle();

    expect(storage.save).toHaveBeenCalledTimes(2);
  });

  it("runs one save at a time and writes only the newest queued data", async () => {
    const controlled = createControlledStorage();
    const session = createGameDataSession(controlled.storage);
    const loading = session.load(fallbackData);
    controlled.finishLoad({ status: "ready", data: fallbackData, storedText: JSON.stringify(fallbackData) });
    await loading;

    expect(session.requestSave(withXp(fallbackData, 1))).toBe("saving");
    expect(session.requestSave(withXp(fallbackData, 2))).toBe("queued");
    expect(session.requestSave(withXp(fallbackData, 3))).toBe("queued");
    expect(session.requestSave(withXp(fallbackData, 3))).toBe("unchanged");
    expect(controlled.saves).toHaveLength(1);

    await controlled.finishNextSave();
    expect(controlled.saves.map((data) => data.legacyXpBonus)).toEqual([1, 3]);

    await controlled.finishNextSave();
    await session.whenIdle();
    expect(session.requestSave(withXp(fallbackData, 3))).toBe("unchanged");
  });

  it("still writes a change back to the saved data while another save is running", async () => {
    const controlled = createControlledStorage();
    const session = createGameDataSession(controlled.storage);
    const loading = session.load(fallbackData);
    controlled.finishLoad({ status: "ready", data: fallbackData, storedText: JSON.stringify(fallbackData) });
    await loading;

    session.requestSave(withXp(fallbackData, 1));
    // The player undoes the change before the first write finishes.
    expect(session.requestSave(fallbackData)).toBe("queued");

    await controlled.finishNextSave();
    await controlled.finishNextSave();
    expect(controlled.saves.map((data) => data.legacyXpBonus)).toEqual([1, undefined]);
  });

  it("retries queued data after a running save is refused", async () => {
    const controlled = createControlledStorage();
    const session = createGameDataSession(controlled.storage);
    const loading = session.load(fallbackData);
    controlled.finishLoad({ status: "ready", data: fallbackData, storedText: JSON.stringify(fallbackData) });
    await loading;

    session.requestSave(withXp(fallbackData, 1));
    session.requestSave(withXp(fallbackData, 2));
    await controlled.finishNextSave(false);

    expect(controlled.saves.map((data) => data.legacyXpBonus)).toEqual([1, 2]);
  });
});

describe("game data session: adapters that throw synchronously", () => {
  /** An adapter whose save throws before returning a promise, for the calls the test chooses. */
  function createThrowingStorage(throwOnCalls: number[]) {
    const saves: StoredQuestData[] = [];
    const storage: GameStorage = {
      load: async () => ({ status: "ready", data: fallbackData, storedText: JSON.stringify(fallbackData) }),
      // Deliberately not async: the throw happens before any promise exists.
      save: vi.fn((data: StoredQuestData) => {
        saves.push(data);
        if (throwOnCalls.includes(saves.length)) throw new Error("SecurityError");
        return Promise.resolve(true);
      }),
    };
    return { storage, saves };
  }

  // Each check below runs before whenIdle(), so a regression fails here instead of hanging.
  it("is not left stuck after a save throws synchronously", async () => {
    const { storage, saves } = createThrowingStorage([1]);
    const session = createGameDataSession(storage);
    await session.load(fallbackData);

    expect(session.requestSave(withXp(fallbackData, 1))).toBe("saving");
    expect(console.error).toHaveBeenCalled();

    // Not "queued" behind a save that already ended.
    expect(session.requestSave(withXp(fallbackData, 2))).toBe("saving");
    expect(saves.map((data) => data.legacyXpBonus)).toEqual([1, 2]);

    await session.whenIdle();
    expect(session.requestSave(withXp(fallbackData, 2))).toBe("unchanged");
  });

  it("retries the same data after a synchronous throw", async () => {
    const { storage, saves } = createThrowingStorage([1]);
    const session = createGameDataSession(storage);
    await session.load(fallbackData);

    session.requestSave(withXp(fallbackData, 1));
    expect(session.requestSave(withXp(fallbackData, 1))).toBe("saving");
    await session.whenIdle();

    expect(saves.map((data) => data.legacyXpBonus)).toEqual([1, 1]);
  });

  it("keeps going when a queued save throws synchronously", async () => {
    const { storage, saves } = createThrowingStorage([2]);
    const session = createGameDataSession(storage);
    await session.load(fallbackData);

    expect(session.requestSave(withXp(fallbackData, 1))).toBe("saving");
    expect(session.requestSave(withXp(fallbackData, 2))).toBe("queued");
    // Let the first save finish; the queued one then throws as it starts.
    await Promise.resolve();
    await Promise.resolve();
    expect(saves.map((data) => data.legacyXpBonus)).toEqual([1, 2]);

    expect(session.requestSave(withXp(fallbackData, 3))).toBe("saving");
    await session.whenIdle();
    expect(saves.map((data) => data.legacyXpBonus)).toEqual([1, 2, 3]);
    expect(session.requestSave(withXp(fallbackData, 3))).toBe("unchanged");
  });

  it("resolves whenIdle after every save throws synchronously", async () => {
    const { storage } = createThrowingStorage([1, 2, 3]);
    const session = createGameDataSession(storage);
    await session.load(fallbackData);

    session.requestSave(withXp(fallbackData, 1));
    expect(session.requestSave(withXp(fallbackData, 2))).toBe("saving");
    expect(session.requestSave(withXp(fallbackData, 3))).toBe("saving");

    await expect(session.whenIdle()).resolves.toBeUndefined();
  });
});

describe("compatibility with existing browser saves", () => {
  it("keeps all progress in a real old save through load, save and reload", async () => {
    const originalText = JSON.stringify(legacyFixture.save);
    const storage = createStorage({ [questStorageKey]: originalText });

    const firstSession = createGameDataSession(createBrowserGameStorage(() => storage));
    const first = await firstSession.load(fallbackData);
    expect(first.status).toBe("ready");
    // The upgraded save differs from the stored text, so the first save writes the new format.
    expect(firstSession.requestSave(first.data)).toBe("saving");
    await firstSession.whenIdle();

    const secondSession = createGameDataSession(createBrowserGameStorage(() => storage));
    const second = await secondSession.load(fallbackData);

    expect(second).toEqual({ status: "ready", data: first.data });
    expect(secondSession.requestSave(second.data)).toBe("unchanged");
    expect(storage.values.get(validBackupStorageKey)).toBe(originalText);

    // The same figures the app showed for this save on main before any storage work:
    // "Level 2, 30 / 150 XP, 15 quests completed (13 daily, 2 personal), 2 days current streak".
    const totalXp = getXpLedgerTotal(
      second.data.completionHistory ?? {},
      second.data.personalXpByQuestId,
      second.data.legacyXpBonus ?? 0,
    );
    expect(getLevelProgress(totalXp)).toMatchObject({ level: 2, xpIntoLevel: 30, xpForNextLevel: 150 });
    expect(getCompletedOverallCounts(
      second.data.completionHistory ?? {},
      second.data.personalCompletedOnByQuestId,
      second.data.questLists.personal,
      second.data.deletedLegacyPersonalCompletionCount,
    )).toEqual({ daily: 13, personal: 2, total: 15 });
    expect(getStreakValues(second.data.completionHistory ?? {}, "2026-10-21").currentStreak).toBe(2);
    expect(second.data.questLists).toEqual(first.data.questLists);
    expect(second.data.categoryLists).toEqual(first.data.categoryLists);
    expect(second.data.discoveredPlantIds).toEqual(first.data.discoveredPlantIds);
  });
});
