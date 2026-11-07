import type { BrowserGardenSummary, BrowserSavePreview } from "./browser-save-preview";
import type { BrowserImportOutcome, BrowserImportRefusal, StorageControllerSnapshot } from "./game-storage-controller";
import type { GameStorageProblem } from "./game-storage";
import { dateFromKey } from "./quest-logic";
import { describeSaveProblem } from "./storage-messages";

/**
 * What the import screens show and decide, kept apart from React so it can be tested on its own:
 * whether this browser's garden can be imported, how a garden is summarized, what each outcome says,
 * and when an open confirmation no longer applies.
 */

/** Whether this browser's garden is worth importing, and if not, why, for the player. */
export type BrowserImportAvailability =
  | { available: true; summary: BrowserGardenSummary }
  | { available: false; reason: BrowserImportRefusal; message: string; summary: BrowserGardenSummary | null };

export function browserImportAvailability(preview: BrowserSavePreview | null): BrowserImportAvailability {
  if (!preview) return { available: false, reason: "browser-empty", message: describeImportRefusal("browser-empty"), summary: null };
  switch (preview.status) {
    case "ready":
      return preview.hasMeaningfulProgress
        ? { available: true, summary: preview.summary }
        : { available: false, reason: "no-progress", message: describeImportRefusal("no-progress"), summary: preview.summary };
    case "empty":
      return { available: false, reason: "browser-empty", message: describeImportRefusal("browser-empty"), summary: null };
    case "newer-version":
      return { available: false, reason: "browser-newer-version", message: describeImportRefusal("browser-newer-version"), summary: null };
    default:
      return { available: false, reason: "browser-unreadable", message: describeImportRefusal("browser-unreadable"), summary: null };
  }
}

/** Why an import can't happen, for the player. Calm and specific: nothing has been changed in any of these. */
export function describeImportRefusal(reason: BrowserImportRefusal): string {
  switch (reason) {
    case "busy":
      return "An import is already running. Give it a moment to finish.";
    case "not-cloud":
      return "Importing needs a verified sign-in with your cloud garden open. Nothing was changed.";
    case "not-loaded":
      return "Your cloud garden needs to finish loading first. Nothing was changed.";
    case "unsaved":
      return "Some changes to your cloud garden haven't been saved yet. Once they're saved, or the saving problem is sorted out, you can import. Nothing was changed.";
    case "stale":
      return "Your cloud garden changed since you opened this, so nothing was imported. Review the latest comparison and confirm again.";
    case "browser-changed":
      return "The garden in this browser changed since you opened this, so nothing was imported. Review the latest comparison and confirm again.";
    case "browser-empty":
      return "There's no garden saved in this browser to import.";
    case "browser-unreadable":
      return "The garden in this browser couldn't be read safely, so it can't be imported. It hasn't been changed.";
    case "browser-newer-version":
      return "The garden in this browser was saved by a newer version of Plantetary. Refresh the page to update, then try again.";
    case "no-progress":
      return "The garden in this browser only has the starter quests, so there's nothing to bring over yet.";
  }
}

/** Refusals where the gardens moved on under an open confirmation: show a fresh comparison, ask again. */
export function needsFreshReview(outcome: BrowserImportOutcome): boolean {
  return outcome.status === "refused" && (outcome.reason === "stale" || outcome.reason === "browser-changed");
}

export type ImportMessage = {
  /** A generic cancellation contains no account data and survives the intermediate auth-loading state. */
  accountIndependent?: true;
  tone: "success" | "info" | "warning" | "error";
  title: string;
  message: string;
};

function describeImportProblem(problem: GameStorageProblem): string {
  if (problem === "network") return "Plantetary couldn't reach the server.";
  if (problem === "server-outdated") return "Importing isn't set up on the server yet.";
  return describeSaveProblem(problem);
}

/**
 * What to tell the player after an import, a verification or a retry. Null for `unresolved`, which has
 * its own card with the ways forward. `replacing`: whether the account had a cloud garden before.
 */
export function describeImportOutcome(outcome: BrowserImportOutcome, replacing: boolean): ImportMessage | null {
  switch (outcome.status) {
    case "imported":
      return {
        tone: "success",
        title: "Your browser garden is now your cloud garden",
        message: replacing
          ? "Your previous cloud garden was backed up in your account first. The garden in this browser hasn't changed."
          : "It's saved to your account. The garden in this browser hasn't changed.",
      };
    case "unchanged":
      return {
        tone: "info",
        title: "Your cloud garden already matches this browser",
        message: "They were already the same, so nothing needed replacing.",
      };
    case "conflict":
      return {
        tone: "warning",
        title: "Your cloud garden changed somewhere else",
        message: "Newer cloud progress was protected. Review the current cloud garden before confirming another import.",
      };
    case "backup-failed":
      return {
        tone: "error",
        title: "Nothing was imported",
        message: "Plantetary couldn't back up your cloud garden first, so it left it as it was. Try again in a moment.",
      };
    case "failed":
      return {
        tone: "error",
        title: "The import didn't go through",
        message: `${describeImportProblem(outcome.problem)} Nothing was imported. The garden in this browser hasn't changed.`,
      };
    case "refused":
      return { tone: needsFreshReview(outcome) ? "warning" : "info", title: "Nothing was imported", message: describeImportRefusal(outcome.reason) };
    case "cancelled":
      return describeCancelledImport("importing");
    case "unresolved":
      return null;
  }
}

/**
 * What to tell the player when the account changes (or they sign out) part-way through. Generic, with no
 * account data, so it can stay on screen for whoever is signed in next.
 * - `confirming`: the confirmation was still open, so nothing was sent.
 * - `importing`: the import had been sent. The server may still have applied it, but only to the account
 *   that started it (the request carries that account's ID and token), after backing up its cloud garden.
 */
export function describeCancelledImport(stage: "confirming" | "importing"): ImportMessage {
  return stage === "confirming"
    ? {
      accountIndependent: true,
      tone: "info",
      title: "Import cancelled",
      message: "The signed-in account changed before the import was confirmed, so nothing was imported. Nothing was added to any account.",
    }
    : {
      accountIndependent: true,
      tone: "info",
      title: "Import interrupted",
      message: "The signed-in account changed before the import finished, so this page stopped following it. " +
        "It may still have completed in the account that started it; if so, that account's previous cloud garden was backed up first. " +
        "Nothing was added to any other account, and the garden in this browser hasn't changed.",
    };
}

/** Why an import's outcome isn't known yet, for the unresolved-import card. */
export function describeUnresolvedImport(problem: GameStorageProblem, canRetry: boolean): string {
  const why = problem === "network" ? "the connection dropped before the server answered" : "the server's answer didn't come through";
  const next = canRetry
    ? "At the last check, your cloud garden was unchanged. You can retry the same import; newer cloud progress will be protected."
    : "Check your cloud garden once you're back online to see whether it finished.";
  return `Plantetary sent your browser garden, but ${why}. To keep both gardens safe, nothing is shown or saved until this is settled. The garden in this browser hasn't changed. ${next}`;
}

/** A completion date key ("2026-10-19") for display, or a friendly placeholder. */
export function formatActivityDate(dateKey: string | null): string {
  if (!dateKey) return "Not recorded";
  return dateFromKey(dateKey).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** "Level 3 · 240 XP" and similar, for screen readers and the summary cards. */
export function describeGardenSummary(summary: BrowserGardenSummary): string {
  const quests = `${summary.quests.total} ${summary.quests.total === 1 ? "quest" : "quests"}`;
  const plants = `${summary.plants.discovered} ${summary.plants.discovered === 1 ? "plant" : "plants"}`;
  return `Level ${summary.level}, ${summary.totalXp} XP, ${quests}, ${plants}, last active ${formatActivityDate(summary.lastActivityDate)}`;
}

/** What an open confirmation was made for: the garden on screen and the account it belongs to. */
export type ConfirmationScope = { generation: number; accountId: string };

/**
 * Whether an open confirmation still applies. Any new garden on screen (an account change, signing out,
 * a reload) or a different account means it doesn't: it must close, and nothing from it may be shown or
 * imported for whoever is here now.
 */
export function isConfirmationCurrent(scope: ConfirmationScope, storage: StorageControllerSnapshot): boolean {
  return storage.mode === "cloud" && storage.account?.id === scope.accountId &&
    storage.generation === scope.generation && (storage.phase === "ready" || storage.phase === "choose");
}
