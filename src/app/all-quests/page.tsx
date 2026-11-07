"use client";

import AppShell from "../app-shell";
import QuestPanel from "../quest-panel";
import { getAllQuestListsForDisplay, getDailyQuestsForDisplay } from "../quest-logic";
import { useQuestStore } from "../quest-store";

export default function AllQuestsPage() {
  const {
    questLists,
    todayKey,
    dailyCompletedQuestIds,
    toggleQuest,
    deleteQuest,
  } = useQuestStore();
  const sortedQuestLists = getAllQuestListsForDisplay(questLists, todayKey);
  const dailyQuests = getDailyQuestsForDisplay(sortedQuestLists.daily, dailyCompletedQuestIds);

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
            onToggleQuest={(questId) => toggleQuest("daily", questId)}
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
            onToggleQuest={(questId) => toggleQuest("personal", questId)}
            onDeleteQuest={(questId) => deleteQuest("personal", questId)}
          />
        </div>
      </main>
    </AppShell>
  );
}
