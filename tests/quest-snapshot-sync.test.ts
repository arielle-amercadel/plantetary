import { describe, expect, it } from "vitest";
import {
  addQuestToHistory,
  addQuestToHistoryAtDate,
  getSnapshotStatus,
  getStreakValues,
  getRecoverableOrphanedDailyQuestIds,
  removeQuestFromHistory,
  removeQuestFromHistoryAtDate,
  recoverOrphanedDailyQuestFromHistory,
  rescheduleQuestInHistory,
} from "../src/app/quest-logic";
import type { CompletionHistory, CompletionSnapshot, Quest } from "../src/app/quest-types";

const todayKey = "2026-10-19";

function makeQuest(overrides: Partial<Quest> = {}): Quest {
  return {
    id: "quest",
    title: "Test quest",
    category: "Wellness",
    schedule: "Mon",
    difficulty: "Easy",
    completed: false,
    repeatSchedule: "Selected days",
    selectedDays: ["Mon"],
    ...overrides,
  };
}

function snapshot(scheduledQuestIds: string[], completedQuestIds: string[] = []): CompletionSnapshot {
  return { scheduledQuestIds, completedQuestIds };
}

function historyWithToday(today: CompletionSnapshot): CompletionHistory {
  return {
    "2026-10-17": snapshot(["past"], ["past"]),
    "2026-10-18": snapshot(["yesterday"], ["yesterday"]),
    [todayKey]: today,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((child) => deepFreeze(child));
    Object.freeze(value);
  }
  return value;
}

describe("daily completion snapshot synchronization", () => {
  it("adds a quest scheduled today", () => {
    const history = historyWithToday(snapshot(["existing"]));
    const next = addQuestToHistory(history, makeQuest({ id: "new" }), todayKey);

    expect(next[todayKey]).toEqual(snapshot(["existing", "new"]));
    expect(next).not.toBe(history);
  });

  it("uses the action date for additions and preserves snapshot ledger fields", () => {
    const yesterday = "2026-10-19";
    const actionDate = new Date(2026, 9, 20);
    const today = "2026-10-20";
    const history: CompletionHistory = {
      [yesterday]: { ...snapshot(["old"], ["old"]), xpAwardedByQuestId: { old: 5 } },
      [today]: { ...snapshot(["existing"]), xpAwardedByQuestId: { existing: 10 } },
    };

    const next = addQuestToHistoryAtDate(history, makeQuest({ id: "new", selectedDays: ["Tue"] }), actionDate);

    expect(next[yesterday]).toBe(history[yesterday]);
    expect(next[today]).toEqual({
      scheduledQuestIds: ["existing", "new"],
      completedQuestIds: [],
      xpAwardedByQuestId: { existing: 10 },
    });
  });

  it("leaves history unchanged when an added quest is not scheduled today", () => {
    const history = historyWithToday(snapshot(["existing"]));
    const result = addQuestToHistory(history, makeQuest({ id: "tuesday", selectedDays: ["Tue"] }), todayKey);

    expect(result).toBe(history);
  });

  it("does not add a duplicate scheduled ID", () => {
    const history = historyWithToday(snapshot(["quest"]));

    expect(addQuestToHistory(history, makeQuest(), todayKey)).toBe(history);
  });

  it("returns the same history for an absent snapshot before checking the schedule", () => {
    const history: CompletionHistory = { "2026-10-18": snapshot(["yesterday"], ["yesterday"]) };

    expect(addQuestToHistory(history, makeQuest(), todayKey)).toBe(history);
  });

  it("removes an incomplete quest from today's scheduled IDs", () => {
    const history = historyWithToday(snapshot(["a", "b"]));
    const next = removeQuestFromHistory(history, "b", todayKey);

    expect(next[todayKey]).toEqual(snapshot(["a"]));
  });

  it("uses the action date for deletions and preserves snapshot ledger fields", () => {
    const actionDate = new Date(2026, 9, 20);
    const history: CompletionHistory = {
      "2026-10-19": { ...snapshot(["old"], ["old"]), xpAwardedByQuestId: { old: 5 } },
      "2026-10-20": { ...snapshot(["remove", "keep"]), xpAwardedByQuestId: { remove: 10, keep: 20 } },
    };

    const next = removeQuestFromHistoryAtDate(history, "remove", actionDate);

    expect(next["2026-10-19"]).toBe(history["2026-10-19"]);
    expect(next["2026-10-20"]).toEqual({
      scheduledQuestIds: ["keep"],
      completedQuestIds: [],
      xpAwardedByQuestId: { remove: 10, keep: 20 },
    });
  });

  it("preserves completed quest history, XP, and prior snapshots when deleted today", () => {
    const priorDaySnapshot = {
      ...snapshot(["prior"], ["prior"]),
      xpAwardedByQuestId: { prior: 20 },
    };
    const todaySnapshot = {
      ...snapshot(["a", "b"], ["a", "b"]),
      xpAwardedByQuestId: { a: 10, b: 5 },
    };
    const history = {
      ...historyWithToday(todaySnapshot),
      "2026-10-18": priorDaySnapshot,
    };

    const next = removeQuestFromHistory(history, "a", todayKey);

    expect(next).toBe(history);
    expect(next[todayKey].scheduledQuestIds).toEqual(["a", "b"]);
    expect(next[todayKey].completedQuestIds).toEqual(["a", "b"]);
    expect(next[todayKey].xpAwardedByQuestId).toEqual({ a: 10, b: 5 });
    expect(next[todayKey]).toEqual(todaySnapshot);
    expect(next["2026-10-18"]).toBe(priorDaySnapshot);
    expect(next["2026-10-18"]).toEqual(priorDaySnapshot);
  });

  it("leaves the history unchanged when the deleted ID is not scheduled today", () => {
    const history = historyWithToday(snapshot(["a"]));

    expect(removeQuestFromHistory(history, "missing", todayKey)).toBe(history);
  });

  it("returns the same history for deletion when today's snapshot is absent", () => {
    const history: CompletionHistory = { "2026-10-18": snapshot(["yesterday"], ["yesterday"]) };

    expect(removeQuestFromHistory(history, "quest", todayKey)).toBe(history);
  });

  it("adds a quest rescheduled into today", () => {
    const history = historyWithToday(snapshot(["existing"]));
    const next = rescheduleQuestInHistory(history, makeQuest({ id: "new" }), todayKey);

    expect(next[todayKey]).toEqual(snapshot(["existing", "new"]));
  });

  it("adds a quest rescheduled into today once and preserves the full snapshot", () => {
    const saturdayKey = "2026-10-17";
    const priorSnapshot = snapshot(["prior"], ["prior"]);
    const todaySnapshot = {
      ...snapshot(["existing"], ["existing"]),
      xpAwardedByQuestId: { existing: 10 },
      note: "preserve this field",
    };
    const history: CompletionHistory = {
      "2026-10-16": priorSnapshot,
      [saturdayKey]: todaySnapshot,
    };
    const saturdayQuest = makeQuest({
      id: "water",
      schedule: "Sat",
      repeatSchedule: "Selected days",
      selectedDays: ["Sat"],
    });

    const next = rescheduleQuestInHistory(history, saturdayQuest, saturdayKey);
    const addedAgain = rescheduleQuestInHistory(next, saturdayQuest, saturdayKey);

    expect(next[saturdayKey]).toEqual({
      ...todaySnapshot,
      scheduledQuestIds: ["existing", "water"],
    });
    expect(addedAgain).toBe(next);
    expect(next["2026-10-16"]).toBe(priorSnapshot);
  });

  it("removes an incomplete quest rescheduled out of today", () => {
    const history = historyWithToday(snapshot(["a", "b"]));
    const next = rescheduleQuestInHistory(
      history,
      makeQuest({ id: "b", selectedDays: ["Tue"] }),
      todayKey,
    );

    expect(next[todayKey]).toEqual(snapshot(["a"]));
  });

  it("removes an incomplete quest no longer scheduled today and preserves snapshot fields", () => {
    const saturdayKey = "2026-10-17";
    const priorSnapshot = snapshot(["prior"], ["prior"]);
    const todaySnapshot = {
      ...snapshot(["water", "other"], ["other"]),
      xpAwardedByQuestId: { water: 10, other: 5 },
      note: "preserve this field",
    };
    const history: CompletionHistory = {
      "2026-10-16": priorSnapshot,
      [saturdayKey]: todaySnapshot,
    };
    const water = makeQuest({
      id: "water",
      schedule: "Mon, Wed, Tue",
      repeatSchedule: "Selected days",
      selectedDays: ["Mon", "Wed", "Tue"],
    });

    const next = rescheduleQuestInHistory(history, water, saturdayKey);

    expect(next[saturdayKey]).toEqual({
      ...todaySnapshot,
      scheduledQuestIds: ["other"],
    });
    expect(next[saturdayKey].completedQuestIds).toEqual(["other"]);
    expect(next[saturdayKey].xpAwardedByQuestId).toEqual({ water: 10, other: 5 });
    expect(next["2026-10-16"]).toBe(priorSnapshot);
  });

  it("keeps a completed quest rescheduled out of today", () => {
    const todaySnapshot = {
      ...snapshot(["a"], ["a"]),
      xpAwardedByQuestId: { a: 10 },
      note: "preserve this field",
    };
    const history = historyWithToday(todaySnapshot);

    expect(rescheduleQuestInHistory(
      history,
      makeQuest({ id: "a", selectedDays: ["Tue"] }),
      todayKey,
    )).toBe(history);
    expect(history[todayKey]).toEqual(todaySnapshot);
  });

  it("does not reschedule when the current schedule still applies to today", () => {
    const history = historyWithToday(snapshot(["quest"]));

    expect(rescheduleQuestInHistory(history, makeQuest(), todayKey)).toBe(history);
  });

  it("leaves an already scheduled quest unchanged during rescheduling", () => {
    const history = historyWithToday(snapshot(["quest"]));

    expect(rescheduleQuestInHistory(history, makeQuest(), todayKey)).toBe(history);
  });

  it("returns the same history for rescheduling when today's snapshot is absent", () => {
    const history: CompletionHistory = { "2026-10-18": snapshot(["yesterday"], ["yesterday"]) };

    expect(rescheduleQuestInHistory(history, makeQuest(), todayKey)).toBe(history);
  });

  it.each([
    ["add", (history: CompletionHistory) => addQuestToHistory(history, makeQuest({ id: "new" }), todayKey)],
    ["delete", (history: CompletionHistory) => removeQuestFromHistory(history, "b", todayKey)],
    ["reschedule", (history: CompletionHistory) => rescheduleQuestInHistory(history, makeQuest({ id: "new" }), todayKey)],
  ])("preserves earlier snapshot references after %s", (_operation, operation) => {
    const history = historyWithToday(snapshot(["b"]));
    const pastSnapshot = history["2026-10-17"];
    const yesterdaySnapshot = history["2026-10-18"];

    const next = operation(history);

    expect(next["2026-10-17"]).toBe(pastSnapshot);
    expect(next["2026-10-18"]).toBe(yesterdaySnapshot);
  });

  it("does not mutate deeply frozen histories", () => {
    const history = deepFreeze(historyWithToday(snapshot(["a", "b"], ["a"]))) as CompletionHistory;
    const before = JSON.stringify(history);

    expect(() => {
      addQuestToHistory(history, makeQuest({ id: "new" }), todayKey);
      removeQuestFromHistory(history, "b", todayKey);
      removeQuestFromHistory(history, "a", todayKey);
      rescheduleQuestInHistory(history, makeQuest({ id: "new" }), todayKey);
      rescheduleQuestInHistory(history, makeQuest({ id: "b", selectedDays: ["Tue"] }), todayKey);
    }).not.toThrow();
    expect(JSON.stringify(history)).toBe(before);
    expect(history[todayKey].scheduledQuestIds).toEqual(["a", "b"]);
    expect(history[todayKey].completedQuestIds).toEqual(["a"]);
  });

  it("lets today's streak qualify after deleting an incomplete quest", () => {
    const history = historyWithToday(snapshot(["a", "b"], ["a"]));
    const next = removeQuestFromHistory(history, "b", todayKey);

    expect(getSnapshotStatus(next[todayKey])).toBe("complete");
    expect(getStreakValues(next, todayKey).currentStreak).toBe(3);
  });

  it("preserves today's status and streak when deleting a completed quest", () => {
    const history = historyWithToday(snapshot(["a", "b"], ["a", "b"]));
    const statusBefore = getSnapshotStatus(history[todayKey]);
    const streakBefore = getStreakValues(history, todayKey);
    const next = removeQuestFromHistory(history, "a", todayKey);

    expect(next).toBe(history);
    expect(getSnapshotStatus(next[todayKey])).toBe(statusBefore);
    expect(getStreakValues(next, todayKey)).toEqual(streakBefore);
  });

  it("offers only scheduled, incomplete IDs absent from the current Daily Quest list", () => {
    const todaySnapshot = {
      ...snapshot(["orphan", "completed-orphan", "current"], ["completed-orphan"]),
      xpAwardedByQuestId: { "completed-orphan": 10 },
    };

    expect(getRecoverableOrphanedDailyQuestIds(todaySnapshot, [makeQuest({ id: "current" })]))
      .toEqual(["orphan"]);
  });

  it("requires confirmation and recovers only the current day's incomplete orphan", () => {
    const priorDaySnapshot = {
      ...snapshot(["prior-orphan"], []),
      xpAwardedByQuestId: { prior: 5 },
      note: "keep this field",
    };
    const todaySnapshot = {
      ...snapshot(["orphan", "completed-orphan", "current"], ["completed-orphan"]),
      xpAwardedByQuestId: { orphan: 7, "completed-orphan": 10 },
      note: "also keep this field",
    };
    const history: CompletionHistory = {
      "2026-10-18": priorDaySnapshot,
      [todayKey]: todaySnapshot,
    };
    const dailyQuests = [makeQuest({ id: "current" })];

    expect(recoverOrphanedDailyQuestFromHistory(history, "orphan", dailyQuests, todayKey, false))
      .toBe(history);

    const recovered = recoverOrphanedDailyQuestFromHistory(history, "orphan", dailyQuests, todayKey, true);

    expect(recovered[todayKey]).toEqual({
      ...todaySnapshot,
      scheduledQuestIds: ["completed-orphan", "current"],
    });
    expect(recovered[todayKey].completedQuestIds).toEqual(["completed-orphan"]);
    expect(recovered[todayKey].xpAwardedByQuestId).toEqual({ orphan: 7, "completed-orphan": 10 });
    expect(recovered["2026-10-18"]).toBe(priorDaySnapshot);
  });

  it("rejects stale or invalid recovery candidates without changing history", () => {
    const history = historyWithToday(snapshot(["orphan", "completed-orphan"], ["completed-orphan"]));
    const currentQuest = makeQuest({ id: "orphan" });

    expect(recoverOrphanedDailyQuestFromHistory(history, "orphan", [currentQuest], todayKey, true))
      .toBe(history);
    expect(recoverOrphanedDailyQuestFromHistory(history, "completed-orphan", [], todayKey, true))
      .toBe(history);
    expect(recoverOrphanedDailyQuestFromHistory(history, "not-scheduled", [], todayKey, true))
      .toBe(history);
    expect(recoverOrphanedDailyQuestFromHistory(history, "orphan", [], "2026-10-20", true))
      .toBe(history);
  });
});
