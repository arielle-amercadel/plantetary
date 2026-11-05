import { describe, expect, it } from "vitest";
import { removeInvalidPersonalDueDates } from "../src/app/quest-logic";
import type { Quest, QuestLists } from "../src/app/quest-types";

function makeQuest(overrides: Partial<Quest> = {}): Quest {
  return {
    id: "personal",
    title: "Return library book",
    category: "Study",
    schedule: "",
    difficulty: "Hard",
    completed: true,
    notes: "Second floor",
    ...overrides,
  };
}

function lists(personal: Quest[], daily: Quest[] = []): QuestLists {
  return { daily, personal };
}

describe("removeInvalidPersonalDueDates", () => {
  it.each([
    ["an impossible date", "2026-02-30"],
    ["February 29 outside a leap year", "2027-02-29"],
    ["month 13", "2026-13-01"],
    ["day 00", "2026-10-00"],
    ["malformed text", "not-a-date"],
    ["a date with a time", "2026-10-22T00:00:00Z"],
    ["a US-formatted date", "10/22/2026"],
    ["unpadded numbers", "2026-1-5"],
    ["surrounding spaces", " 2026-10-22 "],
    ["an empty string", ""],
    ["null", null],
    ["a number", 20261022],
    ["a boolean", true],
    ["an object", { year: 2026 }],
    ["an array", ["2026-10-22"]],
  ])("removes %s", (_description, dueDate) => {
    const quest = makeQuest({ dueDate: dueDate as unknown as string });

    const [corrected] = removeInvalidPersonalDueDates(lists([quest])).personal;

    expect(corrected).not.toHaveProperty("dueDate");
  });

  it("keeps every other field of the corrected quest", () => {
    const { dueDate: _removed, ...expected } = makeQuest({ dueDate: "2026-02-30", schedule: "Due Oct 20" });
    void _removed;

    const [corrected] = removeInvalidPersonalDueDates(lists([makeQuest({ dueDate: "2026-02-30", schedule: "Due Oct 20" })])).personal;

    expect(corrected).toEqual(expected);
  });

  it.each([
    ["a normal date", "2026-10-22"],
    ["a past date", "2020-01-01"],
    ["a far-future date", "2099-12-31"],
    ["February 29 in a leap year", "2028-02-29"],
  ])("keeps %s unchanged", (_description, dueDate) => {
    const quest = makeQuest({ dueDate });

    const [kept] = removeInvalidPersonalDueDates(lists([quest])).personal;

    expect(kept).toBe(quest);
    expect(kept.dueDate).toBe(dueDate);
  });

  it("returns the same lists when nothing needs correcting, so no backup is triggered", () => {
    const clean = lists([makeQuest({ dueDate: "2026-10-22" }), makeQuest({ id: "undated" })]);

    expect(removeInvalidPersonalDueDates(clean)).toBe(clean);
  });

  it("corrects only the quests that need it, in their original order", () => {
    const valid = makeQuest({ id: "valid", dueDate: "2026-10-22" });
    const undated = makeQuest({ id: "undated" });
    const invalid = makeQuest({ id: "invalid", dueDate: "2026-02-30" });

    const { personal } = removeInvalidPersonalDueDates(lists([valid, invalid, undated]));

    expect(personal.map((quest) => quest.id)).toEqual(["valid", "invalid", "undated"]);
    expect(personal[0]).toBe(valid);
    expect(personal[2]).toBe(undated);
    expect(personal[1]).not.toHaveProperty("dueDate");
  });

  it("does not change the original quest", () => {
    const quest = makeQuest({ dueDate: "2026-02-30" });

    removeInvalidPersonalDueDates(lists([quest]));

    expect(quest.dueDate).toBe("2026-02-30");
  });

  it("leaves Daily Quests alone, including any due date they carry", () => {
    const daily = makeQuest({ id: "daily", schedule: "Mon, Wed", repeatSchedule: "Selected days", selectedDays: ["Mon", "Wed"], dueDate: "2026-02-30" });
    const questLists = lists([makeQuest({ dueDate: "2026-02-30" })], [daily]);

    const corrected = removeInvalidPersonalDueDates(questLists);

    expect(corrected.daily).toBe(questLists.daily);
    expect(corrected.daily[0]).toBe(daily);
  });
});
