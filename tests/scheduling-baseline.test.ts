import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  createSnapshot,
  ensureCompletionSnapshotForDate,
  getDailyQuestScheduleLabel,
  getLocalDateKey,
  getSnapshotStatus,
  getStreakValues,
  hasQuestScheduleChanged,
  isQuestPastDue,
  isQuestScheduledOnDate,
  normalizeDailyQuestSchedules,
  scheduledDaysForQuest,
  toggleDailyQuestCompletion,
} from "../src/app/quest-logic";
import type { CompletionHistory, Quest, Weekday } from "../src/app/quest-types";

/**
 * Baseline for Stage 1B, written before daily scheduling moved away from the legacy `schedule` text.
 * Since Step 4, the app schedules from structured recurrence only, and saved quests are converted on
 * load. So tests of older data go through `loaded`, the same conversion a saved quest gets, and every
 * expected day is unchanged from the original baseline. Each group's title names what it protects:
 *   [legacy text]  [structured recurrence]  [no fallback]  [precedence]  [progress]  [personal]
 * A failure here means behavior changed, so a later step must preserve it or change it deliberately.
 */

const ALL_DAYS: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Monday, October 19, 2026 through Sunday, October 25, 2026, in local time.
const DAY_OF_WEEK = ALL_DAYS.map((day, index) => [day, new Date(2026, 9, 19 + index, 12)] as const);
const monday = new Date(2026, 9, 19, 12);
const tuesday = new Date(2026, 9, 20, 12);

function quest(overrides: Partial<Quest> = {}): Quest {
  return {
    id: "quest",
    title: "Test quest",
    category: "Wellness",
    schedule: "",
    difficulty: "Easy",
    completed: false,
    ...overrides,
  };
}

/** What a saved quest becomes when the app loads it. */
function loaded(saved: Quest): Quest {
  return normalizeDailyQuestSchedules({ daily: [saved], personal: [] }).daily[0];
}

function scheduledWeekdays(target: Quest): Weekday[] {
  return DAY_OF_WEEK.filter(([, date]) => isQuestScheduledOnDate(target, date)).map(([day]) => day);
}

describe("[legacy text] older saves scheduled from the schedule field, once converted on load", () => {
  it.each<[string, string, Weekday[]]>([
    ["exact every-day text", "Every day", ALL_DAYS],
    ["lowercase every-day text", "every day", ALL_DAYS],
    ["uppercase every-day text", "EVERY DAY", ALL_DAYS],
    ["every-day text with surrounding spaces", "  Every Day  ", ALL_DAYS],
    ["one weekday", "Mon", ["Mon"]],
    ["two weekdays", "Mon, Wed", ["Mon", "Wed"]],
    ["weekdays without spaces", "Mon,Wed", ["Mon", "Wed"]],
    ["weekdays with extra spaces", "  Mon ,  Wed  ", ["Mon", "Wed"]],
    ["all seven weekdays", "Mon, Tue, Wed, Thu, Fri, Sat, Sun", ALL_DAYS],
  ])("recognizes %s", (_description, schedule, expected) => {
    expect(scheduledDaysForQuest(loaded(quest({ schedule })))).toEqual(expected);
  });

  it.each<[string, string]>([
    ["empty text", ""],
    ["only spaces", "   "],
    ["an unknown word", "Daily"],
    ["an unknown plural", "Weekdays"],
    ["a personal label", "Due today"],
    ["a fixed date label", "Due Oct 20"],
    ["no due date text", "No due date"],
    ["a full weekday name", "Monday"],
    ["lowercase weekdays", "mon, wed"],
    ["one unknown day in a list", "Mon, Funday"],
    ["a trailing comma", "Mon, Wed,"],
  ])("schedules no days for %s, rather than guessing", (_description, schedule) => {
    expect(scheduledDaysForQuest(loaded(quest({ schedule })))).toEqual([]);
  });

  it("keeps weekdays in their written order", () => {
    expect(scheduledDaysForQuest(loaded(quest({ schedule: "Wed, Mon" })))).toEqual(["Wed", "Mon"]);
  });

  it("keeps a weekday written twice", () => {
    expect(scheduledDaysForQuest(loaded(quest({ schedule: "Mon, Mon" })))).toEqual(["Mon", "Mon"]);
  });

  it.each(DAY_OF_WEEK)("schedules an every-day quest on %s", (_day, date) => {
    expect(isQuestScheduledOnDate(loaded(quest({ schedule: "Every day" })), date)).toBe(true);
  });

  it("schedules a text weekday quest only on its own days", () => {
    expect(scheduledWeekdays(loaded(quest({ schedule: "Mon, Wed" })))).toEqual(["Mon", "Wed"]);
    expect(scheduledWeekdays(loaded(quest({ schedule: "Sun" })))).toEqual(["Sun"]);
  });

  it("never schedules a quest with unrecognized text", () => {
    expect(scheduledWeekdays(loaded(quest({ schedule: "Daily" })))).toEqual([]);
  });

  it.each<[string, string, string]>([
    ["every-day text as Every day", "Every day", "Every day"],
    ["lowercase every-day text as Every day", "every day", "Every day"],
    ["every-day text with spaces as Every day", "  Every Day  ", "Every day"],
    ["one weekday", "Mon", "Mon"],
    ["weekdays in Monday-first order", "Wed, Mon", "Mon, Wed"],
    ["weekdays written without spaces", "Mon,Wed", "Mon, Wed"],
    ["unrecognized text as no days", "Daily", "No days selected"],
    ["empty text as no days", "", "No days selected"],
  ])("labels %s", (_description, schedule, expected) => {
    expect(getDailyQuestScheduleLabel(loaded(quest({ schedule })))).toBe(expected);
  });
});

describe("[structured recurrence] scheduling from repeatSchedule and selectedDays", () => {
  const structuredEveryDay = quest({ schedule: "Every day", repeatSchedule: "Every day", selectedDays: ALL_DAYS });

  it("schedules an Every day quest on all seven days", () => {
    expect(scheduledDaysForQuest(structuredEveryDay)).toEqual(ALL_DAYS);
    expect(scheduledWeekdays(structuredEveryDay)).toEqual(ALL_DAYS);
    expect(getDailyQuestScheduleLabel(structuredEveryDay)).toBe("Every day");
  });

  it.each<[string, Weekday[], Weekday[]]>([
    ["one day", ["Fri"], ["Fri"]],
    ["two days", ["Mon", "Wed"], ["Mon", "Wed"]],
    ["all seven days", ALL_DAYS, ALL_DAYS],
  ])("schedules a Selected days quest with %s", (_description, selectedDays, expected) => {
    const target = quest({ schedule: selectedDays.join(", "), repeatSchedule: "Selected days", selectedDays });

    expect(scheduledDaysForQuest(target)).toEqual(expected);
    expect(scheduledWeekdays(target)).toEqual(expected);
  });

  it("keeps Selected days in saved order but labels them Monday-first", () => {
    const target = quest({ schedule: "Wed, Mon", repeatSchedule: "Selected days", selectedDays: ["Wed", "Mon"] });

    expect(scheduledDaysForQuest(target)).toEqual(["Wed", "Mon"]);
    expect(getDailyQuestScheduleLabel(target)).toBe("Mon, Wed");
  });

  it("schedules no days for Selected days with an empty list", () => {
    expect(scheduledDaysForQuest(quest({ repeatSchedule: "Selected days", selectedDays: [] }))).toEqual([]);
  });

  it("ignores unknown weekdays in a Selected days list", () => {
    const selectedDays = ["Mon", "Funday"] as unknown as Weekday[];

    expect(scheduledDaysForQuest(quest({ repeatSchedule: "Selected days", selectedDays }))).toEqual(["Mon"]);
  });

  it("treats a move from text-only to structured recurrence as a schedule change", () => {
    const textOnly = quest({ schedule: "Every day" });

    expect(hasQuestScheduleChanged(textOnly, structuredEveryDay)).toBe(true);
    expect(hasQuestScheduleChanged(structuredEveryDay, { ...structuredEveryDay })).toBe(false);
  });
});

describe("[no fallback] normal gameplay never reads the legacy text", () => {
  it.each(["Every day", "every day", "Mon", "Mon, Wed", "Mon, Tue, Wed, Thu, Fri, Sat, Sun"])(
    "does not schedule from the text %j alone",
    (schedule) => {
      const textOnly = quest({ schedule });

      expect(scheduledDaysForQuest(textOnly)).toEqual([]);
      expect(scheduledWeekdays(textOnly)).toEqual([]);
      expect(getDailyQuestScheduleLabel(textOnly)).toBe("No days selected");
      expect(createSnapshot([textOnly], monday).scheduledQuestIds).toEqual([]);
    },
  );

  it.each<[string, Partial<Quest>, Weekday[]]>([
    ["Every day ignores weekday text", { repeatSchedule: "Every day", schedule: "Mon" }, ALL_DAYS],
    ["Every day ignores missing days", { repeatSchedule: "Every day", schedule: "" }, ALL_DAYS],
    ["Selected days ignores every-day text", { repeatSchedule: "Selected days", selectedDays: ["Tue"], schedule: "Every day" }, ["Tue"]],
    ["an empty selection ignores every-day text", { repeatSchedule: "Selected days", selectedDays: [], schedule: "Every day" }, []],
    ["a missing selection ignores weekday text", { repeatSchedule: "Selected days", schedule: "Mon, Wed" }, []],
    ["a day list ignores text when repeatSchedule is absent", { selectedDays: ["Tue"], schedule: "Every day" }, ["Tue"]],
    ["an empty day list does not fall back to text", { selectedDays: [], schedule: "Every day" }, []],
  ])("%s", (_description, fields, expected) => {
    expect(scheduledDaysForQuest(quest(fields))).toEqual(expected);
  });

  it("gives the same schedule and label whatever the text says", () => {
    const structured = { repeatSchedule: "Selected days" as const, selectedDays: ["Mon", "Wed"] as Weekday[] };

    for (const schedule of ["", "Every day", "Fri", "Daily", "Due today"]) {
      const target = quest({ ...structured, schedule });

      expect(scheduledDaysForQuest(target)).toEqual(["Mon", "Wed"]);
      expect(getDailyQuestScheduleLabel(target)).toBe("Mon, Wed");
    }
  });
});

describe("[precedence] when saved scheduling fields disagree", () => {
  it.each<[string, Partial<Quest>, Weekday[]]>([
    ["Every day beats weekday text", { repeatSchedule: "Every day", schedule: "Mon" }, ALL_DAYS],
    ["Every day beats unknown text", { repeatSchedule: "Every day", schedule: "Daily" }, ALL_DAYS],
    ["Every day beats a partial day list", { repeatSchedule: "Every day", selectedDays: ["Mon"], schedule: "Mon" }, ALL_DAYS],
    ["Selected days beats every-day text", { repeatSchedule: "Selected days", selectedDays: ["Tue"], schedule: "Every day" }, ["Tue"]],
    ["Selected days beats weekday text", { repeatSchedule: "Selected days", selectedDays: ["Tue"], schedule: "Mon" }, ["Tue"]],
    ["Selected days with no list ignores every-day text", { repeatSchedule: "Selected days", schedule: "Every day" }, []],
    ["Selected days with no list ignores weekday text", { repeatSchedule: "Selected days", schedule: "Mon, Wed" }, []],
    ["Selected days with an empty list ignores every-day text", { repeatSchedule: "Selected days", selectedDays: [], schedule: "Every day" }, []],
    ["a day list beats every-day text when repeatSchedule is absent", { selectedDays: ["Tue"], schedule: "Every day" }, ["Tue"]],
    ["a day list beats weekday text when repeatSchedule is absent", { selectedDays: ["Tue"], schedule: "Mon" }, ["Tue"]],
    ["an empty day list falls back to every-day text", { selectedDays: [], schedule: "Every day" }, ALL_DAYS],
    ["an empty day list falls back to weekday text", { selectedDays: [], schedule: "Mon" }, ["Mon"]],
  ])("%s", (_description, fields, expected) => {
    expect(scheduledDaysForQuest(loaded(quest(fields)))).toEqual(expected);
  });

  it("does not fall back to text when a day list holds only unknown weekdays", () => {
    const selectedDays = ["Funday"] as unknown as Weekday[];

    expect(scheduledDaysForQuest(loaded(quest({ selectedDays, schedule: "Every day" })))).toEqual([]);
  });

  // These rows used to show text that contradicted the real schedule. The days have not changed.
  it.each<[string, Partial<Quest>, string, Weekday[]]>([
    ["Every day with weekday text shows Every day", { repeatSchedule: "Every day", schedule: "Mon" }, "Every day", ALL_DAYS],
    ["Every day with empty text shows Every day", { repeatSchedule: "Every day", schedule: "" }, "Every day", ALL_DAYS],
    ["a day list with every-day text shows its day", { selectedDays: ["Tue"], schedule: "Every day" }, "Tue", ["Tue"]],
    ["Selected days with no list and every-day text shows no days", { repeatSchedule: "Selected days", schedule: "Every day" }, "No days selected", []],
    ["Selected days with no list and weekday text shows no days", { repeatSchedule: "Selected days", schedule: "Mon" }, "No days selected", []],
  ])("the label matches the schedule: %s", (_description, fields, label, days) => {
    const target = loaded(quest(fields));

    expect(getDailyQuestScheduleLabel(target)).toBe(label);
    expect(scheduledDaysForQuest(target)).toEqual(days);
  });

  it("does not use a due date for scheduling", () => {
    expect(scheduledDaysForQuest(loaded(quest({ schedule: "Mon", dueDate: "2026-10-20" })))).toEqual(["Mon"]);
    expect(isQuestScheduledOnDate(quest({ schedule: "", dueDate: "2026-10-19" }), monday)).toBe(false);
  });
});

describe("[progress] snapshots, rollover, and streaks with converted and structured quests", () => {
  const everyDay = loaded(quest({ id: "every", schedule: "Every day" }));
  const mondayWednesday = loaded(quest({ id: "mw", schedule: "Mon, Wed" }));
  const structuredTuesday = quest({ id: "tue", schedule: "Tue", repeatSchedule: "Selected days", selectedDays: ["Tue"] });
  const unknown = loaded(quest({ id: "unknown", schedule: "Daily" }));
  const allQuests = [everyDay, mondayWednesday, structuredTuesday, unknown];

  it("builds each day's snapshot from converted and structured quests alike", () => {
    expect(createSnapshot(allQuests, monday).scheduledQuestIds).toEqual(["every", "mw"]);
    expect(createSnapshot(allQuests, tuesday).scheduledQuestIds).toEqual(["every", "tue"]);
    expect(createSnapshot(allQuests, new Date(2026, 9, 21, 12)).scheduledQuestIds).toEqual(["every", "mw"]);
    expect(createSnapshot(allQuests, new Date(2026, 9, 22, 12)).scheduledQuestIds).toEqual(["every"]);
  });

  it("uses the local calendar day near midnight on both sides", () => {
    const lateMonday = new Date(2026, 9, 19, 23, 59, 59);
    const earlyTuesday = new Date(2026, 9, 20, 0, 0, 1);

    expect(getLocalDateKey(lateMonday)).toBe("2026-10-19");
    expect(getLocalDateKey(earlyTuesday)).toBe("2026-10-20");
    expect(isQuestScheduledOnDate(mondayWednesday, lateMonday)).toBe(true);
    expect(isQuestScheduledOnDate(mondayWednesday, earlyTuesday)).toBe(false);
  });

  it("creates the next day's snapshot on rollover and leaves the finished day alone", () => {
    const start = ensureCompletionSnapshotForDate({}, allQuests, "2026-10-19");
    const completed = toggleDailyQuestCompletion(start, "2026-10-19", "every", "Easy");
    const rolled = ensureCompletionSnapshotForDate(completed, allQuests, "2026-10-20");

    expect(rolled["2026-10-19"]).toBe(completed["2026-10-19"]);
    expect(rolled["2026-10-19"].completedQuestIds).toEqual(["every"]);
    expect(rolled["2026-10-20"]).toEqual({ scheduledQuestIds: ["every", "tue"], completedQuestIds: [] });
  });

  it("fills unopened days using converted schedules", () => {
    const start: CompletionHistory = { "2026-10-19": { scheduledQuestIds: ["mw"], completedQuestIds: ["mw"] } };
    const next = ensureCompletionSnapshotForDate(start, [mondayWednesday], "2026-10-23");

    expect(next["2026-10-20"].scheduledQuestIds).toEqual([]);
    expect(next["2026-10-21"].scheduledQuestIds).toEqual(["mw"]);
    expect(next["2026-10-22"].scheduledQuestIds).toEqual([]);
    expect(getSnapshotStatus(next["2026-10-21"])).toBe("incomplete");
    expect(getStreakValues(next, "2026-10-23").currentStreak).toBe(0);
  });

  it("keeps a streak across days a converted quest is not scheduled", () => {
    const start: CompletionHistory = { "2026-10-19": { scheduledQuestIds: ["mw"], completedQuestIds: ["mw"] } };
    const onTuesday = ensureCompletionSnapshotForDate(start, [mondayWednesday], "2026-10-20");

    expect(getStreakValues(onTuesday, "2026-10-20").currentStreak).toBe(1);
  });

  it("does not schedule a quest with unrecognized text, so it never breaks a streak", () => {
    let history: CompletionHistory = {};
    let date = monday;
    for (let day = 0; day < 3; day += 1) {
      history = ensureCompletionSnapshotForDate(history, [unknown], getLocalDateKey(date));
      date = addCalendarDays(date, 1);
    }

    expect(Object.values(history).every((snapshot) => snapshot.scheduledQuestIds.length === 0)).toBe(true);
    expect(getStreakValues(history, "2026-10-21").currentStreak).toBe(0);
  });

  it("awards daily XP the same way for converted and structured quests", () => {
    const start: CompletionHistory = {
      "2026-10-20": { scheduledQuestIds: ["every", "tue"], completedQuestIds: [] },
    };
    const first = toggleDailyQuestCompletion(start, "2026-10-20", "every", "Easy");
    const both = toggleDailyQuestCompletion(first, "2026-10-20", "tue", "Hard");

    expect(both["2026-10-20"].xpAwardedByQuestId).toEqual({ every: 5, tue: 20 });
    expect(getSnapshotStatus(both["2026-10-20"])).toBe("complete");
  });
});

describe("[personal] Personal Quests stay independent of daily recurrence", () => {
  it("does not treat a due date or date label as a scheduled day", () => {
    const personal = quest({ schedule: "Due today", dueDate: "2026-10-19" });

    expect(scheduledDaysForQuest(personal)).toEqual([]);
    expect(isQuestScheduledOnDate(personal, monday)).toBe(false);
  });

  it("is judged past due from its date, not from any schedule fields", () => {
    const personal = quest({ schedule: "Every day", repeatSchedule: "Every day", dueDate: "2026-10-18" });

    expect(isQuestPastDue(personal, "personal", "2026-10-19")).toBe(true);
    expect(isQuestPastDue(personal, "daily", "2026-10-19")).toBe(false);
  });

  it("does not match old schedule text if a Personal Quest is ever passed to the helper", () => {
    expect(isQuestScheduledOnDate(quest({ schedule: "Every day" }), monday)).toBe(false);
  });

  it("stays out of daily snapshots, which are built only from the list they are given", () => {
    const personal = quest({ id: "personal", schedule: "Every day" });
    const daily = quest({ id: "daily", schedule: "Every day", repeatSchedule: "Every day" });

    expect(createSnapshot([daily], monday).scheduledQuestIds).toEqual(["daily"]);
    expect(createSnapshot([daily], monday).scheduledQuestIds).not.toContain(personal.id);
  });
});
