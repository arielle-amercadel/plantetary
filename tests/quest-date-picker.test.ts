import { describe, expect, it } from "vitest";
import {
  getCalendarGridDays,
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
