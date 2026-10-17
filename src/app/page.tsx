
import Image from "next/image";
import QuestPanel, { type Quest } from "./quest-panel";

const dailyQuests: Quest[] = [
  { id: "water", title: "Drink a glass of water", category: "Wellness", schedule: "Every day", xp: 20, completed: true },
  { id: "skincare", title: "Morning skincare", category: "Self-care", schedule: "Every day", xp: 20, completed: true },
  { id: "reading", title: "Read for 20 minutes", category: "Personal growth", schedule: "Every day", xp: 20, completed: false },
  { id: "stretch", title: "Evening stretch", category: "Wellness", schedule: "Every day", xp: 20, completed: false },
];

const personalQuests: Quest[] = [
  { id: "biology", title: "Review biology notes", category: "Study", schedule: "Due today", xp: 30, completed: false },
  { id: "moodboard", title: "Finish portfolio moodboard", category: "Projects", schedule: "Due Oct 20", xp: 30, completed: false },
  { id: "desk", title: "Tidy the desk", category: "Chores", schedule: "No due date", xp: 30, completed: true },
];

function FigmaIcon({
  src,
  size = 18,
}: {
  src: string;
  size?: number;
}) {
  return (
    <Image
      src={src}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
    />
  );
}

export default function Home() {
  return (
    <main className="plantetary-app" id="dashboard">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <a className="brand-title" href="#dashboard" aria-label="Plantetary home">
            <FigmaIcon src="/icon-sprout-brand.svg" size={24} />
            <span>Plantetary</span>
          </a>
          <p>Small steps. A little more growth.</p>
        </div>

        <nav className="sidebar-nav" aria-label="Main navigation">
          <a className="nav-link is-active" href="#dashboard">
            <FigmaIcon src="/icon-home.svg" />
            <span>Home</span>
          </a>
          <a className="nav-link" href="#daily-quests">
            <FigmaIcon src="/icon-square-plus.svg" />
            <span>Add quest</span>
          </a>
          <a className="nav-link" href="#plant-collection">
            <FigmaIcon src="/icon-book-sidebar.svg" />
            <span>Plant Journal</span>
          </a>
        </nav>

        <section className="player-summary" aria-label="Player progress">
          <h2>Mira’s adventure</h2>
          <p>Level 5 · Budding botanist</p>
          <div
            className="sidebar-xp-track"
            role="progressbar"
            aria-label="Experience toward level 6"
            aria-valuemin={0}
            aria-valuemax={300}
            aria-valuenow={180}
          >
            <span />
          </div>
          <p className="sidebar-xp-label">180 / 300 XP to level 6</p>
        </section>

        <div className="sidebar-spacer" />

        <aside className="encouragement">
          <Image
            src="/plant-potted.png"
            alt=""
            width={80}
            height={80}
            unoptimized
            className="pixel-art"
          />
          <p>You don’t have to do it all. A little progress still counts.</p>
        </aside>

        <div className="player-account">
          <div className="player-avatar" aria-hidden="true">M</div>
          <div className="account-copy">
            <strong>Mira</strong>
            <span>Your cozy corner</span>
          </div>
          <button className="icon-button account-settings" type="button" aria-label="Settings">
            <FigmaIcon src="/icon-settings.svg" />
          </button>
        </div>
      </aside>

      <div className="workspace">
        <header className="workspace-topbar">
          <div className="breadcrumb">
            <FigmaIcon src="/icon-sprout.svg" size={17} />
            <span>Your cozy corner</span>
            <span className="breadcrumb-divider">/</span>
            <strong>Home</strong>
          </div>
          <div className="date-label">
            <FigmaIcon src="/icon-sun.svg" size={17} />
            <span>Saturday, October 17</span>
          </div>
        </header>

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

        <div className="dashboard-content">
          <section className="welcome-row" aria-labelledby="welcome-heading">
            <div>
              <h1 id="welcome-heading">A little progress, a little magic.</h1>
              <p>Welcome back, Mira. Let’s make room for the things that matter.</p>
            </div>
            <a className="primary-button" href="#daily-quests">
              <FigmaIcon src="/icon-plus-cta.svg" size={16} />
              <span>Add quest</span>
            </a>
          </section>

          <section className="progress-overview" aria-label="Your progress">
            <div className="level-progress">
              <div className="level-badge">5</div>
              <div className="experience-details">
                <div className="rank-line">
                  <strong>Budding botanist</strong>
                  <span>Level 5</span>
                </div>
                <div
                  className="experience-track"
                  role="progressbar"
                  aria-label="Experience toward level 6"
                  aria-valuemin={0}
                  aria-valuemax={300}
                  aria-valuenow={180}
                >
                  <span />
                </div>
                <div className="experience-labels">
                  <span>180 / 300 XP</span>
                  <span>120 XP to level 6</span>
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
              <strong className="stat-value">7 days</strong>
              <span className="stat-title">Current streak</span>
              <span className="stat-note">Little steps add up</span>
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
                initialQuests={dailyQuests}
              />
              <QuestPanel
                id="personal-quests"
                title="Personal Quests"
                icon="/icon-scroll-text.svg"
                addLabel="Add quest"
                noteIcon="/icon-flag.svg"
                note="One-time adventures, at your own pace."
                initialQuests={personalQuests}
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
        </div>
      </div>
    </main>
  );
}
