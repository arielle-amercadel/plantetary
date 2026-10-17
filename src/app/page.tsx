
"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import AppShell, { FigmaIcon } from "./app-shell";
import QuestPanel from "./quest-panel";
import { getLevelProgress, useQuestStore } from "./quest-store";

export default function Home() {
  const [isAddingDailyQuest, setIsAddingDailyQuest] = useState(false);
  const [isAddingPersonalQuest, setIsAddingPersonalQuest] = useState(false);
  const { questLists, totalXp, currentStreak, longestStreak, dailyCompletedQuestIds, dailyScheduledQuestIds, addQuest, toggleQuest, deleteQuest } = useQuestStore();
  const { level, xpIntoLevel, xpForNextLevel, xpProgressPercent } = getLevelProgress(totalXp);

  return (
    <AppShell page="home">
        <div className="garden-banner" aria-label="Mira’s pixel-art garden">
          <Image
            src="/plantetary-garden.png"
            alt=""
            width={1208}
            height={120}
            priority
            unoptimized
            className="garden-banner-image"
          />
        </div>

        <main className="dashboard-content">
          <section className="welcome-row" aria-labelledby="welcome-heading">
            <div>
              <h1 id="welcome-heading">A little progress, a little magic.</h1>
              <p>Welcome back, Mira. Let’s make room for the things that matter.</p>
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
              <strong className="stat-value">3 / 7</strong>
              <span className="stat-title">Completed today</span>
              <span className="stat-note">2 daily · 1 personal</span>
            </div>
            <div className="stat-card">
              <strong className="stat-value">48</strong>
              <span className="stat-title">Quests completed</span>
              <span className="stat-note">36 daily · 12 personal</span>
            </div>
            <div className="stat-card">
              <div className="streak-current">
                <svg className="streak-flame" viewBox="0 0 16 20" role="img" aria-label="Flame">
                  <path
                    d="M8 0 6 5 3 7 4 10 1 12 2 16 5 19 11 19 14 16 15 12 12 9 13 6 10 7Z"
                    fill="currentColor"
                  />
                  <path d="m8 11-2 3 2 3 3-2-1-3Z" fill="#f7f1e6" />
                </svg>
                <div className="streak-current-copy">
                  <strong className="stat-value">{currentStreak}</strong>
                  <span className="stat-title">Current Streak</span>
                </div>
              </div>
              <span className="stat-note">Longest Streak {longestStreak}</span>
            </div>
          </section>

          <div className="dashboard-columns">
            <div className="quest-column">
              <QuestPanel
                id="daily-quests"
                title="Daily Quests"
                icon="/icon-sun.svg"
                addLabel="Add habit"
                noteIcon="/icon-refresh.svg"
                note="A fresh start every day at midnight. Your history stays with you."
                quests={questLists.daily.map((quest) => dailyScheduledQuestIds.includes(quest.id)
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
                quests={questLists.personal}
                isAdding={isAddingPersonalQuest}
                onAddingChange={setIsAddingPersonalQuest}
                onToggleQuest={(questId) => toggleQuest("personal", questId)}
                onAddQuest={(quest) => addQuest("personal", quest)}
                onDeleteQuest={(questId) => deleteQuest("personal", questId)}
              />
              <div className="quest-history">
                <span>Every completed quest is part of your story.</span>
                <a href="#daily-quests">View completion history <span aria-hidden="true">→</span></a>
              </div>
            </div>

            <aside className="collection-column" id="plant-collection">
              <section className="collection-card">
                <div className="collection-heading">
                  <h2>Your little collection</h2>
                  <FigmaIcon src="/icon-sprout.svg" size={18} />
                </div>
                <p className="collection-count">4 of 8 plants discovered</p>
                <div className="plant-previews">
                  <div className="plant-preview">
                    <Image src="/plant-fern.png" alt="Fern" width={70} height={70} unoptimized className="pixel-art" />
                    <span>Fern</span>
                  </div>
                  <div className="plant-preview">
                    <Image src="/plant-daisy.png" alt="Daisy" width={70} height={70} unoptimized className="pixel-art" />
                    <span>Daisy</span>
                  </div>
                  <div className="plant-preview">
                    <Image src="/plant-cactus.png" alt="Cactus" width={70} height={70} unoptimized className="pixel-art" />
                    <span>Cactus</span>
                  </div>
                </div>
                <a className="journal-button" href="#plant-collection">
                  <FigmaIcon src="/icon-book.svg" size={16} />
                  <span>Open Plant Journal</span>
                </a>
              </section>

              <section className="next-reward">
                <h2>
                  <FigmaIcon src="/icon-sparkles.svg" size={16} />
                  <span>So close to a new leaf</span>
                </h2>
                <div className="reward-details">
                  <Image src="/plant-lavender.png" alt="Undiscovered lavender plant" width={72} height={72} unoptimized className="pixel-art" />
                  <div>
                    <strong>Lavender</strong>
                    <p>Complete 50 quests to discover this plant.</p>
                  </div>
                </div>
                <div
                  className="reward-track"
                  role="progressbar"
                  aria-label="Quests until Lavender"
                  aria-valuemin={0}
                  aria-valuemax={50}
                  aria-valuenow={48}
                >
                  <span />
                </div>
                <p className="reward-caption">48 / 50 quests · Just 2 more!</p>
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
