import { describe, expect, it } from "vitest";
import {
  getQuestXp,
  getStreakValues,
  getXpLedgerTotal,
  recordDailyXpAward,
  recordPersonalXpAward,
  reverseDailyXpAward,
  reversePersonalXpAward,
  toggleDailyQuestCompletion,
} from "../src/app/quest-logic";
import type { CompletionHistory, CompletionSnapshot, Difficulty, Quest } from "../src/app/quest-types";

function snapshot(scheduledQuestIds: string[], completedQuestIds: string[] = []): CompletionSnapshot {
  return { scheduledQuestIds, completedQuestIds };
}

describe("XP ledger logic", () => {
  it("rejects an invalid runtime difficulty", () => {
    expect(() => getQuestXp("Impossible" as Difficulty)).toThrow("Invalid quest difficulty");
  });

  it("sums daily awards across dates, personal awards, and the legacy bonus", () => {
    const history: CompletionHistory = {
      "2026-10-19": { ...snapshot(["daily-a"], ["daily-a"]), xpAwardedByQuestId: { "daily-a": getQuestXp("Medium") } },
      "2026-10-20": { ...snapshot(["daily-a"], ["daily-a"]), xpAwardedByQuestId: { "daily-a": getQuestXp("Medium") } },
    };

    expect(getXpLedgerTotal(history, { personal: getQuestXp("Hard") }, 5)).toBe(45);
  });

  it("records separate daily awards for the same quest on different dates", () => {
    const history: CompletionHistory = {
      "2026-10-19": snapshot(["daily"], ["daily"]),
      "2026-10-20": snapshot(["daily"], ["daily"]),
    };
    const firstDay = recordDailyXpAward(history, "2026-10-19", "daily", "Medium");
    const bothDays = recordDailyXpAward(firstDay, "2026-10-20", "daily", "Medium");

    expect(bothDays["2026-10-19"].xpAwardedByQuestId).toEqual({ daily: 10 });
    expect(bothDays["2026-10-20"].xpAwardedByQuestId).toEqual({ daily: 10 });
    expect(getXpLedgerTotal(bothDays)).toBe(20);
  });

  it.each([Number.NaN, -1])("replaces an invalid existing daily award (%s)", (invalidAward) => {
    const history: CompletionHistory = {
      "2026-10-19": {
        ...snapshot(["daily"], ["daily"]),
        xpAwardedByQuestId: { daily: invalidAward },
      },
    };
    const next = recordDailyXpAward(history, "2026-10-19", "daily", "Medium");

    expect(next["2026-10-19"].xpAwardedByQuestId).toEqual({ daily: 10 });
    expect(getXpLedgerTotal(next)).toBe(10);
  });

  it("reverses one day's daily award without removing awards on other days", () => {
    const history: CompletionHistory = {
      "2026-10-19": { ...snapshot(["daily"], ["daily"]), xpAwardedByQuestId: { daily: 10 } },
      "2026-10-20": { ...snapshot(["daily"], ["daily"]), xpAwardedByQuestId: { daily: 10 } },
    };
    const next = reverseDailyXpAward(history, "2026-10-19", "daily");

    expect(next["2026-10-19"].xpAwardedByQuestId).toBeUndefined();
    expect(next["2026-10-20"].xpAwardedByQuestId).toEqual({ daily: 10 });
    expect(getXpLedgerTotal(next)).toBe(10);
  });

  it("toggles daily XP only on the explicitly supplied calendar date", () => {
    const history: CompletionHistory = {
      "2026-10-19": snapshot(["daily"]),
      "2026-10-20": { ...snapshot(["daily"], ["daily"]), xpAwardedByQuestId: { daily: 10 } },
    };
    const completedOnMonday = toggleDailyQuestCompletion(history, "2026-10-19", "daily", "Medium");
    const uncheckedOnMonday = toggleDailyQuestCompletion(completedOnMonday, "2026-10-19", "daily", "Medium");

    expect(completedOnMonday["2026-10-19"].xpAwardedByQuestId).toEqual({ daily: 10 });
    expect(uncheckedOnMonday["2026-10-19"].xpAwardedByQuestId).toBeUndefined();
    expect(uncheckedOnMonday["2026-10-20"].xpAwardedByQuestId).toEqual({ daily: 10 });
  });

  it("does not change or award XP when today's snapshot is absent or unscheduled", () => {
    const noSnapshot: CompletionHistory = {};
    const unscheduled: CompletionHistory = { "2026-10-19": snapshot(["another-quest"]) };

    expect(toggleDailyQuestCompletion(noSnapshot, "2026-10-19", "daily", "Medium")).toBe(noSnapshot);
    expect(toggleDailyQuestCompletion(unscheduled, "2026-10-19", "daily", "Medium")).toBe(unscheduled);
  });

  it("records personal XP once and reverses only that personal award", () => {
    const first = recordPersonalXpAward(undefined, "personal", "Medium");
    const repeated = recordPersonalXpAward(first, "personal", "Hard");

    expect(first).toEqual({ personal: 10 });
    expect(repeated).toBe(first);
    expect(getXpLedgerTotal({}, repeated)).toBe(10);
    expect(reversePersonalXpAward(repeated, "personal")).toBeUndefined();
    expect(getXpLedgerTotal({}, reversePersonalXpAward(repeated, "personal"))).toBe(0);
  });

  it("keeps previously recorded XP when a quest's difficulty changes", () => {
    const history: CompletionHistory = { "2026-10-19": snapshot(["daily"], ["daily"]) };
    const dailyAward = recordDailyXpAward(history, "2026-10-19", "daily", "Medium");
    const dailyAfterDifficultyChange = recordDailyXpAward(dailyAward, "2026-10-19", "daily", "Hard");
    const personalAward = recordPersonalXpAward(undefined, "personal", "Medium");
    const personalAfterDifficultyChange = recordPersonalXpAward(personalAward, "personal", "Hard");

    expect(dailyAfterDifficultyChange).toBe(dailyAward);
    expect(personalAfterDifficultyChange).toBe(personalAward);
    expect(dailyAfterDifficultyChange["2026-10-19"].xpAwardedByQuestId).toEqual({ daily: 10 });
    expect(getXpLedgerTotal(dailyAfterDifficultyChange, personalAfterDifficultyChange)).toBe(20);
  });

  it("retains historical XP when the awarded quests are removed from quest lists", () => {
    const dailyQuest: Quest = {
      id: "daily",
      title: "Daily quest",
      category: "Wellness",
      schedule: "Every day",
      difficulty: "Medium",
      completed: true,
    };
    const personalQuest: Quest = { ...dailyQuest, id: "personal", schedule: "No due date" };
    const questLists = { daily: [dailyQuest], personal: [personalQuest] };
    const history = recordDailyXpAward(
      { "2026-10-19": snapshot([dailyQuest.id], [dailyQuest.id]) },
      "2026-10-19",
      dailyQuest.id,
      dailyQuest.difficulty,
    );
    const personalXp = recordPersonalXpAward(undefined, personalQuest.id, personalQuest.difficulty);
    const totalBeforeDeletion = getXpLedgerTotal(history, personalXp);
    const remainingQuestLists = {
      daily: questLists.daily.filter((quest) => quest.id !== dailyQuest.id),
      personal: questLists.personal.filter((quest) => quest.id !== personalQuest.id),
    };

    expect(remainingQuestLists).toEqual({ daily: [], personal: [] });
    expect(getXpLedgerTotal(history, personalXp)).toBe(totalBeforeDeletion);
    expect(totalBeforeDeletion).toBe(20);
  });

  it("handles missing and empty optional ledger fields safely", () => {
    const history: CompletionHistory = {
      "2026-10-19": snapshot(["daily"]),
      "2026-10-20": { ...snapshot(["daily"]), xpAwardedByQuestId: {} },
    };

    expect(getXpLedgerTotal()).toBe(0);
    expect(getXpLedgerTotal(history, {}, 0)).toBe(0);
    expect(recordDailyXpAward(history, "2026-10-21", "daily", "Easy")).toBe(history);
    expect(recordDailyXpAward(history, "2026-10-19", "not-scheduled", "Easy")).toBe(history);
    expect(recordDailyXpAward(history, "2026-10-19", "daily", "Easy")).toBe(history);
    expect(reverseDailyXpAward(history, "2026-10-19", "daily")).toBe(history);
    expect(recordPersonalXpAward(undefined, "personal", "Easy")).toEqual({ personal: 5 });
    expect(reversePersonalXpAward(undefined, "personal")).toBeUndefined();
    expect(reversePersonalXpAward({}, "personal")).toEqual({});
  });

  it("does not let XP ledger fields affect streak calculations", () => {
    const history: CompletionHistory = {
      "2026-10-19": snapshot(["daily"], ["daily"]),
      "2026-10-20": snapshot(["daily"], ["daily"]),
    };
    const historyWithAwards: CompletionHistory = {
      ...history,
      "2026-10-19": { ...history["2026-10-19"], xpAwardedByQuestId: { daily: 10 } },
      "2026-10-20": { ...history["2026-10-20"], xpAwardedByQuestId: { daily: 10 } },
    };

    expect(getStreakValues(historyWithAwards, "2026-10-20"))
      .toEqual(getStreakValues(history, "2026-10-20"));
  });
});
