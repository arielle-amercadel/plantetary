import { describe, expect, it } from "vitest";
import {
  createSnapshot,
  ensureCompletionSnapshotForDate,
  findCategoryMatch,
  formatLocalDateLabel,
  formatWeekdaySchedule,
  getCompletedOverallCounts,
  getCompletionHistoryView,
  getDailyQuestScheduleLabel,
  getDailyQuestsForDisplay,
  getCustomCategoryError,
  getLevelProgress,
  getLocalDateKey,
  getQuestListProgress,
  getQuestXp,
  getSnapshotStatus,
  getStreakValues,
  getXpLedgerTotal,
  isQuestPastDue,
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

  it("marks only incomplete Personal Quests with a valid past local due date", () => {
    const todayKey = getLocalDateKey(new Date(2026, 9, 18, 0, 15));
    const personal = makeQuest({ schedule: "Due Oct 17", dueDate: "2026-10-17" });

    expect(isQuestPastDue(personal, "personal", todayKey)).toBe(true);
    expect(isQuestPastDue({ ...personal, dueDate: todayKey }, "personal", todayKey)).toBe(false);
    expect(isQuestPastDue({ ...personal, dueDate: "2026-10-19" }, "personal", todayKey)).toBe(false);
    expect(isQuestPastDue({ ...personal, completed: true }, "personal", todayKey)).toBe(false);
    expect(isQuestPastDue({ ...personal, dueDate: undefined }, "personal", todayKey)).toBe(false);
    expect(isQuestPastDue(personal, "daily", todayKey)).toBe(false);
    expect(isQuestPastDue({ ...personal, dueDate: "2026-02-30" }, "personal", todayKey)).toBe(false);
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

  describe("filling days the app was not opened", () => {
    const mondayOnly = makeQuest({ id: "mon", schedule: "Mon", repeatSchedule: "Selected days", selectedDays: ["Mon"] });
    const completedMonday: CompletionHistory = {
      "2026-10-19": { ...snapshot(["mon"], ["mon"]), xpAwardedByQuestId: { mon: 5 } },
    };

    it("records every day since the latest record, with nothing scheduled on the empty ones", () => {
      const next = ensureCompletionSnapshotForDate(completedMonday, [mondayOnly], "2026-10-26");

      expect(Object.keys(next).sort()).toEqual([
        "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26",
      ]);
      expect(next["2026-10-22"]).toEqual(snapshot([]));
      expect(next["2026-10-26"]).toEqual(snapshot(["mon"]));
    });

    it("preserves the streak across days with nothing scheduled, without increasing it", () => {
      const next = ensureCompletionSnapshotForDate(completedMonday, [mondayOnly], "2026-10-26");

      expect(getStreakValues(next, "2026-10-26")).toEqual({ currentStreak: 1, longestStreak: 1 });
    });

    it("counts successful scheduled days rather than calendar days", () => {
      const nextMonday = ensureCompletionSnapshotForDate(completedMonday, [mondayOnly], "2026-10-26");
      const completedAgain = { ...nextMonday, "2026-10-26": snapshot(["mon"], ["mon"]) };

      expect(getStreakValues(completedAgain, "2026-10-26")).toEqual({ currentStreak: 2, longestStreak: 2 });
    });

    it("breaks the streak after a scheduled day that passed unopened, but not while that day is today", () => {
      const onMissedDay = ensureCompletionSnapshotForDate(completedMonday, [mondayOnly], "2026-10-26");
      const dayAfterMissedDay = ensureCompletionSnapshotForDate(completedMonday, [mondayOnly], "2026-10-27");

      expect(getStreakValues(onMissedDay, "2026-10-26").currentStreak).toBe(1);
      expect(dayAfterMissedDay["2026-10-26"]).toEqual(snapshot(["mon"]));
      expect(getStreakValues(dayAfterMissedDay, "2026-10-27").currentStreak).toBe(0);
      expect(getStreakValues(dayAfterMissedDay, "2026-10-27").longestStreak).toBe(1);
    });

    it("never overwrites existing records or changes XP, counts, or history", () => {
      const next = ensureCompletionSnapshotForDate(completedMonday, [makeQuest({ id: "new-quest" })], "2026-10-26");

      expect(next["2026-10-19"]).toBe(completedMonday["2026-10-19"]);
      expect(getXpLedgerTotal(next)).toBe(5);
      expect(getCompletedOverallCounts(next, undefined, [], 0).total).toBe(1);
      expect(getCompletionHistoryView(next, undefined, undefined, [], 0, [mondayOnly]).sections.map((section) => section.dateKey))
        .toEqual(["2026-10-19"]);
      expect(completedMonday).toEqual({
        "2026-10-19": { ...snapshot(["mon"], ["mon"]), xpAwardedByQuestId: { mon: 5 } },
      });
    });

    it("leaves gaps before the latest record alone, because their schedules are unknown", () => {
      const history: CompletionHistory = {
        "2026-10-05": snapshot(["mon"], ["mon"]),
        "2026-10-19": snapshot(["mon"], ["mon"]),
      };
      const next = ensureCompletionSnapshotForDate(history, [mondayOnly], "2026-10-20");

      expect(Object.keys(next).sort()).toEqual(["2026-10-05", "2026-10-19", "2026-10-20"]);
    });

    it("fills nothing for a brand-new history or a date earlier than the latest record", () => {
      expect(Object.keys(ensureCompletionSnapshotForDate({}, [mondayOnly], "2026-10-26"))).toEqual(["2026-10-26"]);
      expect(Object.keys(ensureCompletionSnapshotForDate(completedMonday, [mondayOnly], "2026-10-10")).sort())
        .toEqual(["2026-10-10", "2026-10-19"]);
    });

    it("returns the same history when today is already recorded", () => {
      const history = { ...completedMonday, "2026-10-26": snapshot(["mon"]) };

      expect(ensureCompletionSnapshotForDate(history, [mondayOnly], "2026-10-26")).toBe(history);
    });

    it("does not skip days across month ends, year ends, or clock changes", () => {
      const next = ensureCompletionSnapshotForDate({ "2026-10-30": snapshot([]) }, [mondayOnly], "2027-01-03");
      const keys = Object.keys(next).sort();

      expect(keys).toHaveLength(66);
      expect(keys).toContain("2026-11-01");
      expect(keys).toContain("2026-12-31");
      expect(keys).toContain("2027-01-01");
    });
  });

  describe("Daily Quest checkmarks and progress", () => {
    const today = makeQuest({ id: "today" });
    const otherDay = makeQuest({ id: "other-day", schedule: "Tue", repeatSchedule: "Selected days", selectedDays: ["Tue"] });

    it("uses today's completions and ignores the saved flag in both directions", () => {
      const quests = [
        makeQuest({ id: "done", completed: false }),
        makeQuest({ id: "not-done", completed: true }),
        { ...otherDay, completed: true },
      ];
      const displayed = getDailyQuestsForDisplay(quests, ["done"]);

      expect(displayed.map((quest) => quest.completed)).toEqual([true, false, false]);
      expect(quests[1].completed).toBe(true);
    });

    it("keeps a quest checked when it was completed today and then rescheduled away", () => {
      const rescheduledAway = { ...otherDay, id: "moved" };

      expect(getDailyQuestsForDisplay([rescheduledAway], ["moved"])[0].completed).toBe(true);
    });

    it("counts only today's scheduled Daily Quests", () => {
      const displayed = getDailyQuestsForDisplay([today, otherDay, makeQuest({ id: "also-today" })], ["today"]);

      expect(getQuestListProgress(displayed, "daily", ["today", "also-today"])).toEqual({ completed: 1, total: 2 });
      expect(getQuestListProgress(displayed, "daily", [])).toEqual({ completed: 0, total: 0 });
    });

    it("counts a quest completed today and rescheduled away, since today's record still includes it", () => {
      const displayed = getDailyQuestsForDisplay([{ ...otherDay, id: "moved" }], ["moved"]);

      expect(getQuestListProgress(displayed, "daily", ["moved"])).toEqual({ completed: 1, total: 1 });
    });

    it("counts every Personal Quest using its own one-time completion", () => {
      const quests = [makeQuest({ id: "a", completed: true }), makeQuest({ id: "b" })];

      expect(getQuestListProgress(quests, "personal", [])).toEqual({ completed: 1, total: 2 });
    });
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
