import { describe, expect, it } from "vitest";
import {
  createSnapshot,
  ensureCompletionSnapshotForDate,
  findCategoryMatch,
  formatLocalDateLabel,
  formatWeekdaySchedule,
  getDailyQuestScheduleLabel,
  getCustomCategoryError,
  getLevelProgress,
  getLocalDateKey,
  getQuestXp,
  getSnapshotStatus,
  getStreakValues,
  isQuestScheduledOnDate,
} from "../src/app/quest-logic";
import type { CompletionHistory, CompletionSnapshot, Quest } from "../src/app/quest-types";

const monday = new Date(2026, 9, 19);
const tuesday = new Date(2026, 9, 20);

function makeQuest(overrides: Partial<Quest> = {}): Quest {
  return {
    id: "quest",
    title: "Test quest",
    category: "Wellness",
    schedule: "Every day",
    difficulty: "Easy",
    completed: false,
    ...overrides,
  };
}

function snapshot(scheduledQuestIds: string[], completedQuestIds: string[] = []): CompletionSnapshot {
  return { scheduledQuestIds, completedQuestIds };
}

describe("XP and level logic", () => {
  it("returns XP by difficulty", () => {
    expect(getQuestXp("Easy")).toBe(5);
    expect(getQuestXp("Medium")).toBe(10);
    expect(getQuestXp("Hard")).toBe(20);
  });

  it.each([
    [0, 1, 0, 100],
    [99, 1, 99, 100],
    [100, 2, 0, 150],
    [249, 2, 149, 150],
    [250, 3, 0, 200],
  ])("calculates level progress for %i total XP", (totalXp, level, xpIntoLevel, xpForNextLevel) => {
    expect(getLevelProgress(totalXp)).toMatchObject({ level, xpIntoLevel, xpForNextLevel });
  });

  it("calculates a progress percentage", () => {
    expect(getLevelProgress(50).xpProgressPercent).toBe(50);
  });
});

describe("local dates and quest schedules", () => {
  it("formats a local calendar date", () => {
    expect(getLocalDateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("matches every-day, selected-day, and legacy schedules", () => {
    expect(isQuestScheduledOnDate(makeQuest({ repeatSchedule: "Every day" }), monday)).toBe(true);
    expect(isQuestScheduledOnDate(makeQuest({ repeatSchedule: "Every day" }), tuesday)).toBe(true);
    expect(isQuestScheduledOnDate(makeQuest({
      repeatSchedule: "Selected days",
      selectedDays: ["Mon", "Wed"],
    }), monday)).toBe(true);
    expect(isQuestScheduledOnDate(makeQuest({
      repeatSchedule: "Selected days",
      selectedDays: ["Mon", "Wed"],
    }), tuesday)).toBe(false);
    expect(isQuestScheduledOnDate(makeQuest({ schedule: "Every day" }), tuesday)).toBe(true);
    expect(isQuestScheduledOnDate(makeQuest({ schedule: "Mon, Wed" }), monday)).toBe(true);
    expect(isQuestScheduledOnDate(makeQuest({ schedule: "Mon, Wed" }), tuesday)).toBe(false);
    expect(isQuestScheduledOnDate(makeQuest({ schedule: "Due today" }), monday)).toBe(false);
  });

  it("formats selected weekdays in Monday-to-Sunday order without changing the selection", () => {
    const clickedOrder: Quest["selectedDays"] = ["Wed", "Mon", "Tue"];
    const quest = makeQuest({
      schedule: "Wed, Mon, Tue",
      repeatSchedule: "Selected days",
      selectedDays: clickedOrder,
    });

    expect(formatWeekdaySchedule(clickedOrder)).toBe("Mon, Tue, Wed");
    expect(getDailyQuestScheduleLabel(quest)).toBe("Mon, Tue, Wed");
    expect(quest.selectedDays).toEqual(["Wed", "Mon", "Tue"]);
  });

  it("formats legacy weekday labels chronologically and preserves non-weekday labels", () => {
    expect(getDailyQuestScheduleLabel(makeQuest({ schedule: "Wed, Mon, Tue" })))
      .toBe("Mon, Tue, Wed");
    expect(getDailyQuestScheduleLabel(makeQuest({ schedule: "Every day" }))).toBe("Every day");
    expect(getDailyQuestScheduleLabel(makeQuest({ schedule: "Due Oct 17" }))).toBe("Due Oct 17");
  });
});

describe("completion snapshots and streaks", () => {
  it("reports snapshot status, including the current missing-snapshot behavior", () => {
    expect(getSnapshotStatus(undefined)).toBe("unscheduled");
    expect(getSnapshotStatus(snapshot([]))).toBe("unscheduled");
    expect(getSnapshotStatus(snapshot(["a", "b"], ["a", "b"]))).toBe("complete");
    expect(getSnapshotStatus(snapshot(["a", "b"], ["a"]))).toBe("incomplete");
  });

  it("creates a snapshot with only quests scheduled on that date and no completions", () => {
    const quests = [
      makeQuest({ id: "daily", repeatSchedule: "Every day" }),
      makeQuest({ id: "monday", repeatSchedule: "Selected days", selectedDays: ["Mon"] }),
      makeQuest({ id: "tuesday", repeatSchedule: "Selected days", selectedDays: ["Tue"] }),
    ];
    expect(createSnapshot(quests, monday)).toEqual({
      scheduledQuestIds: ["daily", "monday"],
      completedQuestIds: [],
    });
  });

  it("uses the local calendar date and weekday near midnight", () => {
    const lateSaturday = new Date(2026, 9, 17, 23, 30);
    const dailySaturday = makeQuest({
      repeatSchedule: "Selected days",
      selectedDays: ["Sat"],
    });

    expect(getLocalDateKey(lateSaturday)).toBe("2026-10-17");
    expect(isQuestScheduledOnDate(dailySaturday, lateSaturday)).toBe(true);
    expect(formatLocalDateLabel(lateSaturday, "en-US")).toBe("Saturday, October 17");
    if (lateSaturday.toISOString().slice(0, 10) !== getLocalDateKey(lateSaturday)) {
      expect(getLocalDateKey(lateSaturday)).toBe("2026-10-17");
    }
  });

  it("creates one snapshot on local-date rollover without replacing existing history or XP", () => {
    const quests = [makeQuest({ id: "every-day" })];
    const history: CompletionHistory = {
      "2026-10-17": {
        scheduledQuestIds: ["every-day"],
        completedQuestIds: ["every-day"],
        xpAwardedByQuestId: { "every-day": 10 },
      },
    };

    const afterRollover = ensureCompletionSnapshotForDate(history, quests, "2026-10-18");
    const repeatedUpdate = ensureCompletionSnapshotForDate(afterRollover, quests, "2026-10-18");

    expect(afterRollover["2026-10-18"]).toEqual({
      scheduledQuestIds: ["every-day"],
      completedQuestIds: [],
    });
    expect(afterRollover["2026-10-17"]).toEqual(history["2026-10-17"]);
    expect(repeatedUpdate).toBe(afterRollover);
    expect(repeatedUpdate["2026-10-17"].xpAwardedByQuestId).toEqual({ "every-day": 10 });
  });

  it("returns zero streaks for empty history", () => {
    expect(getStreakValues({}, "2026-10-21")).toEqual({ currentStreak: 0, longestStreak: 0 });
  });

  it("keeps a streak through an unfinished current day", () => {
    const history: CompletionHistory = {
      "2026-10-19": snapshot(["a"], ["a"]),
      "2026-10-20": snapshot(["a"], ["a"]),
      "2026-10-21": snapshot(["a"]),
    };
    expect(getStreakValues(history, "2026-10-21")).toEqual({ currentStreak: 2, longestStreak: 2 });
  });

  it("includes today once today qualifies", () => {
    const history: CompletionHistory = {
      "2026-10-19": snapshot(["a"], ["a"]),
      "2026-10-20": snapshot(["a"], ["a"]),
      "2026-10-21": snapshot(["a"], ["a"]),
    };
    expect(getStreakValues(history, "2026-10-21")).toEqual({ currentStreak: 3, longestStreak: 3 });
  });

  it("breaks the longest run across a missing calendar day", () => {
    const history: CompletionHistory = {
      "2026-10-19": snapshot(["a"], ["a"]),
      "2026-10-21": snapshot(["a"], ["a"]),
    };
    expect(getStreakValues(history, "2026-10-21")).toEqual({ currentStreak: 1, longestStreak: 1 });
  });

  it("skips a recorded unscheduled day between complete days", () => {
    const history: CompletionHistory = {
      "2026-10-19": snapshot(["a"], ["a"]),
      "2026-10-20": snapshot([]),
      "2026-10-21": snapshot(["a"], ["a"]),
    };
    expect(getStreakValues(history, "2026-10-21")).toEqual({ currentStreak: 2, longestStreak: 2 });
  });

  it("breaks the current streak at a scheduled incomplete day", () => {
    const history: CompletionHistory = {
      "2026-10-19": snapshot(["a"], ["a"]),
      "2026-10-20": snapshot(["a"]),
      "2026-10-21": snapshot(["a"]),
    };
    expect(getStreakValues(history, "2026-10-21").currentStreak).toBe(0);
  });
});

describe("category helpers", () => {
  const categories = ["Wellness", "Self-care"];

  it("matches categories without case or surrounding-space sensitivity", () => {
    expect(findCategoryMatch(categories, "  wELLNESS ")).toBe("Wellness");
    expect(findCategoryMatch(categories, "New category")).toBeUndefined();
  });

  it("returns the appropriate custom-category errors", () => {
    expect(getCustomCategoryError(categories, "   ")).toBe("Enter a category name.");
    expect(getCustomCategoryError(categories, "  WELLNESS ")).toBe("That category already exists.");
    expect(getCustomCategoryError(categories, "Gardening")).toBe("");
  });
});
