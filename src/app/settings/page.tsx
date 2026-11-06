"use client";

import { useEffect, useState } from "react";
import AppShell from "../app-shell";
import ProfileAvatarArtwork from "../profile-avatar-artwork";
import { getLocalDateKey } from "../quest-logic";
import { useQuestStore } from "../quest-store";
import AccountSection from "./account-section";
import {
  createSettingsExportJson,
  defaultProfilePreferences,
  defaultReminderPreferences,
  loadProfilePreferences,
  loadReminderPreferences,
  profileAvatars,
  profilePreferencesUpdatedEvent,
  resetPlantetaryStorage,
  saveProfilePreferences,
  saveReminderPreferences,
  type ProfilePreferences,
  type ReminderPreferences,
} from "../settings-logic";

export default function SettingsPage() {
  const { totalXp, getDataForExport, hasRestored } = useQuestStore();
  const [profile, setProfile] = useState<ProfilePreferences>(defaultProfilePreferences);
  const [reminders, setReminders] = useState<ReminderPreferences>(defaultReminderPreferences);
  const [displayName, setDisplayName] = useState(defaultProfilePreferences.displayName);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [profileMessage, setProfileMessage] = useState("");
  const [reminderMessage, setReminderMessage] = useState("");
  const [dataMessage, setDataMessage] = useState("");
  const [profileError, setProfileError] = useState(false);
  const [reminderError, setReminderError] = useState(false);
  const [dataError, setDataError] = useState(false);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);

  useEffect(() => {
    const restorePreferences = () => {
      try {
        const savedProfile = loadProfilePreferences(window.localStorage);
        setProfile(savedProfile);
        setDisplayName(savedProfile.displayName);
        setReminders(loadReminderPreferences(window.localStorage));
      } catch {
        setStorageAvailable(false);
      } finally {
        setPreferencesLoaded(true);
      }
    };
    const restoreTimer = window.setTimeout(restorePreferences, 0);
    return () => window.clearTimeout(restoreTimer);
  }, []);

  function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextProfile = { ...profile, displayName: displayName.trim().slice(0, 32) };
    if (!nextProfile.displayName) {
      setProfileError(true);
      setProfileMessage("Enter a display name before saving.");
      return;
    }

    try {
      if (!saveProfilePreferences(window.localStorage, nextProfile)) throw new Error("Storage unavailable");
      setProfile(nextProfile);
      setDisplayName(nextProfile.displayName);
      setProfileError(false);
      setProfileMessage("Profile saved on this device.");
      window.dispatchEvent(new Event(profilePreferencesUpdatedEvent));
    } catch {
      setProfileError(true);
      setProfileMessage("Plantetary could not save your profile preferences in this browser.");
    }
  }

  function saveReminders(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reminders.enabled && reminders.questTypes.length === 0) {
      setReminderError(true);
      setReminderMessage("Choose Daily Quests, Personal Quests, or both.");
      return;
    }

    try {
      if (!saveReminderPreferences(window.localStorage, reminders)) throw new Error("Storage unavailable");
      setReminderError(false);
      setReminderMessage("Reminder preferences saved on this device. Notifications are not sent by Plantetary yet.");
    } catch {
      setReminderError(true);
      setReminderMessage("Plantetary could not save reminder preferences in this browser.");
    }
  }

  function exportData() {
    try {
      const json = createSettingsExportJson(
        getDataForExport(),
        totalXp,
        profile,
        reminders,
        new Date().toISOString(),
      );
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `plantetary-backup-${getLocalDateKey(new Date())}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDataError(false);
      setDataMessage("Your Plantetary backup was downloaded.");
    } catch {
      setDataError(true);
      setDataMessage("Plantetary could not create the backup file. Your saved data was not changed.");
    }
  }

  function resetData() {
    const confirmed = window.confirm(
      "Reset Plantetary data on this device? This removes your quests, categories, completion history, XP records, plant discoveries, profile and reminder preferences, and Plantetary backup copies. This cannot be undone. Other websites’ browser data will not be touched.",
    );
    if (!confirmed) {
      setDataError(false);
      setDataMessage("Reset canceled. Your saved data is unchanged.");
      return;
    }

    try {
      if (!resetPlantetaryStorage(window.localStorage, true)) throw new Error("Storage unavailable");
      window.location.reload();
    } catch {
      setDataError(true);
      setDataMessage("Plantetary could not safely reset its saved data. Please check this browser’s storage settings.");
    }
  }

  function toggleReminderType(type: "daily" | "personal") {
    setReminders((current) => ({
      ...current,
      questTypes: current.questTypes.includes(type)
        ? current.questTypes.filter((selected) => selected !== type)
        : [...current.questTypes, type],
    }));
  }

  return (
    <AppShell page="settings">
      <main className="settings-content">
        <header className="settings-heading">
          <h1>Settings</h1>
          <p>Manage your local preferences and Plantetary data.</p>
        </header>

        <AccountSection />

        <section className="settings-section" aria-labelledby="settings-profile-heading">
          <h2 id="settings-profile-heading">Profile</h2>
          <p className="settings-description">Choose the name and little avatar shown in your cozy corner.</p>
          <form onSubmit={saveProfile}>
            <fieldset disabled={!preferencesLoaded || !storageAvailable}>
              <label className="settings-field" htmlFor="profile-display-name">
                Display name
                <input
                  id="profile-display-name"
                  type="text"
                  maxLength={32}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
              <div className="settings-field" role="radiogroup" aria-label="Choose an avatar">
                <span>Avatar (optional)</span>
                <div className="settings-avatar-options">
                  <label className={`settings-avatar-option${profile.avatar === null ? " is-selected" : ""}`}>
                    <input
                      type="radio"
                      name="profile-avatar"
                      value="none"
                      checked={profile.avatar === null}
                      onChange={() => setProfile((current) => ({ ...current, avatar: null }))}
                    />
                    <span className="settings-avatar-symbol"><ProfileAvatarArtwork avatar={null} /></span>
                    <span className="settings-avatar-label">None</span>
                  </label>
                  {profileAvatars.map((avatar) => (
                    <label className={`settings-avatar-option${profile.avatar === avatar.id ? " is-selected" : ""}`} key={avatar.id}>
                      <input
                        type="radio"
                        name="profile-avatar"
                        value={avatar.id}
                        checked={profile.avatar === avatar.id}
                        onChange={() => setProfile((current) => ({ ...current, avatar: avatar.id }))}
                      />
                      <span className="settings-avatar-symbol"><ProfileAvatarArtwork avatar={avatar.id} /></span>
                      <span className="settings-avatar-label">{avatar.label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="settings-form-row">
                <button className="settings-action-button" type="submit">Save profile</button>
              </div>
            </fieldset>
          </form>
          <p className={`settings-message${profileError ? " is-error" : ""}`} role="status">{profileMessage}</p>
        </section>

        <section className="settings-section" aria-labelledby="settings-reminders-heading">
          <h2 id="settings-reminders-heading">Quest reminders</h2>
          <p className="settings-description">
            Save a reminder preference for this device. Plantetary does not currently send notifications or run background reminders.
          </p>
          <form onSubmit={saveReminders}>
            <fieldset disabled={!preferencesLoaded || !storageAvailable}>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={reminders.enabled}
                  onChange={(event) => setReminders((current) => ({ ...current, enabled: event.target.checked }))}
                />
                Save a reminder preference
              </label>
              <div className="settings-choice-row" aria-label="Quest types for reminder preference">
                <label className="settings-check-option">
                  <input type="checkbox" checked={reminders.questTypes.includes("daily")} onChange={() => toggleReminderType("daily")} />
                  Daily Quests
                </label>
                <label className="settings-check-option">
                  <input type="checkbox" checked={reminders.questTypes.includes("personal")} onChange={() => toggleReminderType("personal")} />
                  Personal Quests
                </label>
              </div>
              <div className="settings-form-row">
                <label className="settings-field" htmlFor="reminder-time">
                  Preferred time
                  <input
                    id="reminder-time"
                    type="time"
                    value={reminders.time}
                    onChange={(event) => setReminders((current) => ({ ...current, time: event.target.value }))}
                  />
                </label>
                <button className="settings-action-button" type="submit">Save preferences</button>
              </div>
            </fieldset>
          </form>
          <p className={`settings-message${reminderError ? " is-error" : ""}`} role="status">{reminderMessage}</p>
        </section>

        <section className="settings-section" aria-labelledby="settings-data-heading">
          <h2 id="settings-data-heading">Data management</h2>
          <p className="settings-description">
            Export includes your quests, custom categories, completion history, XP ledger, discoveries, and local preferences. Reset removes Plantetary data and its safety backups from this device.
          </p>
          <div className="settings-form-row">
            <button className="settings-action-button" type="button" disabled={!hasRestored} onClick={exportData}>
              Export data as JSON
            </button>
            <button className="settings-reset-button" type="button" onClick={resetData}>
              Reset Plantetary data
            </button>
          </div>
          <p className={`settings-message${dataError ? " is-error" : ""}`} role="status">{dataMessage}</p>
        </section>
      </main>
    </AppShell>
  );
}
