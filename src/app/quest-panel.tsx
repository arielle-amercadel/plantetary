"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getDailyQuestScheduleLabel, getDueDateLabel, getQuestListProgress, isQuestPastDue, isQuestScheduledOnDate } from "./quest-logic";
import { getQuestXp, useQuestStore, type Quest } from "./quest-store";

type QuestPanelProps = {
  id: string;
  title: string;
  icon: string;
  addLabel: string;
  noteIcon: string;
  note: string;
  quests: Quest[];
  /** Shows the link to the full Create a quest form, with this panel's quest type chosen. */
  showAddButton?: boolean;
  onToggleQuest: (questId: string) => void;
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
  onToggleQuest,
  onDeleteQuest,
}: QuestPanelProps) {
  const router = useRouter();
  const list = id === "daily-quests" ? "daily" : "personal";
  const { dailyScheduledQuestIds, todayKey, canPlay } = useQuestStore();
  const progress = getQuestListProgress(quests, list, dailyScheduledQuestIds);

  // No quests to play until the garden has loaded: starter quests shown meanwhile must not be playable.
  if (!canPlay) {
    return (
      <section className="quest-panel" id={id} aria-labelledby={`${id}-heading`} aria-busy="true">
        <header className="quest-panel-header">
          <div className="quest-panel-title-wrap">
            <h2 className="quest-panel-title" id={`${id}-heading`}>
              <Image src={icon} alt="" aria-hidden="true" width={20} height={20} />
              <span>{title}</span>
            </h2>
          </div>
        </header>
        <p className="quest-panel-loading" role="status">Your quests will appear once your garden has loaded.</p>
      </section>
    );
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
          // The accessible name starts with the visible label ("Add habit", "Add quest"), so speech control
          // can use it (WCAG 2.5.3), and says which list, to tell it apart from the page's other "Add quest" links.
          <Link
            className="quest-add-button"
            href={`/quests/new?type=${list}`}
            aria-label={list === "daily" ? "Add habit to Daily Quests" : "Add quest to Personal Quests"}
          >
            <Image src="/icon-plus.svg" alt="" aria-hidden="true" width={15} height={15} />
            <span>{addLabel}</span>
          </Link>
        )}
      </header>

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
