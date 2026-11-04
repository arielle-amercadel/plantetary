import { describe, expect, it } from "vitest";
import { getDueDateLabel } from "../src/app/quest-logic";

const today = "2026-10-19";

describe("getDueDateLabel", () => {
  describe("no label", () => {
    it("returns no label without a due date", () => {
      expect(getDueDateLabel(undefined, today)).toBeUndefined();
      expect(getDueDateLabel("", today)).toBeUndefined();
    });

    it.each([
      ["text", "not-a-date"],
      ["an old saved label", "Due today"],
      ["a US-formatted date", "10/22/2026"],
      ["a date with a time", "2026-10-22T00:00:00Z"],
      ["surrounding spaces", " 2026-10-22 "],
      ["unpadded month and day", "2026-1-5"],
      ["month 13", "2026-13-01"],
      ["month 00", "2026-00-10"],
      ["day 00", "2026-10-00"],
      ["April 31", "2026-04-31"],
      ["February 30", "2026-02-30"],
      ["February 29 outside a leap year", "2027-02-29"],
      ["February 29 in a non-leap century", "2100-02-29"],
      ["year 0000", "0000-01-01"],
    ])("returns no label for %s", (_description, dueDate) => {
      expect(getDueDateLabel(dueDate, today)).toBeUndefined();
    });

    it("returns no label for non-string values read from saved data", () => {
      for (const value of [null, 20261022, {}, true]) {
        expect(getDueDateLabel(value as unknown as string, today)).toBeUndefined();
      }
    });
  });

  describe("relative dates", () => {
    it("labels today and tomorrow", () => {
      expect(getDueDateLabel("2026-10-19", today)).toBe("Due today");
      expect(getDueDateLabel("2026-10-20", today)).toBe("Due tomorrow");
    });

    it("recalculates as the day changes, because nothing is stored", () => {
      const dueDate = "2026-10-20";

      expect(getDueDateLabel(dueDate, "2026-10-18")).toBe("Due Oct 20");
      expect(getDueDateLabel(dueDate, "2026-10-19")).toBe("Due tomorrow");
      expect(getDueDateLabel(dueDate, "2026-10-20")).toBe("Due today");
      expect(getDueDateLabel(dueDate, "2026-10-21")).toBe("Due Oct 20");
    });
  });

  describe("other dates", () => {
    it("shows future dates this year without the year", () => {
      expect(getDueDateLabel("2026-10-21", today)).toBe("Due Oct 21");
      expect(getDueDateLabel("2026-10-22", today)).toBe("Due Oct 22");
      expect(getDueDateLabel("2026-12-31", today)).toBe("Due Dec 31");
    });

    it("shows past dates this year as the actual date", () => {
      expect(getDueDateLabel("2026-10-18", today)).toBe("Due Oct 18");
      expect(getDueDateLabel("2026-10-15", today)).toBe("Due Oct 15");
      expect(getDueDateLabel("2026-01-01", today)).toBe("Due Jan 1");
    });

    it("includes the year for dates in another year, past or future", () => {
      expect(getDueDateLabel("2027-01-05", today)).toBe("Due Jan 5, 2027");
      expect(getDueDateLabel("2025-12-30", today)).toBe("Due Dec 30, 2025");
    });
  });

  describe("month and year boundaries", () => {
    it("recognizes tomorrow across a month end", () => {
      expect(getDueDateLabel("2026-11-01", "2026-10-31")).toBe("Due tomorrow");
      expect(getDueDateLabel("2026-05-01", "2026-04-30")).toBe("Due tomorrow");
    });

    it("recognizes tomorrow across a year end, without adding the year", () => {
      expect(getDueDateLabel("2027-01-01", "2026-12-31")).toBe("Due tomorrow");
    });

    it("adds the year for dates just past the year end", () => {
      expect(getDueDateLabel("2027-01-02", "2026-12-31")).toBe("Due Jan 2, 2027");
      expect(getDueDateLabel("2026-12-31", "2027-01-01")).toBe("Due Dec 31, 2026");
    });

    it("keeps the first and last days of a month on the right date", () => {
      expect(getDueDateLabel("2026-03-01", today)).toBe("Due Mar 1");
      expect(getDueDateLabel("2026-03-31", today)).toBe("Due Mar 31");
      expect(getDueDateLabel("2026-06-30", today)).toBe("Due Jun 30");
    });
  });

  describe("leap years", () => {
    it("accepts February 29 in a leap year", () => {
      expect(getDueDateLabel("2028-02-29", "2028-01-15")).toBe("Due Feb 29");
      expect(getDueDateLabel("2028-02-29", today)).toBe("Due Feb 29, 2028");
      expect(getDueDateLabel("2000-02-29", today)).toBe("Due Feb 29, 2000");
    });

    it("moves from February 28 to February 29 in a leap year", () => {
      expect(getDueDateLabel("2028-02-29", "2028-02-28")).toBe("Due tomorrow");
      expect(getDueDateLabel("2028-03-01", "2028-02-29")).toBe("Due tomorrow");
    });

    it("moves from February 28 to March 1 outside a leap year", () => {
      expect(getDueDateLabel("2027-03-01", "2027-02-28")).toBe("Due tomorrow");
    });
  });

  describe("local calendar dates", () => {
    // Run under several timezones by the TZ environment variable. Each date below would show the
    // previous day in the Americas if it were parsed as UTC midnight.
    it("shows the written calendar day whatever the timezone", () => {
      expect(getDueDateLabel("2026-11-01", today)).toBe("Due Nov 1");
      expect(getDueDateLabel("2026-01-01", today)).toBe("Due Jan 1");
      expect(getDueDateLabel("2027-01-01", today)).toBe("Due Jan 1, 2027");
    });

    it("finds tomorrow across US and New Zealand clock changes", () => {
      expect(getDueDateLabel("2026-03-08", "2026-03-07")).toBe("Due tomorrow");
      expect(getDueDateLabel("2026-03-09", "2026-03-08")).toBe("Due tomorrow");
      expect(getDueDateLabel("2026-11-01", "2026-10-31")).toBe("Due tomorrow");
      expect(getDueDateLabel("2026-11-02", "2026-11-01")).toBe("Due tomorrow");
      expect(getDueDateLabel("2026-04-05", "2026-04-04")).toBe("Due tomorrow");
      expect(getDueDateLabel("2026-09-27", "2026-09-26")).toBe("Due tomorrow");
    });

    it("gives the same answer for the same inputs", () => {
      expect(getDueDateLabel("2026-10-22", today)).toBe(getDueDateLabel("2026-10-22", today));
    });
  });

  describe("without a valid today", () => {
    it("falls back to the full date rather than guessing relative wording", () => {
      expect(getDueDateLabel("2026-10-19", "")).toBe("Due Oct 19, 2026");
      expect(getDueDateLabel("2026-10-20", "not-a-date")).toBe("Due Oct 20, 2026");
    });

    it("still returns no label for an invalid due date", () => {
      expect(getDueDateLabel("2026-02-30", "")).toBeUndefined();
    });
  });
});
