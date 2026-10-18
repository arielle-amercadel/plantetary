import { describe, expect, it } from "vitest";
import { getXpLedgerTotal, updateQuestInLists } from "../src/app/quest-logic";
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
