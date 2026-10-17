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

export type QuestLists = Record<QuestListKey, Quest[]>;
export type CategoryLists = Record<QuestListKey, string[]>;
export type StoredQuestData = {
  questLists: QuestLists;
  categoryLists: CategoryLists;
  completionHistory?: CompletionHistory;
  schemaVersion?: number;
  legacyXpBonus?: number;
  personalXpByQuestId?: Record<string, number>;
};

export type CompletionSnapshot = {
  scheduledQuestIds: string[];
  completedQuestIds: string[];
  xpAwardedByQuestId?: Record<string, number>;
};
export type CompletionHistory = Record<string, CompletionSnapshot>;
export type StreakDay = { date: string; label: string; status: "complete" | "incomplete" | "unscheduled" };
