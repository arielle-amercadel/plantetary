import { describe, expect, it } from "vitest";
import type { SaveSnapshot } from "../src/app/game-data-session";
import type { StorageControllerSnapshot, UnsavedRecovery } from "../src/app/game-storage-controller";
import { describeSaveStatus, describeUnsavedChanges, shouldWarnBeforeLeaving } from "../src/app/storage-messages";
import type { StoredQuestData } from "../src/app/quest-types";

const garden: StoredQuestData = {
  schemaVersion: 5,
  questLists: { daily: [], personal: [] },
  categoryLists: { daily: [], personal: [] },
};

function storage(save: SaveSnapshot | null, changes: Partial<StorageControllerSnapshot> = {}): StorageControllerSnapshot {
  return {
    generation: 1,
    phase: "ready",
    mode: "cloud",
    account: { id: "a", email: "a@example.com" },
    loaded: { status: "ready", data: garden },
    problem: null,
    save,
    unsavedRecoveries: [],
    recoveriesAtRisk: false,
    ...changes,
  };
}

const recovery = (reason: UnsavedRecovery["reason"]): UnsavedRecovery =>
  ({ id: "r", reason, ownerId: null, accountLabel: null, closedAt: 0, data: garden });

describe("the save-status indicator", () => {
  it("shows saving and saved for a cloud garden", () => {
    expect(describeSaveStatus(storage({ status: "saving", hasUnsavedChanges: true }))).toMatchObject({ tone: "saving", label: "Saving…" });
    expect(describeSaveStatus(storage({ status: "saved", hasUnsavedChanges: false }))).toMatchObject({
      tone: "saved",
      label: "Saved",
      detail: "All changes saved to your account.",
    });
  });

  it("says it's retrying while an automatic retry waits, and not saved once none is left", () => {
    const retrying = describeSaveStatus(storage({ status: "error", problem: "network", failedAttempts: 1, nextRetryAt: 5_000, hasUnsavedChanges: true }));
    const stopped = describeSaveStatus(storage({ status: "error", problem: "network", failedAttempts: 4, nextRetryAt: null, hasUnsavedChanges: true }));

    expect(retrying).toMatchObject({ tone: "error", label: "Retrying…" });
    expect(retrying?.detail).toContain("couldn't reach the server");
    expect(retrying?.detail).toContain("Trying again shortly");
    expect(stopped).toMatchObject({ tone: "error", label: "Not saved" });
    expect(stopped?.detail).toContain("still on this screen");
  });

  it("says saving has paused after a conflict", () => {
    expect(describeSaveStatus(storage({ status: "conflict", backup: "saved", hasUnsavedChanges: true }))).toMatchObject({
      tone: "conflict",
      label: "Saving paused",
    });
  });

  it("stays quiet for a browser garden that saves normally, but shows a failed browser save", () => {
    const browser = { mode: "browser" as const, account: null };
    expect(describeSaveStatus(storage({ status: "saved", hasUnsavedChanges: false }, browser))).toBeNull();
    expect(describeSaveStatus(storage({ status: "saving", hasUnsavedChanges: true }, browser))).toBeNull();
    const failed = describeSaveStatus(storage({ status: "error", problem: "storage", failedAttempts: 1, nextRetryAt: null, hasUnsavedChanges: true }, browser));
    expect(failed).toMatchObject({ tone: "error", label: "Not saved" });
    expect(failed?.detail).toContain("in this browser");
  });

  it.each([
    ["waiting", { phase: "waiting" as const, save: null }],
    ["loading", { phase: "loading" as const }],
    ["the first-time choice", { phase: "choose" as const }],
    ["a failed cloud load", { phase: "cloud-failed" as const }],
  ])("shows nothing while %s", (_, changes) => {
    expect(describeSaveStatus(storage({ status: "loading", hasUnsavedChanges: false }, changes))).toBeNull();
  });
});

describe("the warning before leaving the page", () => {
  it("warns while anything is unsaved, in any state, including a change waiting for the short pause", () => {
    expect(shouldWarnBeforeLeaving(storage({ status: "saving", hasUnsavedChanges: true }))).toBe(true);
    expect(shouldWarnBeforeLeaving(storage({ status: "conflict", backup: "saved", hasUnsavedChanges: true }))).toBe(true);
    expect(shouldWarnBeforeLeaving(storage({ status: "error", problem: "server", failedAttempts: 1, nextRetryAt: 1, hasUnsavedChanges: true }))).toBe(true);
    expect(shouldWarnBeforeLeaving(storage({ status: "loading", hasUnsavedChanges: true }, { phase: "cloud-failed", loaded: null }))).toBe(true);
  });

  it("doesn't warn when everything is saved, or before anything loads", () => {
    expect(shouldWarnBeforeLeaving(storage({ status: "saved", hasUnsavedChanges: false }))).toBe(false);
    expect(shouldWarnBeforeLeaving(storage({ status: "saving", hasUnsavedChanges: false }))).toBe(false);
    expect(shouldWarnBeforeLeaving(storage(null, { phase: "waiting" }))).toBe(false);
  });

  it("warns for changes kept from an account change, but not for ones already kept in this tab", () => {
    const saved = { status: "saved" as const, hasUnsavedChanges: false };
    expect(shouldWarnBeforeLeaving(storage(saved, { unsavedRecoveries: [recovery("account-changed")] }))).toBe(true);
    expect(shouldWarnBeforeLeaving(storage(saved, { unsavedRecoveries: [recovery("page-left")] }))).toBe(false);
  });
});

describe("describing unsaved changes after a conflict", () => {
  it.each([
    ["saved", "A backup copy of them was kept in your account."],
    ["outdated", "A backup copy of earlier changes was kept in your account, but not of the newest ones."],
    ["failed", "They couldn't be backed up either."],
  ] as const)("says what the %s backup holds", (backup, text) => {
    expect(describeUnsavedChanges({ status: "conflict", backup, hasUnsavedChanges: true })).toContain(text);
  });
});
