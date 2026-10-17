"use client";

import Image from "next/image";
import { useState } from "react";

export type Quest = {
  id: string;
  title: string;
  category: string;
  schedule: string;
  xp: number;
  completed: boolean;
};

type QuestPanelProps = {
  id: string;
  title: string;
  icon: string;
  addLabel: string;
  noteIcon: string;
  note: string;
  initialQuests: Quest[];
};

export default function QuestPanel({
  id,
  title,
  icon,
  addLabel,
  noteIcon,
  note,
  initialQuests,
}: QuestPanelProps) {
  const [quests, setQuests] = useState(initialQuests);
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const completedCount = quests.filter((quest) => quest.completed).length;

  function toggleQuest(questId: string) {
    setQuests((current) =>
      current.map((quest) =>
        quest.id === questId ? { ...quest, completed: !quest.completed } : quest,
      ),
    );
  }

  function removeQuest(questId: string) {
    setQuests((current) => current.filter((quest) => quest.id !== questId));
  }

  function addQuest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedTitle = newTitle.trim();
    if (!trimmedTitle) return;

    setQuests((current) => [
      ...current,
      {
        id: `${id}-${Date.now()}`,
        title: trimmedTitle,
        category: id === "daily-quests" ? "Wellness" : "Personal",
        schedule: id === "daily-quests" ? "Every day" : "Due today",
        xp: id === "daily-quests" ? 20 : 30,
        completed: false,
      },
    ]);
    setNewTitle("");
    setIsAdding(false);
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
            {completedCount} / {quests.length} done
          </span>
        </div>
        <button
          className="quest-add-button"
          type="button"
          onClick={() => setIsAdding((current) => !current)}
          aria-expanded={isAdding}
        >
          <Image src="/icon-plus.svg" alt="" aria-hidden="true" width={15} height={15} />
          <span>{addLabel}</span>
        </button>
      </header>

      {isAdding && (
        <form className="new-quest-form" onSubmit={addQuest}>
          <input
            autoFocus
            aria-label="New quest name"
            placeholder="Name your quest"
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
          />
          <button type="submit">Add</button>
          <button type="button" onClick={() => setIsAdding(false)}>
            Cancel
          </button>
        </form>
      )}

      <ul className="quest-list">
        {quests.map((quest) => (
          <li className={`quest-row${quest.completed ? " is-complete" : ""}`} key={quest.id}>
            <button
              className={`quest-check${quest.completed ? " is-checked" : ""}`}
              type="button"
              aria-label={`${quest.completed ? "Mark incomplete" : "Complete"}: ${quest.title}`}
              aria-pressed={quest.completed}
              onClick={() => toggleQuest(quest.id)}
            >
              {quest.completed && (
                <Image src="/icon-check.svg" alt="" aria-hidden="true" width={15} height={15} />
              )}
            </button>
            <div className="quest-copy">
              <strong>{quest.title}</strong>
              <span>{quest.category} <span aria-hidden="true">·</span> {quest.schedule}</span>
            </div>
            <span className={`quest-status${quest.completed ? " is-done" : ""}`}>
              {quest.completed ? "Done" : `+${quest.xp} XP`}
            </span>
            <button
              className="quest-row-action"
              type="button"
              disabled
              aria-label={`Edit ${quest.title} in the future quest editor`}
              title="Quest editing will be added with the Edit Quest screen"
            >
              <Image src="/icon-pencil.svg" alt="" aria-hidden="true" width={14} height={14} />
            </button>
            <button
              className="quest-row-action is-delete"
              type="button"
              onClick={() => removeQuest(quest.id)}
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