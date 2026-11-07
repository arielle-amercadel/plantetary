"use client";

import { useState } from "react";
import { downloadJson } from "./download-file";
import { describeUnresolvedImport } from "./import-flow";
import { GardenSummaryCard, useImportFlow } from "./import-flow-provider";
import { getLocalDateKey } from "./quest-logic";
import { useQuestStore } from "./quest-store";
import { describeCloudLoadProblem, describeConflictBackup, describeSaveProblem } from "./storage-messages";


const timeLabel = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const unsavedFileName = (at: number, suffix = "") =>
  `plantetary-unsaved-changes-${getLocalDateKey(new Date(at))}${suffix ? `-${suffix}` : ""}.json`;

/**
 * What the player must know or decide about where their garden is saved: the first-time cloud choice,
 * a cloud garden that couldn't load, a browser save that couldn't be read, a conflict, a save that keeps
 * failing, and changes left unsaved (when the account changed, or when this tab last left the page).
 * The save-status indicator in the top bar (save-status-indicator.tsx) shows where saving stands.
 */
export default function StorageNotices() {
  const { storage, storageActions, getDataForExport } = useQuestStore();
  const importFlow = useImportFlow();
  const [busy, setBusy] = useState(false);
  /** The generation whose conflict has the "Load latest garden?" confirmation open, so it never carries over. */
  const [confirmingGeneration, setConfirmingGeneration] = useState<number | null>(null);
  const save = storage.save;
  const inConflict = storage.phase === "ready" && save?.status === "conflict";
  const failingSave = storage.phase === "ready" && save?.status === "error" && save.nextRetryAt === null && save.hasUnsavedChanges
    ? save
    : null;
  const confirmingReload = inConflict && confirmingGeneration === storage.generation;
  /** After a load of the latest garden failed: the changes from before are only in the session now. */
  const unsavedBehindFailedLoad = storage.phase === "cloud-failed" && Boolean(save?.hasUnsavedChanges);

  /** The newest unsaved changes, or, if the session has none, the garden on screen. */
  function downloadUnsaved() {
    downloadJson(storageActions.getUnsavedData() ?? getDataForExport(), unsavedFileName(Date.now()));
  }

  /**
   * Asks the controller for the entry's changes at the moment of the click, so a notice drawn for one
   * account can never download anything once that account isn't the one signed in.
   */
  function downloadRecovery(id: string, closedAt: number) {
    const data = storageActions.getRecoveryData(id);
    if (data) downloadJson(data, unsavedFileName(closedAt, id));
  }

  async function loadLatest() {
    setConfirmingGeneration(null);
    await run(storageActions.reloadLatest);
  }

  function askToLoadLatest() {
    // Always asks while anything is unsaved, even after a download: changes made since then aren't in it.
    if (!save?.hasUnsavedChanges) {
      void loadLatest();
      return;
    }
    setConfirmingGeneration(storage.generation);
  }

  async function run(action: () => unknown) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {storage.phase === "choose" && (
        <section className="settings-section storage-notice" aria-labelledby="cloud-choice-heading">
          <h2 id="cloud-choice-heading">Start your cloud garden?</h2>
          <p className="settings-description">
            Your account doesn&apos;t have a saved garden yet. You can start a fresh garden saved to your account,
            {importFlow.availability.available ? " bring the garden saved in this browser to your account," : ""}
            {" "}or keep playing with the progress saved in this browser. Your progress in this browser stays here,
            unchanged, whichever you choose. Nothing from it is uploaded unless you choose to import it.
          </p>
          {importFlow.availability.available && (
            <GardenSummaryCard title="The garden in this browser" summary={importFlow.availability.summary} emptyText="No garden" />
          )}
          <div className="storage-notice-actions">
            {importFlow.availability.available && (
              <button className="settings-action-button storage-import-action" type="button" disabled={busy || importFlow.busy} onClick={importFlow.openImport}>
                Import my browser garden
              </button>
            )}
            <button className="settings-action-button" type="button" disabled={busy || importFlow.busy} onClick={() => run(storageActions.startFreshCloudGarden)}>
              Start a fresh cloud garden
            </button>
            <button className="settings-reset-button" type="button" disabled={busy || importFlow.busy} onClick={() => run(storageActions.keepPlayingOnDevice)}>
              Keep playing on this device
            </button>
          </div>
        </section>
      )}

      {storage.phase === "importing" && (
        <section className="settings-section storage-notice" aria-labelledby="import-progress-heading">
          <h2 id="import-progress-heading">Importing your browser garden…</h2>
          <p className="settings-description" role="status">
            Your garden will be back in a moment. Nothing can change it while this finishes, so nothing gets lost.
          </p>
        </section>
      )}

      {storage.phase === "import-unresolved" && storage.unresolvedImport && (
        <section className="settings-section storage-notice is-warning import-recovery" aria-labelledby="import-unresolved-heading">
          <h2 id="import-unresolved-heading" tabIndex={-1}>We couldn&apos;t confirm whether your import finished</h2>
          <p className="settings-description" role="alert">
            {describeUnresolvedImport(storage.unresolvedImport.problem, storage.unresolvedImport.canRetry)}
          </p>
          <div className="storage-notice-actions">
            <button className="settings-action-button" type="button" disabled={importFlow.busy} onClick={() => importFlow.settleUnresolved("verify")}>
              {importFlow.busy ? "Checking…" : "Check my cloud garden"}
            </button>
            {storage.unresolvedImport.canRetry && (
              <button className="settings-action-button" type="button" disabled={importFlow.busy} onClick={() => importFlow.settleUnresolved("retry")}>
                Try the same import again
              </button>
            )}
            <button className="settings-reset-button" type="button" disabled={importFlow.busy} onClick={() => importFlow.settleUnresolved("leave")}>
              Load my cloud garden without waiting
            </button>
          </div>
          <p className="settings-description import-fine-print">
            Loading without waiting is safe: if the import does finish later, your next save will notice and nothing will be overwritten.
          </p>
        </section>
      )}

      {storage.phase === "cloud-failed" && (
        <section className="settings-section storage-notice" aria-labelledby="cloud-failed-heading">
          <h2 id="cloud-failed-heading">Your cloud garden couldn&apos;t be loaded</h2>
          <p className="settings-description" role="alert">
            {describeCloudLoadProblem(storage.problem)} Nothing has been saved or changed in the meantime.
          </p>
          {unsavedBehindFailedLoad && (
            <p className="settings-description">
              Your changes from before haven&apos;t been saved. Download them to keep a copy: trying again loads the
              latest garden in their place.
            </p>
          )}
          <div className="storage-notice-actions">
            {unsavedBehindFailedLoad && (
              <button className="settings-action-button" type="button" onClick={downloadUnsaved}>
                Download unsaved changes
              </button>
            )}
            <button className="settings-action-button" type="button" disabled={busy} onClick={() => run(storageActions.retryLoad)}>
              {busy ? "Trying again…" : "Try again"}
            </button>
            <button className="settings-reset-button" type="button" disabled={busy} onClick={() => run(storageActions.keepPlayingOnDevice)}>
              Play on this device instead
            </button>
          </div>
        </section>
      )}

      {storage.phase === "ready" && storage.mode === "browser" && storage.loaded?.status === "failed" && (
        <p className="settings-message is-error storage-notice" role="alert">
          Plantetary couldn&apos;t safely read the progress saved in this browser, so changes won&apos;t be saved
          this visit. Your saved progress hasn&apos;t been changed.
        </p>
      )}

      {inConflict && save.status === "conflict" && (
        <section className="settings-section storage-notice is-warning" aria-labelledby="save-conflict-heading">
          <h2 id="save-conflict-heading">Your garden changed somewhere else</h2>
          <p className="settings-description" role="alert">
            Your garden was saved from another tab or device after this page loaded, so saving here has paused
            to keep from overwriting it.{" "}
            {save.hasUnsavedChanges
              ? <>Your latest changes on this page haven&apos;t been saved. {describeConflictBackup(save.backup)}</>
              : null}
          </p>
          <p className="settings-description">
            Download your changes to keep a copy, then load the latest garden to keep playing. Changes made here
            until then won&apos;t be saved.
          </p>
          {confirmingReload ? (
            <div
              className="storage-confirm"
              role="alertdialog"
              aria-labelledby="save-conflict-confirm-heading"
              aria-describedby="save-conflict-confirm-text"
            >
              <p className="settings-message is-error" id="save-conflict-confirm-heading"><strong>Load the latest garden?</strong></p>
              <p className="settings-description" id="save-conflict-confirm-text">
                Loading the version saved in your account replaces the garden on this page, including every
                change here that hasn&apos;t been saved. A copy you downloaded earlier doesn&apos;t include
                changes made since, so download again if you want to keep them all.
              </p>
              <div className="storage-notice-actions">
                <button className="settings-action-button" type="button" disabled={busy} onClick={downloadUnsaved}>
                  Download my changes
                </button>
                <button className="settings-reset-button" type="button" disabled={busy} onClick={() => void loadLatest()}>
                  Load latest anyway
                </button>
                <button className="settings-action-button" type="button" disabled={busy} onClick={() => setConfirmingGeneration(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="storage-notice-actions">
              {save.hasUnsavedChanges && (
                <button className="settings-action-button" type="button" disabled={busy} onClick={downloadUnsaved}>
                  Download my changes
                </button>
              )}
              <button className="settings-reset-button" type="button" disabled={busy} onClick={askToLoadLatest}>
                {busy ? "Loading…" : "Load latest garden"}
              </button>
            </div>
          )}
        </section>
      )}

      {failingSave && (
        <section className="settings-section storage-notice is-warning" aria-labelledby="save-failed-heading">
          <h2 id="save-failed-heading">Your latest changes haven&apos;t been saved</h2>
          <p className="settings-description" role="alert">
            {describeSaveProblem(failingSave.problem)} Your changes are still on this screen
            {storage.mode === "cloud" ? ", and your next change tries saving again" : ""}. Download them to keep a copy.
          </p>
          <div className="storage-notice-actions">
            <button className="settings-action-button" type="button" onClick={() => storageActions.retrySave()}>
              Try saving again
            </button>
            <button className="settings-reset-button" type="button" onClick={downloadUnsaved}>
              Download my changes
            </button>
          </div>
        </section>
      )}

      {storage.unsavedRecoveries.map((entry) => (
        <section key={entry.id} className="settings-section storage-notice" aria-labelledby={`${entry.id}-heading`}>
          <h2 id={`${entry.id}-heading`}>Some changes weren&apos;t saved</h2>
          {entry.reason === "page-left" ? (
            <p className="settings-description" role="alert">
              Your latest changes {entry.accountLabel ? <>for <strong>{entry.accountLabel}</strong></> : null} hadn&apos;t been saved
              when this page was closed or reloaded, at {timeLabel(entry.closedAt)}. They weren&apos;t added to your garden.
              Download them to keep a copy.
            </p>
          ) : (
            <p className="settings-description" role="alert">
              Your latest changes {entry.accountLabel ? <>for <strong>{entry.accountLabel}</strong></> : "in this browser"} couldn&apos;t
              be saved before saving stopped (the signed-in account changed, or couldn&apos;t be confirmed), at {timeLabel(entry.closedAt)}.
              They weren&apos;t added to any other garden. Download them to keep a copy.
            </p>
          )}
          <div className="storage-notice-actions">
            <button
              className="settings-action-button"
              type="button"
              onClick={() => downloadRecovery(entry.id, entry.closedAt)}
            >
              Download unsaved changes
            </button>
            <button className="settings-reset-button" type="button" onClick={() => storageActions.dismissUnsavedRecovery(entry.id)}>
              Dismiss
            </button>
          </div>
        </section>
      ))}
    </>
  );
}
