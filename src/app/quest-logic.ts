import type {
  CompletionHistory,
  CompletionSnapshot,
  Difficulty,
  Quest,
  StreakDay,
  Weekday,
} from "./quest-types";

export const weekdays: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const weekdayLabels: Weekday[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const weekdayNames: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function getLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateFromKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

export function addCalendarDays(date: Date, amount: number): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  result.setDate(result.getDate() + amount);
  return result;
}

export function scheduledDaysForQuest(quest: Quest): Weekday[] {
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

export function getSnapshotStatus(snapshot: CompletionSnapshot | undefined): StreakDay["status"] {
  if (!snapshot || snapshot.scheduledQuestIds.length === 0) return "unscheduled";
  return snapshot.scheduledQuestIds.every((id) => snapshot.completedQuestIds.includes(id))
    ? "complete"
    : "incomplete";
}

export function createSnapshot(quests: Quest[], date: Date): CompletionSnapshot {
  return {
    scheduledQuestIds: quests.filter((quest) => isQuestScheduledOnDate(quest, date)).map((quest) => quest.id),
    completedQuestIds: [],
  };
}

export function addQuestToHistory(
  history: CompletionHistory,
  quest: Quest,
  todayKey: string,
): CompletionHistory {
  const snapshot = history[todayKey];
  if (!snapshot) return history;

  if (!isQuestScheduledOnDate(quest, dateFromKey(todayKey)) || snapshot.scheduledQuestIds.includes(quest.id)) {
    return history;
  }

  return {
    ...history,
    [todayKey]: {
      scheduledQuestIds: [...snapshot.scheduledQuestIds, quest.id],
      completedQuestIds: snapshot.completedQuestIds,
    },
  };
}

export function removeQuestFromHistory(
  history: CompletionHistory,
  questId: string,
  todayKey: string,
): CompletionHistory {
  const snapshot = history[todayKey];
  if (!snapshot || snapshot.completedQuestIds.includes(questId) || !snapshot.scheduledQuestIds.includes(questId)) {
    return history;
  }

  return {
    ...history,
    [todayKey]: {
      scheduledQuestIds: snapshot.scheduledQuestIds.filter((id) => id !== questId),
      completedQuestIds: snapshot.completedQuestIds,
    },
  };
}

export function rescheduleQuestInHistory(
  history: CompletionHistory,
  quest: Quest,
  todayKey: string,
): CompletionHistory {
  const snapshot = history[todayKey];
  if (!snapshot) return history;

  if (isQuestScheduledOnDate(quest, dateFromKey(todayKey))) {
    if (snapshot.scheduledQuestIds.includes(quest.id)) return history;
    return {
      ...history,
      [todayKey]: {
        scheduledQuestIds: [...snapshot.scheduledQuestIds, quest.id],
        completedQuestIds: snapshot.completedQuestIds,
      },
    };
  }

  if (snapshot.completedQuestIds.includes(quest.id) || !snapshot.scheduledQuestIds.includes(quest.id)) {
    return history;
  }

  return {
    ...history,
    [todayKey]: {
      scheduledQuestIds: snapshot.scheduledQuestIds.filter((id) => id !== quest.id),
      completedQuestIds: snapshot.completedQuestIds,
    },
  };
}

export function getStreakValues(history: CompletionHistory, todayKey: string) {
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

const xpByDifficulty: Record<Difficulty, number> = {
  Easy: 5,
  Medium: 10,
  Hard: 20,
};

export function getQuestXp(difficulty: Difficulty): number {
  const xp = xpByDifficulty[difficulty];
  if (xp === undefined) throw new Error("Invalid quest difficulty");
  return xp;
}

function isValidXpAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount >= 0;
}

function sumXpRecord(record: Record<string, number> | undefined): number {
  if (!record) return 0;
  return Object.values(record).reduce(
    (total, amount) => total + (isValidXpAmount(amount) ? amount : 0),
    0,
  );
}

export function getXpLedgerTotal(
  completionHistory: CompletionHistory = {},
  personalXpByQuestId?: Record<string, number>,
  legacyXpBonus = 0,
): number {
  const dailyXp = Object.values(completionHistory).reduce(
    (total, snapshot) => total + sumXpRecord(snapshot.xpAwardedByQuestId),
    0,
  );
  return dailyXp + sumXpRecord(personalXpByQuestId) + (isValidXpAmount(legacyXpBonus) ? legacyXpBonus : 0);
}

export function recordDailyXpAward(
  completionHistory: CompletionHistory,
  dateKey: string,
  questId: string,
  difficulty: Difficulty,
): CompletionHistory {
  const snapshot = completionHistory[dateKey];
  if (
    !snapshot ||
    !snapshot.scheduledQuestIds.includes(questId) ||
    !snapshot.completedQuestIds.includes(questId)
  ) return completionHistory;

  const currentAwards = snapshot.xpAwardedByQuestId;
  const existingAward = currentAwards?.[questId];
  if (existingAward !== undefined && isValidXpAmount(existingAward)) return completionHistory;

  return {
    ...completionHistory,
    [dateKey]: {
      ...snapshot,
      xpAwardedByQuestId: {
        ...currentAwards,
        [questId]: getQuestXp(difficulty),
      },
    },
  };
}

export function reverseDailyXpAward(
  completionHistory: CompletionHistory,
  dateKey: string,
  questId: string,
): CompletionHistory {
  const snapshot = completionHistory[dateKey];
  const currentAwards = snapshot?.xpAwardedByQuestId;
  if (!snapshot || !currentAwards || !Object.hasOwn(currentAwards, questId)) return completionHistory;

  const remainingAwards = { ...currentAwards };
  delete remainingAwards[questId];
  const nextSnapshot = { ...snapshot };
  if (Object.keys(remainingAwards).length > 0) nextSnapshot.xpAwardedByQuestId = remainingAwards;
  else delete nextSnapshot.xpAwardedByQuestId;

  return { ...completionHistory, [dateKey]: nextSnapshot };
}

export function recordPersonalXpAward(
  personalXpByQuestId: Record<string, number> | undefined,
  questId: string,
  difficulty: Difficulty,
): Record<string, number> {
  const awards = personalXpByQuestId ?? {};
  const existingAward = awards[questId];
  if (existingAward !== undefined && isValidXpAmount(existingAward)) return awards;
  return { ...awards, [questId]: getQuestXp(difficulty) };
}

export function reversePersonalXpAward(
  personalXpByQuestId: Record<string, number> | undefined,
  questId: string,
): Record<string, number> | undefined {
  if (!personalXpByQuestId || !Object.hasOwn(personalXpByQuestId, questId)) return personalXpByQuestId;
  const remainingAwards = { ...personalXpByQuestId };
  delete remainingAwards[questId];
  return Object.keys(remainingAwards).length > 0 ? remainingAwards : undefined;
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
