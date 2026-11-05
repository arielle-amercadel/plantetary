"use client";

import { dateFromKey, getCompletionHistoryCardText } from "../quest-logic";
import { useQuestStore } from "../quest-store";
import type { CompletionHistoryItem, CompletionHistorySection } from "../quest-types";

function formatDate(dateKey: string): string {
  return dateFromKey(dateKey).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function CompletionCard({ item }: { item: CompletionHistoryItem }) {
  const copy = getCompletionHistoryCardText(item);

  return (
    <article className="completion-history-card">
      <div className="completion-history-card-main">
        <h3>{copy.title}</h3>
        <p>{copy.description}</p>
      </div>
      <span className="completion-history-xp">
        {item.xp === undefined ? "XP not recorded" : `+${item.xp} XP`}
      </span>
    </article>
  );
}

function DatedSection({ section, todayKey }: { section: CompletionHistorySection; todayKey: string }) {
  return (
    <details className="completion-history-date" open={section.dateKey === todayKey}>
      <summary>
        <span>{formatDate(section.dateKey)}</span>
        <span className="completion-history-count">
          {section.completionCount} {section.completionCount === 1 ? "completion" : "completions"}
        </span>
      </summary>
      <div className="completion-history-date-content">
        {section.daily.length > 0 && (
          <section className="completion-history-group" aria-label="Daily quest completions">
            <h2>Daily Quests</h2>
            <div className="completion-history-list">
              {section.daily.map((item) => <CompletionCard key={`daily-${item.questId}`} item={item} />)}
            </div>
          </section>
        )}
        {section.personal.length > 0 && (
          <section className="completion-history-group" aria-label="Personal quest completions">
            <h2>Personal Quests</h2>
            <div className="completion-history-list">
              {section.personal.map((item) => <CompletionCard key={`personal-${item.questId}`} item={item} />)}
            </div>
          </section>
        )}
      </div>
    </details>
  );
}

export default function CompletionHistoryScreen() {
  const { completionHistoryView, todayKey, hasRestored } = useQuestStore();

  if (!hasRestored) {
    return <main className="completion-history-content"><p>Opening your completion history…</p></main>;
  }

  const { sections, earlier } = completionHistoryView;
  return (
    <main className="completion-history-content">
      <header className="completion-history-header">
        <h1>Completion History</h1>
        <p>A little record of the quests you’ve completed along the way.</p>
      </header>

      <p className="completion-history-notice">
        Some older XP amounts may be estimates because historical awards were not always recorded exactly.
      </p>

      {earlier.completionCount > 0 && (
        <section className="completion-history-earlier" aria-labelledby="completion-history-earlier-title">
          <header>
            <h2 id="completion-history-earlier-title">Earlier completions</h2>
            <span>{earlier.completionCount} {earlier.completionCount === 1 ? "completion" : "completions"}</span>
          </header>
          <p>These legacy Personal completions do not have a reliable saved date. Individual details may not be available.</p>
          {earlier.items.length > 0 && (
            <div className="completion-history-list">
              {earlier.items.map((item) => <CompletionCard key={`legacy-${item.questId}`} item={item} />)}
            </div>
          )}
          {earlier.unidentifiableCount > 0 && (
            <p className="completion-history-legacy-count">
              {earlier.unidentifiableCount} {earlier.unidentifiableCount === 1 ? "completion has" : "completions have"} no saved quest ID or individual details.
            </p>
          )}
        </section>
      )}

      {sections.length > 0 ? (
        <div className="completion-history-dates">
          {sections.map((section) => <DatedSection key={section.dateKey} section={section} todayKey={todayKey} />)}
        </div>
      ) : earlier.completionCount === 0 ? (
        <section className="completion-history-empty">
          <h2>Your story is just beginning</h2>
          <p>Completed quests will appear here, one small step at a time.</p>
        </section>
      ) : null}
    </main>
  );
}
