import { describe, expect, it } from "vitest";
import {
  findQuestForEditing,
  getAllQuestListsForDisplay,
  getHomeQuestListsForDisplay,
  getXpLedgerTotal,
  hasQuestScheduleChanged,
  updateQuestInLists,
} from "../src/app/quest-logic";
import type { CompletionHistory, Quest, QuestLists } from "../src/app/quest-types";

function makeQuest(overrides: Partial<Quest> = {}): Quest {
  return {
    id: "daily-1",
    title: "Drink water",
    category: "Wellness",
    schedule: "Every day",
    difficulty: "Medium",
    completed: true,
    repeatSchedule: "Every day",
    selectedDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    notes: "Keep a glass nearby",
    ...overrides,
  };
}

function makeQuestLists(dailyQuest = makeQuest()): QuestLists {
  return { daily: [dailyQuest], personal: [] };
}

describe("updating an existing quest", () => {
  it("updates title and notes in place without adding a duplicate", () => {
    const lists = makeQuestLists();
    const next = updateQuestInLists(lists, "daily", "daily-1", {
      title: "Drink water after breakfast",
      notes: "Use the blue glass",
    });

    expect(next.daily).toHaveLength(1);
    expect(next.daily[0]).toMatchObject({
      id: "daily-1",
      title: "Drink water after breakfast",
      notes: "Use the blue glass",
    });
    expect(next.daily[0].completed).toBe(true);
  });

  it("preserves the original ID and completion state", () => {
    const lists = makeQuestLists(makeQuest({ completed: true }));
    const unsafeUpdates = { id: "replacement-id", completed: false, title: "Updated" } as Partial<Quest>;
    const next = updateQuestInLists(lists, "daily", "daily-1", unsafeUpdates);

    expect(next.daily[0].id).toBe("daily-1");
    expect(next.daily[0].completed).toBe(true);
    expect(next.daily[0].title).toBe("Updated");
  });

  it("preserves completion history and earned XP when difficulty changes", () => {
    const lists = makeQuestLists();
    const history: CompletionHistory = {
      "2026-10-19": {
        scheduledQuestIds: ["daily-1"],
        completedQuestIds: ["daily-1"],
        xpAwardedByQuestId: { "daily-1": 10 },
      },
    };
    const historyBefore = JSON.stringify(history);
    const xpBefore = getXpLedgerTotal(history);
    const next = updateQuestInLists(lists, "daily", "daily-1", { difficulty: "Hard" });

    expect(next.daily[0].difficulty).toBe("Hard");
    expect(JSON.stringify(history)).toBe(historyBefore);
    expect(getXpLedgerTotal(history)).toBe(xpBefore);
    expect(getXpLedgerTotal(history)).toBe(10);
  });

  it("updates Daily schedule fields together", () => {
    const next = updateQuestInLists(makeQuestLists(), "daily", "daily-1", {
      repeatSchedule: "Selected days",
      selectedDays: ["Tue", "Thu"],
      schedule: "Tue, Thu",
    });

    expect(next.daily[0]).toMatchObject({
      repeatSchedule: "Selected days",
      selectedDays: ["Tue", "Thu"],
      schedule: "Tue, Thu",
    });
  });

  it("detects schedule edits without treating title or difficulty edits as schedule changes", () => {
    const current = makeQuest();

    expect(hasQuestScheduleChanged(current, {
      ...current,
      title: "Updated title",
      difficulty: "Hard",
    })).toBe(false);
    expect(hasQuestScheduleChanged(current, {
      ...current,
      repeatSchedule: "Selected days",
      selectedDays: ["Tue", "Thu"],
      schedule: "Tue, Thu",
    })).toBe(true);
  });

  it("updates a Personal due date and its display label together", () => {
    const personal = makeQuest({
      id: "personal-1",
      schedule: "No due date",
      dueDate: undefined,
    });
    const next = updateQuestInLists({ daily: [], personal: [personal] }, "personal", "personal-1", {
      dueDate: "2026-11-05",
      schedule: "Due Nov 5",
    });

    expect(next.personal[0]).toMatchObject({ dueDate: "2026-11-05", schedule: "Due Nov 5" });
  });

  it("leaves quest lists unchanged when the ID is missing", () => {
    const lists = makeQuestLists();

    expect(updateQuestInLists(lists, "daily", "missing", { title: "No quest" })).toBe(lists);
  });
});

describe("All Quests display data", () => {
  it("includes every Daily Quest and puts today's scheduled quests first", () => {
    const todayQuest = makeQuest({ id: "today", repeatSchedule: "Selected days", selectedDays: ["Mon"], schedule: "Mon" });
    const otherDayQuest = makeQuest({ id: "other-day", repeatSchedule: "Selected days", selectedDays: ["Tue"], schedule: "Tue" });
    const everyDayQuest = makeQuest({ id: "every-day" });
    const result = getAllQuestListsForDisplay(
      { daily: [otherDayQuest, todayQuest, everyDayQuest], personal: [] },
      "2026-10-19",
    );

    expect(result.daily.map((quest) => quest.id)).toEqual(["today", "every-day", "other-day"]);
    expect(result.daily).toHaveLength(3);
    expect(result.daily[2].schedule).toBe("Tue");
  });

  it("sorts dated Personal Quests soonest first and keeps undated quests after them", () => {
    const later = makeQuest({ id: "later", dueDate: "2026-11-05" });
    const undated = makeQuest({ id: "undated", dueDate: undefined });
    const earlier = makeQuest({ id: "earlier", dueDate: "2026-10-20" });
    const invalid = makeQuest({ id: "invalid", dueDate: "not-a-date" });
    const result = getAllQuestListsForDisplay(
      { daily: [], personal: [later, undated, earlier, invalid] },
      "2026-10-19",
    );

    expect(result.personal.map((quest) => quest.id)).toEqual(["earlier", "later", "undated", "invalid"]);
  });

  it("returns exact quest data and its list for the existing edit form", () => {
    const daily = makeQuest({
      id: "daily-edit",
      title: "Water the seedlings",
      category: "Garden",
      difficulty: "Hard",
      repeatSchedule: "Selected days",
      selectedDays: ["Mon", "Wed"],
      schedule: "Mon, Wed",
      notes: "In the morning",
    });
    const personal = makeQuest({ id: "personal-edit", dueDate: "2026-11-02", schedule: "Due Nov 2" });
    const lists = { daily: [daily], personal: [personal] };

    expect(findQuestForEditing(lists, "daily-edit")).toEqual({ quest: daily, list: "daily" });
    expect(findQuestForEditing(lists, "personal-edit")).toEqual({ quest: personal, list: "personal" });
    expect(findQuestForEditing(lists, "missing")).toBeUndefined();
  });

  it("reflects an edit in the shared list projection without duplicating the quest", () => {
    const lists = makeQuestLists();
    const updated = updateQuestInLists(lists, "daily", "daily-1", { title: "New title" });
    const displayed = getAllQuestListsForDisplay(updated, "2026-10-19");

    expect(displayed.daily).toHaveLength(1);
    expect(displayed.daily[0].title).toBe("New title");
    expect(displayed.daily[0].completed).toBe(true);
  });
});

describe("Home quest display data", () => {
  it("shows only Daily Quests scheduled for the local weekday and leaves Personal Quests unchanged", () => {
    const everyDay = makeQuest({ id: "every-day", repeatSchedule: "Every day" });
    const mondayQuest = makeQuest({ id: "monday", repeatSchedule: "Selected days", selectedDays: ["Mon"], schedule: "Mon" });
    const tuesdayQuest = makeQuest({ id: "tuesday", repeatSchedule: "Selected days", selectedDays: ["Tue"], schedule: "Tue" });
    const personal = [makeQuest({ id: "personal", dueDate: "2026-11-05" })];
    const source = { daily: [tuesdayQuest, everyDay, mondayQuest], personal };

    const result = getHomeQuestListsForDisplay(source, "2026-10-19");

    expect(result.daily.map((quest) => quest.id)).toEqual(["every-day", "monday"]);
    expect(result.personal).toBe(personal);
  });

  it("shows no Daily Quests when the date has no matching scheduled quests", () => {
    const tuesdayQuest = makeQuest({ id: "tuesday", repeatSchedule: "Selected days", selectedDays: ["Tue"], schedule: "Tue" });

    expect(getHomeQuestListsForDisplay({ daily: [tuesdayQuest], personal: [] }, "2026-10-19").daily).toEqual([]);
  });

  it("does not filter other-day quests out of the All Quests display", () => {
    const mondayQuest = makeQuest({ id: "monday", repeatSchedule: "Selected days", selectedDays: ["Mon"], schedule: "Mon" });
    const tuesdayQuest = makeQuest({ id: "tuesday", repeatSchedule: "Selected days", selectedDays: ["Tue"], schedule: "Tue" });

    expect(getAllQuestListsForDisplay({ daily: [tuesdayQuest, mondayQuest], personal: [] }, "2026-10-19").daily.map((quest) => quest.id))
      .toEqual(["monday", "tuesday"]);
  });
});
