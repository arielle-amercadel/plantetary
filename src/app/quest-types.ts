export type Difficulty = "Easy" | "Medium" | "Hard";
export type QuestListKey = "daily" | "personal";
export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
export type RepeatSchedule = "Every day" | "Selected days";

export type Quest = {
  id: string;
  title: string;
  category: string;
  /** Legacy text kept only so older saves can be recognized and converted on load. */
  schedule?: string;
  difficulty: Difficulty;
  completed: boolean;
  repeatSchedule?: RepeatSchedule;
  selectedDays?: Weekday[];
  dueDate?: string;
  notes?: string;
};

export type QuestLists = Record<QuestListKey, Quest[]>;
export type CategoryLists = Record<QuestListKey, string[]>;
export type CompletionQuestType = QuestListKey;
export type CompletionQuestDetails = {
  title: string;
  category: string;
  difficulty: Difficulty;
  questType: CompletionQuestType;
};
export type CompletionDetailsByType = Partial<Record<CompletionQuestType, Record<string, CompletionQuestDetails>>>;
export type StoredQuestData = {
  questLists: QuestLists;
  categoryLists: CategoryLists;
  completionHistory?: CompletionHistory;
  schemaVersion?: number;
  legacyXpBonus?: number;
  personalXpByQuestId?: Record<string, number>;
  personalCompletedOnByQuestId?: Record<string, string>;
  deletedLegacyPersonalCompletionCount?: number;
  discoveredPlantIds?: string[];
  pendingPlantGiftIds?: string[];
  starterPlantGiftPending?: boolean;
};

export type CompletionSnapshot = {
  scheduledQuestIds: string[];
  completedQuestIds: string[];
  xpAwardedByQuestId?: Record<string, number>;
  completionDetails?: CompletionDetailsByType;
};
export type CompletionHistory = Record<string, CompletionSnapshot>;
export type StreakDay = { date: string; label: string; status: "complete" | "incomplete" | "unscheduled" };

export type CompletionHistoryItem = {
  questId: string;
  questType: CompletionQuestType;
  details?: CompletionQuestDetails;
  detailsSource?: "current";
  xp?: number;
};
export type CompletionHistorySection = {
  dateKey: string;
  daily: CompletionHistoryItem[];
  personal: CompletionHistoryItem[];
  completionCount: number;
};
export type EarlierCompletionHistory = {
  items: CompletionHistoryItem[];
  unidentifiableCount: number;
  completionCount: number;
};
