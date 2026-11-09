"use client";

import { useEffect, useState } from "react";
import AppShell from "../app-shell";
import ProfileAvatarArtwork from "../profile-avatar-artwork";
import { getLocalDateKey } from "../quest-logic";
import { canResetBrowserData } from "../game-storage-controller";
import { useQuestStore } from "../quest-store";
import AccountSection from "./account-section";
import YourDataSection from "./your-data-section";
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
  const { totalXp, getDataForExport, hasRestored, storage, canPlay, writeBrowserData } = useQuestStore();
  // Reset clears this browser only. For a cloud garden it would look like a reset but change nothing
  // saved to the account, so it's turned off until cloud resets exist (Stage 10).
  const resetUnavailable = !canResetBrowserData(storage);
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
  const [preferencesDirty, setPreferencesDirty] = useState(false);
  const [preferencesGeneration, setPreferencesGeneration] = useState(-1);

  useEffect(() => {
    // Keep a stale draft visible, but never let it write after handoff/reset in another tab.
    if (!storage.mode || (storage.mode === "browser" && storage.phase !== "ready" && storage.phase !== "browser-failed")) return;
    if (preferencesLoaded && preferencesDirty) return;
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
        setPreferencesGeneration(storage.generation);
      }
    };
    const restoreTimer = window.setTimeout(restorePreferences, 0);
    return () => window.clearTimeout(restoreTimer);
  }, [storage.generation, storage.mode, storage.phase, preferencesLoaded, preferencesDirty]);

  function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (storage.mode === "browser" && preferencesGeneration !== storage.generation) return;
    const nextProfile = { ...profile, displayName: displayName.trim().slice(0, 32) };
    if (!nextProfile.displayName) {
      setProfileError(true);
      setProfileMessage("Enter a display name before saving.");
      return;
    }

    try {
      if (!writeBrowserData(storage.generation, () => saveProfilePreferences(window.localStorage, nextProfile))) throw new Error("Storage unavailable");
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
    if (storage.mode === "browser" && preferencesGeneration !== storage.generation) return;
    if (reminders.enabled && reminders.questTypes.length === 0) {
      setReminderError(true);
      setReminderMessage("Choose Daily Quests, Personal Quests, or both.");
      return;
    }

    try {
      if (!writeBrowserData(storage.generation, () => saveReminderPreferences(window.localStorage, reminders))) throw new Error("Storage unavailable");
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
    if (resetUnavailable) return;
    const confirmed = window.confirm(
      "Reset Plantetary data on this device? This removes your quests, categories, completion history, XP records, plant discoveries, profile and reminder preferences, and Plantetary backup copies. This cannot be undone. Other websites’ browser data will not be touched.",
    );
    if (!confirmed) {
      setDataError(false);
      setDataMessage("Reset canceled. Your saved data is unchanged.");
      return;
    }

    try {
      if (!writeBrowserData(storage.generation, () => resetPlantetaryStorage(window.localStorage, true), true)) throw new Error("Storage unavailable");
      window.dispatchEvent(new Event(profilePreferencesUpdatedEvent));
      setPreferencesDirty(false);
      setDataError(false);
      setDataMessage("Plantetary data was reset on this device.");
    } catch {
      setDataError(true);
      setDataMessage("Plantetary could not safely complete the reset. Check browser storage access and free space, and keep an export before trying again.");
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
        {preferencesLoaded && preferencesGeneration !== storage.generation && storage.mode === "browser" && (
          <p className="settings-message" role="status">Your garden changed while Settings was open. Your draft is still visible. <button className="settings-action-button" type="button" onClick={() => window.location.reload()}>Reload Settings</button> to load current preferences before saving.</p>
        )}

        <section className="settings-section" aria-labelledby="settings-profile-heading">
          <h2 id="settings-profile-heading">Profile</h2>
          <p className="settings-description">Choose the name and little avatar shown in your cozy corner.</p>
          <form onSubmit={saveProfile} onChangeCapture={() => setPreferencesDirty(true)}>
            <fieldset disabled={!preferencesLoaded || !storageAvailable || (storage.mode === "browser" && (!canPlay || preferencesGeneration !== storage.generation))}>
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
          <form onSubmit={saveReminders} onChangeCapture={() => setPreferencesDirty(true)}>
            <fieldset disabled={!preferencesLoaded || !storageAvailable || (storage.mode === "browser" && (!canPlay || preferencesGeneration !== storage.generation))}>
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

        <YourDataSection />

        <section className="settings-section" aria-labelledby="settings-data-heading">
          <h2 id="settings-data-heading">Data management</h2>
          <p className="settings-description">
            Export includes your quests, custom categories, completion history, XP ledger, discoveries, and local preferences. A successful reset removes the browser garden, its safety backups, profile and reminder preferences. A reset marker remains to protect open tabs; cloud data, sign-in cookies and downloaded files are not deleted.
            {storage.mode === "cloud" && " Your garden is saved to your account, which Reset can't change yet, so it's turned off while you're using your cloud garden."}
            {storage.mode === "browser" && storage.phase === "browser-failed" && resetUnavailable && " Reset is blocked until this garden can be safely loaded and validated. Restore browser storage access or update the app if this save needs a newer version, then try loading again. If changes are unsaved, download them first."}
            {storage.mode === "browser" && storage.loaded?.problem === "backup-failed" && !resetUnavailable && " Your older garden was validated, but its safety copy could not be stored. Export it first. A confirmed reset permanently removes the garden and its backups. A small amount of free browser storage is required to reset safely."}
          </p>
          <div className="settings-form-row">
            <button className="settings-action-button" type="button" disabled={!hasRestored || !storage.loaded || !preferencesLoaded} onClick={exportData}>
              Export data as JSON
            </button>
            <button className="settings-reset-button" type="button" disabled={resetUnavailable} onClick={resetData}>
              Reset Plantetary data
            </button>
          </div>
          <p className={`settings-message${dataError ? " is-error" : ""}`} role="status">{dataMessage}</p>
        </section>
      </main>
    </AppShell>
  );
}
