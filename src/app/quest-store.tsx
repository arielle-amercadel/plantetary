"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

export type Difficulty = "Easy" | "Medium" | "Hard";
export type QuestListKey = "daily" | "personal";
export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
export type RepeatSchedule = "Every day" | "Selected days";

export type Quest = {
  id: string;
  title: string;
  category: string;
  schedule: string;
  difficulty: Difficulty;
  completed: boolean;
  repeatSchedule?: RepeatSchedule;
  selectedDays?: Weekday[];
  dueDate?: string;
  notes?: string;
};

type QuestLists = Record<QuestListKey, Quest[]>;
type CategoryLists = Record<QuestListKey, string[]>;
type StoredQuestData = {
  questLists: QuestLists;
  categoryLists: CategoryLists;
  completionHistory?: CompletionHistory;
};

export type CompletionSnapshot = {
  scheduledQuestIds: string[];
  completedQuestIds: string[];
};
export type CompletionHistory = Record<string, CompletionSnapshot>;
export type StreakDay = { date: string; label: string; status: "complete" | "incomplete" | "unscheduled" };

const weekdayLabels: Weekday[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekdayNames: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function getLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function addCalendarDays(date: Date, amount: number): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  result.setDate(result.getDate() + amount);
  return result;
}

function scheduledDaysForQuest(quest: Quest): Weekday[] {
  if (quest.repeatSchedule === "Every day") return weekdays;
  if (quest.repeatSchedule === "Selected days") {
    return quest.selectedDays?.filter((day) => weekdays.includes(day)) ?? [];
  }
  if (quest.selectedDays?.length) return quest.selectedDays.filter((day) => weekdays.includes(day));

  // Older quests stored only a display string. Accept clear, exact schedule labels;
  // ambiguous or unknown values stay unscheduled instead of becoming daily.
  const schedule = quest.schedule.trim();
  if (schedule.toLowerCase() === "every day") return weekdays;
  const parsedDays = schedule.split(",").map((day) => day.trim());
  if (parsedDays.length > 0 && parsedDays.every((day) => weekdays.includes(day as Weekday))) {
    return parsedDays as Weekday[];
  }
  return [];
}

export function isQuestScheduledOnDate(quest: Quest, date: Date): boolean {
  return scheduledDaysForQuest(quest).includes(weekdayLabels[date.getDay()]);
}

function isCompletionHistory(value: unknown): value is CompletionHistory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([date, snapshot]) =>
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Boolean(snapshot) && typeof snapshot === "object" &&
    Array.isArray((snapshot as CompletionSnapshot).scheduledQuestIds) &&
    (snapshot as CompletionSnapshot).scheduledQuestIds.every((id) => typeof id === "string") &&
    Array.isArray((snapshot as CompletionSnapshot).completedQuestIds) &&
    (snapshot as CompletionSnapshot).completedQuestIds.every((id) => typeof id === "string"),
  );
}

function getSnapshotStatus(snapshot: CompletionSnapshot | undefined): StreakDay["status"] {
  if (!snapshot || snapshot.scheduledQuestIds.length === 0) return "unscheduled";
  return snapshot.scheduledQuestIds.every((id) => snapshot.completedQuestIds.includes(id))
    ? "complete"
    : "incomplete";
}

function createSnapshot(quests: Quest[], date: Date): CompletionSnapshot {
  return {
    scheduledQuestIds: quests.filter((quest) => isQuestScheduledOnDate(quest, date)).map((quest) => quest.id),
    completedQuestIds: [],
  };
}

function getStreakValues(history: CompletionHistory, todayKey: string) {
  let longestStreak = 0;
  let run = 0;
  let previousKey: string | undefined;
  for (const [key, snapshot] of Object.entries(history).sort(([a], [b]) => a.localeCompare(b))) {
    if (previousKey && getLocalDateKey(addCalendarDays(dateFromKey(previousKey), 1)) !== key) {
      run = 0;
    }
    const status = getSnapshotStatus(snapshot);
    if (status === "complete") {
      run += 1;
      longestStreak = Math.max(longestStreak, run);
    } else if (status === "incomplete") {
      run = 0;
    }
    previousKey = key;
  }

  // Walk backward through recorded calendar days. Unscheduled days are skipped;
  // an incomplete scheduled day ends the run. Today is omitted until it qualifies.
  let currentStreak = 0;
  const todaySnapshot = history[todayKey];
  let cursor = todaySnapshot && getSnapshotStatus(todaySnapshot) === "complete"
    ? dateFromKey(todayKey)
    : addCalendarDays(dateFromKey(todayKey), -1);
  while (true) {
    const key = getLocalDateKey(cursor);
    const snapshot = history[key];
    if (!snapshot) break;
    if (snapshot.scheduledQuestIds.length === 0) {
      cursor = addCalendarDays(cursor, -1);
      continue;
    }
    if (getSnapshotStatus(snapshot) !== "complete") break;
    currentStreak += 1;
    cursor = addCalendarDays(cursor, -1);
  }
  return { currentStreak, longestStreak };
}

const questStorageKey = "plantetary-quest-data";

const initialCategoryLists: CategoryLists = {
  daily: ["Wellness", "Self-care", "Personal growth"],
  personal: ["Study", "Projects", "Chores", "Personal"],
};

const initialQuestLists: QuestLists = {
  daily: [
    {
      id: "water",
      title: "Drink a glass of water",
      category: "Wellness",
      schedule: "Every day",
      difficulty: "Easy",
      completed: true,
    },
    {
      id: "skincare",
      title: "Morning skincare",
      category: "Self-care",
      schedule: "Every day",
      difficulty: "Easy",
      completed: true,
    },
    {
      id: "reading",
      title: "Read for 20 minutes",
      category: "Personal growth",
      schedule: "Every day",
      difficulty: "Medium",
      completed: false,
    },
    {
      id: "stretch",
      title: "Evening stretch",
      category: "Wellness",
      schedule: "Every day",
      difficulty: "Easy",
      completed: false,
    },
  ],
  personal: [
    {
      id: "biology",
      title: "Review biology notes",
      category: "Study",
      schedule: "Due today",
      difficulty: "Medium",
      completed: false,
    },
    {
      id: "moodboard",
      title: "Finish portfolio moodboard",
      category: "Projects",
      schedule: "Due Oct 20",
      difficulty: "Hard",
      completed: false,
    },
    {
      id: "desk",
      title: "Tidy the desk",
      category: "Chores",
      schedule: "No due date",
      difficulty: "Easy",
      completed: true,
    },
  ],
};

const weekdays: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function isQuest(value: unknown): value is Quest {
  if (typeof value !== "object" || value === null) return false;

  const quest = value as Record<string, unknown>;
  return (
    typeof quest.id === "string" &&
    typeof quest.title === "string" &&
    typeof quest.category === "string" &&
    typeof quest.schedule === "string" &&
    (quest.difficulty === "Easy" || quest.difficulty === "Medium" || quest.difficulty === "Hard") &&
    typeof quest.completed === "boolean" &&
    (quest.repeatSchedule === undefined ||
      quest.repeatSchedule === "Every day" || quest.repeatSchedule === "Selected days") &&
    (quest.selectedDays === undefined ||
      (Array.isArray(quest.selectedDays) && quest.selectedDays.every((day) => weekdays.includes(day)))) &&
    (quest.dueDate === undefined || typeof quest.dueDate === "string") &&
    (quest.notes === undefined || typeof quest.notes === "string")
  );
}

function isStoredQuestData(value: unknown): value is StoredQuestData {
  if (typeof value !== "object" || value === null) return false;

  const data = value as Record<string, unknown>;
  const questLists = data.questLists as Record<string, unknown> | undefined;
  const categoryLists = data.categoryLists as Record<string, unknown> | undefined;

  return Boolean(
    questLists &&
      Array.isArray(questLists.daily) &&
      questLists.daily.every(isQuest) &&
      Array.isArray(questLists.personal) &&
      questLists.personal.every(isQuest) &&
      categoryLists &&
      Array.isArray(categoryLists.daily) &&
      categoryLists.daily.every((category) => typeof category === "string") &&
      Array.isArray(categoryLists.personal) &&
      categoryLists.personal.every((category) => typeof category === "string"),
  );
}

const xpByDifficulty: Record<Difficulty, number> = {
  Easy: 5,
  Medium: 10,
  Hard: 20,
};

export function getQuestXp(difficulty: Difficulty): number {
  return xpByDifficulty[difficulty];
}

export function findCategoryMatch(categories: string[], name: string): string | undefined {
  const normalizedName = name.trim().toLowerCase();
  if (!normalizedName) return undefined;

  return categories.find((category) => category.trim().toLowerCase() === normalizedName);
}

export function getCustomCategoryError(categories: string[], name: string): string {
  if (!name.trim()) return "Enter a category name.";
  if (findCategoryMatch(categories, name)) return "That category already exists.";
  return "";
}

export function getLevelProgress(totalXp: number) {
  let level = 1;
  let xpIntoLevel = totalXp;
  let xpForNextLevel = 100;

  while (xpIntoLevel >= xpForNextLevel) {
    xpIntoLevel -= xpForNextLevel;
    level += 1;
    xpForNextLevel += 50;
  }

  return {
    level,
    xpIntoLevel,
    xpForNextLevel,
    xpProgressPercent: (xpIntoLevel / xpForNextLevel) * 100,
  };
}

type QuestStoreValue = {
  questLists: QuestLists;
  categoryLists: CategoryLists;
  totalXp: number;
  currentStreak: number;
  longestStreak: number;
  streakWeek: StreakDay[];
  dailyCompletedQuestIds: string[];
  dailyScheduledQuestIds: string[];
  addQuest: (list: QuestListKey, quest: Quest) => void;
  addCategory: (list: QuestListKey, name: string) => boolean;
  toggleQuest: (list: QuestListKey, questId: string) => void;
  deleteQuest: (list: QuestListKey, questId: string) => void;
};

const QuestStoreContext = createContext<QuestStoreValue | null>(null);

export function QuestProvider({ children }: { children: ReactNode }) {
  const [questLists, setQuestLists] = useState(initialQuestLists);
  const [categoryLists, setCategoryLists] = useState(initialCategoryLists);
  const [completionHistory, setCompletionHistory] = useState<CompletionHistory>({});
  const [todayKey, setTodayKey] = useState("");
  const [hasRestored, setHasRestored] = useState(false);

  useEffect(() => {
    let restoredQuestLists = initialQuestLists;
    let restoredCategoryLists = initialCategoryLists;
    let restoredCompletionHistory: CompletionHistory = {};

    try {
      if (typeof window !== "undefined") {
        const savedData = window.localStorage.getItem(questStorageKey);
        if (savedData) {
          const parsedData: unknown = JSON.parse(savedData);
          if (isStoredQuestData(parsedData)) {
            restoredQuestLists = parsedData.questLists;
            restoredCategoryLists = parsedData.categoryLists;
            if (isCompletionHistory(parsedData.completionHistory)) {
              restoredCompletionHistory = parsedData.completionHistory;
            }
          }
        }
      }
    } catch {}

    queueMicrotask(() => {
      const restoredToday = getLocalDateKey(new Date());
      if (!restoredCompletionHistory[restoredToday]) {
        restoredCompletionHistory[restoredToday] = createSnapshot(
          restoredQuestLists.daily,
          dateFromKey(restoredToday),
        );
      }
      setQuestLists(restoredQuestLists);
      setCategoryLists(restoredCategoryLists);
      setCompletionHistory(restoredCompletionHistory);
      setTodayKey(restoredToday);
      setHasRestored(true);
    });
  }, []);

  useEffect(() => {
    const updateToday = () => {
      const nextTodayKey = getLocalDateKey(new Date());
      setTodayKey(nextTodayKey);
      setCompletionHistory((current) => current[nextTodayKey]
        ? current
        : { ...current, [nextTodayKey]: createSnapshot(questLists.daily, dateFromKey(nextTodayKey)) });
    };
    const interval = window.setInterval(updateToday, 60_000);
    window.addEventListener("focus", updateToday);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", updateToday);
    };
  }, [questLists.daily]);

  useEffect(() => {
    if (!hasRestored || typeof window === "undefined") return;

    try {
      window.localStorage.setItem(
        questStorageKey,
        JSON.stringify({ questLists, categoryLists, completionHistory }),
      );
    } catch {
      return;
    }
  }, [hasRestored, questLists, categoryLists, completionHistory, todayKey]);

  const totalXp = [...questLists.daily, ...questLists.personal]
    .filter((quest) => quest.completed)
    .reduce((total, quest) => total + getQuestXp(quest.difficulty), 0);
  const historyForDisplay = completionHistory;
  const streaks = todayKey
    ? getStreakValues(historyForDisplay, todayKey)
    : { currentStreak: 0, longestStreak: 0 };
  const mondayOffset = todayKey ? (dateFromKey(todayKey).getDay() + 6) % 7 : 0;
  const weekStart = todayKey ? addCalendarDays(dateFromKey(todayKey), -mondayOffset) : new Date();
  const streakWeek: StreakDay[] = Array.from({ length: 7 }, (_, index) => {
    const date = addCalendarDays(weekStart, index);
    const dateKey = getLocalDateKey(date);
    return {
      date: dateKey,
      label: weekdayNames[index],
      status: getSnapshotStatus(historyForDisplay[dateKey]),
    };
  });
  const dailyCompletedQuestIds = todayKey
    ? completionHistory[todayKey]?.completedQuestIds ?? []
    : [];
  const dailyScheduledQuestIds = todayKey
    ? completionHistory[todayKey]?.scheduledQuestIds ?? []
    : [];

  function updateQuestList(
    list: QuestListKey,
    update: (quests: Quest[]) => Quest[],
  ) {
    setQuestLists((current) => ({
      ...current,
      [list]: update(current[list]),
    }));
  }

  function addQuest(list: QuestListKey, quest: Quest) {
    updateQuestList(list, (quests) => [...quests, quest]);
  }

  function addCategory(list: QuestListKey, name: string) {
    const trimmedName = name.trim();
    if (!trimmedName || findCategoryMatch(categoryLists[list], trimmedName)) return false;

    setCategoryLists((current) => {
      if (findCategoryMatch(current[list], trimmedName)) return current;
      return { ...current, [list]: [...current[list], trimmedName] };
    });
    return true;
  }

  function toggleQuest(list: QuestListKey, questId: string) {
    if (list === "daily" && todayKey) {
      const quest = questLists.daily.find((item) => item.id === questId);
      const snapshot = completionHistory[todayKey]
        ?? createSnapshot(questLists.daily, dateFromKey(todayKey));
      if (quest && snapshot.scheduledQuestIds.includes(questId)) {
        const isCompletedToday = snapshot.completedQuestIds.includes(questId);
        const nextCompletedIds = new Set(snapshot.completedQuestIds);
        if (isCompletedToday) nextCompletedIds.delete(questId);
        else nextCompletedIds.add(questId);
        setCompletionHistory((current) => {
          return {
            ...current,
            [todayKey]: {
              scheduledQuestIds: current[todayKey]?.scheduledQuestIds ?? snapshot.scheduledQuestIds,
              completedQuestIds: [...nextCompletedIds],
            },
          };
        });
        updateQuestList(list, (quests) => quests.map((item) =>
          item.id === questId ? { ...item, completed: !isCompletedToday } : item,
        ));
        return;
      }
    }
    updateQuestList(list, (quests) =>
      quests.map((quest) =>
        quest.id === questId ? { ...quest, completed: !quest.completed } : quest,
      ),
    );
  }

  function deleteQuest(list: QuestListKey, questId: string) {
    updateQuestList(list, (quests) => quests.filter((quest) => quest.id !== questId));
  }

  return (
    <QuestStoreContext.Provider
      value={{ questLists, categoryLists, totalXp, ...streaks, streakWeek, dailyCompletedQuestIds, dailyScheduledQuestIds, addQuest, addCategory, toggleQuest, deleteQuest }}
    >
      {children}
    </QuestStoreContext.Provider>
  );
}

export function useQuestStore() {
  const store = useContext(QuestStoreContext);

  if (!store) {
    throw new Error("useQuestStore must be used within QuestProvider");
  }

  return store;
}
