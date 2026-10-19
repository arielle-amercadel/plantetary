import type { StoredQuestData } from "./quest-types";

export const reminderPreferencesStorageKey = "plantetary-reminder-preferences-v1";
export const profilePreferencesStorageKey = "plantetary-profile-preferences-v1";
export const profilePreferencesUpdatedEvent = "plantetary-profile-preferences-updated";

export const profileAvatars = [
  { id: "seedling", label: "Seedling", symbol: "🌱" },
  { id: "leaf", label: "Leaf", symbol: "🍃" },
  { id: "flower", label: "Flower", symbol: "🌼" },
  { id: "cactus", label: "Cactus", symbol: "🌵" },
] as const;

export type ReminderPreferences = {
  enabled: boolean;
  questTypes: Array<"daily" | "personal">;
  time: string;
};

export type ProfilePreferences = {
  displayName: string;
  avatar: typeof profileAvatars[number]["id"] | null;
};

export type SettingsStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const defaultReminderPreferences: ReminderPreferences = {
  enabled: false,
  questTypes: ["daily", "personal"],
  time: "20:00",
};

export const defaultProfilePreferences: ProfilePreferences = {
  displayName: "Mira",
  avatar: null,
};

export function getGardenBannerTitle(displayName: string | null | undefined): string {
  const name = displayName?.trim() || defaultProfilePreferences.displayName;
  const possessive = /s$/i.test(name) ? "'" : "'s";
  return `${name}${possessive} Garden`;
}

export function getWelcomeGreeting(displayName: string | null | undefined): string {
  const name = displayName?.trim() || defaultProfilePreferences.displayName;
  return `Welcome back, ${name}.`;
}

const plantetaryStorageKeys = [
  "plantetary-quest-data",
  "plantetary-quest-data-backup-v1",
  "plantetary-quest-data-invalid-backup",
  reminderPreferencesStorageKey,
  profilePreferencesStorageKey,
];

function readJson(storage: SettingsStorage, key: string): unknown {
  try {
    const rawValue = storage.getItem(key);
    return rawValue === null ? undefined : JSON.parse(rawValue);
  } catch {
    return undefined;
  }
}

export function loadReminderPreferences(storage: SettingsStorage): ReminderPreferences {
  const value = readJson(storage, reminderPreferencesStorageKey);
  if (!value || typeof value !== "object") return defaultReminderPreferences;

  const record = value as Record<string, unknown>;
  const questTypes = Array.isArray(record.questTypes)
    ? [...new Set(record.questTypes.filter((type): type is "daily" | "personal" => type === "daily" || type === "personal"))]
    : defaultReminderPreferences.questTypes;
  const time = typeof record.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(record.time)
    ? record.time
    : defaultReminderPreferences.time;

  return {
    enabled: record.enabled === true,
    questTypes,
    time,
  };
}

export function saveReminderPreferences(
  storage: SettingsStorage,
  preferences: ReminderPreferences,
): boolean {
  try {
    storage.setItem(reminderPreferencesStorageKey, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

export function loadProfilePreferences(storage: SettingsStorage): ProfilePreferences {
  const value = readJson(storage, profilePreferencesStorageKey);
  if (!value || typeof value !== "object") return defaultProfilePreferences;

  const record = value as Record<string, unknown>;
  const displayName = typeof record.displayName === "string" && record.displayName.trim()
    ? record.displayName.trim().slice(0, 32)
    : defaultProfilePreferences.displayName;
  const avatar = profileAvatars.some((choice) => choice.id === record.avatar)
    ? record.avatar as ProfilePreferences["avatar"]
    : null;

  return { displayName, avatar };
}

export function saveProfilePreferences(
  storage: SettingsStorage,
  preferences: ProfilePreferences,
): boolean {
  try {
    storage.setItem(profilePreferencesStorageKey, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

export function createSettingsExportJson(
  questData: StoredQuestData,
  totalXp: number,
  profilePreferences: ProfilePreferences,
  reminderPreferences: ReminderPreferences,
  exportedAt: string,
): string {
  return JSON.stringify({
    app: "Plantetary",
    exportVersion: 1,
    exportedAt,
    totalXp,
    questData,
    profilePreferences,
    reminderPreferences,
  }, null, 2);
}

export function resetPlantetaryStorage(storage: SettingsStorage, confirmed: boolean): boolean {
  if (!confirmed) return false;

  const originals = new Map<string, string | null>();
  try {
    for (const key of plantetaryStorageKeys) originals.set(key, storage.getItem(key));
  } catch {
    return false;
  }

  const removed: string[] = [];
  try {
    for (const key of plantetaryStorageKeys) {
      storage.removeItem(key);
      removed.push(key);
    }
    return true;
  } catch {
    for (const key of removed) {
      const value = originals.get(key);
      if (value !== null && value !== undefined) {
        try {
          storage.setItem(key, value);
        } catch {
          // Best-effort restoration if browser storage becomes unavailable mid-reset.
        }
      }
    }
    return false;
  }
}
