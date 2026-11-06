"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  CategoryLists,
  CompletionHistory,
  Quest,
  QuestLists,
  QuestListKey,
  StreakDay,
  StoredQuestData,
} from "./quest-types";
import {
  addCalendarDays,
  addQuestToHistoryAtDate,
  dateFromKey,
  ensureCompletionSnapshotForDate,
  findCategoryMatch,
  getXpLedgerTotal,
  getLocalDateKey,
  getCompletionHistoryView,
  getCompletedOverallCounts,
  getCompletedTodayCounts,
  getRecoverableOrphanedDailyQuestIds,
  getSnapshotStatus,
  getStreakValues,
  hasQuestScheduleChanged,
  isDailyQuestScheduledForToggle,
  migrateStoredData,
  clearPersonalCompletionDate,
  preserveDeletedLegacyPersonalCompletionCount,
  recordPersonalCompletionDate,
  recordCompletionDetails,
  removeCompletionDetails,
  recordPersonalXpAward,
  removeQuestFromHistoryAtDate,
  recoverOrphanedDailyQuestFromHistory,
  rescheduleQuestInHistory,
  reversePersonalXpAward,
  toggleDailyQuestCompletion,
  toggleDailyQuestCompletionWithDetails,
  updateQuestInLists,
  weekdayNames,
  weekdays,
} from "./quest-logic";
import {
  mergeDiscoveredPlantIds,
  mergePendingPlantGiftIds,
  migratePlantDiscoveries,
  unwrapPlantGift as unwrapPlantGiftState,
} from "./plant-journal-logic";
import { createBrowserGameStorage, type StorageStatus } from "./game-storage";
import { createGameDataSession } from "./game-data-session";

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

const initialCategoryLists: CategoryLists = {
  daily: ["Wellness", "Self-care", "Personal growth"],
  personal: ["Study", "Projects", "Chores", "Personal"],
};

export const initialQuestLists: QuestLists = {
  daily: [
    {
      id: "water",
      title: "Drink a glass of water",
      category: "Wellness",
      repeatSchedule: "Every day",
      selectedDays: [...weekdays],
      difficulty: "Easy",
      completed: false,
    },
    {
      id: "skincare",
      title: "Morning skincare",
      category: "Self-care",
      repeatSchedule: "Every day",
      selectedDays: [...weekdays],
      difficulty: "Easy",
      completed: false,
    },
    {
      id: "reading",
      title: "Read for 20 minutes",
      category: "Personal growth",
      repeatSchedule: "Every day",
      selectedDays: [...weekdays],
      difficulty: "Medium",
      completed: false,
    },
    {
      id: "stretch",
      title: "Evening stretch",
      category: "Wellness",
      repeatSchedule: "Every day",
      selectedDays: [...weekdays],
      difficulty: "Easy",
      completed: false,
    },
  ],
  personal: [
    {
      id: "biology",
      title: "Review biology notes",
      category: "Study",
      difficulty: "Medium",
      completed: false,
    },
    {
      id: "moodboard",
      title: "Finish portfolio moodboard",
      category: "Projects",
      difficulty: "Hard",
      completed: false,
    },
    {
      id: "desk",
      title: "Tidy the desk",
      category: "Chores",
      difficulty: "Easy",
      completed: false,
    },
  ],
};

const initialStoredQuestData = migratePlantDiscoveries(migrateStoredData({
  questLists: initialQuestLists,
  categoryLists: initialCategoryLists,
  starterPlantGiftPending: true,
}));

type QuestStoreValue = {
  questLists: QuestLists;
  categoryLists: CategoryLists;
  totalXp: number;
  completedTodayCounts: { daily: number; personal: number; total: number };
  completedOverallCounts: { daily: number; personal: number; total: number };
  completionHistoryView: ReturnType<typeof getCompletionHistoryView>;
  todayKey: string;
  discoveredPlantIds: string[];
  pendingPlantGiftIds: string[];
  starterPlantGiftPending: boolean;
  currentStreak: number;
  longestStreak: number;
  streakWeek: StreakDay[];
  dailyCompletedQuestIds: string[];
  dailyScheduledQuestIds: string[];
  recoverableDailyQuestIds: string[];
  /** `loading` until the save is read; `failed` means this session's changes are never saved. */
  storageStatus: StorageStatus;
  /** True once loading has finished, whether it worked or not. */
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
  unwrapPlantGift: (plantId: string) => void;
  getDataForExport: () => StoredQuestData;
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
  const [personalCompletedOnByQuestId, setPersonalCompletedOnByQuestId] = useState<Record<string, string> | undefined>(
    initialStoredQuestData.personalCompletedOnByQuestId,
  );
  const [deletedLegacyPersonalCompletionCount, setDeletedLegacyPersonalCompletionCount] = useState<number | undefined>(
    initialStoredQuestData.deletedLegacyPersonalCompletionCount,
  );
  const [legacyXpBonus, setLegacyXpBonus] = useState(initialStoredQuestData.legacyXpBonus ?? 0);
  const [schemaVersion, setSchemaVersion] = useState(initialStoredQuestData.schemaVersion ?? 3);
  const [storedDiscoveredPlantIds, setDiscoveredPlantIds] = useState<string[]>(
    initialStoredQuestData.discoveredPlantIds ?? [],
  );
  const [storedPendingPlantGiftIds, setPendingPlantGiftIds] = useState<string[]>(
    initialStoredQuestData.pendingPlantGiftIds ?? [],
  );
  const [todayKey, setTodayKey] = useState("");
  const [storageStatus, setStorageStatus] = useState<StorageStatus>("loading");
  const [gameData] = useState(() => createGameDataSession(createBrowserGameStorage()));
  const hasRestored = storageStatus !== "loading";

  useEffect(() => {
    let cancelled = false;

    void gameData.load(initialStoredQuestData).then(({ status, data: restoredData }) => {
      if (cancelled) return;
      const restoredToday = getLocalDateKey(new Date());
      const restoredHistory = restoredData.completionHistory ?? {};
      const completionHistory = ensureCompletionSnapshotForDate(
        restoredHistory,
        restoredData.questLists.daily,
        restoredToday,
      );
      setQuestLists(restoredData.questLists);
      setCategoryLists(restoredData.categoryLists);
      setCompletionHistory(completionHistory);
      setPersonalXpByQuestId(restoredData.personalXpByQuestId);
      setPersonalCompletedOnByQuestId(restoredData.personalCompletedOnByQuestId);
      setDeletedLegacyPersonalCompletionCount(restoredData.deletedLegacyPersonalCompletionCount);
      setLegacyXpBonus(restoredData.legacyXpBonus ?? 0);
      setDiscoveredPlantIds(restoredData.discoveredPlantIds ?? []);
      setPendingPlantGiftIds(restoredData.pendingPlantGiftIds ?? []);
      setSchemaVersion(restoredData.schemaVersion ?? 3);
      setTodayKey(restoredToday);
      setStorageStatus(status);
    });

    return () => {
      cancelled = true;
    };
  }, [gameData]);

  useEffect(() => {
    const updateToday = () => {
      const nextTodayKey = getLocalDateKey(new Date());
      setTodayKey(nextTodayKey);
      setCompletionHistory((current) =>
        ensureCompletionSnapshotForDate(current, questLists.daily, nextTodayKey),
      );
    };
    const updateTodayWhenVisible = () => {
      if (document.visibilityState === "visible") updateToday();
    };
    const interval = window.setInterval(updateToday, 60_000);
    window.addEventListener("focus", updateToday);
    document.addEventListener("visibilitychange", updateTodayWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", updateToday);
      document.removeEventListener("visibilitychange", updateTodayWhenVisible);
    };
  }, [questLists.daily]);

  const totalXp = getXpLedgerTotal(completionHistory, personalXpByQuestId, legacyXpBonus);
  const discoveredPlantIds = mergeDiscoveredPlantIds(storedDiscoveredPlantIds);
  const pendingPlantGiftIds = mergePendingPlantGiftIds(
    storedPendingPlantGiftIds,
    totalXp,
    discoveredPlantIds,
  );
  const starterPlantGiftPending = pendingPlantGiftIds.includes("fern");

  useEffect(() => {
    // Never write while loading or after a failed load: the starter data on screen could replace a real save.
    if (storageStatus !== "ready") return;

    // Skipped automatically when the data matches what was last saved.
    gameData.requestSave({
      schemaVersion,
      questLists,
      categoryLists,
      completionHistory,
      personalXpByQuestId,
      personalCompletedOnByQuestId,
      deletedLegacyPersonalCompletionCount,
      legacyXpBonus,
      discoveredPlantIds,
      pendingPlantGiftIds,
      starterPlantGiftPending,
    });
  }, [storageStatus, gameData, questLists, categoryLists, completionHistory, personalXpByQuestId, personalCompletedOnByQuestId, deletedLegacyPersonalCompletionCount, legacyXpBonus, discoveredPlantIds, pendingPlantGiftIds, starterPlantGiftPending, schemaVersion, todayKey, totalXp]);

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
  const completedTodayCounts = getCompletedTodayCounts(
    completionHistory,
    personalCompletedOnByQuestId,
    todayKey,
  );
  const completedOverallCounts = getCompletedOverallCounts(
    completionHistory,
    personalCompletedOnByQuestId,
    questLists.personal,
    deletedLegacyPersonalCompletionCount,
  );
  const completionHistoryView = getCompletionHistoryView(
    completionHistory,
    personalCompletedOnByQuestId,
    personalXpByQuestId,
    questLists.personal,
    deletedLegacyPersonalCompletionCount,
    questLists.daily,
  );
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
      const actionDateKey = getLocalDateKey(actionDate);
      setCompletionHistory((current) => addQuestToHistoryAtDate(
        ensureCompletionSnapshotForDate(current, questLists.daily, actionDateKey),
        quest,
        actionDate,
      ));
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
      setCompletionHistory((current) => rescheduleQuestInHistory(
        ensureCompletionSnapshotForDate(current, questLists.daily, actionDateKey),
        updatedQuest,
        actionDateKey,
      ));
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
      const actionHistory = ensureCompletionSnapshotForDate(completionHistory, questLists.daily, actionDateKey);
      const actionSnapshot = actionHistory[actionDateKey];
      if (!quest) return;
      if (!isDailyQuestScheduledForToggle(quest, actionSnapshot, actionDate)) return;

      const nextHistoryForDiscovery = toggleDailyQuestCompletion(
        actionHistory,
        actionDateKey,
        questId,
        quest.difficulty,
      );
      setCompletionHistory((current) =>
        toggleDailyQuestCompletionWithDetails(
          ensureCompletionSnapshotForDate(current, questLists.daily, actionDateKey),
          actionDateKey,
          quest,
        ),
      );
      const nextTotalXp = getXpLedgerTotal(nextHistoryForDiscovery, personalXpByQuestId, legacyXpBonus);
      setPendingPlantGiftIds((current) =>
        mergePendingPlantGiftIds(current, nextTotalXp, discoveredPlantIds),
      );
      return;
    }

    if (list === "personal") {
      const quest = questLists.personal.find((item) => item.id === questId);
      if (quest) {
        const actionDateKey = getLocalDateKey(new Date());
        const nextPersonalXpForDiscovery = quest.completed
          ? reversePersonalXpAward(personalXpByQuestId, questId)
          : recordPersonalXpAward(personalXpByQuestId, questId, quest.difficulty);
        setPersonalCompletedOnByQuestId((current) => quest.completed
          ? clearPersonalCompletionDate(current, questId)
          : recordPersonalCompletionDate(current, questId, actionDateKey));
        const previousCompletionDate = personalCompletedOnByQuestId?.[questId];
        setCompletionHistory((current) => {
          const withActionDate = ensureCompletionSnapshotForDate(current, questLists.daily, actionDateKey);
          return quest.completed
            ? removeCompletionDetails(withActionDate, "personal", questId, previousCompletionDate)
            : recordCompletionDetails(withActionDate, actionDateKey, "personal", quest);
        });
        setPersonalXpByQuestId((current) => quest.completed
          ? reversePersonalXpAward(current, questId)
          : recordPersonalXpAward(current, questId, quest.difficulty));
        const nextTotalXp = getXpLedgerTotal(completionHistory, nextPersonalXpForDiscovery, legacyXpBonus);
        setPendingPlantGiftIds((current) =>
          mergePendingPlantGiftIds(current, nextTotalXp, discoveredPlantIds),
        );
      }
    }

    updateQuestList(list, (quests) =>
      quests.map((quest) =>
        quest.id === questId ? { ...quest, completed: !quest.completed } : quest,
      ),
    );
  }

  function deleteQuest(list: QuestListKey, questId: string) {
    if (list === "personal") {
      const quest = questLists.personal.find((item) => item.id === questId);
      if (quest) {
        setDeletedLegacyPersonalCompletionCount((current) =>
          preserveDeletedLegacyPersonalCompletionCount(
            current,
            quest,
            personalCompletedOnByQuestId,
          ),
        );
      }
    }
    updateQuestList(list, (quests) => quests.filter((quest) => quest.id !== questId));
    if (list === "daily") {
      const actionDate = new Date();
      const actionDateKey = getLocalDateKey(actionDate);
      setCompletionHistory((current) => removeQuestFromHistoryAtDate(
        ensureCompletionSnapshotForDate(current, questLists.daily, actionDateKey),
        questId,
        actionDate,
      ));
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

  function unwrapPlantGift(plantId: string) {
    if (!pendingPlantGiftIds.includes(plantId)) return;
    const result = unwrapPlantGiftState(discoveredPlantIds, pendingPlantGiftIds, plantId);
    setDiscoveredPlantIds(result.discoveredPlantIds);
    setPendingPlantGiftIds(result.pendingPlantGiftIds);
  }

  function getDataForExport(): StoredQuestData {
    return {
      schemaVersion,
      questLists,
      categoryLists,
      completionHistory,
      personalXpByQuestId,
      personalCompletedOnByQuestId,
      deletedLegacyPersonalCompletionCount,
      legacyXpBonus,
      discoveredPlantIds,
      pendingPlantGiftIds,
      starterPlantGiftPending,
    };
  }

  return (
    <QuestStoreContext.Provider
      value={{ questLists, categoryLists, totalXp, completedTodayCounts, completedOverallCounts, completionHistoryView, todayKey, discoveredPlantIds, pendingPlantGiftIds, starterPlantGiftPending, currentStreak: streaks.currentStreak, longestStreak: streaks.longestStreak, streakWeek, dailyCompletedQuestIds, dailyScheduledQuestIds, recoverableDailyQuestIds, storageStatus, hasRestored, addQuest, updateQuest, addCategory, toggleQuest, deleteQuest, recoverOrphanedDailyQuest, unwrapPlantGift, getDataForExport }}
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
