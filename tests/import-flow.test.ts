import { describe, expect, it } from "vitest";
import type { BrowserGardenSummary, BrowserSavePreview } from "../src/app/browser-save-preview";
import { summarizeGarden } from "../src/app/browser-save-preview";
import type { BrowserImportOutcome, BrowserImportRefusal, StorageControllerSnapshot } from "../src/app/game-storage-controller";
import {
  browserImportAvailability,
  describeGardenSummary,
  describeImportOutcome,
  describeImportRefusal,
  describeUnresolvedImport,
  formatActivityDate,
  isConfirmationCurrent,
  needsFreshReview,
} from "../src/app/import-flow";
import { initialStoredQuestData } from "../src/app/quest-defaults";

const summary: BrowserGardenSummary = {
  level: 2, totalXp: 120, quests: { daily: 4, personal: 3, total: 7 }, plants: { discovered: 2, pendingGifts: 0 }, lastActivityDate: "2026-10-19",
};
const ready = (hasMeaningfulProgress: boolean): BrowserSavePreview =>
  ({ status: "ready", rawText: "{}", data: initialStoredQuestData, upgraded: false, summary, hasMeaningfulProgress });

function storage(changes: Partial<StorageControllerSnapshot> = {}): StorageControllerSnapshot {
  return {
    generation: 4, phase: "ready", mode: "cloud", account: { id: "a", email: "a@example.com" },
    loaded: { status: "ready", data: initialStoredQuestData }, problem: null, save: { status: "saved", hasUnsavedChanges: false },
    unresolvedImport: null, unsavedRecoveries: [], recoveriesAtRisk: false, ...changes,
  };
}

describe("whether the browser garden can be imported", () => {
  it("offers importing only for a readable garden with real progress", () => {
    expect(browserImportAvailability(ready(true))).toEqual({ available: true, summary });
    expect(browserImportAvailability(ready(false))).toMatchObject({ available: false, reason: "no-progress", summary });
  });

  it.each([
    [null, "browser-empty"],
    [{ status: "empty" }, "browser-empty"],
    [{ status: "invalid" }, "browser-unreadable"],
    [{ status: "unsupported-version" }, "browser-unreadable"],
    [{ status: "unavailable" }, "browser-unreadable"],
    [{ status: "failed" }, "browser-unreadable"],
    [{ status: "newer-version", schemaVersion: 99 }, "browser-newer-version"],
  ] as const)("explains why not for %j", (preview, reason) => {
    const availability = browserImportAvailability(preview as BrowserSavePreview | null);
    expect(availability).toMatchObject({ available: false, reason, summary: null });
    expect(availability.available === false && availability.message.length).toBeGreaterThan(10);
  });
});

describe("messages", () => {
  it("has a calm, specific explanation for every refusal", () => {
    const reasons: BrowserImportRefusal[] = ["busy", "not-cloud", "not-loaded", "unsaved", "stale", "browser-changed", "browser-empty", "browser-unreadable", "browser-newer-version", "no-progress"];
    const messages = reasons.map(describeImportRefusal);
    expect(new Set(messages).size).toBe(reasons.length);
    for (const message of messages) expect(message).not.toMatch(/error|fail/i);
  });

  it("asks for a fresh review only when the gardens moved on under the confirmation", () => {
    expect(needsFreshReview({ status: "refused", reason: "stale" })).toBe(true);
    expect(needsFreshReview({ status: "refused", reason: "browser-changed" })).toBe(true);
    expect(needsFreshReview({ status: "refused", reason: "unsaved" })).toBe(false);
    expect(needsFreshReview({ status: "conflict" })).toBe(false);
  });

  it("says a replaced cloud garden was backed up, and that the browser garden is unchanged", () => {
    expect(describeImportOutcome({ status: "imported", revision: 2 }, true)).toMatchObject({ tone: "success", message: expect.stringContaining("backed up") });
    const first = describeImportOutcome({ status: "imported", revision: 1 }, false);
    expect(first?.message).not.toContain("backed up");
    expect(first?.message).toContain("browser hasn't changed");
  });

  it.each([
    [{ status: "unchanged", revision: 1 }, "info", "already matches"],
    [{ status: "conflict" }, "warning", "changed somewhere else"],
    [{ status: "backup-failed" }, "error", "Nothing was imported"],
    [{ status: "failed", problem: "network" }, "error", "didn't go through"],
    [{ status: "cancelled" }, "info", "cancelled"],
    [{ status: "refused", reason: "stale" }, "warning", "Nothing was imported"],
    [{ status: "refused", reason: "unsaved" }, "info", "Nothing was imported"],
  ] as const)("describes %j", (outcome, tone, title) => {
    const message = describeImportOutcome(outcome as BrowserImportOutcome, true);
    expect(message?.tone).toBe(tone);
    expect(message?.title).toContain(title);
  });

  it("a network failure says the server couldn't be reached, and that nothing changed", () => {
    expect(describeImportOutcome({ status: "failed", problem: "network" }, true)?.message).toBe(
      "Plantetary couldn't reach the server. Nothing was imported. The garden in this browser hasn't changed.",
    );
  });

  it("leaves unresolved imports to their own card", () => {
    expect(describeImportOutcome({ status: "unresolved", problem: "network", canRetry: true }, true)).toBeNull();
  });

  it("explains an unresolved import, and when a retry is safe", () => {
    expect(describeUnresolvedImport("network", true)).toContain("You can retry the same import");
    expect(describeUnresolvedImport("unknown", false)).toContain("Check your cloud garden");
    expect(describeUnresolvedImport("network", false)).toContain("garden in this browser hasn't changed");
  });
});

describe("garden summaries", () => {
  it("formats activity dates, and says when there's none", () => {
    expect(formatActivityDate(null)).toBe("Not recorded");
    expect(formatActivityDate("2026-10-19")).toMatch(/2026/);
  });

  it("reads out a summary in one sentence", () => {
    expect(describeGardenSummary(summary)).toMatch(/^Level 2, 120 XP, 7 quests, 2 plants, last active /);
    expect(describeGardenSummary({ ...summary, quests: { daily: 1, personal: 0, total: 1 }, plants: { discovered: 1, pendingGifts: 0 } }))
      .toContain("1 quest, 1 plant");
  });

  it("summarizes any garden the same way, for the cloud side of the comparison", () => {
    expect(summarizeGarden({ ...initialStoredQuestData, legacyXpBonus: 120 })).toMatchObject({ level: 2, totalXp: 120, lastActivityDate: null });
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, 1e100, Number.MAX_VALUE])("can summarize a huge finite cloud XP total without hanging: %s", (xp) => {
    const result = summarizeGarden({ ...initialStoredQuestData, legacyXpBonus: xp });
    expect(result.totalXp).toBe(xp);
    expect(Number.isFinite(result.level)).toBe(true);
  });
});

describe("an open confirmation", () => {
  const scope = { generation: 4, accountId: "a" };

  it("applies while the same account's garden is on screen", () => {
    expect(isConfirmationCurrent(scope, storage())).toBe(true);
    expect(isConfirmationCurrent(scope, storage({ phase: "choose", loaded: null }))).toBe(true);
  });

  it.each([
    ["another account signs in", { account: { id: "b", email: "b@example.com" } }],
    ["signing out", { mode: "browser" as const, account: null }],
    ["a new garden on screen (reload, import)", { generation: 5 }],
    ["an import running", { phase: "importing" as const }],
    ["a failed load", { phase: "cloud-failed" as const }],
  ])("ends when %s", (_, changes) => {
    expect(isConfirmationCurrent(scope, storage(changes))).toBe(false);
  });
});
