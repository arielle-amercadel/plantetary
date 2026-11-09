import { browserResetStorageKey } from "../src/app/quest-storage";
import { describe, expect, it } from "vitest";
import type { SettingsStorage } from "../src/app/settings-logic";
import {
  createSettingsExportJson,
  defaultProfilePreferences,
  defaultReminderPreferences,
  getGardenBannerTitle,
  getWelcomeGreeting,
  loadProfilePreferences,
  loadReminderPreferences,
  profilePreferencesStorageKey,
  reminderPreferencesStorageKey,
  resetPlantetaryStorage,
  saveProfilePreferences,
  saveReminderPreferences,
} from "../src/app/settings-logic";
import type { StoredQuestData } from "../src/app/quest-types";

function makeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: SettingsStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  return { storage, values };
}

const savedQuestData: StoredQuestData = {
  schemaVersion: 3,
  questLists: {
    daily: [{ id: "daily-1", title: "Water a plant", category: "Garden", schedule: "Every day", difficulty: "Easy", completed: true }],
    personal: [],
  },
  categoryLists: { daily: ["Garden"], personal: ["Personal"] },
  completionHistory: {
    "2026-10-18": {
      scheduledQuestIds: ["daily-1"],
      completedQuestIds: ["daily-1"],
      xpAwardedByQuestId: { "daily-1": 5 },
    },
  },
  legacyXpBonus: 2,
};

describe("Settings preferences", () => {
  it("formats the garden banner with a fallback and natural possessives", () => {
    expect(getGardenBannerTitle(" Arielle ")).toBe("Arielle's Garden");
    expect(getGardenBannerTitle("James")).toBe("James' Garden");
    expect(getGardenBannerTitle("")).toBe("Mira's Garden");
    expect(getGardenBannerTitle(undefined)).toBe("Mira's Garden");
  });

  it("uses the saved display name in the dashboard greeting with a fallback", () => {
    expect(getWelcomeGreeting("Arielle")).toBe("Welcome back, Arielle.");
    expect(getWelcomeGreeting("")).toBe("Welcome back, Mira.");
    expect(getWelcomeGreeting(undefined)).toBe("Welcome back, Mira.");
  });

  it("saves and restores reminder preferences", () => {
    const { storage } = makeStorage();
    const preferences = { enabled: true, questTypes: ["daily"] as Array<"daily" | "personal">, time: "07:30" };

    expect(loadReminderPreferences(storage)).toEqual(defaultReminderPreferences);
    expect(saveReminderPreferences(storage, preferences)).toBe(true);
    expect(loadReminderPreferences(storage)).toEqual(preferences);
    expect(storage.getItem(reminderPreferencesStorageKey)).not.toBeNull();
  });

  it("saves and restores profile name and avatar preferences", () => {
    const { storage } = makeStorage();
    const preferences = { displayName: "Fern", avatar: "flower" as const };

    expect(loadProfilePreferences(storage)).toEqual(defaultProfilePreferences);
    expect(saveProfilePreferences(storage, preferences)).toBe(true);
    expect(loadProfilePreferences(storage)).toEqual(preferences);
    expect(storage.getItem(profilePreferencesStorageKey)).not.toBeNull();
  });
});

describe("Settings data management", () => {
  it("exports quest, category, completion, and XP data without changing storage", () => {
    const { storage, values } = makeStorage({ "plantetary-quest-data": JSON.stringify(savedQuestData), unrelated: "keep me" });
    const before = JSON.stringify([...values.entries()]);
    const json = createSettingsExportJson(
      savedQuestData,
      7,
      defaultProfilePreferences,
      defaultReminderPreferences,
      "2026-10-18T12:00:00.000Z",
    );
    const exported = JSON.parse(json);

    expect(exported.totalXp).toBe(7);
    expect(exported.questData.questLists.daily[0].id).toBe("daily-1");
    expect(exported.questData.categoryLists.daily).toEqual(["Garden"]);
    expect(exported.questData.completionHistory["2026-10-18"].completedQuestIds).toEqual(["daily-1"]);
    expect(exported.questData.completionHistory["2026-10-18"].xpAwardedByQuestId["daily-1"]).toBe(5);
    expect(JSON.stringify([...values.entries()])).toBe(before);
    expect(storage.getItem("unrelated")).toBe("keep me");
  });

  it("does not remove data when reset is canceled", () => {
    const { storage, values } = makeStorage({ "plantetary-quest-data": "saved", unrelated: "keep me" });
    const before = JSON.stringify([...values.entries()]);

    expect(resetPlantetaryStorage(storage, false)).toBe(false);
    expect(JSON.stringify([...values.entries()])).toBe(before);
  });

  it("does not delete any data if the reset identity cannot be stored", () => {
    const { storage, values } = makeStorage({ "plantetary-quest-data": "keep this", unrelated: "keep me" });
    const originalWrite = storage.setItem;
    storage.setItem = (key, value) => {
      if (key === browserResetStorageKey) throw new Error("QuotaExceededError");
      originalWrite(key, value);
    };
    expect(resetPlantetaryStorage(storage, true)).toBe(false);
    expect(values.get("plantetary-quest-data")).toBe("keep this");
    expect(values.get("unrelated")).toBe("keep me");
  });

  it("restores removed data when deletion fails after publishing reset identity", () => {
    const { storage, values } = makeStorage({
      "plantetary-quest-data": "original garden",
      "plantetary-quest-data-backup-v1": "original backup",
    });
    const originalRemove = storage.removeItem;
    storage.removeItem = (key) => {
      if (key === "plantetary-quest-data-backup-v1") throw new Error("Removal blocked");
      originalRemove(key);
    };
    expect(resetPlantetaryStorage(storage, true)).toBe(false);
    expect(values.get("plantetary-quest-data")).toBe("original garden");
    expect(values.get("plantetary-quest-data-backup-v1")).toBe("original backup");
    // The published identity remains: drafts conservatively treat this as a reset attempt.
    expect(values.get(browserResetStorageKey)).toBeTruthy();
  });

  it("publishes a new reset identity even when garden content is absent or identical", () => {
    const { storage } = makeStorage({});
    expect(resetPlantetaryStorage(storage, true)).toBe(true);
    const first = storage.getItem(browserResetStorageKey);
    expect(first).toBeTruthy();
    expect(resetPlantetaryStorage(storage, true)).toBe(true);
    expect(storage.getItem(browserResetStorageKey)).not.toBe(first);
  });

  it("clears only Plantetary data after confirmation and preserves unrelated browser storage", () => {
    const { storage, values } = makeStorage({
      "plantetary-quest-data": JSON.stringify(savedQuestData),
      "plantetary-quest-data-backup-v1": "backup",
      "plantetary-quest-data-invalid-backup": "invalid backup",
      [reminderPreferencesStorageKey]: "reminders",
      [profilePreferencesStorageKey]: "profile",
      unrelated: "keep me",
    });

    expect(resetPlantetaryStorage(storage, true)).toBe(true);
    expect(values.has("plantetary-quest-data")).toBe(false);
    expect(values.has("plantetary-quest-data-backup-v1")).toBe(false);
    expect(values.has("plantetary-quest-data-invalid-backup")).toBe(false);
    expect(values.has(reminderPreferencesStorageKey)).toBe(false);
    expect(values.has(profilePreferencesStorageKey)).toBe(false);
    expect(values.get("unrelated")).toBe("keep me");
  });
});
