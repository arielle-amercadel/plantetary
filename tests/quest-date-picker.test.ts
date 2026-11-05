import { describe, expect, it } from "vitest";
import { isCompletionDateKey } from "../src/app/quest-logic";
import {
  canTurnCalendarMonth,
  getCalendarGridDays,
  isSavableDueDate,
  shiftCalendarDateByDays,
  shiftCalendarDateByMonths,
} from "../src/app/quests/new/quest-date-picker-logic";

describe("Add/Edit Quest date picker calendar logic", () => {
  it("builds a Monday-first grid with complete weeks around a leap February", () => {
    const days = getCalendarGridDays(2024, 1);

    expect(days).toHaveLength(35);
    expect(days[0]).toMatchObject({ dateKey: "2024-01-29", isCurrentMonth: false });
    expect(days.filter((day) => day.isCurrentMonth)).toHaveLength(29);
    expect(days.find((day) => day.dateKey === "2024-02-29")).toMatchObject({
      dayOfMonth: 29,
      isCurrentMonth: true,
    });
    expect(days.at(-1)).toMatchObject({ dateKey: "2024-03-03", isCurrentMonth: false });
  });

  it("creates six rows when a month spans six calendar weeks", () => {
    const days = getCalendarGridDays(2026, 2);

    expect(days).toHaveLength(42);
    expect(days[0].dateKey).toBe("2026-02-23");
    expect(days.at(-1)?.dateKey).toBe("2026-04-05");
  });

  it("clamps month navigation to the last valid day of the target month", () => {
    expect(shiftCalendarDateByMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(shiftCalendarDateByMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(shiftCalendarDateByMonths("2026-03-31", -1)).toBe("2026-02-28");
  });

  it("moves by local calendar days across month and daylight-saving boundaries", () => {
    expect(shiftCalendarDateByDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftCalendarDateByDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("supported date range of the picker", () => {
  it.each<[string, number, string]>([
    ["0001-01-01", -1, "0001-01-01"],
    ["0001-01-01", -7, "0001-01-01"],
    ["0001-01-05", -7, "0001-01-01"],
    ["0001-01-02", -1, "0001-01-01"],
    ["9999-12-31", 1, "9999-12-31"],
    ["9999-12-31", 7, "9999-12-31"],
    ["9999-12-28", 7, "9999-12-31"],
    ["9999-12-30", 1, "9999-12-31"],
  ])("keeps %s moved by %i days at %s", (dateKey, amount, expected) => {
    expect(shiftCalendarDateByDays(dateKey, amount)).toBe(expected);
  });

  it.each<[string, number, string]>([
    ["0001-01-15", -1, "0001-01-01"],
    ["0001-06-15", -12, "0001-01-01"],
    ["0001-02-15", -1, "0001-01-15"],
    ["9999-12-15", 1, "9999-12-31"],
    ["9999-06-15", 12, "9999-12-31"],
    ["9999-11-30", 1, "9999-12-30"],
  ])("keeps %s moved by %i months at %s", (dateKey, amount, expected) => {
    expect(shiftCalendarDateByMonths(dateKey, amount)).toBe(expected);
  });

  it("only allows turning to months inside the supported range", () => {
    expect(canTurnCalendarMonth(1, 0, -1)).toBe(false);
    expect(canTurnCalendarMonth(1, 0, 1)).toBe(true);
    expect(canTurnCalendarMonth(1, 1, -1)).toBe(true);
    expect(canTurnCalendarMonth(9999, 11, 1)).toBe(false);
    expect(canTurnCalendarMonth(9999, 11, -1)).toBe(true);
    expect(canTurnCalendarMonth(9999, 10, 1)).toBe(true);
    expect(canTurnCalendarMonth(2026, 11, 1)).toBe(true);
    expect(canTurnCalendarMonth(2026, 0, -1)).toBe(true);
  });

  it("marks the cells after December 9999 as outside the supported range", () => {
    const days = getCalendarGridDays(9999, 11);
    const outside = days.filter((day) => !isCompletionDateKey(day.dateKey));

    expect(outside.map((day) => day.dateKey)).toEqual(["10000-01-01", "10000-01-02"]);
    expect(days.filter((day) => day.isCurrentMonth).every((day) => isCompletionDateKey(day.dateKey))).toBe(true);
  });

  it("has no cells before January 0001", () => {
    const days = getCalendarGridDays(1, 0);

    expect(days[0].dateKey).toBe("0001-01-01");
    expect(days.every((day) => isCompletionDateKey(day.dateKey))).toBe(true);
  });

  it("allows an empty or valid due date and rejects anything else", () => {
    for (const dueDate of ["", "0001-01-01", "9999-12-31", "2024-02-29", "2026-10-19"]) {
      expect(isSavableDueDate(dueDate), dueDate).toBe(true);
    }
    for (const dueDate of ["0000-12-31", "0000-12-01", "10000-01-01", "2026-02-29", "2026-13-01", "soon", " "]) {
      expect(isSavableDueDate(dueDate), dueDate).toBe(false);
    }
  });

  it("leaves normal movement unchanged, including leap years", () => {
    expect(shiftCalendarDateByDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(shiftCalendarDateByDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftCalendarDateByDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(shiftCalendarDateByMonths("2024-02-29", 12)).toBe("2025-02-28");
    expect(shiftCalendarDateByMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(shiftCalendarDateByMonths("0004-02-29", -12)).toBe("0003-02-28");
    expect(shiftCalendarDateByMonths("9998-12-15", 12)).toBe("9999-12-15");
  });
});
