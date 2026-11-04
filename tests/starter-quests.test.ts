import { describe, expect, it } from "vitest";
import { getDueDateLabel, isQuestPastDue, isQuestScheduledOnDate } from "../src/app/quest-logic";
import { initialQuestLists } from "../src/app/quest-store";

const todayKey = "2026-10-19";
const monday = new Date(2026, 9, 19);

describe("starter quests", () => {
  it("gives Personal Quests no due date and no saved label", () => {
    expect(initialQuestLists.personal.length).toBeGreaterThan(0);
    for (const quest of initialQuestLists.personal) {
      expect(quest.dueDate).toBeUndefined();
      expect(quest.schedule).toBe("");
    }
  });

  it("shows no label or past-due state for Personal Quests", () => {
    for (const quest of initialQuestLists.personal) {
      expect(getDueDateLabel(quest.dueDate, todayKey)).toBeUndefined();
      expect(isQuestPastDue(quest, "personal", todayKey)).toBe(false);
    }
  });

  it("does not treat a Personal Quest's empty schedule as a scheduled day", () => {
    for (const quest of initialQuestLists.personal) {
      expect(isQuestScheduledOnDate(quest, monday)).toBe(false);
    }
  });

  it("keeps Daily Quests scheduled every day through their saved text", () => {
    expect(initialQuestLists.daily.length).toBeGreaterThan(0);
    for (const quest of initialQuestLists.daily) {
      expect(quest.schedule).toBe("Every day");
      expect(quest.dueDate).toBeUndefined();
      expect(isQuestScheduledOnDate(quest, monday)).toBe(true);
    }
  });
});
