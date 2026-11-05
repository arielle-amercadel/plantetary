import { describe, expect, it } from "vitest";
import {
  ensureCompletionSnapshotForDate,
  getDailyQuestScheduleLabel,
  getStreakValues,
  normalizeDailyQuestSchedules,
  normalizeSavedQuestLists,
  scheduledDaysForQuest,
  weekdays,
} from "../src/app/quest-logic";
import type { CompletionHistory, Quest, QuestLists, Weekday } from "../src/app/quest-types";

const ALL_DAYS: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function quest(overrides: Record<string, unknown> = {}): Quest {
  return {
    id: "quest",
    title: "Test quest",
    category: "Wellness",
    difficulty: "Easy",
    completed: false,
    ...overrides,
  } as Quest;
}

function normalize(target: Quest): Quest {
  return normalizeDailyQuestSchedules({ daily: [target], personal: [] }).daily[0];
}

describe("normalizeDailyQuestSchedules", () => {
  describe("text-only quests", () => {
    it.each(["Every day", "every day", "EVERY DAY", "  Every Day  "])("converts %j to Every day with all seven days", (schedule) => {
      const converted = normalize(quest({ schedule }));

      expect(converted.repeatSchedule).toBe("Every day");
      expect(converted.selectedDays).toEqual(ALL_DAYS);
      expect(converted).not.toHaveProperty("schedule");
    });

    it.each<[string, Weekday[]]>([
      ["Mon", ["Mon"]],
      ["Mon, Wed", ["Mon", "Wed"]],
      ["Mon,Wed", ["Mon", "Wed"]],
      ["Wed, Mon", ["Wed", "Mon"]],
      ["Mon, Tue, Wed, Thu, Fri, Sat, Sun", ALL_DAYS],
    ])("converts %j to Selected days, in its written order", (schedule, expected) => {
      const converted = normalize(quest({ schedule }));

      expect(converted.repeatSchedule).toBe("Selected days");
      expect(converted.selectedDays).toEqual(expected);
      expect(converted).not.toHaveProperty("schedule");
    });

    it.each(["Daily", "Weekdays", "", "   ", "Monday", "mon, wed", "Mon, Funday", "Mon, Wed,", "Due today"])(
      "does not schedule unsupported text %j",
      (schedule) => {
        const converted = normalize(quest({ schedule }));

        expect(converted.repeatSchedule).toBe("Selected days");
        expect(converted.selectedDays).toEqual([]);
        expect(scheduledDaysForQuest(converted)).toEqual([]);
        expect(converted).not.toHaveProperty("schedule");
      },
    );
  });

  describe("existing structured recurrence", () => {
    it("leaves a clean Every day quest as the same object", () => {
      const clean = quest({ repeatSchedule: "Every day", selectedDays: [...ALL_DAYS] });

      expect(normalize(clean)).toBe(clean);
    });

    it("leaves a clean Selected days quest as the same object, whatever its day order", () => {
      const clean = quest({ repeatSchedule: "Selected days", selectedDays: ["Wed", "Mon"] });

      expect(normalize(clean)).toBe(clean);
    });

    it("fills in the days for Every day when they are missing or partial", () => {
      expect(normalize(quest({ schedule: "Every day", repeatSchedule: "Every day" })).selectedDays).toEqual(ALL_DAYS);
      expect(normalize(quest({ repeatSchedule: "Every day", selectedDays: ["Mon"] })).selectedDays).toEqual(ALL_DAYS);
    });
  });

  describe("conflicting fields keep today's precedence", () => {
    it.each<[string, Record<string, unknown>, string, Weekday[]]>([
      ["Every day over weekday text", { repeatSchedule: "Every day", schedule: "Mon" }, "Every day", ALL_DAYS],
      ["Selected days over every-day text", { repeatSchedule: "Selected days", selectedDays: ["Tue"], schedule: "Every day" }, "Selected days", ["Tue"]],
      ["no days stays no days despite every-day text", { repeatSchedule: "Selected days", selectedDays: [], schedule: "Every day" }, "Selected days", []],
      ["a missing list stays no days despite every-day text", { repeatSchedule: "Selected days", schedule: "Every day" }, "Selected days", []],
      ["a missing list stays no days despite weekday text", { repeatSchedule: "Selected days", schedule: "Mon, Wed" }, "Selected days", []],
      ["a day list over every-day text without repeatSchedule", { selectedDays: ["Tue"], schedule: "Every day" }, "Selected days", ["Tue"]],
      ["an empty list falls back to every-day text", { selectedDays: [], schedule: "Every day" }, "Every day", ALL_DAYS],
      ["an empty list falls back to weekday text", { selectedDays: [], schedule: "Mon" }, "Selected days", ["Mon"]],
    ])("%s", (_description, fields, repeatSchedule, days) => {
      const converted = normalize(quest(fields));

      expect(converted.repeatSchedule).toBe(repeatSchedule);
      expect(converted.selectedDays).toEqual(days);
      expect(converted).not.toHaveProperty("schedule");
    });
  });

  describe("malformed recurrence", () => {
    it.each<[string, Record<string, unknown>, string, Weekday[]]>([
      ["an unknown repeatSchedule, recovering from every-day text", { repeatSchedule: "Weekly", schedule: "Every day" }, "Every day", ALL_DAYS],
      ["an unknown repeatSchedule, recovering from weekday text", { repeatSchedule: "Weekly", schedule: "Mon, Wed" }, "Selected days", ["Mon", "Wed"]],
      ["an unknown repeatSchedule, recovering from a day list", { repeatSchedule: "Weekly", selectedDays: ["Fri"], schedule: "Mon" }, "Selected days", ["Fri"]],
      ["an unknown repeatSchedule with nothing usable", { repeatSchedule: "Weekly", schedule: "Daily" }, "Selected days", []],
      ["a wrong-type repeatSchedule", { repeatSchedule: 5, schedule: "Mon" }, "Selected days", ["Mon"]],
      ["a null repeatSchedule", { repeatSchedule: null, schedule: "Every day" }, "Every day", ALL_DAYS],
      ["a day list holding invalid entries", { repeatSchedule: "Selected days", selectedDays: ["Mon", "Funday", 7, null], schedule: "" }, "Selected days", ["Mon"]],
      ["only invalid entries, which do not fall back to text", { selectedDays: ["Funday"], schedule: "Every day" }, "Selected days", []],
      ["a day list that is a string", { selectedDays: "Mon", schedule: "Every day" }, "Every day", ALL_DAYS],
      ["a day list that is an object", { selectedDays: { Mon: true }, schedule: "Tue" }, "Selected days", ["Tue"]],
      ["a null day list under Selected days", { repeatSchedule: "Selected days", selectedDays: null, schedule: "Mon" }, "Selected days", []],
      ["a wrong-type schedule", { schedule: 42 }, "Selected days", []],
      ["a null schedule", { schedule: null, selectedDays: ["Mon"] }, "Selected days", ["Mon"]],
      ["a missing schedule", {}, "Selected days", []],
      ["a missing schedule with valid recurrence", { repeatSchedule: "Every day" }, "Every day", ALL_DAYS],
    ])("recovers %s", (_description, fields, repeatSchedule, days) => {
      const converted = normalize(quest(fields));

      expect(converted.repeatSchedule).toBe(repeatSchedule);
      expect(converted.selectedDays).toEqual(days);
      expect(converted).not.toHaveProperty("schedule");
      expect(scheduledDaysForQuest(converted)).toEqual(days);
      expect(() => getDailyQuestScheduleLabel(converted)).not.toThrow();
    });
  });

  describe("equivalence with the rules older saves ran on", () => {
    // A frozen copy of the scheduling rules from before Stage 1B Step 4, which older saves relied on.
    // It stays here so conversion keeps being checked against what those quests actually did.
    function daysBeforeStep4(target: Quest): Weekday[] {
      if (target.repeatSchedule === "Every day") return ALL_DAYS;
      if (target.repeatSchedule === "Selected days") {
        return target.selectedDays?.filter((day) => ALL_DAYS.includes(day)) ?? [];
      }
      if (target.selectedDays?.length) return target.selectedDays.filter((day) => ALL_DAYS.includes(day));
      const text = (target.schedule ?? "").trim();
      if (text.toLowerCase() === "every day") return ALL_DAYS;
      const parsed = text.split(",").map((day) => day.trim());
      if (parsed.length > 0 && parsed.every((day) => ALL_DAYS.includes(day as Weekday))) return parsed as Weekday[];
      return [];
    }

    const repeats = [undefined, "Every day", "Selected days"] as const;
    const dayLists: (Weekday[] | undefined)[] = [undefined, [], ["Mon"], ["Wed", "Mon"], ["Mon", "Mon"], [...ALL_DAYS]];
    const schedules = [
      "Every day", "every day", " Every Day ", "Mon", "Mon, Wed", "Wed,Mon", "Mon, Mon",
      "Mon, Tue, Wed, Thu, Fri, Sat, Sun", "", "  ", "Daily", "Weekdays", "Mon, Funday", "Due today", "No due date",
    ];
    const shapes = repeats.flatMap((repeatSchedule) => dayLists.flatMap((selectedDays) =>
      schedules.map((schedule) => quest({ repeatSchedule, selectedDays, schedule }))));

    it("covers every combination of the supported fields", () => {
      expect(shapes).toHaveLength(270);
    });

    it("schedules the same days, in the same order, for every shape", () => {
      for (const shape of shapes) {
        expect(scheduledDaysForQuest(normalize(shape)), JSON.stringify(shape)).toEqual(daysBeforeStep4(shape));
      }
    });

    it("labels every shape from its real schedule, whatever its text said", () => {
      for (const shape of shapes) {
        const days = daysBeforeStep4(shape);
        const converted = normalize(shape);
        const expected = converted.repeatSchedule === "Every day"
          ? "Every day"
          : days.length > 0
            ? ALL_DAYS.filter((day) => days.includes(day)).join(", ")
            : "No days selected";

        expect(getDailyQuestScheduleLabel(converted), JSON.stringify(shape)).toBe(expected);
      }
    });

    it("always leaves explicit recurrence", () => {
      for (const shape of shapes) {
        const converted = normalize(shape);

        expect(["Every day", "Selected days"]).toContain(converted.repeatSchedule);
        expect(Array.isArray(converted.selectedDays)).toBe(true);
      }
    });

    it("changes nothing the second time, for every shape", () => {
      for (const shape of shapes) {
        const once = normalize(shape);

        expect(normalize(once), JSON.stringify(shape)).toBe(once);
      }
    });
  });

  describe("safe handling of a save", () => {
    it("returns the same lists when nothing needs converting, so no backup is triggered", () => {
      const lists: QuestLists = {
        daily: [
          quest({ id: "a", repeatSchedule: "Every day", selectedDays: [...ALL_DAYS] }),
          quest({ id: "b", repeatSchedule: "Selected days", selectedDays: ["Mon"] }),
        ],
        personal: [quest({ id: "p", schedule: "Due today" })],
      };

      expect(normalizeDailyQuestSchedules(lists)).toBe(lists);
    });

    it("returns new lists when any quest changes, and reuses the quests that did not", () => {
      const clean = quest({ id: "a", repeatSchedule: "Every day", selectedDays: [...ALL_DAYS] });
      const lists: QuestLists = { daily: [clean, quest({ id: "b", schedule: "Mon" })], personal: [] };

      const next = normalizeDailyQuestSchedules(lists);

      expect(next).not.toBe(lists);
      expect(next.daily[0]).toBe(clean);
      expect(next.daily.map(({ id }) => id)).toEqual(["a", "b"]);
    });

    it("keeps every other field of a converted quest", () => {
      const fields = { id: "keep", title: "Keep me", category: "Self-care", difficulty: "Hard", completed: true, notes: "A note" };

      expect(normalize(quest({ ...fields, schedule: "Every day" }))).toEqual({
        ...fields,
        repeatSchedule: "Every day",
        selectedDays: ALL_DAYS,
      });
    });

    it.each<[string, unknown]>([
      ["a valid date", "2026-10-22"],
      ["an impossible date", "2026-02-30"],
      ["malformed text", "not-a-date"],
      ["an empty string", ""],
      ["a number", 123],
      ["null", null],
      ["an object", { year: 2026 }],
    ])("removes %s from a Daily Quest's due date, and keeps its schedule", (_description, dueDate) => {
      const converted = normalize(quest({ repeatSchedule: "Selected days", selectedDays: ["Mon"], notes: "A note", dueDate }));

      expect(converted).not.toHaveProperty("dueDate");
      expect(converted.selectedDays).toEqual(["Mon"]);
      expect(converted.notes).toBe("A note");
    });

    it("does not change the original quest or lists", () => {
      const before = quest({ schedule: "Every day", selectedDays: [] });
      const snapshot = JSON.stringify(before);

      normalize(before);

      expect(JSON.stringify(before)).toBe(snapshot);
    });

    it("gives each converted quest its own day list", () => {
      const { daily } = normalizeDailyQuestSchedules({
        daily: [quest({ id: "a", schedule: "Every day" }), quest({ id: "b", schedule: "Every day" })],
        personal: [],
      });

      expect(daily[0].selectedDays).not.toBe(daily[1].selectedDays);
      expect(daily[0].selectedDays).not.toBe(weekdays);
    });

    it("leaves Personal Quests untouched, whatever their fields say", () => {
      const personal = [
        quest({ id: "a", schedule: "Due today" }),
        quest({ id: "b", schedule: "Every day", dueDate: "2026-10-22" }),
      ];
      const lists: QuestLists = { daily: [quest({ id: "d", schedule: "Mon" })], personal };

      expect(normalizeDailyQuestSchedules(lists).personal).toBe(personal);
    });
  });

  describe("normalizeSavedQuestLists", () => {
    const clean = (): QuestLists => ({
      daily: [quest({ id: "d", repeatSchedule: "Selected days", selectedDays: ["Mon"] })],
      personal: [quest({ id: "dated", dueDate: "2026-10-22" }), quest({ id: "undated" })],
    });

    it("returns the same lists for a clean save", () => {
      const lists = clean();

      expect(normalizeSavedQuestLists(lists)).toBe(lists);
    });

    it.each(["Due today", "Due Oct 20", "No due date", "", "Every day"])("removes the old Personal label %j", (schedule) => {
      const { personal } = normalizeSavedQuestLists({ daily: [], personal: [quest({ schedule, notes: "A note" })] });

      expect(personal[0]).not.toHaveProperty("schedule");
      expect(personal[0].notes).toBe("A note");
    });

    it("keeps valid Personal due dates and removes invalid ones", () => {
      const { personal } = normalizeSavedQuestLists({
        daily: [],
        personal: [
          quest({ id: "good", schedule: "Due Oct 22", dueDate: "2026-10-22" }),
          quest({ id: "bad", schedule: "Due today", dueDate: "2026-02-30" }),
        ],
      });

      expect(personal[0].dueDate).toBe("2026-10-22");
      expect(personal[1]).not.toHaveProperty("dueDate");
    });

    it("does not give Personal Quests any recurrence", () => {
      const { personal } = normalizeSavedQuestLists({ daily: [], personal: [quest({ schedule: "Every day" })] });

      expect(personal[0]).not.toHaveProperty("repeatSchedule");
      expect(personal[0]).not.toHaveProperty("selectedDays");
    });

    it("cleans every quest in a mixed save, and changes nothing the second time", () => {
      const once = normalizeSavedQuestLists({
        daily: [quest({ id: "a", schedule: "Every day", dueDate: "2026-10-22" }), quest({ id: "b", repeatSchedule: "Selected days", selectedDays: ["Mon"] })],
        personal: [quest({ id: "c", schedule: "Due today", dueDate: "not-a-date" }), quest({ id: "d" })],
      });

      expect(JSON.stringify(once)).not.toContain("schedule\"");
      expect(JSON.stringify(once)).not.toContain("not-a-date");
      expect(normalizeSavedQuestLists(once)).toBe(once);
    });

    it("does not change the original lists", () => {
      const lists: QuestLists = {
        daily: [quest({ schedule: "Every day", dueDate: "2026-10-22" })],
        personal: [quest({ schedule: "Due today" })],
      };
      const before = JSON.stringify(lists);

      normalizeSavedQuestLists(lists);

      expect(JSON.stringify(lists)).toBe(before);
    });
  });

  describe("progress built on converted quests", () => {
    it("fills unopened days from the text-only quests' original days, and leaves finished days alone", () => {
      const original = [quest({ id: "every", schedule: "Every day" }), quest({ id: "mw", schedule: "Mon, Wed" })];
      const converted = normalizeDailyQuestSchedules({ daily: original, personal: [] }).daily;
      const start: CompletionHistory = {
        "2026-10-19": { scheduledQuestIds: ["every", "mw"], completedQuestIds: ["every", "mw"], xpAwardedByQuestId: { every: 5, mw: 5 } },
      };

      const after = ensureCompletionSnapshotForDate(start, converted, "2026-10-23");

      expect(after["2026-10-19"]).toBe(start["2026-10-19"]);
      expect(after["2026-10-20"].scheduledQuestIds).toEqual(["every"]);
      expect(after["2026-10-21"].scheduledQuestIds).toEqual(["every", "mw"]);
      expect(after["2026-10-22"].scheduledQuestIds).toEqual(["every"]);
      expect(after["2026-10-23"].scheduledQuestIds).toEqual(["every"]);
      expect(getStreakValues(after, "2026-10-23")).toEqual({ currentStreak: 0, longestStreak: 1 });
    });
  });
});
