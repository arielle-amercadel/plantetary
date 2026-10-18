import { describe, expect, it } from "vitest";
import {
  clearPersonalCompletionDate,
  getCompletedOverallCounts,
  getCompletedTodayCounts,
  preserveDeletedLegacyPersonalCompletionCount,
  recordPersonalCompletionDate,
  toggleDailyQuestCompletion,
} from "../src/app/quest-logic";
import type { CompletionHistory, Quest } from "../src/app/quest-types";

const todayKey = "2026-10-19";
const yesterdayKey = "2026-10-18";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach((child) => deepFreeze(child));
  }
  return value;
}

function personalQuest(overrides: Partial<Quest> = {}): Quest {
  return {
    id: "personal-1",
    title: "Personal quest",
    category: "Personal",
    schedule: "No due date",
    difficulty: "Easy",
    completed: false,
    ...overrides,
  };
}

describe("quest completion counts", () => {
  it("counts only today's daily completions that were scheduled", () => {
    const history = deepFreeze<CompletionHistory>({
      [todayKey]: {
        scheduledQuestIds: ["scheduled", "scheduled"],
        completedQuestIds: ["scheduled", "not-scheduled"],
      },
    });

    expect(getCompletedTodayCounts(history, undefined, todayKey)).toEqual({
      daily: 1,
      personal: 0,
      total: 1,
    });
  });

  it("counts a daily quest completed on two dates twice overall", () => {
    const history = deepFreeze<CompletionHistory>({
      [yesterdayKey]: { scheduledQuestIds: ["daily"], completedQuestIds: ["daily"] },
      [todayKey]: { scheduledQuestIds: ["daily"], completedQuestIds: ["daily"] },
    });

    expect(getCompletedOverallCounts(history, undefined, [])).toEqual({
      daily: 2,
      personal: 0,
      total: 2,
    });
  });

  it("counts personal completions today and on earlier dates in the right totals", () => {
    const dates = deepFreeze({ current: todayKey, previous: yesterdayKey });

    expect(getCompletedTodayCounts(undefined, dates, todayKey)).toEqual({
      daily: 0,
      personal: 1,
      total: 1,
    });
    expect(getCompletedOverallCounts(undefined, dates, [])).toEqual({
      daily: 0,
      personal: 2,
      total: 2,
    });
  });

  it("counts a currently completed legacy personal quest overall but not today", () => {
    const quests = deepFreeze([personalQuest({ completed: true })]);

    expect(getCompletedTodayCounts(undefined, undefined, todayKey)).toEqual({
      daily: 0,
      personal: 0,
      total: 0,
    });
    expect(getCompletedOverallCounts(undefined, undefined, quests)).toEqual({
      daily: 0,
      personal: 1,
      total: 1,
    });
  });

  it("removes a personal completion when unchecked and preserves the daily uncheck behavior", () => {
    const originalDates = deepFreeze({ personal: todayKey });
    const uncheckedDates = clearPersonalCompletionDate(originalDates, "personal");
    const personalAfterUncheck = getCompletedOverallCounts(undefined, uncheckedDates, [
      personalQuest({ id: "personal", completed: false }),
    ]);
    const originalHistory = deepFreeze<CompletionHistory>({
      [todayKey]: {
        scheduledQuestIds: ["daily"],
        completedQuestIds: ["daily"],
        xpAwardedByQuestId: { daily: 5 },
      },
    });
    const dailyAfterUncheck = toggleDailyQuestCompletion(originalHistory, todayKey, "daily", "Easy");

    expect(getCompletedTodayCounts(undefined, originalDates, todayKey).total).toBe(1);
    expect(personalAfterUncheck.total).toBe(0);
    expect(getCompletedOverallCounts(dailyAfterUncheck, undefined, []).total).toBe(0);
    expect(dailyAfterUncheck[todayKey].completedQuestIds).toEqual([]);
    expect(dailyAfterUncheck[todayKey].xpAwardedByQuestId).toBeUndefined();
  });

  it("keeps dated completions counted after deletion and preserves deleted legacy completions without a date", () => {
    const dates = deepFreeze({ dated: yesterdayKey });
    const datedBefore = getCompletedOverallCounts(undefined, dates, [personalQuest({ id: "dated", completed: true })]);
    const datedAfter = getCompletedOverallCounts(undefined, dates, []);
    const legacy = deepFreeze(personalQuest({ id: "legacy", completed: true }));
    const legacyBefore = getCompletedOverallCounts(undefined, undefined, [legacy]);
    const deletedLegacyCount = preserveDeletedLegacyPersonalCompletionCount(undefined, legacy, undefined);
    const legacyAfter = getCompletedOverallCounts(undefined, undefined, [], deletedLegacyCount);

    expect(datedAfter).toEqual(datedBefore);
    expect(datedAfter.total).toBe(1);
    expect(legacyBefore.total).toBe(1);
    expect(legacyAfter).toEqual(legacyBefore);
    expect(legacyAfter.personal).toBe(1);
  });

  it("ignores missing and malformed completion data safely", () => {
    const malformedHistory = {
      [todayKey]: { scheduledQuestIds: ["daily"], completedQuestIds: "daily" },
      "not-a-date": { scheduledQuestIds: ["other"], completedQuestIds: ["other"] },
    } as unknown as CompletionHistory;
    const malformedDates = {
      invalid: 123,
      alsoInvalid: "not-a-date",
      impossibleDate: "2026-02-30",
      "": todayKey,
    } as unknown as Record<string, string>;

    expect(getCompletedTodayCounts(undefined, undefined, todayKey)).toEqual({ daily: 0, personal: 0, total: 0 });
    expect(getCompletedOverallCounts(undefined, undefined, undefined)).toEqual({ daily: 0, personal: 0, total: 0 });
    expect(getCompletedTodayCounts(malformedHistory, malformedDates, todayKey)).toEqual({ daily: 0, personal: 0, total: 0 });
    expect(getCompletedOverallCounts(malformedHistory, malformedDates, undefined)).toEqual({ daily: 0, personal: 0, total: 0 });
  });

  it("keeps each total equal to its daily and personal breakdown", () => {
    const history = deepFreeze<CompletionHistory>({
      [yesterdayKey]: { scheduledQuestIds: ["daily-1"], completedQuestIds: ["daily-1"] },
      [todayKey]: { scheduledQuestIds: ["daily-2"], completedQuestIds: ["daily-2", "orphan"] },
    });
    const dates = deepFreeze({ personal: todayKey, deleted: yesterdayKey });
    const quests = deepFreeze([personalQuest({ id: "legacy", completed: true })]);
    const today = getCompletedTodayCounts(history, dates, todayKey);
    const overall = getCompletedOverallCounts(history, dates, quests, 1);

    expect(today.total).toBe(today.daily + today.personal);
    expect(overall.total).toBe(overall.daily + overall.personal);
  });
});

describe("personal completion date helpers", () => {
  it("records a date without mutating input and keeps the same reference for an unchanged date", () => {
    const original = deepFreeze({ personal: todayKey });
    const recorded = recordPersonalCompletionDate(original, "second", todayKey);

    expect(recorded).toEqual({ personal: todayKey, second: todayKey });
    expect(recorded).not.toBe(original);
    expect(original).toEqual({ personal: todayKey });
    expect(recordPersonalCompletionDate(original, "personal", todayKey)).toBe(original);
  });

  it("clears a date without mutating input and keeps the same reference for a no-op", () => {
    const original = deepFreeze({ personal: todayKey, other: yesterdayKey });
    const cleared = clearPersonalCompletionDate(original, "personal");

    expect(cleared).toEqual({ other: yesterdayKey });
    expect(cleared).not.toBe(original);
    expect(original).toEqual({ personal: todayKey, other: yesterdayKey });
    expect(clearPersonalCompletionDate(original, "missing")).toBe(original);
    expect(clearPersonalCompletionDate(undefined, "missing")).toBeUndefined();
  });
});
