import { describe, expect, it } from "vitest";
import {
  getDailyQuestScheduleLabel,
  getDueDateLabel,
  isQuestPastDue,
  isQuestScheduledOnDate,
  scheduledDaysForQuest,
  weekdays,
} from "../src/app/quest-logic";
import { initialQuestLists } from "../src/app/quest-store";

const todayKey = "2026-10-19";
const monday = new Date(2026, 9, 19);

describe("starter quests", () => {
  it("gives Personal Quests no due date and no saved label", () => {
    expect(initialQuestLists.personal.length).toBeGreaterThan(0);
    for (const quest of initialQuestLists.personal) {
      expect(quest.dueDate).toBeUndefined();
      expect(quest).not.toHaveProperty("schedule");
    }
  });

  it("shows no label or past-due state for Personal Quests", () => {
    for (const quest of initialQuestLists.personal) {
      expect(getDueDateLabel(quest.dueDate, todayKey)).toBeUndefined();
      expect(isQuestPastDue(quest, "personal", todayKey)).toBe(false);
    }
  });

  it("does not treat a Personal Quest as scheduled on any day", () => {
    for (const quest of initialQuestLists.personal) {
      expect(isQuestScheduledOnDate(quest, monday)).toBe(false);
    }
  });

  describe("explicit recurrence on Daily Quests", () => {
    const allDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

    it("saves Every day with all seven days in the standard order", () => {
      expect(initialQuestLists.daily).toHaveLength(4);
      for (const quest of initialQuestLists.daily) {
        expect(quest.repeatSchedule).toBe("Every day");
        expect(quest.selectedDays).toEqual(allDays);
      }
    });

    it("is scheduled and labeled from its recurrence", () => {
      for (const quest of initialQuestLists.daily) {
        expect(isQuestScheduledOnDate(quest, monday)).toBe(true);
        expect(scheduledDaysForQuest(quest)).toEqual(allDays);
        expect(getDailyQuestScheduleLabel(quest)).toBe("Every day");
      }
    });

    it("gives each quest its own list, separate from the shared weekday constant", () => {
      const lists = initialQuestLists.daily.map((quest) => quest.selectedDays);

      expect(new Set(lists).size).toBe(lists.length);
      for (const list of lists) expect(list).not.toBe(weekdays);
    });

    it("preserves the other starter details", () => {
      expect(initialQuestLists.daily.map(({ id, title, category, difficulty, completed }) => ({
        id, title, category, difficulty, completed,
      }))).toEqual([
        { id: "water", title: "Drink a glass of water", category: "Wellness", difficulty: "Easy", completed: false },
        { id: "skincare", title: "Morning skincare", category: "Self-care", difficulty: "Easy", completed: false },
        { id: "reading", title: "Read for 20 minutes", category: "Personal growth", difficulty: "Medium", completed: false },
        { id: "stretch", title: "Evening stretch", category: "Wellness", difficulty: "Easy", completed: false },
      ]);
    });

    it("does not add recurrence to Personal Quests", () => {
      for (const quest of initialQuestLists.personal) {
        expect(quest).not.toHaveProperty("repeatSchedule");
        expect(quest).not.toHaveProperty("selectedDays");
      }
    });
  });

  it("gives Daily Quests no legacy text or due date, and keeps them scheduled every day", () => {
    expect(initialQuestLists.daily.length).toBeGreaterThan(0);
    for (const quest of initialQuestLists.daily) {
      expect(quest).not.toHaveProperty("schedule");
      expect(quest.dueDate).toBeUndefined();
      expect(isQuestScheduledOnDate(quest, monday)).toBe(true);
    }
  });
});
