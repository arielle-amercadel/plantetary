"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import ProfileAvatarArtwork from "./profile-avatar-artwork";
import { getLevelProgress, useQuestStore } from "./quest-store";
import SaveStatusIndicator from "./save-status-indicator";
import StorageNotices from "./storage-notices";
import { ImportResult } from "./import-flow-provider";
import { dateFromKey, formatLocalDateLabel } from "./quest-logic";
import {
  defaultProfilePreferences,
  loadProfilePreferences,
  profilePreferencesUpdatedEvent,
} from "./settings-logic";

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
  page: "home" | "create" | "journal" | "history" | "all-quests" | "settings" | "privacy";
}) {
  const { totalXp, todayKey, pendingPlantGiftIds, hasRestored } = useQuestStore();
  const { level, xpIntoLevel, xpForNextLevel, xpProgressPercent } = getLevelProgress(totalXp);
  const [profile, setProfile] = useState(defaultProfilePreferences);
  // Phones and tablets (up to 1050px, where the sidebar becomes a top bar): the links open from a menu
  // button as a floating panel. Above that, the sidebar is unchanged and this has no effect.
  const [menuOpen, setMenuOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const giftCount = hasRestored ? pendingPlantGiftIds.length : 0;
  const giftsLabel = giftCount > 0 ? `${giftCount} ${giftCount === 1 ? "gift" : "gifts"} waiting` : "";

  useEffect(() => {
    if (!menuOpen) return;
    // Escape closes it and returns focus to the button; a tap or click outside the header closes it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!sidebarRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    // Widening past the breakpoint shows the sidebar again; the menu shouldn't reopen on narrowing.
    const desktop = window.matchMedia("(min-width: 1051px)");
    const onBreakpoint = () => { if (desktop.matches) setMenuOpen(false); };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    desktop.addEventListener("change", onBreakpoint);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      desktop.removeEventListener("change", onBreakpoint);
    };
  }, [menuOpen]);

  useEffect(() => {
    const restoreProfile = () => {
      try {
        setProfile(loadProfilePreferences(window.localStorage));
      } catch {
        setProfile(defaultProfilePreferences);
      }
    };
    restoreProfile();
    window.addEventListener("storage", restoreProfile);
    window.addEventListener(profilePreferencesUpdatedEvent, restoreProfile);
    return () => {
      window.removeEventListener("storage", restoreProfile);
      window.removeEventListener(profilePreferencesUpdatedEvent, restoreProfile);
    };
  }, []);

  return (
    <div className="plantetary-app">
      <aside
        className="sidebar"
        ref={sidebarRef}
        onBlur={(event) => {
          // Tabbing out of the menu closes it, so it never floats over the page behind the keyboard focus.
          if (menuOpen && !event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false);
        }}
      >
        <div className="sidebar-brand">
          <Link className="brand-title" href="/" aria-label="Plantetary home">
            <FigmaIcon src="/icon-sprout-brand.svg" size={24} />
            <span>Plantetary</span>
          </Link>
          <p>Small steps. A little more growth.</p>
        </div>

        <button
          ref={menuButtonRef}
          className="sidebar-menu-button"
          type="button"
          aria-label={giftsLabel ? `Menu, ${giftsLabel}` : "Menu"}
          aria-expanded={menuOpen}
          aria-controls="main-navigation"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {/* Three pixel bars, or a pixel cross when open. */}
          <svg width={22} height={22} viewBox="0 0 11 11" aria-hidden="true" shapeRendering="crispEdges">
            {menuOpen ? (
              <>
                <rect x="1" y="1" width="2" height="2" /><rect x="3" y="3" width="2" height="2" />
                <rect x="5" y="5" width="1" height="1" /><rect x="6" y="6" width="2" height="2" />
                <rect x="8" y="8" width="2" height="2" /><rect x="8" y="1" width="2" height="2" />
                <rect x="6" y="3" width="2" height="2" /><rect x="3" y="6" width="2" height="2" />
                <rect x="1" y="8" width="2" height="2" />
              </>
            ) : (
              <>
                <rect x="1" y="2" width="9" height="1.5" /><rect x="1" y="4.75" width="9" height="1.5" />
                <rect x="1" y="7.5" width="9" height="1.5" />
              </>
            )}
          </svg>
          {giftCount > 0 && <span className="sidebar-menu-gift" aria-hidden="true" />}
        </button>

        <nav
          className={`sidebar-nav${menuOpen ? " is-open" : ""}`}
          id="main-navigation"
          aria-label="Main navigation"
          onClick={(event) => {
            // Choosing a destination closes the menu (including the page already shown).
            if ((event.target as Element).closest("a")) setMenuOpen(false);
          }}
        >
          <Link className={`nav-link${page === "home" ? " is-active" : ""}`} aria-current={page === "home" ? "page" : undefined} href="/">
            <FigmaIcon src="/icon-home.svg" />
            <span>Home</span>
          </Link>
          <Link className={`nav-link${page === "all-quests" ? " is-active" : ""}`} aria-current={page === "all-quests" ? "page" : undefined} href="/all-quests">
            <FigmaIcon src="/icon-check.svg" />
            <span>All Quests</span>
          </Link>
          <Link className={`nav-link${page === "create" ? " is-active" : ""}`} aria-current={page === "create" ? "page" : undefined} href="/quests/new">
            <FigmaIcon src="/icon-square-plus.svg" />
            <span>Add quest</span>
          </Link>
          <Link
            className={`nav-link${page === "journal" ? " is-active" : ""}`}
            href="/plant-journal"
            aria-current={page === "journal" ? "page" : undefined}
            aria-label={giftsLabel ? `Plant Journal, ${giftsLabel}` : undefined}
          >
            <FigmaIcon src="/icon-book-sidebar.svg" />
            <span>Plant Journal</span>
            {hasRestored && pendingPlantGiftIds.length > 0 && <span className="journal-nav-badge" aria-hidden="true">{pendingPlantGiftIds.length}</span>}
          </Link>
          <Link className={`nav-link${page === "history" ? " is-active" : ""}`} aria-current={page === "history" ? "page" : undefined} href="/completion-history">
            <FigmaIcon src="/icon-scroll-text.svg" />
            <span>Completion History</span>
          </Link>
          {/* Only in the menu (phones and tablets). The desktop sidebar keeps its Settings icon instead. */}
          <Link
            className={`nav-link nav-link-menu-only${page === "settings" ? " is-active" : ""}`}
            href="/settings"
            aria-current={page === "settings" ? "page" : undefined}
          >
            <FigmaIcon src="/icon-settings.svg" />
            <span>Settings</span>
          </Link>
          <Link
            className={`nav-link nav-link-menu-only${page === "privacy" ? " is-active" : ""}`}
            href="/privacy"
            aria-current={page === "privacy" ? "page" : undefined}
          >
            <FigmaIcon src="/icon-heart.svg" />
            <span>Privacy</span>
          </Link>
        </nav>

        <section className="player-summary" aria-label="Player progress">
          <h2>{profile.displayName}’s adventure</h2>
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
          <div className="player-avatar" aria-hidden="true">
            {profile.avatar !== null
              ? <ProfileAvatarArtwork avatar={profile.avatar} />
              : profile.displayName.charAt(0).toUpperCase()}
          </div>
          <div className="account-copy">
            <strong>{profile.displayName}</strong>
            <span>Your cozy corner</span>
          </div>
          <Link
            className="icon-button account-settings"
            href="/settings"
            aria-label="Settings"
            aria-current={page === "settings" ? "page" : undefined}
            title="Settings"
          >
            <FigmaIcon src="/icon-settings.svg" />
          </Link>
        </div>

        {/* The desktop sidebar's quiet link to the Privacy Notice; phones and tablets have it in the menu. */}
        <Link
          className={`sidebar-privacy-link${page === "privacy" ? " is-active" : ""}`}
          href="/privacy"
          aria-current={page === "privacy" ? "page" : undefined}
        >
          Privacy
        </Link>
      </aside>

      <div className="workspace">
        <header className="workspace-topbar">
          <div className="breadcrumb">
            <FigmaIcon src="/icon-sprout.svg" size={17} />
            <span>Your cozy corner</span>
            <span className="breadcrumb-divider">/</span>
            <strong>{page === "home" ? "Home" : page === "all-quests" ? "All Quests" : page === "journal" ? "Plant Journal" : page === "history" ? "Completion History" : page === "settings" ? "Settings" : page === "privacy" ? "Privacy" : "Create Quest"}</strong>
          </div>
          <div className="workspace-topbar-status">
            <SaveStatusIndicator />
            <div className="date-label">
              <FigmaIcon src="/icon-sun.svg" size={17} />
              <span>{todayKey ? formatLocalDateLabel(dateFromKey(todayKey)) : ""}</span>
            </div>
          </div>
        </header>
        <ImportResult />
        <StorageNotices />
        {children}
      </div>
    </div>
  );
}
