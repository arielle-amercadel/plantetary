import { describe, expect, it } from "vitest";
import {
  addQuestToHistory,
  getSnapshotStatus,
  getStreakValues,
  removeQuestFromHistory,
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

  it("leaves the history unchanged when the deleted quest was completed today", () => {
    const history = historyWithToday(snapshot(["a"], ["a"]));

    expect(removeQuestFromHistory(history, "a", todayKey)).toBe(history);
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

  it("removes an incomplete quest rescheduled out of today", () => {
    const history = historyWithToday(snapshot(["a", "b"]));
    const next = rescheduleQuestInHistory(
      history,
      makeQuest({ id: "b", selectedDays: ["Tue"] }),
      todayKey,
    );

    expect(next[todayKey]).toEqual(snapshot(["a"]));
  });

  it("keeps a completed quest rescheduled out of today", () => {
    const history = historyWithToday(snapshot(["a"], ["a"]));

    expect(rescheduleQuestInHistory(
      history,
      makeQuest({ id: "a", selectedDays: ["Tue"] }),
      todayKey,
    )).toBe(history);
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
});
