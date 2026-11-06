import { readQuestSave } from "./quest-storage";
import type { StoredQuestData } from "./quest-types";

/**
 * An account's unsaved changes, kept in this tab so a reload or an accidental close doesn't lose them
 * silently: a cloud garden's changes when the page was hidden or closed before they were saved
 * (`page-left`), or changes left when the account changed on the page (`account-changed`). Download only:
 * nothing here is ever written to any garden, browser or cloud.
 */
export type PersistedRecovery = {
  /** Unique across pages: a `page-left` entry is named after its page, so a page only replaces its own. */
  id: string;
  /** Why it was kept. Missing means `page-left`. */
  reason?: "page-left" | "account-changed";
  /** The verified account the changes belong to. They're only ever shown to that same account. */
  userId: string;
  /** Partly hidden email, as in other recovery notices. */
  accountLabel: string | null;
  /** When they were kept, in milliseconds since 1970. */
  closedAt: number;
  data: StoredQuestData;
};

export type PersistedRecoveryStore = {
  read: () => PersistedRecovery[];
  /** Replaces every entry. An empty list removes the stored value. Failing to store is never an error. */
  write: (entries: PersistedRecovery[]) => void;
};

/**
 * sessionStorage: one tab only, gone when the tab closes, so account data doesn't outlive the visit on a
 * shared device. A reload, or reopening a just-closed tab, keeps it.
 */
export const recoveryStorageKey = "plantetary-unsaved-cloud-changes";

/** The most entries kept. The oldest go first; each is a whole garden. */
export const maxPersistedRecoveries = 5;

type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isRecovery(value: unknown): value is PersistedRecovery {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && entry.id.length > 0 &&
    (entry.reason === undefined || entry.reason === "page-left" || entry.reason === "account-changed") &&
    typeof entry.userId === "string" && entry.userId.length > 0 &&
    (entry.accountLabel === null || typeof entry.accountLabel === "string") &&
    typeof entry.closedAt === "number" && Number.isFinite(entry.closedAt) &&
    readQuestSave(entry.data).status === "valid";
}

export function createRecoveryStore(getStorage: () => RecoveryStorage | null | undefined): PersistedRecoveryStore {
  return {
    read() {
      try {
        const text = getStorage()?.getItem(recoveryStorageKey);
        if (!text) return [];
        const value: unknown = JSON.parse(text);
        // Anything unreadable is skipped, never repaired: it was only ever a copy.
        return Array.isArray(value) ? value.filter(isRecovery) : [];
      } catch {
        return [];
      }
    },
    write(entries) {
      try {
        const storage = getStorage();
        if (!storage) return;
        if (entries.length === 0) {
          storage.removeItem(recoveryStorageKey);
          return;
        }
        const kept = [...entries].sort((a, b) => a.closedAt - b.closedAt).slice(-maxPersistedRecoveries);
        storage.setItem(recoveryStorageKey, JSON.stringify(kept));
      } catch {
        // Full or unavailable: the warning before leaving still applies.
      }
    },
  };
}

/** JSON text with object keys sorted, so two gardens with the same content compare equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, inner: unknown) => {
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) return inner;
    return Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}
