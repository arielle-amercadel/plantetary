"use client";

import { createContext, useContext, useState } from "react";
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
  addQuest: (list: QuestListKey, quest: Quest) => void;
  addCategory: (list: QuestListKey, name: string) => boolean;
  toggleQuest: (list: QuestListKey, questId: string) => void;
  deleteQuest: (list: QuestListKey, questId: string) => void;
};

const QuestStoreContext = createContext<QuestStoreValue | null>(null);

export function QuestProvider({ children }: { children: ReactNode }) {
  const [questLists, setQuestLists] = useState(initialQuestLists);
  const [categoryLists, setCategoryLists] = useState(initialCategoryLists);
  const totalXp = [...questLists.daily, ...questLists.personal]
    .filter((quest) => quest.completed)
    .reduce((total, quest) => total + getQuestXp(quest.difficulty), 0);

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
      value={{ questLists, categoryLists, totalXp, addQuest, addCategory, toggleQuest, deleteQuest }}
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