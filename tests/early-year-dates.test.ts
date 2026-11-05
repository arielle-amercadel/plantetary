import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  dateFromKey,
  getDueDateLabel,
  getLocalDateKey,
  isQuestPastDue,
  localNoonDate,
} from "../src/app/quest-logic";
import {
  getCalendarGridDays,
  shiftCalendarDateByDays,
  shiftCalendarDateByMonths,
} from "../src/app/quests/new/quest-date-picker-logic";
import type { Quest } from "../src/app/quest-types";

const today = "2026-10-19";

describe("years 0001 through 0100", () => {
  describe("getDueDateLabel", () => {
    it.each<[string, string]>([
      ["0001-01-01", "Due Jan 1, 1"],
      ["0099-12-31", "Due Dec 31, 99"],
      ["0100-01-01", "Due Jan 1, 100"],
      ["0999-06-15", "Due Jun 15, 999"],
      ["1000-01-01", "Due Jan 1, 1000"],
    ])("labels %s with its real year", (dueDate, label) => {
      expect(getDueDateLabel(dueDate, today)).toBe(label);
    });

    it("does not mistake an early year for the same year in the 1900s", () => {
      expect(getDueDateLabel("0026-10-19", "1926-10-19")).toBe("Due Oct 19, 26");
    });

    it("uses relative wording and hides the year within an early year", () => {
      expect(getDueDateLabel("0001-01-01", "0001-01-01")).toBe("Due today");
      expect(getDueDateLabel("0001-01-02", "0001-01-01")).toBe("Due tomorrow");
      expect(getDueDateLabel("0001-03-05", "0001-01-01")).toBe("Due Mar 5");
    });

    it("finds tomorrow across the boundary between years 0099 and 0100", () => {
      expect(getDueDateLabel("0100-01-01", "0099-12-31")).toBe("Due tomorrow");
    });

    it("keeps leap-year rules for early years", () => {
      expect(getDueDateLabel("0004-02-29", today)).toBe("Due Feb 29, 4");
      expect(getDueDateLabel("0100-02-29", today)).toBeUndefined();
    });

    it("treats an early date as past due", () => {
      const quest = { id: "q", title: "Q", category: "C", difficulty: "Easy", completed: false, dueDate: "0001-01-01" } as Quest;

      expect(isQuestPastDue(quest, "personal", today)).toBe(true);
    });
  });

  describe("date helpers", () => {
    it.each<[string, number, number, number]>([
      ["0001-01-01", 1, 0, 1],
      ["0099-12-31", 99, 11, 31],
      ["0100-01-01", 100, 0, 1],
    ])("reads %s as that exact local date at noon", (key, year, monthIndex, day) => {
      const date = dateFromKey(key);

      expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()]).toEqual([year, monthIndex, day, 12]);
    });

    it.each(["0001-01-01", "0009-02-03", "0099-12-31", "0100-01-01", "0999-12-31"])("round-trips %s", (key) => {
      expect(getLocalDateKey(dateFromKey(key))).toBe(key);
    });

    it("moves across early year boundaries in both directions", () => {
      expect(getLocalDateKey(addCalendarDays(dateFromKey("0099-12-31"), 1))).toBe("0100-01-01");
      expect(getLocalDateKey(addCalendarDays(dateFromKey("0100-01-01"), -1))).toBe("0099-12-31");
      expect(getLocalDateKey(addCalendarDays(dateFromKey("0001-01-01"), 31))).toBe("0001-02-01");
    });

    it("rolls an out-of-range month or day over within an early year", () => {
      expect(getLocalDateKey(localNoonDate(99, 12, 1))).toBe("0100-01-01");
      expect(getLocalDateKey(localNoonDate(100, 0, 0))).toBe("0099-12-31");
    });
  });

  describe("date picker", () => {
    it("builds the calendar grid for the real early year", () => {
      const days = getCalendarGridDays(1, 0);
      const inMonth = days.filter((day) => day.isCurrentMonth);

      expect(inMonth).toHaveLength(31);
      expect(inMonth[0].dateKey).toBe("0001-01-01");
      expect(inMonth[30].dateKey).toBe("0001-01-31");
      expect(days.map((day) => day.dateKey).every((key) => !key.startsWith("19"))).toBe(true);
    });

    it.each<[number, number]>([[1, 0], [99, 11], [100, 0], [4, 1]])(
      "starts each week of the year %i, month %i calendar on a Monday",
      (year, monthIndex) => {
        const days = getCalendarGridDays(year, monthIndex);

        expect(days.length % 7).toBe(0);
        for (let index = 0; index < days.length; index += 7) {
          expect(dateFromKey(days[index].dateKey).getDay(), days[index].dateKey).toBe(1);
        }
      },
    );

    it("handles February in early leap and non-leap years", () => {
      expect(getCalendarGridDays(4, 1).filter((day) => day.isCurrentMonth)).toHaveLength(29);
      expect(getCalendarGridDays(100, 1).filter((day) => day.isCurrentMonth)).toHaveLength(28);
    });

    it("moves by days and months across early years", () => {
      expect(shiftCalendarDateByDays("0099-12-31", 1)).toBe("0100-01-01");
      expect(shiftCalendarDateByMonths("0099-12-15", 1)).toBe("0100-01-15");
      expect(shiftCalendarDateByMonths("0100-01-31", -1)).toBe("0099-12-31");
      expect(shiftCalendarDateByMonths("0099-01-31", 12)).toBe("0100-01-31");
      expect(shiftCalendarDateByMonths("0001-01-31", 1)).toBe("0001-02-28");
    });
  });
});

describe("modern dates are unaffected", () => {
  it("builds exactly what the numeric Date constructor builds, for years 100 to 3000", () => {
    for (let year = 100; year <= 3000; year += 37) {
      for (const [monthIndex, day] of [[0, 1], [1, 28], [2, 0], [5, 15], [11, 31], [12, 1], [0, -3]]) {
        expect(localNoonDate(year, monthIndex, day).getTime(), `${year}-${monthIndex}-${day}`)
          .toBe(new Date(year, monthIndex, day, 12).getTime());
      }
    }
  });

  it.each(["1900-01-01", "1999-12-31", "2000-02-29", "2026-10-19", "2026-11-01", "2099-12-31"])("round-trips %s", (key) => {
    expect(getLocalDateKey(dateFromKey(key))).toBe(key);
  });

  it("keeps modern labels the same", () => {
    expect(getDueDateLabel("2026-10-19", today)).toBe("Due today");
    expect(getDueDateLabel("2026-10-20", today)).toBe("Due tomorrow");
    expect(getDueDateLabel("2026-10-22", today)).toBe("Due Oct 22");
    expect(getDueDateLabel("2027-01-05", today)).toBe("Due Jan 5, 2027");
    expect(getDueDateLabel("1999-01-01", today)).toBe("Due Jan 1, 1999");
  });

  it("keeps the calendar grid the same", () => {
    const october = getCalendarGridDays(2026, 9);

    expect(october.filter((day) => day.isCurrentMonth)).toHaveLength(31);
    expect(october[0].dateKey).toBe("2026-09-28");
    expect(october.at(-1)?.dateKey).toBe("2026-11-01");
  });
});
