import { describe, expect, it, vi } from "vitest";
import { inspectBrowserGarden } from "../src/app/browser-save-preview";
import { createBrowserGameStorage } from "../src/app/game-storage";
import { initialStoredQuestData } from "../src/app/quest-defaults";
import { getLevelProgress } from "../src/app/quest-logic";
import { latestQuestSaveVersion, questStorageKey, readQuestSave, validBackupStorageKey, invalidBackupStorageKey } from "../src/app/quest-storage";
import type { StoredQuestData } from "../src/app/quest-types";

const starter = (): StoredQuestData => structuredClone(initialStoredQuestData);

function reader(raw: string | null) {
  const values = new Map([
    [validBackupStorageKey, "existing valid backup"],
    [invalidBackupStorageKey, "existing invalid backup"],
    ["plantetary-profile", "local profile"],
  ]);
  if (raw !== null) values.set(questStorageKey, raw);
  const before = [...values];
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn(() => { throw new Error("Preview must never write"); }),
    removeItem: vi.fn(() => { throw new Error("Preview must never remove"); }),
  };
  const verifyReadOnly = () => {
    expect(storage.getItem).toHaveBeenCalledExactlyOnceWith(questStorageKey);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect([...values]).toEqual(before);
  };
  return { storage, verifyReadOnly };
}

/** Every fixture, including migrations and failures, checks the write prohibition. */
function inspect(value: unknown) {
  const raw = JSON.stringify(value);
  const env = reader(raw);
  const result = inspectBrowserGarden(() => env.storage);
  env.verifyReadOnly();
  return result;
}

describe("read-only browser garden preview", () => {
  it("summarizes the whole garden using its XP ledger and latest recorded completion", () => {
    const data = starter();
    data.legacyXpBonus = 80;
    data.completionHistory = {
      "2026-10-19": { scheduledQuestIds: ["water"], completedQuestIds: ["water"], xpAwardedByQuestId: { water: 5 } },
      // Opening the app records this day but doesn't prove player activity.
      "2026-11-06": { scheduledQuestIds: ["water"], completedQuestIds: [] },
    };
    data.questLists.personal[0].completed = true;
    data.personalXpByQuestId = { biology: 15 };
    data.personalCompletedOnByQuestId = { biology: "2026-10-21" };
    data.discoveredPlantIds = ["fern", "daisy"];
    data.pendingPlantGiftIds = ["cactus", "sunflower"];
    const result = inspect(data);
    expect(result).toMatchObject({
      status: "ready", hasMeaningfulProgress: true,
      summary: { level: 2, totalXp: 100, quests: { daily: 4, personal: 3, total: 7 },
        plants: { discovered: 2, pendingGifts: 2 }, lastActivityDate: "2026-10-21" },
    });
  });

  it("does not offer a starter-only save, even with automatically recorded history", () => {
    const data = starter();
    data.completionHistory = { "2026-11-06": { scheduledQuestIds: ["water"], completedQuestIds: [] } };
    expect(inspect(data)).toMatchObject({ status: "ready", hasMeaningfulProgress: false,
      summary: { totalXp: 0, level: 1, lastActivityDate: null, plants: { discovered: 0, pendingGifts: 1 } } });
  });

  it("upgrades a legacy completed garden in memory and retains the exact original text", () => {
    const data = starter();
    delete data.schemaVersion;
    delete data.pendingPlantGiftIds;
    delete data.discoveredPlantIds;
    delete data.starterPlantGiftPending;
    data.questLists.personal[0].completed = true;
    const raw = JSON.stringify(data, null, 2);
    const env = reader(raw);
    const result = inspectBrowserGarden(() => env.storage);
    expect(result).toMatchObject({ status: "ready", rawText: raw, upgraded: true,
      hasMeaningfulProgress: true, data: { schemaVersion: latestQuestSaveVersion },
      summary: { totalXp: 10, lastActivityDate: null } });
    env.verifyReadOnly();
  });

  it("preserves legacy completion history and calculates its XP without adding today's snapshot", () => {
    const data = starter();
    delete data.schemaVersion;
    data.completionHistory = {
      "2026-10-19": { scheduledQuestIds: ["water"], completedQuestIds: ["water"] },
      "2026-10-20": { scheduledQuestIds: ["water"], completedQuestIds: ["water"] },
    };
    const result = inspect(data);
    expect(result).toMatchObject({ status: "ready", upgraded: true, hasMeaningfulProgress: true,
      summary: { totalXp: 10, lastActivityDate: "2026-10-20" } });
    if (result.status !== "ready") throw new Error("Expected a readable legacy save");
    expect(Object.keys(result.data.completionHistory ?? {})).toEqual(["2026-10-19", "2026-10-20"]);
    expect(result.data.completionHistory?.["2026-10-19"].completedQuestIds).toEqual(["water"]);
  });

  it("returns a detached snapshot whose edits cannot change the browser save", () => {
    const raw = JSON.stringify(starter());
    const env = reader(raw);
    const result = inspectBrowserGarden(() => env.storage);
    if (result.status !== "ready") throw new Error("Expected a readable save");
    result.data.questLists.daily[0].title = "Changed in memory";
    expect(result.rawText).toBe(raw);
    env.verifyReadOnly();
    const next = inspectBrowserGarden(() => ({ getItem: () => raw }));
    expect(next).toMatchObject({ status: "ready", hasMeaningfulProgress: false });
  });

  it.each([undefined, 0, 1, 2, 3, 4])("supports starter-only legacy version %s without counting the automatically granted Fern", (version) => {
    const data = starter();
    data.schemaVersion = version;
    delete data.discoveredPlantIds;
    delete data.pendingPlantGiftIds;
    delete data.starterPlantGiftPending;
    expect(inspect(data)).toMatchObject({ status: "ready", hasMeaningfulProgress: false });
  });

  it("recognizes legacy starter recurrence by the days it runs, not its old representation", () => {
    const data = starter();
    delete data.schemaVersion;
    delete data.discoveredPlantIds;
    delete data.pendingPlantGiftIds;
    delete data.starterPlantGiftPending;
    data.questLists.daily.forEach((quest) => {
      delete quest.repeatSchedule;
      quest.schedule = "Every day";
    });
    // These unused legacy fields do not schedule Personal Quests.
    data.questLists.personal.forEach((quest) => {
      quest.schedule = "Anytime";
      quest.repeatSchedule = "Every day";
      quest.selectedDays = ["Mon"];
    });
    expect(inspect(data)).toMatchObject({ status: "ready", upgraded: true, hasMeaningfulProgress: false });
  });

  it("counts a real recurrence change as meaningful", () => {
    const data = starter();
    data.questLists.daily[0].repeatSchedule = "Selected days";
    data.questLists.daily[0].selectedDays = ["Mon"];
    expect(inspect(data)).toMatchObject({ status: "ready", hasMeaningfulProgress: true });
  });

  it("does not offer a starter-only legacy garden already migrated and saved by a previous visit", () => {
    const legacy = starter();
    delete legacy.schemaVersion;
    delete legacy.discoveredPlantIds;
    delete legacy.pendingPlantGiftIds;
    delete legacy.starterPlantGiftPending;
    const migrated = readQuestSave(legacy);
    if (migrated.status !== "valid") throw new Error("Expected a readable legacy save");
    expect(migrated.data.discoveredPlantIds).toContain("fern");
    expect(inspect(migrated.data)).toMatchObject({ status: "ready", hasMeaningfulProgress: false });
  });

  it("counts only catalog plants in the summary but preserves unknown discoveries in the data", () => {
    const data = starter();
    data.discoveredPlantIds = ["daisy", "daisy", "unknown-plant"];
    data.pendingPlantGiftIds = ["cactus", "cactus", "unknown-gift"];
    const result = inspect(data);
    expect(result).toMatchObject({ status: "ready", summary: { plants: { discovered: 1, pendingGifts: 1 } } });
    if (result.status !== "ready") throw new Error("Expected a readable save");
    expect(result.data.discoveredPlantIds).toContain("unknown-plant");
  });

  it("summarizes legacy plant milestones using the existing migration rules", () => {
    const data = starter();
    data.schemaVersion = 1;
    data.legacyXpBonus = 75;
    delete data.discoveredPlantIds;
    delete data.pendingPlantGiftIds;
    delete data.starterPlantGiftPending;
    expect(inspect(data)).toMatchObject({ status: "ready", hasMeaningfulProgress: true,
      summary: { totalXp: 75, level: 1, plants: { discovered: 3, pendingGifts: 0 } } });
  });

  it("retains completion-only evidence even when an orphaned quest has no XP award", () => {
    const data = starter();
    data.completionHistory = {
      "2026-10-19": { scheduledQuestIds: ["removed"], completedQuestIds: ["removed"] },
    };
    expect(inspect(data)).toMatchObject({ status: "ready", hasMeaningfulProgress: true,
      summary: { totalXp: 0, lastActivityDate: "2026-10-19" } });
  });

  it("recovers malformed optional fields in memory without changing the original text", () => {
    const data = { ...starter(), completionHistory: "broken", personalXpByQuestId: { biology: -5 },
      personalCompletedOnByQuestId: { biology: "not-a-date" } };
    expect(inspect(data)).toMatchObject({ status: "ready", rawText: JSON.stringify(data), upgraded: true,
      hasMeaningfulProgress: false, summary: { totalXp: 0, lastActivityDate: null } });
  });

  it.each(["{broken", JSON.stringify({ schemaVersion: 1 }), JSON.stringify({ ...starter(), schemaVersion: 1 })])(
    "never creates missing safety backups while inspecting %s", (raw) => {
      const values = new Map([[questStorageKey, raw]]);
      const storage = { getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, text: string) => { values.set(key, text); }),
        removeItem: vi.fn((key: string) => { values.delete(key); }) };
      inspectBrowserGarden(() => storage);
      expect([...values]).toEqual([[questStorageKey, raw]]);
      expect(storage.getItem).toHaveBeenCalledExactlyOnceWith(questStorageKey);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["earned XP", (data: StoredQuestData) => { data.legacyXpBonus = 5; }],
    ["custom quest", (data: StoredQuestData) => { data.questLists.personal.push({ ...data.questLists.personal[0], id: "custom" }); }],
    ["edited quest", (data: StoredQuestData) => { data.questLists.daily[0].notes = "My notes"; }],
    ["removed quest", (data: StoredQuestData) => { data.questLists.daily.pop(); }],
    ["custom category", (data: StoredQuestData) => { data.categoryLists.daily.push("My category"); }],
    ["collected plant beyond the starter Fern", (data: StoredQuestData) => { data.discoveredPlantIds = ["daisy"]; }],
    ["retained completion count", (data: StoredQuestData) => { data.deletedLegacyPersonalCompletionCount = 1; }],
  ] as const)("recognizes %s as meaningful progress", (_, edit) => {
    const data = starter();
    edit(data);
    expect(inspect(data)).toMatchObject({ status: "ready", hasMeaningfulProgress: true });
  });

  it("does not count quest/category ordering or object key order as progress", () => {
    const data = starter();
    data.questLists.daily.reverse();
    data.categoryLists.personal.reverse();
    expect(inspect(data)).toMatchObject({ status: "ready", hasMeaningfulProgress: false });
  });

  it.each([null, [], {}, { questLists: "bad" }])("rejects invalid save %j without creating a backup", (data) => {
    expect(inspect(data)).toEqual({ status: "invalid" });
  });

  it("rejects malformed JSON without creating a backup", () => {
    const env = reader("{broken");
    expect(inspectBrowserGarden(() => env.storage)).toEqual({ status: "invalid" });
    env.verifyReadOnly();
  });

  it("blocks future formats before interpreting their contents", () => {
    expect(inspect({ schemaVersion: latestQuestSaveVersion + 1, questLists: "future shape" }))
      .toEqual({ status: "newer-version", schemaVersion: latestQuestSaveVersion + 1 });
  });

  it.each([null, "5", -1, 2.5])("blocks unsupported version tag %j", (schemaVersion) => {
    expect(inspect({ ...starter(), schemaVersion })).toEqual({ status: "unsupported-version" });
  });

  it("does not infer activity from due dates, invalid calendar dates or passive history", () => {
    const data = starter();
    data.questLists.personal[0].dueDate = "2027-01-01";
    data.completionHistory = { "2026-02-31": { scheduledQuestIds: ["water"], completedQuestIds: ["water"] } };
    expect(inspect(data)).toMatchObject({ status: "ready", summary: { lastActivityDate: null } });
  });

  it.each([0, 0.5, 99, 99.99999999999999, 100, 249, 249.99999999999997, 250, 450, 1000, 10000])("matches the game's level at %s XP", (xp) => {
    expect(inspect({ ...starter(), legacyXpBonus: xp })).toMatchObject({
      status: "ready", summary: { level: getLevelProgress(xp).level },
    });
  });

  it("returns empty rather than starter data when no save exists", () => {
    const env = reader(null);
    expect(inspectBrowserGarden(() => env.storage)).toEqual({ status: "empty" });
    env.verifyReadOnly();
  });

  it("handles the default browser getter when localStorage itself is blocked", async () => {
    vi.stubGlobal("window", { get localStorage() { throw new Error("SecurityError"); } });
    try {
      expect(inspectBrowserGarden()).toEqual({ status: "unavailable" });
      expect(await createBrowserGameStorage().inspect()).toEqual({ status: "unavailable" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("handles a huge finite XP ledger without an unbounded level loop", () => {
    const result = inspect({ ...starter(), legacyXpBonus: Number.MAX_SAFE_INTEGER });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected a readable save");
    const completed = result.summary.level - 1;
    expect(completed * (25 * completed + 75)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect((completed + 1) * (25 * (completed + 1) + 75)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it("rejects overflowing XP totals rather than presenting an invalid summary", () => {
    expect(inspect({ ...starter(), legacyXpBonus: Number.MAX_VALUE,
      personalXpByQuestId: { deleted: Number.MAX_VALUE } })).toEqual({ status: "invalid" });
  });

  it("handles unavailable or blocked storage", () => {
    expect(inspectBrowserGarden(() => null)).toEqual({ status: "unavailable" });
    expect(inspectBrowserGarden(() => { throw new Error("SecurityError"); })).toEqual({ status: "unavailable" });
    const env = reader("{}");
    env.storage.getItem.mockImplementation(() => { throw new Error("SecurityError"); });
    expect(inspectBrowserGarden(() => env.storage)).toEqual({ status: "unavailable" });
    env.verifyReadOnly();
  });

  it("exposes inspection on the browser adapter without invoking its writable load path", async () => {
    const env = reader(JSON.stringify(starter()));
    expect(await createBrowserGameStorage(() => env.storage).inspect()).toMatchObject({ status: "ready", hasMeaningfulProgress: false });
    env.verifyReadOnly();
  });
});
