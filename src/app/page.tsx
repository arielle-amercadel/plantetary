
"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import AppShell, { FigmaIcon } from "./app-shell";
import QuestPanel from "./quest-panel";
import { getHomeQuestListsForDisplay } from "./quest-logic";
import { getLevelProgress, useQuestStore } from "./quest-store";
import { getNextPlantProgress, getPlantCollectionStatus, getWaitingGiftsLabel, plantCatalog } from "./plant-journal-logic";
import {
  defaultProfilePreferences,
  getGardenBannerTitle,
  getWelcomeGreeting,
  loadProfilePreferences,
  profilePreferencesUpdatedEvent,
} from "./settings-logic";

export default function Home() {
  const [isAddingDailyQuest, setIsAddingDailyQuest] = useState(false);
  const [isAddingPersonalQuest, setIsAddingPersonalQuest] = useState(false);
  const [displayName, setDisplayName] = useState(defaultProfilePreferences.displayName);
  const { questLists, todayKey, totalXp, completedTodayCounts, completedOverallCounts, discoveredPlantIds, pendingPlantGiftIds, currentStreak, dailyCompletedQuestIds, dailyScheduledQuestIds, recoverableDailyQuestIds, hasRestored, addQuest, toggleQuest, deleteQuest, recoverOrphanedDailyQuest } = useQuestStore();
  const { level, xpIntoLevel, xpForNextLevel, xpProgressPercent } = getLevelProgress(totalXp);
  const homeQuestLists = getHomeQuestListsForDisplay(questLists, todayKey);
  const discoveredPlants = plantCatalog.filter((plant) => discoveredPlantIds.includes(plant.id));
  const nextDiscovery = hasRestored ? getNextPlantProgress(totalXp, discoveredPlantIds, pendingPlantGiftIds) : undefined;
  const collectionStatus = getPlantCollectionStatus(totalXp, discoveredPlantIds, pendingPlantGiftIds);
  const gardenTitle = getGardenBannerTitle(displayName);

  useEffect(() => {
    const restoreProfile = () => {
      setDisplayName(loadProfilePreferences(window.localStorage).displayName);
    };
    const restoreTimer = window.setTimeout(restoreProfile, 0);
    window.addEventListener("storage", restoreProfile);
    window.addEventListener(profilePreferencesUpdatedEvent, restoreProfile);
    return () => {
      window.clearTimeout(restoreTimer);
      window.removeEventListener("storage", restoreProfile);
      window.removeEventListener(profilePreferencesUpdatedEvent, restoreProfile);
    };
  }, []);

  return (
    <AppShell page="home">
        <div className="garden-banner" role="img" aria-label={gardenTitle}>
          <Image
            src="/plantetary-garden.png"
            alt=""
            width={1208}
            height={120}
            priority
            unoptimized
            className="garden-banner-image"
          />
          <span className="garden-banner-title-mask" aria-hidden="true" />
          <span
            className="garden-banner-title"
            aria-hidden="true"
            style={{ "--garden-title-length": gardenTitle.length } as CSSProperties}
          >
            {gardenTitle}
          </span>
        </div>

        <main className="dashboard-content">
          <section className="welcome-row" aria-labelledby="welcome-heading">
            <div>
              <h1 id="welcome-heading">A little progress, a little magic.</h1>
              <p>{getWelcomeGreeting(displayName)} Let’s make room for the things that matter.</p>
            </div>
            <Link
              className="primary-button"
              href="/quests/new"
            >
              <FigmaIcon src="/icon-plus-cta.svg" size={16} />
              <span>Add quest</span>
            </Link>
          </section>

          <section className="progress-overview" aria-label="Your progress">
            <div className="level-progress">
              <div className="level-badge">{level}</div>
              <div className="experience-details">
                <div className="rank-line">
                  <strong>Budding botanist</strong>
                  <span>Level {level}</span>
                </div>
                <div
                  className="experience-track"
                  role="progressbar"
                  aria-label={`Experience toward level ${level + 1}`}
                  aria-valuemin={0}
                  aria-valuemax={xpForNextLevel}
                  aria-valuenow={xpIntoLevel}
                >
                  <span style={{ width: `${xpProgressPercent}%` }} />
                </div>
                <div className="experience-labels">
                  <span>{xpIntoLevel} / {xpForNextLevel} XP</span>
                  <span>{xpForNextLevel - xpIntoLevel} XP to level {level + 1}</span>
                </div>
              </div>
            </div>
            <div className="stat-card">
              <strong className="stat-value">{completedTodayCounts.total}</strong>
              <span className="stat-title">Completed today</span>
              <span className="stat-note">{completedTodayCounts.daily} daily · {completedTodayCounts.personal} personal</span>
            </div>
            <div className="stat-card">
              <strong className="stat-value">{completedOverallCounts.total}</strong>
              <span className="stat-title">Quests completed</span>
              <span className="stat-note">{completedOverallCounts.daily} daily · {completedOverallCounts.personal} personal</span>
            </div>
            <div className="stat-card">
              <strong className="stat-value">{currentStreak} days</strong>
              <span className="stat-title">Current streak</span>
              <span className="stat-note">Little steps add up</span>
            </div>
          </section>

          {recoverableDailyQuestIds.length > 0 && (
            <section className="streak-recovery" aria-labelledby="streak-recovery-heading">
              <p id="streak-recovery-heading">
                Unfinished scheduled quest IDs are missing from your Daily Quests. Confirm only if you deleted one today; removing it changes today’s obligations and may affect today’s streak.
              </p>
              <ul>
                {recoverableDailyQuestIds.map((questId) => (
                  <li key={questId}>
                    <code>{questId}</code>
                    <button
                      type="button"
                      onClick={() => {
                        const confirmed = window.confirm(
                          `Remove ${questId} from today's scheduled obligations? This may affect today's streak. This only changes today's snapshot.`,
                        );
                        if (confirmed) recoverOrphanedDailyQuest(questId);
                      }}
                    >
                      Review recovery
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="dashboard-columns">
            <div className="quest-column">
              <QuestPanel
                id="daily-quests"
                title="Daily Quests"
                icon="/icon-sun.svg"
                addLabel="Add habit"
                noteIcon="/icon-refresh.svg"
                note="A fresh start every day at midnight. Your history stays with you."
                quests={homeQuestLists.daily.map((quest) => dailyScheduledQuestIds.includes(quest.id)
                  ? { ...quest, completed: dailyCompletedQuestIds.includes(quest.id) }
                  : quest)}
                isAdding={isAddingDailyQuest}
                onAddingChange={setIsAddingDailyQuest}
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
                note="One-time adventures, at your own pace."
                quests={homeQuestLists.personal}
                isAdding={isAddingPersonalQuest}
                onAddingChange={setIsAddingPersonalQuest}
                onToggleQuest={(questId) => toggleQuest("personal", questId)}
                onAddQuest={(quest) => addQuest("personal", quest)}
                onDeleteQuest={(questId) => deleteQuest("personal", questId)}
              />
              <div className="quest-history">
                <span>Every completed quest is part of your story.</span>
                <Link href="/completion-history">View completion history <span aria-hidden="true">→</span></Link>
              </div>
            </div>

            <aside className="collection-column" id="plant-collection">
              <section className="collection-card">
                <div className="collection-heading">
                  <h2>Your little collection</h2>
                  <FigmaIcon src="/icon-sprout.svg" size={18} />
                </div>
                <p className="collection-count">
                  {hasRestored ? `${discoveredPlants.length} of ${plantCatalog.length} plants discovered` : "Loading collection…"}
                </p>
                <div className="plant-previews">
                  {hasRestored && discoveredPlants.slice(0, 3).map((plant) => (
                    <div className="plant-preview" key={plant.id}>
                      {plant.imageSrc
                        ? <Image src={plant.imageSrc} alt={plant.name} width={70} height={70} unoptimized className="pixel-art" />
                        : <FigmaIcon src="/icon-sprout.svg" size={48} />}
                      <span>{plant.name}</span>
                    </div>
                  ))}
                </div>
                <Link className="journal-button" href="/plant-journal">
                  <FigmaIcon src="/icon-book.svg" size={16} />
                  <span>Open Plant Journal</span>
                </Link>
              </section>

              <section className="next-reward">
                <h2>
                  <FigmaIcon src="/icon-sparkles.svg" size={16} />
                  <span>{!hasRestored ? "Growing your garden" : nextDiscovery ? "So close to a new leaf" : collectionStatus === "gifts-waiting" ? "Your collection is almost complete" : "Your collection is complete"}</span>
                </h2>
                {!hasRestored ? (
                  <div className="reward-details"><p>Your saved discoveries are loading.</p></div>
                ) : nextDiscovery ? (
                  <>
                    <div className="reward-details">
                      {nextDiscovery.plant.imageSrc
                        ? <Image src={nextDiscovery.plant.imageSrc} alt={`Undiscovered ${nextDiscovery.plant.name}`} width={72} height={72} unoptimized className="pixel-art locked-plant-preview" />
                        : <FigmaIcon src="/icon-sprout.svg" size={56} />}
                      <div>
                        <strong>{nextDiscovery.plant.name}</strong>
                        <p>Discover at {nextDiscovery.plant.xpThreshold} XP.</p>
                      </div>
                    </div>
                    <div
                      className="reward-track"
                      role="progressbar"
                      aria-label={`XP progress toward ${nextDiscovery.plant.name}`}
                      aria-valuemin={0}
                      aria-valuemax={Math.max(1, nextDiscovery.plant.xpThreshold)}
                      aria-valuenow={Math.max(0, Math.min(totalXp, nextDiscovery.plant.xpThreshold))}
                    >
                      <span style={{ width: `${nextDiscovery.progressPercent}%` }} />
                    </div>
                    <p className="reward-caption">{totalXp} / {nextDiscovery.plant.xpThreshold} XP · {nextDiscovery.xpRemaining} to go</p>
                  </>
                ) : (
                  <div className="reward-details">
                    <p>
                      {collectionStatus === "gifts-waiting"
                        ? `${getWaitingGiftsLabel(pendingPlantGiftIds.length)} to be unwrapped in your Plant Journal.`
                        : `All ${plantCatalog.length} plants have been discovered.`}
                    </p>
                  </div>
                )}
              </section>

              <aside className="gentle-reminder">
                <FigmaIcon src="/icon-heart.svg" size={16} />
                <p>Rest is productive, too. Your quests will be here when you’re ready.</p>
              </aside>
            </aside>
          </div>
        </main>
    </AppShell>
  );
}
