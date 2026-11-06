import type { CategoryLists, QuestLists } from "./quest-types";
import { migrateStoredData, weekdays } from "./quest-logic";
import { migratePlantDiscoveries } from "./plant-journal-logic";

export const initialCategoryLists: CategoryLists = {
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

export const initialStoredQuestData = migratePlantDiscoveries(migrateStoredData({
  questLists: initialQuestLists,
  categoryLists: initialCategoryLists,
  starterPlantGiftPending: true,
}));

