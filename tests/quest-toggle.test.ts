import { describe, expect, it } from "vitest";
import {
  getXpLedgerTotal,
  isDailyQuestScheduledForToggle,
  recordPersonalXpAward,
  reversePersonalXpAward,
  toggleDailyQuestCompletion,
} from "../src/app/quest-logic";
import type { CompletionHistory, Quest } from "../src/app/quest-types";

const dateKey = "2026-10-19";

function quest(overrides: Partial<Quest> = {}): Quest {
  return {
    id: "daily",
    title: "Test quest",
    category: "Wellness",
    schedule: "Mon",
    difficulty: "Medium",
    completed: false,
    repeatSchedule: "Selected days",
    selectedDays: ["Mon"],
    ...overrides,
  };
}

describe("quest completion toggles", () => {
  it("does not change an unscheduled daily quest, its history, or XP", () => {
    const dailyQuest = quest({ selectedDays: ["Tue"] });
    const history: CompletionHistory = {
      [dateKey]: { scheduledQuestIds: ["another-quest"], completedQuestIds: [] },
    };
    const totalXpBefore = getXpLedgerTotal(history);
    let nextQuest = dailyQuest;
    let nextHistory = history;

    if (isDailyQuestScheduledForToggle(dailyQuest, history[dateKey])) {
      nextQuest = { ...dailyQuest, completed: !dailyQuest.completed };
      nextHistory = toggleDailyQuestCompletion(history, dateKey, dailyQuest.id, dailyQuest.difficulty);
    }

    expect(nextQuest).toBe(dailyQuest);
    expect(nextQuest.completed).toBe(false);
    expect(nextHistory).toBe(history);
    expect(nextHistory[dateKey].completedQuestIds).toEqual([]);
    expect(getXpLedgerTotal(nextHistory)).toBe(totalXpBefore);
  });

  it("still toggles a scheduled daily quest and awards its XP", () => {
    const dailyQuest = quest();
    const history: CompletionHistory = {
      [dateKey]: { scheduledQuestIds: [dailyQuest.id], completedQuestIds: [] },
    };
    const nextQuest = isDailyQuestScheduledForToggle(dailyQuest, history[dateKey])
      ? { ...dailyQuest, completed: !dailyQuest.completed }
      : dailyQuest;
    const nextHistory = isDailyQuestScheduledForToggle(dailyQuest, history[dateKey])
      ? toggleDailyQuestCompletion(history, dateKey, dailyQuest.id, dailyQuest.difficulty)
      : history;

    expect(nextQuest.completed).toBe(true);
    expect(nextHistory[dateKey].completedQuestIds).toEqual([dailyQuest.id]);
    expect(getXpLedgerTotal(nextHistory)).toBe(10);
  });

  it("still toggles personal quests and awards or reverses their XP", () => {
    const personalQuest = quest({ id: "personal", schedule: "Due today", completed: false });
    const completedQuest = { ...personalQuest, completed: true };
    const awarded = recordPersonalXpAward(undefined, personalQuest.id, personalQuest.difficulty);
    const reversed = reversePersonalXpAward(awarded, personalQuest.id);

    expect(completedQuest.completed).toBe(true);
    expect(getXpLedgerTotal({}, awarded)).toBe(10);
    expect({ ...completedQuest, completed: false }.completed).toBe(false);
    expect(getXpLedgerTotal({}, reversed)).toBe(0);
  });
});
