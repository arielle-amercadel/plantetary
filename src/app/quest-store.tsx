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
  addQuestToHistoryAtDate,
  createSnapshot,
  dateFromKey,
  findCategoryMatch,
  getXpLedgerTotal,
  getLocalDateKey,
  getRecoverableOrphanedDailyQuestIds,
  getSnapshotStatus,
  getStreakValues,
  hasQuestScheduleChanged,
  isDailyQuestScheduledForToggle,
  migrateStoredData,
  recordPersonalXpAward,
  removeQuestFromHistoryAtDate,
  recoverOrphanedDailyQuestFromHistory,
  rescheduleQuestInHistory,
  reversePersonalXpAward,
  toggleDailyQuestCompletion,
  updateQuestInLists,
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
const validBackupStorageKey = "plantetary-quest-data-backup-v1";
const invalidBackupStorageKey = "plantetary-quest-data-invalid-backup";

function preserveRawValueIfAbsent(backupKey: string, rawValue: string): boolean {
  try {
    if (window.localStorage.getItem(backupKey) !== null) return true;
    window.localStorage.setItem(backupKey, rawValue);
    return window.localStorage.getItem(backupKey) === rawValue;
  } catch {
    return false;
  }
}

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

const initialStoredQuestData = migrateStoredData({
  questLists: initialQuestLists,
  categoryLists: initialCategoryLists,
});

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
  recoverableDailyQuestIds: string[];
  hasRestored: boolean;
  addQuest: (list: QuestListKey, quest: Quest) => void;
  updateQuest: (
    list: QuestListKey,
    questId: string,
    updates: Partial<Omit<Quest, "id" | "completed">>,
  ) => boolean;
  addCategory: (list: QuestListKey, name: string) => boolean;
  toggleQuest: (list: QuestListKey, questId: string) => void;
  deleteQuest: (list: QuestListKey, questId: string) => void;
  recoverOrphanedDailyQuest: (questId: string) => void;
};

const QuestStoreContext = createContext<QuestStoreValue | null>(null);

export function QuestProvider({ children }: { children: ReactNode }) {
  const [questLists, setQuestLists] = useState(initialStoredQuestData.questLists);
  const [categoryLists, setCategoryLists] = useState(initialStoredQuestData.categoryLists);
  const [completionHistory, setCompletionHistory] = useState<CompletionHistory>(
    initialStoredQuestData.completionHistory ?? {},
  );
  const [personalXpByQuestId, setPersonalXpByQuestId] = useState<Record<string, number> | undefined>(
    initialStoredQuestData.personalXpByQuestId,
  );
  const [legacyXpBonus, setLegacyXpBonus] = useState(initialStoredQuestData.legacyXpBonus ?? 0);
  const [schemaVersion, setSchemaVersion] = useState(initialStoredQuestData.schemaVersion ?? 2);
  const [todayKey, setTodayKey] = useState("");
  const [hasRestored, setHasRestored] = useState(false);
  const [canPersistStorage, setCanPersistStorage] = useState(true);

  useEffect(() => {
    let canPersist = true;
    let restoredData = initialStoredQuestData;

    try {
      if (typeof window !== "undefined") {
        const rawData = window.localStorage.getItem(questStorageKey);
        if (rawData !== null) {
          let parsedData: unknown;
          try {
            parsedData = JSON.parse(rawData);
          } catch {
            parsedData = undefined;
          }

          if (isStoredQuestData(parsedData)) {
            const validHistory = parsedData.completionHistory === undefined ||
              isCompletionHistory(parsedData.completionHistory);
            const validatedData: StoredQuestData = validHistory
              ? parsedData
              : { ...parsedData, completionHistory: undefined };
            const migratedData = migrateStoredData(validatedData);
            if (
              (migratedData !== validatedData || validatedData !== parsedData) &&
              !preserveRawValueIfAbsent(validBackupStorageKey, rawData)
            ) {
              canPersist = false;
              console.error("Plantetary could not back up saved data before migrating it. Changes will not be saved this session.");
            }
            restoredData = migratedData;
          } else if (!preserveRawValueIfAbsent(invalidBackupStorageKey, rawData)) {
            canPersist = false;
            console.error("Plantetary could not back up invalid saved data. Defaults will not overwrite it this session.");
          }
        }
      }
    } catch {
      canPersist = false;
      console.error("Plantetary could not safely access saved data. Changes will not be saved this session.");
    }

    queueMicrotask(() => {
      const restoredToday = getLocalDateKey(new Date());
      const restoredHistory = restoredData.completionHistory ?? {};
      const completionHistory = restoredHistory[restoredToday]
        ? restoredHistory
        : {
          ...restoredHistory,
          [restoredToday]: createSnapshot(restoredData.questLists.daily, dateFromKey(restoredToday)),
        };
      setQuestLists(restoredData.questLists);
      setCategoryLists(restoredData.categoryLists);
      setCompletionHistory(completionHistory);
      setPersonalXpByQuestId(restoredData.personalXpByQuestId);
      setLegacyXpBonus(restoredData.legacyXpBonus ?? 0);
      setSchemaVersion(restoredData.schemaVersion ?? 2);
      setTodayKey(restoredToday);
      setCanPersistStorage(canPersist);
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
    if (!hasRestored || !canPersistStorage || typeof window === "undefined") return;

    try {
      window.localStorage.setItem(
        questStorageKey,
        JSON.stringify({
          schemaVersion,
          questLists,
          categoryLists,
          completionHistory,
          personalXpByQuestId,
          legacyXpBonus,
        }),
      );
    } catch {
      return;
    }
  }, [hasRestored, canPersistStorage, questLists, categoryLists, completionHistory, personalXpByQuestId, legacyXpBonus, schemaVersion, todayKey]);

  const totalXp = getXpLedgerTotal(completionHistory, personalXpByQuestId, legacyXpBonus);
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
  const recoverableDailyQuestIds = todayKey
    ? getRecoverableOrphanedDailyQuestIds(completionHistory[todayKey], questLists.daily)
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
    if (list === "daily") {
      const actionDate = new Date();
      setCompletionHistory((current) => addQuestToHistoryAtDate(current, quest, actionDate));
    }
  }

  function updateQuest(
    list: QuestListKey,
    questId: string,
    updates: Partial<Omit<Quest, "id" | "completed">>,
  ): boolean {
    const existingQuest = questLists[list].find((quest) => quest.id === questId);
    if (!existingQuest) return false;
    const updatedQuest = {
      ...existingQuest,
      ...updates,
      id: existingQuest.id,
      completed: existingQuest.completed,
    };
    setQuestLists((current) => updateQuestInLists(current, list, questId, updates));
    if (list === "daily" && hasQuestScheduleChanged(existingQuest, updatedQuest)) {
      const actionDateKey = getLocalDateKey(new Date());
      setCompletionHistory((current) => rescheduleQuestInHistory(current, updatedQuest, actionDateKey));
    }
    return true;
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
    if (list === "daily") {
      const actionDate = new Date();
      const actionDateKey = getLocalDateKey(actionDate);
      const quest = questLists.daily.find((item) => item.id === questId);
      const actionSnapshot = completionHistory[actionDateKey];
      if (!quest) return;
      if (!isDailyQuestScheduledForToggle(quest, actionSnapshot, actionDate)) return;

      setCompletionHistory((current) =>
        toggleDailyQuestCompletion(current, actionDateKey, questId, quest.difficulty),
      );
      updateQuestList(list, (quests) => quests.map((item) =>
        item.id === questId ? { ...item, completed: !item.completed } : item,
      ));
      return;
    }

    if (list === "personal") {
      const quest = questLists.personal.find((item) => item.id === questId);
      if (quest) {
        setPersonalXpByQuestId((current) => quest.completed
          ? reversePersonalXpAward(current, questId)
          : recordPersonalXpAward(current, questId, quest.difficulty));
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
    if (list === "daily") {
      const actionDate = new Date();
      setCompletionHistory((current) => removeQuestFromHistoryAtDate(current, questId, actionDate));
    }
  }

  function recoverOrphanedDailyQuest(questId: string) {
    const actionDateKey = getLocalDateKey(new Date());
    setCompletionHistory((current) => recoverOrphanedDailyQuestFromHistory(
      current,
      questId,
      questLists.daily,
      actionDateKey,
      true,
    ));
  }

  return (
    <QuestStoreContext.Provider
      value={{ questLists, categoryLists, totalXp, ...streaks, streakWeek, dailyCompletedQuestIds, dailyScheduledQuestIds, recoverableDailyQuestIds, hasRestored, addQuest, updateQuest, addCategory, toggleQuest, deleteQuest, recoverOrphanedDailyQuest }}
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
