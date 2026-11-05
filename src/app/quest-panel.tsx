"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import CategoryPicker, { CUSTOM_CATEGORY_VALUE } from "./category-picker";
import { getDailyQuestScheduleLabel, getDueDateLabel, getQuestListProgress, isQuestPastDue, isQuestScheduledOnDate, weekdays } from "./quest-logic";
import { getCustomCategoryError, getQuestXp, useQuestStore, type Difficulty, type Quest } from "./quest-store";

type QuestPanelProps = {
  id: string;
  title: string;
  icon: string;
  addLabel: string;
  noteIcon: string;
  note: string;
  quests: Quest[];
  showAddButton?: boolean;
  isAdding: boolean;
  onAddingChange: (isAdding: boolean) => void;
  onToggleQuest: (questId: string) => void;
  onAddQuest: (quest: Quest) => void;
  onDeleteQuest: (questId: string) => void;
};

function QuestCategoryLine({ category, dateLabel }: { category: string; dateLabel?: string }) {
  return <span>{category}{dateLabel && <> <span aria-hidden="true">·</span> {dateLabel}</>}</span>;
}

export default function QuestPanel({
  id,
  title,
  icon,
  addLabel,
  noteIcon,
  note,
  quests,
  showAddButton = true,
  isAdding,
  onAddingChange,
  onToggleQuest,
  onAddQuest,
  onDeleteQuest,
}: QuestPanelProps) {
  const router = useRouter();
  const list = id === "daily-quests" ? "daily" : "personal";
  const defaultCategory = list === "daily" ? "Wellness" : "Personal";
  const { categoryLists, addCategory, dailyScheduledQuestIds, todayKey } = useQuestStore();
  const [newTitle, setNewTitle] = useState("");
  const [newDifficulty, setNewDifficulty] = useState<Difficulty>("Easy");
  const [categorySelection, setCategorySelection] = useState(defaultCategory);
  const [customCategoryName, setCustomCategoryName] = useState("");
  const progress = getQuestListProgress(quests, list, dailyScheduledQuestIds);
  const customCategoryError = categorySelection === CUSTOM_CATEGORY_VALUE
    ? getCustomCategoryError(categoryLists[list], customCategoryName)
    : "";

  function addQuest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedTitle = newTitle.trim();
    const category = categorySelection === CUSTOM_CATEGORY_VALUE
      ? customCategoryName.trim()
      : categorySelection;
    if (!trimmedTitle || !category || customCategoryError) return;
    if (categorySelection === CUSTOM_CATEGORY_VALUE && !addCategory(list, category)) return;

    onAddQuest({
      id: `${id}-${Date.now()}`,
      title: trimmedTitle,
      category,
      ...(list === "daily" ? { repeatSchedule: "Every day" as const, selectedDays: [...weekdays] } : {}),
      difficulty: newDifficulty,
      completed: false,
    });
    setNewTitle("");
    setNewDifficulty("Easy");
    setCategorySelection(defaultCategory);
    setCustomCategoryName("");
    onAddingChange(false);
  }

  return (
    <section className="quest-panel" id={id} aria-labelledby={`${id}-heading`}>
      <header className="quest-panel-header">
        <div className="quest-panel-title-wrap">
          <h2 className="quest-panel-title" id={`${id}-heading`}>
            <Image src={icon} alt="" aria-hidden="true" width={20} height={20} />
            <span>{title}</span>
          </h2>
          <span className="quest-count">
            {progress.completed} / {progress.total} done
          </span>
        </div>
        {showAddButton && (
          <button
            className="quest-add-button"
            type="button"
            onClick={() => onAddingChange(!isAdding)}
            aria-expanded={isAdding}
          >
            <Image src="/icon-plus.svg" alt="" aria-hidden="true" width={15} height={15} />
            <span>{addLabel}</span>
          </button>
        )}
      </header>

      {showAddButton && isAdding && (
        <form className="new-quest-form" onSubmit={addQuest}>
          <input
            autoFocus
            aria-label="New quest name"
            placeholder="Name your quest"
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
          />
          <CategoryPicker
            id={`${id}-category`}
            label={`${title} category`}
            options={categoryLists[list]}
            selection={categorySelection}
            onSelectionChange={(selection) => {
              setCategorySelection(selection);
              if (selection !== CUSTOM_CATEGORY_VALUE) setCustomCategoryName("");
            }}
            customName={customCategoryName}
            onCustomNameChange={setCustomCategoryName}
            customNameError={customCategoryError}
          />
          <select
            aria-label="Quest difficulty"
            value={newDifficulty}
            onChange={(event) => setNewDifficulty(event.target.value as Difficulty)}
          >
            <option value="Easy">Easy</option>
            <option value="Medium">Medium</option>
            <option value="Hard">Hard</option>
          </select>
          <button type="submit">Add</button>
          <button type="button" onClick={() => onAddingChange(false)}>
            Cancel
          </button>
        </form>
      )}

      <ul className="quest-list">
        {quests.map((quest) => (
          <li
            className={`quest-row${quest.completed ? " is-complete" : ""}${isQuestPastDue(quest, list, todayKey) ? " is-past-due" : ""}`}
            key={quest.id}
          >
            <button
              className={`quest-check${quest.completed ? " is-checked" : ""}`}
              type="button"
              disabled={list === "daily" && (
                !dailyScheduledQuestIds.includes(quest.id) ||
                !isQuestScheduledOnDate(quest, new Date())
              )}
              aria-label={`${quest.completed ? "Mark incomplete" : "Complete"}: ${quest.title}`}
              aria-pressed={quest.completed}
              onClick={() => onToggleQuest(quest.id)}
            >
              {quest.completed && (
                <Image src="/icon-check.svg" alt="" aria-hidden="true" width={15} height={15} />
              )}
            </button>
            <div className="quest-copy">
              <strong>{quest.title}</strong>
              <QuestCategoryLine
                category={quest.category}
                dateLabel={list === "daily" ? getDailyQuestScheduleLabel(quest) : getDueDateLabel(quest.dueDate, todayKey)}
              />
              {isQuestPastDue(quest, list, todayKey) && <span className="past-due-badge">Past Due</span>}
              {quest.notes && <span className="quest-notes">{quest.notes}</span>}
            </div>
            <span className="quest-status">
              <span className="quest-difficulty">{quest.difficulty}</span>
              <span className="quest-status-divider" aria-hidden="true">·</span>
              <span>+{getQuestXp(quest.difficulty)} XP</span>
            </span>
            <button
              className="quest-row-action"
              type="button"
              onClick={() => router.push(`/quests/new?edit=${encodeURIComponent(quest.id)}`)}
              aria-label={`Edit ${quest.title}`}
              title={`Edit ${quest.title}`}
            >
              <Image src="/icon-pencil.svg" alt="" aria-hidden="true" width={14} height={14} />
            </button>
            <button
              className="quest-row-action is-delete"
              type="button"
              onClick={() => onDeleteQuest(quest.id)}
              aria-label={`Remove ${quest.title}`}
            >
              <Image src="/icon-trash.svg" alt="" aria-hidden="true" width={14} height={14} />
            </button>
          </li>
        ))}
      </ul>

      <div className="quest-note">
        <Image src={noteIcon} alt="" aria-hidden="true" width={13} height={13} />
        <span>{note}</span>
      </div>
    </section>
  );
}
