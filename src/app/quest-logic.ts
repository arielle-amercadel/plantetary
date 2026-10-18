import type {
  CompletionHistory,
  CompletionSnapshot,
  Difficulty,
  Quest,
  QuestListKey,
  QuestLists,
  StreakDay,
  StoredQuestData,
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

export function formatWeekdaySchedule(days: Weekday[]): string {
  return weekdays.filter((day) => days.includes(day)).join(", ");
}

export function getDailyQuestScheduleLabel(quest: Quest): string {
  if (quest.repeatSchedule === "Every day" || quest.schedule.trim().toLowerCase() === "every day") {
    return quest.schedule;
  }

  const scheduledDays = scheduledDaysForQuest(quest);
  if (scheduledDays.length > 0) return formatWeekdaySchedule(scheduledDays);

  return quest.schedule;
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

export function isDailyQuestScheduledForToggle(
  quest: Quest | undefined,
  snapshot: CompletionSnapshot | undefined,
  date: Date,
): boolean {
  return Boolean(
    quest &&
      snapshot?.scheduledQuestIds.includes(quest.id) &&
      isQuestScheduledOnDate(quest, date),
  );
}

export function updateQuestInLists(
  questLists: QuestLists,
  list: QuestListKey,
  questId: string,
  updates: Partial<Omit<Quest, "id" | "completed">>,
): QuestLists {
  const quests = questLists[list];
  if (!quests.some((quest) => quest.id === questId)) return questLists;

  return {
    ...questLists,
    [list]: quests.map((quest) => quest.id === questId
      ? { ...quest, ...updates, id: quest.id, completed: quest.completed }
      : quest),
  };
}

export function hasQuestScheduleChanged(previous: Quest, updated: Quest): boolean {
  const previousDays = previous.selectedDays;
  const updatedDays = updated.selectedDays;
  const selectedDaysChanged = previousDays === undefined || updatedDays === undefined
    ? previousDays !== updatedDays
    : previousDays.length !== updatedDays.length ||
      previousDays.some((day, index) => day !== updatedDays[index]);

  return previous.schedule !== updated.schedule ||
    previous.repeatSchedule !== updated.repeatSchedule ||
    selectedDaysChanged;
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
      ...snapshot,
      scheduledQuestIds: [...snapshot.scheduledQuestIds, quest.id],
    },
  };
}

export function addQuestToHistoryAtDate(
  history: CompletionHistory,
  quest: Quest,
  actionDate: Date,
): CompletionHistory {
  return addQuestToHistory(history, quest, getLocalDateKey(actionDate));
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
      ...snapshot,
      scheduledQuestIds: snapshot.scheduledQuestIds.filter((id) => id !== questId),
    },
  };
}

export function removeQuestFromHistoryAtDate(
  history: CompletionHistory,
  questId: string,
  actionDate: Date,
): CompletionHistory {
  return removeQuestFromHistory(history, questId, getLocalDateKey(actionDate));
}

export function getRecoverableOrphanedDailyQuestIds(
  snapshot: CompletionSnapshot | undefined,
  dailyQuests: Quest[],
): string[] {
  if (!snapshot) return [];
  const currentQuestIds = new Set(dailyQuests.map((quest) => quest.id));
  return snapshot.scheduledQuestIds.filter((questId) =>
    !snapshot.completedQuestIds.includes(questId) && !currentQuestIds.has(questId),
  );
}

export function recoverOrphanedDailyQuestFromHistory(
  history: CompletionHistory,
  questId: string,
  dailyQuests: Quest[],
  todayKey: string,
  confirmed: boolean,
): CompletionHistory {
  if (
    !confirmed ||
    !getRecoverableOrphanedDailyQuestIds(history[todayKey], dailyQuests).includes(questId)
  ) return history;
  return removeQuestFromHistory(history, questId, todayKey);
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
        ...snapshot,
        scheduledQuestIds: [...snapshot.scheduledQuestIds, quest.id],
      },
    };
  }

  if (snapshot.completedQuestIds.includes(quest.id) || !snapshot.scheduledQuestIds.includes(quest.id)) {
    return history;
  }

  return {
    ...history,
    [todayKey]: {
      ...snapshot,
      scheduledQuestIds: snapshot.scheduledQuestIds.filter((id) => id !== quest.id),
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

function isValidXpAward(amount: unknown): amount is number {
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0;
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

type CompletionCounts = { daily: number; personal: number; total: number };

export function isCompletionDateKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1 || month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function countSnapshotCompletions(snapshot: CompletionSnapshot | undefined): number {
  if (
    !snapshot ||
    !Array.isArray(snapshot.scheduledQuestIds) ||
    !Array.isArray(snapshot.completedQuestIds)
  ) return 0;
  const scheduledIds = new Set(snapshot.scheduledQuestIds.filter((id) => typeof id === "string"));
  return new Set(snapshot.completedQuestIds.filter((id) => typeof id === "string" && scheduledIds.has(id))).size;
}

function countDailyCompletions(history: CompletionHistory | undefined): number {
  if (!history || typeof history !== "object" || Array.isArray(history)) return 0;
  return Object.entries(history).reduce(
    (total, [dateKey, snapshot]) => total + (isCompletionDateKey(dateKey)
      ? countSnapshotCompletions(snapshot)
      : 0),
    0,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function getCompletedTodayCounts(
  completionHistory: CompletionHistory | undefined,
  personalCompletedOnByQuestId: Record<string, string> | undefined,
  todayKey: string,
): CompletionCounts {
  const daily = isRecord(completionHistory) && isRecord(completionHistory[todayKey])
    ? countSnapshotCompletions(completionHistory[todayKey] as CompletionSnapshot)
    : 0;
  const personal = isRecord(personalCompletedOnByQuestId)
    ? Object.entries(personalCompletedOnByQuestId).filter(
      ([questId, dateKey]) => questId.length > 0 && isCompletionDateKey(dateKey) && dateKey === todayKey,
    ).length
    : 0;
  return { daily, personal, total: daily + personal };
}

export function getCompletedOverallCounts(
  completionHistory: CompletionHistory | undefined,
  personalCompletedOnByQuestId: Record<string, string> | undefined,
  currentPersonalQuests: Quest[] | undefined,
  deletedLegacyPersonalCompletionCount = 0,
): CompletionCounts {
  const daily = countDailyCompletions(completionHistory);
  const recordedPersonalCount = isRecord(personalCompletedOnByQuestId)
    ? Object.entries(personalCompletedOnByQuestId).filter(
      ([questId, dateKey]) => questId.length > 0 && isCompletionDateKey(dateKey),
    ).length
    : 0;
  const recordedQuestIds = isRecord(personalCompletedOnByQuestId)
    ? new Set(Object.entries(personalCompletedOnByQuestId)
      .filter(([questId, dateKey]) => questId.length > 0 && isCompletionDateKey(dateKey))
      .map(([questId]) => questId))
    : new Set<string>();
  const legacyCurrentIds = new Set<string>();
  if (Array.isArray(currentPersonalQuests)) {
    for (const quest of currentPersonalQuests) {
      if (
        quest &&
        typeof quest.id === "string" &&
        quest.completed === true &&
        !recordedQuestIds.has(quest.id)
      ) legacyCurrentIds.add(quest.id);
    }
  }
  const deletedLegacyCount = Number.isSafeInteger(deletedLegacyPersonalCompletionCount) &&
    deletedLegacyPersonalCompletionCount >= 0
    ? deletedLegacyPersonalCompletionCount
    : 0;
  const personal = recordedPersonalCount + legacyCurrentIds.size + deletedLegacyCount;
  return { daily, personal, total: daily + personal };
}

export function recordPersonalCompletionDate(
  personalCompletedOnByQuestId: Record<string, string> | undefined,
  questId: string,
  dateKey: string,
): Record<string, string> {
  const current = personalCompletedOnByQuestId ?? {};
  if (!questId || !isCompletionDateKey(dateKey) || current[questId] === dateKey) return current;
  return { ...current, [questId]: dateKey };
}

export function clearPersonalCompletionDate(
  personalCompletedOnByQuestId: Record<string, string> | undefined,
  questId: string,
): Record<string, string> | undefined {
  if (!personalCompletedOnByQuestId || !Object.hasOwn(personalCompletedOnByQuestId, questId)) {
    return personalCompletedOnByQuestId;
  }
  const remainingDates = { ...personalCompletedOnByQuestId };
  delete remainingDates[questId];
  return Object.keys(remainingDates).length > 0 ? remainingDates : undefined;
}

export function preserveDeletedLegacyPersonalCompletionCount(
  currentCount: number | undefined,
  quest: Quest | undefined,
  personalCompletedOnByQuestId: Record<string, string> | undefined,
): number | undefined {
  if (
    !quest?.completed ||
    (personalCompletedOnByQuestId && isCompletionDateKey(personalCompletedOnByQuestId[quest.id]))
  ) return currentCount;
  const count = Number.isSafeInteger(currentCount) && (currentCount ?? 0) >= 0 ? currentCount ?? 0 : 0;
  return count + 1;
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
  if (existingAward !== undefined && isValidXpAward(existingAward)) return completionHistory;

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

export function toggleDailyQuestCompletion(
  completionHistory: CompletionHistory,
  dateKey: string,
  questId: string,
  difficulty: Difficulty,
): CompletionHistory {
  const snapshot = completionHistory[dateKey];
  if (!snapshot || !snapshot.scheduledQuestIds.includes(questId)) return completionHistory;

  const wasCompleted = snapshot.completedQuestIds.includes(questId);
  const completedQuestIds = wasCompleted
    ? snapshot.completedQuestIds.filter((id) => id !== questId)
    : [...snapshot.completedQuestIds, questId];
  const nextHistory = {
    ...completionHistory,
    [dateKey]: { ...snapshot, completedQuestIds },
  };

  return wasCompleted
    ? reverseDailyXpAward(nextHistory, dateKey, questId)
    : recordDailyXpAward(nextHistory, dateKey, questId, difficulty);
}

export function recordPersonalXpAward(
  personalXpByQuestId: Record<string, number> | undefined,
  questId: string,
  difficulty: Difficulty,
): Record<string, number> {
  const awards = personalXpByQuestId ?? {};
  const existingAward = awards[questId];
  if (existingAward !== undefined && isValidXpAward(existingAward)) return awards;
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

function normalizeXpRecord(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const entries = Object.entries(value);
  const validEntries = entries.filter(([, amount]) => isValidXpAward(amount));
  if (validEntries.length === entries.length) return value as Record<string, number>;
  return Object.fromEntries(validEntries) as Record<string, number>;
}

function getLegacyCompletedQuestXp(data: StoredQuestData): number {
  return [...data.questLists.daily, ...data.questLists.personal]
    .filter((quest) => quest.completed)
    .reduce((total, quest) => total + getQuestXp(quest.difficulty), 0);
}

export function migrateStoredData(data: StoredQuestData): StoredQuestData {
  const currentVersion = typeof data.schemaVersion === "number" && Number.isFinite(data.schemaVersion)
    ? data.schemaVersion
    : 0;
  const targetVersion = Math.max(2, currentVersion);
  const dailyQuestsById = new Map(data.questLists.daily.map((quest) => [quest.id, quest]));
  const originalHistory = data.completionHistory ?? {};
  let historyChanged = false;
  const completionHistory: CompletionHistory = {};

  for (const [dateKey, snapshot] of Object.entries(originalHistory)) {
    const originalAwards = snapshot.xpAwardedByQuestId;
    const normalizedAwards = normalizeXpRecord(originalAwards);
    let awardsChanged = normalizedAwards !== originalAwards;
    const awards = { ...normalizedAwards };
    for (const questId of snapshot.scheduledQuestIds) {
      if (!snapshot.completedQuestIds.includes(questId) || awards[questId] !== undefined) continue;
      const quest = dailyQuestsById.get(questId);
      if (quest) {
        awards[questId] = getQuestXp(quest.difficulty);
        awardsChanged = true;
      }
    }

    const hasAwards = Object.keys(awards).length > 0;
    const nextAwards = hasAwards ? (awardsChanged ? awards : originalAwards) : undefined;
    if (nextAwards !== originalAwards) {
      historyChanged = true;
      completionHistory[dateKey] = { ...snapshot, xpAwardedByQuestId: nextAwards };
    } else {
      completionHistory[dateKey] = snapshot;
    }
  }

  const originalPersonalAwards = data.personalXpByQuestId;
  const normalizedPersonalAwards = normalizeXpRecord(originalPersonalAwards);
  let personalAwardsChanged = normalizedPersonalAwards !== originalPersonalAwards;
  const personalAwards = { ...normalizedPersonalAwards };
  for (const quest of data.questLists.personal) {
    if (quest.completed && personalAwards[quest.id] === undefined) {
      personalAwards[quest.id] = getQuestXp(quest.difficulty);
      personalAwardsChanged = true;
    }
  }
  const hasPersonalAwards = Object.keys(personalAwards).length > 0;
  const personalXpByQuestId = hasPersonalAwards
    ? (personalAwardsChanged ? personalAwards : originalPersonalAwards)
    : undefined;
  const originalLegacyBonus = data.legacyXpBonus;
  const validLegacyBonus = typeof originalLegacyBonus === "number" && isValidXpAmount(originalLegacyBonus)
    ? originalLegacyBonus
    : 0;
  const knownLedgerXp = getXpLedgerTotal(completionHistory, personalXpByQuestId);
  const legacyXpBonus = Math.max(validLegacyBonus, getLegacyCompletedQuestXp(data) - knownLedgerXp, 0);

  const historyUnchanged = !historyChanged && (
    data.completionHistory === undefined
      ? Object.keys(originalHistory).length === 0
      : originalHistory === data.completionHistory
  );
  const personalAwardsUnchanged = personalXpByQuestId === originalPersonalAwards;
  const legacyBonusUnchanged = legacyXpBonus === originalLegacyBonus;
  if (
    currentVersion >= 2 &&
    targetVersion === data.schemaVersion &&
    historyUnchanged &&
    personalAwardsUnchanged &&
    legacyBonusUnchanged
  ) return data;

  return {
    ...data,
    schemaVersion: targetVersion,
    completionHistory,
    personalXpByQuestId,
    legacyXpBonus,
  };
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
