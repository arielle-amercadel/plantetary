import legacyFixture from "../e2e/fixtures/main-legacy-save.json";
import { describe, expect, it, vi } from "vitest";
import { createBrowserGardenCoordinator, type BrowserLockManager } from "../src/app/browser-garden-coordinator";
import { createBrowserGameStorage } from "../src/app/game-storage";
import { createGameDataSession } from "../src/app/game-data-session";
import { createGameStorageController } from "../src/app/game-storage-controller";
import { initialStoredQuestData } from "../src/app/quest-defaults";
import { questStorageKey, validBackupStorageKey, invalidBackupStorageKey, latestQuestSaveVersion, browserResetStorageKey } from "../src/app/quest-storage";
import { shouldWarnBeforeLeaving } from "../src/app/storage-messages";
import { resetPlantetaryStorage } from "../src/app/settings-logic";

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** Deterministic exclusive-lock queue, including cancellation while queued. */
function lockManager() {
  let held = false;
  const queue: Array<() => void> = [];
  const drain = () => { if (!held) queue.shift()?.(); };
  return { request: (_name: string, options: LockOptions, callback: () => Promise<void>) => new Promise<void>((resolve, reject) => {
    queue.push(() => {
      if (options.signal?.aborted) { reject(new Error("aborted")); drain(); return; }
      held = true;
      void callback().then(resolve, reject).finally(() => { held = false; drain(); });
    });
    drain();
  }) } as unknown as BrowserLockManager;
}

function setup() {
  const locks = lockManager();
  const values = new Map<string, string>();
  const failures = { read: false, backup: false, garden: false };
  const storage = {
    getItem: (key: string) => {
      if (failures.read) throw new Error("Storage read blocked");
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if ((failures.backup && (key === validBackupStorageKey || key === invalidBackupStorageKey)) || (failures.garden && key === questStorageKey)) throw new Error("QuotaExceededError");
      values.set(key, value);
    },
    removeItem: (key: string) => { values.delete(key); },
  };
  function tab(supported = true) {
    const choices = new Set<string>();
    const coordinator = createBrowserGardenCoordinator(() => supported ? locks : undefined, () => storage.getItem(questStorageKey), () => storage.getItem(browserResetStorageKey));
    const controller = createGameStorageController({
      fallbackData: initialStoredQuestData,
      browserCoordinator: coordinator,
      createBrowserSession: () => createGameDataSession(createBrowserGameStorage(() => storage, {
        canWrite: coordinator.canWrite, pause: coordinator.pause, remember: coordinator.remember,
      })),
      createCloudSession: () => null,
      deviceChoices: { has: (id) => choices.has(id), add: (id) => { choices.add(id); }, remove: (id) => { choices.delete(id); } },
    });
    controller.setAuth({ status: "signed-out" });
    return { coordinator, controller };
  }
  return { tab, values, storage, failures };
}
const garden = (title: string) => ({ ...initialStoredQuestData, questLists: {
  ...initialStoredQuestData.questLists, personal: [{ id: "new", title, difficulty: "Easy" as const, category: "Home", completed: false }],
} });

describe("browser garden ownership", () => {
  it("has one editor; a follower cannot save, reset, or change preferences", async () => {
    const { tab, storage } = setup();
    const a = tab(); const b = tab(); await settle();
    expect(a.coordinator.canWrite()).toBe(true);
    expect(b.coordinator.getAccess()).toBe("follower");
    const aGeneration = a.controller.getSnapshot().generation;
    a.controller.requestSave(aGeneration, garden("Keep me")); await settle();
    const action = vi.fn(() => true);
    expect(b.controller.writeBrowserData(b.controller.getSnapshot().generation, action)).toBe(false);
    expect(b.controller.requestSave(b.controller.getSnapshot().generation, garden("Stale"))).toBe("blocked");
    expect(action).not.toHaveBeenCalled();
    expect(storage.getItem(questStorageKey)).toContain("Keep me");
    a.controller.suspend(); b.controller.suspend();
  });

  it("refreshes a follower and reloads the latest save before handoff", async () => {
    const { tab } = setup(); const a = tab(); const b = tab(); await settle();
    const staleGeneration = b.controller.getSnapshot().generation;
    a.controller.requestSave(a.controller.getSnapshot().generation, garden("Latest")); await settle();
    b.controller.browserStorageChanged(); await settle();
    expect(b.controller.getSnapshot().loaded?.data.questLists.personal[0].title).toBe("Latest");
    a.controller.suspend(); await settle();
    expect(b.coordinator.canWrite()).toBe(true);
    expect(b.controller.getSnapshot().loaded?.data.questLists.personal[0].title).toBe("Latest");
    expect(b.controller.requestSave(staleGeneration, garden("Old callback"))).toBe("blocked");
    b.controller.suspend();
  });

  it("prevents reset resurrection and rejects callbacks from before reset", async () => {
    const { tab, storage } = setup(); const a = tab(); const b = tab(); await settle();
    const generation = a.controller.getSnapshot().generation;
    a.controller.requestSave(generation, garden("Before reset")); await settle();
    expect(a.controller.writeBrowserData(generation, () => resetPlantetaryStorage(storage, true), true)).toBe(true);
    b.controller.browserStorageChanged(); await settle();
    expect(a.controller.requestSave(generation, garden("Resurrect"))).toBe("blocked");
    expect(b.controller.requestSave(b.controller.getSnapshot().generation, garden("Resurrect"))).toBe("blocked");
    a.controller.requestSave(a.controller.getSnapshot().generation, a.controller.getSnapshot().loaded!.data); await settle();
    expect(storage.getItem(questStorageKey)).not.toContain("Before reset");
    a.controller.suspend(); b.controller.suspend();
  });

  for (const failure of ["rollback-write", "rollback-read", "none"] as const) {
    it(`verifies the garden after deletion failure and ${failure}`, async () => {
      const { tab, storage, failures } = setup();
      const a = tab(); await settle();
      const generation = a.controller.getSnapshot().generation;
      const original = garden("Retain my progress");
      a.controller.requestSave(generation, original); await settle();
      const raw = storage.getItem(questStorageKey);
      const remove = storage.removeItem;
      storage.removeItem = (key) => {
        if (key === validBackupStorageKey) {
          failures.garden = failure === "rollback-write";
          failures.read = failure === "rollback-read";
          throw new Error("Deletion failed");
        }
        remove(key);
      };
      expect(a.controller.writeBrowserData(generation, () => resetPlantetaryStorage(storage, true), true)).toBe(false);
      const snapshot = a.controller.getSnapshot();
      if (failure === "none") {
        expect(storage.getItem(questStorageKey)).toBe(raw);
        expect(snapshot.save?.status).toBe("saved");
        expect(shouldWarnBeforeLeaving(snapshot)).toBe(false);
      } else {
        expect(snapshot.save?.status).toBe("conflict");
        expect(a.controller.getUnsavedData()).toEqual(original);
        expect(shouldWarnBeforeLeaving(snapshot)).toBe(true);
        expect(a.coordinator.canWrite()).toBe(false);
        expect(a.controller.getSnapshot().save?.hasUnsavedChanges).toBe(true);
      }
      a.controller.suspend();
    });
  }

  it("preserves local unsaved changes when an external writer changes storage", async () => {
    const { tab, storage } = setup(); const a = tab(); await settle();
    const generation = a.controller.getSnapshot().generation;
    a.controller.requestSave(generation, garden("Saved")); await settle();
    storage.setItem(questStorageKey, JSON.stringify(garden("External")));
    // Detect the stale baseline even if the storage notification has not arrived yet.
    a.controller.requestSave(generation, garden("Unsaved")); await settle();
    expect(a.controller.getSnapshot().save?.status).toBe("conflict");
    expect(a.controller.getUnsavedData()?.questLists.personal[0].title).toBe("Unsaved");
    expect(storage.getItem(questStorageKey)).toContain("External");
    expect(a.controller.writeBrowserData(generation, () => true)).toBe(false);
    await a.controller.reloadLatest();
    expect(a.controller.getSnapshot().loaded?.data.questLists.personal[0].title).toBe("External");
    a.controller.suspend();
  });

  it("retains recovery and blocks saving when conflict reload fails, then retries safely", async () => {
    const { tab, values, failures } = setup(); const a = tab(); await settle();
    failures.garden = true;
    a.controller.requestSave(a.controller.getSnapshot().generation, garden("Unsaved")); await settle();
    values.set(questStorageKey, JSON.stringify(garden("External")));
    a.controller.browserStorageChanged();
    failures.read = true;
    await a.controller.reloadLatest();
    expect(a.controller.getSnapshot().phase).toBe("browser-failed");
    expect(a.controller.getSnapshot().loaded).toBeNull();
    expect(a.controller.getSnapshot().save?.hasUnsavedChanges).toBe(true);
    expect(a.controller.getUnsavedData()?.questLists.personal[0].title).toBe("Unsaved");
    expect(a.controller.requestSave(a.controller.getSnapshot().generation, garden("Must not replace recovery"))).toBe("blocked");
    expect(a.controller.getUnsavedData()?.questLists.personal[0].title).toBe("Unsaved");
    expect(a.coordinator.canWrite()).toBe(false);
    failures.read = false; failures.garden = false;
    await a.controller.reloadLatest();
    expect(a.controller.getSnapshot().phase).toBe("ready");
    expect(a.controller.getSnapshot().loaded?.data.questLists.personal[0].title).toBe("External");
    expect(a.controller.getUnsavedData()).toBeNull();
    a.controller.suspend();
  });

  it("allows only the owner to explicitly reset a validated legacy save after backup quota failure", async () => {
    const { tab, storage, failures } = setup();
    const original = JSON.stringify(legacyFixture.save);
    storage.setItem(questStorageKey, original); failures.backup = true;
    const a = tab(); const b = tab(); await settle();
    const generation = a.controller.getSnapshot().generation;
    expect(a.controller.getSnapshot().loaded?.problem).toBe("backup-failed");
    expect(a.controller.writeBrowserData(generation, () => resetPlantetaryStorage(storage, false), true)).toBe(false);
    expect(storage.getItem(questStorageKey)).toBe(original);
    const followerReset = vi.fn(() => resetPlantetaryStorage(storage, true));
    expect(b.controller.writeBrowserData(b.controller.getSnapshot().generation, followerReset, true)).toBe(false);
    expect(followerReset).not.toHaveBeenCalled();
    expect(a.controller.writeBrowserData(generation, () => resetPlantetaryStorage(storage, true), true)).toBe(true);
    await settle();
    expect(storage.getItem(questStorageKey)).toBeNull();
    expect(a.controller.getSnapshot().phase).toBe("ready");
    expect(a.controller.writeBrowserData(generation, () => true, true)).toBe(false);
    a.controller.suspend(); b.controller.suspend();
  });

  it("does not reset an existing garden when its contents cannot be read", async () => {
    const { tab, storage, failures } = setup();
    const original = JSON.stringify(garden("Keep unreadable data"));
    storage.setItem(questStorageKey, original); failures.read = true;
    const a = tab(); await settle();
    const reset = vi.fn(() => resetPlantetaryStorage(storage, true));
    expect(a.controller.writeBrowserData(a.controller.getSnapshot().generation, reset, true)).toBe(false);
    expect(reset).not.toHaveBeenCalled();
    failures.read = false;
    expect(storage.getItem(questStorageKey)).toBe(original);
    a.controller.suspend();
  });

  it.each([
    ["invalid", "{not json"],
    ["newer", JSON.stringify({ ...initialStoredQuestData, schemaVersion: latestQuestSaveVersion + 1 })],
  ])("keeps reset blocked for a %s save", async (_kind, raw) => {
    const { tab, storage, failures } = setup();
    storage.setItem(questStorageKey, raw); failures.backup = true;
    const a = tab(); await settle();
    const reset = vi.fn(() => resetPlantetaryStorage(storage, true));
    expect(a.controller.writeBrowserData(a.controller.getSnapshot().generation, reset, true)).toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(storage.getItem(questStorageKey)).toBe(raw);
    a.controller.suspend();
  });

  it("changes reset identity without invalidating ordinary ownership handoff", async () => {
    const { tab, storage } = setup(); const a = tab(); const b = tab(); await settle();
    const initial = b.controller.getSnapshot().browserResetToken;
    expect(a.controller.writeBrowserData(a.controller.getSnapshot().generation, () => resetPlantetaryStorage(storage, true), true)).toBe(true);
    b.controller.browserStorageChanged(); await settle();
    const afterReset = b.controller.getSnapshot().browserResetToken;
    expect(afterReset).toBeTruthy();
    expect(afterReset).not.toBe(initial);
    a.controller.suspend(); await settle();
    expect(b.coordinator.canWrite()).toBe(true);
    expect(b.controller.getSnapshot().browserResetToken).toBe(afterReset);
    b.controller.suspend();
  });

  it("fails closed without Web Locks and never creates follower migration backups", async () => {
    const { tab, storage, values } = setup();
    storage.setItem(questStorageKey, JSON.stringify({ ...initialStoredQuestData, schemaVersion: 1 }));
    const original = storage.getItem(questStorageKey);
    const a = tab(false); await settle();
    expect(a.coordinator.getAccess()).toBe("unsupported");
    expect(a.controller.requestSave(a.controller.getSnapshot().generation, garden("No write"))).toBe("blocked");
    expect(storage.getItem(questStorageKey)).toBe(original);
    expect(values.has(validBackupStorageKey)).toBe(false);
    a.controller.suspend();
  });

  it("coordinates signed-in local-only players and releases ownership on leaving browser mode", async () => {
    const { tab } = setup(); const a = tab(); const b = tab(); await settle();
    a.controller.setAuth({ status: "signed-in", user: { id: "a", email: "a@example.com" } }); await settle();
    expect(a.controller.getSnapshot().mode).toBe("cloud");
    expect(b.coordinator.canWrite()).toBe(true);
    expect(a.controller.keepPlayingOnDevice()).toBe(true); await settle();
    expect(a.controller.getSnapshot().mode).toBe("browser");
    expect(a.coordinator.canWrite()).toBe(false);
    b.controller.suspend(); await settle();
    expect(a.coordinator.canWrite()).toBe(true);
    a.controller.useCloudGarden(); await settle();
    expect(a.coordinator.canWrite()).toBe(false);
    a.controller.suspend();
    b.controller.suspend();
  });

  it("rejects rapid follower saves while serializing the editor's newest state", async () => {
    const { tab, storage } = setup(); const a = tab(); const b = tab(); await settle();
    for (let i = 0; i < 25; i++) {
      a.controller.requestSave(a.controller.getSnapshot().generation, garden(`Editor ${i}`));
      expect(b.controller.requestSave(b.controller.getSnapshot().generation, garden(`Stale ${i}`))).toBe("blocked");
    }
    await settle();
    expect(storage.getItem(questStorageKey)).toContain("Editor 24");
    expect(storage.getItem(questStorageKey)).not.toContain("Stale");
    a.controller.suspend(); b.controller.suspend();
  });

  it("turns refused lock requests into read-only mode", async () => {
    const coordinator = createBrowserGardenCoordinator(() => ({ request: () => Promise.reject(new Error("denied")) }) as BrowserLockManager);
    const changed = vi.fn();
    coordinator.start(changed); await settle();
    expect(coordinator.getAccess()).toBe("unsupported");
    expect(coordinator.canWrite()).toBe(false);
    expect(changed).toHaveBeenCalledWith("unavailable");
    coordinator.stop();
  });

  it("cancels obsolete queued ownership and supports strict-mode restart", async () => {
    const { tab } = setup(); const a = tab(); const b = tab(); await settle();
    b.controller.suspend(); b.controller.resume(); await settle();
    a.controller.suspend(); await settle();
    expect(b.coordinator.canWrite()).toBe(true);
    b.controller.suspend(); await settle();
    expect(b.coordinator.canWrite()).toBe(false);
  });
});
