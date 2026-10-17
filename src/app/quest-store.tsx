"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  CategoryLists,
  CompletionHistory,
  CompletionSnapshot,
  Quest,
  QuestLists,
  QuestListKey,
  StreakDay,
  StoredQuestData,
} from "./quest-types";
import {
  addCalendarDays,
  createSnapshot,
  dateFromKey,
  findCategoryMatch,
  getLocalDateKey,
  getQuestXp,
  getSnapshotStatus,
  getStreakValues,
  weekdayNames,
  weekdays,
} from "./quest-logic";

export type {
  Difficulty,
  QuestListKey,
  Weekday,
  RepeatSchedule,
  Quest,
  CompletionSnapshot,
  CompletionHistory,
  StreakDay,
} from "./quest-types";
export {
  getLocalDateKey,
  isQuestScheduledOnDate,
  getQuestXp,
  findCategoryMatch,
  getCustomCategoryError,
  getLevelProgress,
} from "./quest-logic";

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
