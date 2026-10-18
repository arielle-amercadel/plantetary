"use client";

import AppShell from "../app-shell";
import QuestPanel from "../quest-panel";
import { getAllQuestListsForDisplay } from "../quest-logic";
import { useQuestStore } from "../quest-store";

export default function AllQuestsPage() {
  const {
    questLists,
    todayKey,
    dailyScheduledQuestIds,
    dailyCompletedQuestIds,
    addQuest,
    toggleQuest,
    deleteQuest,
  } = useQuestStore();
  const sortedQuestLists = getAllQuestListsForDisplay(questLists, todayKey);
  const dailyQuests = sortedQuestLists.daily.map((quest) =>
    dailyScheduledQuestIds.includes(quest.id)
      ? { ...quest, completed: dailyCompletedQuestIds.includes(quest.id) }
      : quest,
  );

  return (
    <AppShell page="all-quests">
      <main className="dashboard-content">
        <section className="welcome-row" aria-labelledby="all-quests-heading">
          <div>
            <h1 id="all-quests-heading">All Quests</h1>
            <p>Your daily routines and personal goals, all in one place.</p>
          </div>
        </section>

        <div className="quest-column" style={{ marginTop: 24 }}>
          <QuestPanel
            id="daily-quests"
            title="Daily Quests"
            icon="/icon-sun.svg"
            addLabel="Add habit"
            noteIcon="/icon-refresh.svg"
            note="Quests scheduled for today appear first. Your other routines are here, too."
            quests={dailyQuests}
            showAddButton={false}
            isAdding={false}
            onAddingChange={() => {}}
            onToggleQuest={(questId) => toggleQuest("daily", questId)}
            onAddQuest={(quest) => addQuest("daily", quest)}
            onDeleteQuest={(questId) => deleteQuest("daily", questId)}
          />
          <QuestPanel
            id="personal-quests"
            title="Personal Quests"
            icon="/icon-scroll-text.svg"
            addLabel="Add quest"
            noteIcon="/icon-flag.svg"
            note="Your personal goals, ordered by due date."
            quests={sortedQuestLists.personal}
            showAddButton={false}
            isAdding={false}
            onAddingChange={() => {}}
            onToggleQuest={(questId) => toggleQuest("personal", questId)}
            onAddQuest={(quest) => addQuest("personal", quest)}
            onDeleteQuest={(questId) => deleteQuest("personal", questId)}
          />
        </div>
      </main>
    </AppShell>
  );
}
