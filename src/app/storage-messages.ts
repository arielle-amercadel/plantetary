import type { SaveSnapshot } from "./game-data-session";
import type { GameStorageProblem } from "./game-storage";
import type { StorageControllerSnapshot } from "./game-storage-controller";

/** Why the cloud save couldn't be loaded, for the player. */
export function describeCloudLoadProblem(problem: GameStorageProblem | null): string {
  switch (problem) {
    case "network":
      return "Plantetary couldn't reach the server. Check your connection, then try again.";
    case "server":
      return "The server had a problem. Try again in a moment.";
    case "signed-out":
      return "Your sign-in has expired. Sign in again from Settings.";
    case "denied":
      return "Your account couldn't open this save. Try signing in again from Settings.";
    case "invalid-save":
      return "The garden saved in your account couldn't be read. It has been kept exactly as it is.";
    case "newer-version":
      return "Your garden was saved by a newer version of Plantetary. Refresh the page to update, then try again.";
    case "backup-failed":
      return "Your garden is in an older format, and Plantetary couldn't back it up before updating it, so it was left unchanged. Try again.";
    case "identity-changed":
      return "Plantetary couldn't confirm which account is signed in, so it stopped loading and saving your garden to keep it safe. Try again.";
    default:
      return "Something went wrong while loading your garden. Try again.";
  }
}

/** Why the latest changes couldn't be saved, for the player. */
export function describeSaveProblem(problem: GameStorageProblem): string {
  switch (problem) {
    case "network":
      return "Plantetary couldn't reach the server.";
    case "server":
      return "The server had a problem.";
    case "signed-out":
      return "Your sign-in has expired.";
    case "denied":
      return "Your account wasn't allowed to save.";
    case "too-large":
      return "Your garden is too large to save.";
    case "rejected":
      return "The server refused the changes.";
    case "storage":
      return "This browser refused to store them.";
    case "newer-version":
      return "Your garden was saved by a newer version of Plantetary. Refresh the page to update.";
    case "identity-changed":
      return "The signed-in account changed.";
    case "server-outdated":
      return "The server isn't set up for this yet.";
    default:
      return "Something went wrong.";
  }
}

/** What a conflict's backup copy holds, for the player. */
export function describeConflictBackup(backup: "saved" | "outdated" | "failed"): string {
  return backup === "saved"
    ? "A backup copy of them was kept in your account."
    : backup === "outdated"
      ? "A backup copy of earlier changes was kept in your account, but not of the newest ones."
      : "They couldn't be backed up either.";
}

/** What's unsaved and why, before leaving an account. Null when everything is saved. */
export function describeUnsavedChanges(save: SaveSnapshot | null): string | null {
  if (!save?.hasUnsavedChanges) return null;
  switch (save.status) {
    case "conflict":
      return `Your garden changed in another tab or on another device, so your latest changes weren't saved. ${describeConflictBackup(save.backup)}`;
    case "error":
      return `Your latest changes haven't been saved. ${describeSaveProblem(save.problem)}`;
    default:
      return "Your latest changes haven't been saved yet.";
  }
}

/**
 * The save-status indicator: short enough for the top bar. `detail` is said to screen readers and shown
 * as a tooltip. Null when there's nothing to show. Its actions are in the notices below the bar.
 *
 * - A cloud garden always shows where its saving stands, once it has loaded.
 * - A browser garden saves at once, as it always has, so it only shows something when a save failed.
 */
export type SaveStatusView = {
  tone: "saving" | "saved" | "error" | "conflict";
  label: string;
  detail: string;
};

export function describeSaveStatus(storage: StorageControllerSnapshot): SaveStatusView | null {
  const save = storage.save;
  if (storage.phase !== "ready" || !save) return null;
  const where = storage.mode === "cloud" ? "to your account" : "in this browser";
  switch (save.status) {
    case "saving":
      if (storage.mode !== "cloud") return null;
      return { tone: "saving", label: "Saving…", detail: `Saving your latest changes ${where}.` };
    case "saved":
      if (storage.mode !== "cloud") return null;
      return { tone: "saved", label: "Saved", detail: `All changes saved ${where}.` };
    case "error": {
      const retrying = save.nextRetryAt !== null;
      return {
        tone: "error",
        label: retrying ? "Retrying…" : "Not saved",
        detail: `Your latest changes haven't been saved ${where}. ${describeSaveProblem(save.problem)} ${retrying ? "Trying again shortly." : "They're still on this screen."}`,
      };
    }
    case "conflict":
      return {
        tone: "conflict",
        label: "Saving paused",
        detail: "Your garden changed in another tab or on another device, so saving here has paused.",
      };
    default:
      return null;
  }
}

/**
 * Whether leaving the page now would lose something: changes not saved yet (including ones waiting for
 * the short pause before a cloud write), a listed notice about changes from an account change that hasn't
 * been dismissed, or kept changes (listed or hidden) that only this page holds. The browser's prompt is
 * generic, so it reveals nothing about hidden entries.
 *
 * Also while an import is being sent or its outcome isn't confirmed yet: leaving is safe for the data
 * (the browser garden is never changed, and a reload never resends the import), but this page is the only
 * place that would tell the player whether it finished.
 */
export function shouldWarnBeforeLeaving(storage: StorageControllerSnapshot): boolean {
  if (storage.phase === "importing" || storage.phase === "import-unresolved") return true;
  if (storage.save?.hasUnsavedChanges) return true;
  if (storage.recoveriesAtRisk) return true;
  return storage.unsavedRecoveries.some((entry) => entry.reason === "account-changed");
}
