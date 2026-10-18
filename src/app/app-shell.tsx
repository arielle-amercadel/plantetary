"use client";

import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { getLevelProgress, useQuestStore } from "./quest-store";
import { dateFromKey, formatLocalDateLabel } from "./quest-logic";

export function FigmaIcon({
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

export default function AppShell({
  children,
  page,
}: {
  children: ReactNode;
  page: "home" | "create" | "journal" | "history" | "all-quests";
}) {
  const { totalXp, todayKey } = useQuestStore();
  const { level, xpIntoLevel, xpForNextLevel, xpProgressPercent } = getLevelProgress(totalXp);

  return (
    <div className="plantetary-app">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Link className="brand-title" href="/" aria-label="Plantetary home">
            <FigmaIcon src="/icon-sprout-brand.svg" size={24} />
            <span>Plantetary</span>
          </Link>
          <p>Small steps. A little more growth.</p>
        </div>

        <nav className="sidebar-nav" aria-label="Main navigation">
          <Link className={`nav-link${page === "home" ? " is-active" : ""}`} href="/">
            <FigmaIcon src="/icon-home.svg" />
            <span>Home</span>
          </Link>
          <Link className={`nav-link${page === "all-quests" ? " is-active" : ""}`} href="/all-quests">
            <FigmaIcon src="/icon-check.svg" />
            <span>All Quests</span>
          </Link>
          <Link className={`nav-link${page === "create" ? " is-active" : ""}`} href="/quests/new">
            <FigmaIcon src="/icon-square-plus.svg" />
            <span>Add quest</span>
          </Link>
          <Link className={`nav-link${page === "journal" ? " is-active" : ""}`} href="/plant-journal">
            <FigmaIcon src="/icon-book-sidebar.svg" />
            <span>Plant Journal</span>
          </Link>
          <Link className={`nav-link${page === "history" ? " is-active" : ""}`} href="/completion-history">
            <FigmaIcon src="/icon-scroll-text.svg" />
            <span>Completion History</span>
          </Link>
        </nav>

        <section className="player-summary" aria-label="Player progress">
          <h2>Mira’s adventure</h2>
          <p>Level {level} · Budding botanist</p>
          <div
            className="sidebar-xp-track"
            role="progressbar"
            aria-label={`Experience toward level ${level + 1}`}
            aria-valuemin={0}
            aria-valuemax={xpForNextLevel}
            aria-valuenow={xpIntoLevel}
          >
            <span style={{ width: `${xpProgressPercent}%` }} />
          </div>
          <p className="sidebar-xp-label">
            {xpIntoLevel} / {xpForNextLevel} XP to level {level + 1}
          </p>
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
            <strong>{page === "home" ? "Home" : page === "all-quests" ? "All Quests" : page === "journal" ? "Plant Journal" : page === "history" ? "Completion History" : "Create Quest"}</strong>
          </div>
          <div className="date-label">
            <FigmaIcon src="/icon-sun.svg" size={17} />
            <span>{todayKey ? formatLocalDateLabel(dateFromKey(todayKey)) : ""}</span>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
