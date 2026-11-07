"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "./auth/auth-provider";
import { inspectBrowserGarden, summarizeGarden, type BrowserGardenSummary, type BrowserSavePreview } from "./browser-save-preview";
import { downloadText } from "./download-file";
import type { BrowserImportPlan } from "./game-storage-controller";
import {
  browserImportAvailability,
  describeGardenSummary,
  describeImportOutcome,
  describeImportRefusal,
  formatActivityDate,
  isConfirmationCurrent,
  needsFreshReview,
  type BrowserImportAvailability,
  type ConfirmationScope,
  type ImportMessage,
} from "./import-flow";
import { getLocalDateKey } from "./quest-logic";
import { useQuestStore } from "./quest-store";

/**
 * The guest-to-cloud import flow (Stage 8 Step 4): the confirmation dialog, the result message, and the
 * read-only preview of this browser's garden that the first-time card and Settings use to decide whether
 * to offer importing. The controller (Step 3) does the work and every safety check; this only asks,
 * explains and reports.
 */

type Flow =
  | { step: "closed" }
  | { step: "preparing"; scope: ConfirmationScope; token: number }
  | {
    step: "confirm";
    scope: ConfirmationScope;
    plan: BrowserImportPlan;
    cloud: BrowserGardenSummary | null;
    /** The gardens moved on under an earlier confirmation, so this is a fresh one. */
    refreshed: boolean;
  }
  | { step: "importing"; replacing: boolean; scope: ConfirmationScope };

type UnresolvedAction = "verify" | "retry" | "leave";

type ImportFlowValue = {
  result: (ImportMessage & { id: number; accountId: string | null | undefined }) | null;
  dismissResult: () => void;
  /** This browser's garden, read without writing, or null before it's been read. */
  browserPreview: BrowserSavePreview | null;
  availability: BrowserImportAvailability;
  /** Opens the comparison for the cloud account on screen. Prepares the plan now, so its revision is current. */
  openImport: () => void;
  /** An import, verification or retry is running, or the dialog is open. */
  busy: boolean;
  /** For the unresolved-import card. */
  settleUnresolved: (action: UnresolvedAction) => void;
};

const ImportFlowContext = createContext<ImportFlowValue | null>(null);

export function useImportFlow(): ImportFlowValue {
  const value = useContext(ImportFlowContext);
  if (!value) throw new Error("useImportFlow must be used within ImportFlowProvider");
  return value;
}

/** A garden's summary: level, XP, quests, plants and last activity. */
export function GardenSummaryCard({ title, summary, emptyText }: { title: string; summary: BrowserGardenSummary | null; emptyText: string }) {
  return (
    <div className="garden-summary" role="group" aria-label={summary ? `${title}: ${describeGardenSummary(summary)}` : `${title}: ${emptyText}`}>
      <p className="garden-summary-title">{title}</p>
      {summary ? (
        <dl aria-hidden="true">
          <div><dt>Level</dt><dd>{summary.level}</dd></div>
          <div><dt>XP</dt><dd>{summary.totalXp}</dd></div>
          <div><dt>Quests</dt><dd>{summary.quests.total}</dd></div>
          <div><dt>Plants</dt><dd>{summary.plants.discovered}</dd></div>
          <div className="garden-summary-wide"><dt>Last active</dt><dd>{formatActivityDate(summary.lastActivityDate)}</dd></div>
        </dl>
      ) : (
        <p className="garden-summary-empty" aria-hidden="true">{emptyText}</p>
      )}
    </div>
  );
}

export function ImportFlowProvider({ children }: { children: ReactNode }) {
  const { storage, storageActions, getDataForExport } = useQuestStore();
  const { auth } = useAuth();
  const accountId = auth.status === "signed-in" ? auth.user.id : null;
  const accountRef = useRef(accountId);
  const [browserPreview, setBrowserPreview] = useState<BrowserSavePreview | null>(null);
  const [flow, setFlow] = useState<Flow>({ step: "closed" });
  const [result, setResult] = useState<(ImportMessage & { id: number; accountId: string | null | undefined }) | null>(null);
  const [settlingAccount, setSettlingAccount] = useState<string | null>(null);
  const settling = settlingAccount !== null && settlingAccount === accountId;
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const downloadToken = useRef(0);
  const activeOperation = useRef(0);
  const nextToken = useRef(1);
  /** The preparation whose answer may still be shown; 0 once it's cancelled or replaced. */
  const activePreparation = useRef(0);
  const nextResultId = useRef(1);
  /** Whether the import being settled replaced an existing cloud garden, for its result message. */
  const replacingRef = useRef(false);
  /** Where focus was before the dialog opened, to return it on Cancel. */
  const openerRef = useRef<HTMLElement | null>(null);
  /**
   * Where focus goes once the dialog has closed: back to what opened it, to the result message, or to the
   * unresolved-import card. Moved by the effect below, after the dialog's own close, when the page behind
   * it is no longer inert and its buttons are enabled again.
   */
  const pendingFocus = useRef<"opener" | "result" | "unresolved" | null>(null);
  const storageRef = useRef(storage);
  useLayoutEffect(() => {
    storageRef.current = storage;
    accountRef.current = accountId;
  }, [storage, accountId]);

  // Read again whenever a different garden is shown (a sign-in, an import, a reload) or another tab
  // changes this browser's storage. Never written.
  useEffect(() => {
    const read = () => setBrowserPreview(inspectBrowserGarden());
    read();
    window.addEventListener("storage", read);
    return () => window.removeEventListener("storage", read);
  }, [storage.generation]);

  const show = useCallback((message: ImportMessage | null) => {
    setResult(message ? { ...message, id: nextResultId.current++, accountId: message.accountIndependent ? undefined : accountRef.current } : null);
  }, []);

  const close = useCallback((message: ImportMessage | null, returnFocus = false) => {
    activePreparation.current = 0;
    activeOperation.current = 0;
    downloadToken.current += 1;
    setDownloading(false);
    setDownloadError(null);
    setSettlingAccount(null);
    setFlow({ step: "closed" });
    show(message);
    pendingFocus.current = message ? "result" : returnFocus ? "opener" : null;
  }, [show]);

  /** Prepares a plan for the account on screen and shows the comparison. */
  const prepare = useCallback(async (scope: ConfirmationScope, refreshed: boolean) => {
    const token = nextToken.current++;
    activeOperation.current = 0;
    downloadToken.current += 1;
    setDownloading(false);
    setDownloadError(null);
    activePreparation.current = token;
    setFlow({ step: "preparing", scope, token });
    const preparation = await storageActions.prepareBrowserImport();
    // Cancelled, or replaced by a newer preparation, while it ran: its answer is never shown.
    if (activePreparation.current !== token) return;
    activePreparation.current = 0;
    if (preparation.status !== "ready") {
      close({ tone: "info", title: "Importing isn't available right now", message: describeImportRefusal(preparation.reason) }, true);
      return;
    }
    const now = storageRef.current;
    if (accountRef.current !== scope.accountId || !isConfirmationCurrent(scope, now)) {
      close(describeImportOutcome({ status: "cancelled" }, false), true);
      return;
    }
    // The cloud garden on screen is this account's, just saved by the preparation. Never shown when the
    // account has none yet: there's nothing of anyone's to compare.
    const cloud = now.phase === "ready" && preparation.plan.expectedRevision !== null ? summarizeGarden(getDataForExport()) : null;
    setFlow({ step: "confirm", scope, plan: preparation.plan, cloud, refreshed });
  }, [storageActions, close, getDataForExport]);

  const openImport = useCallback(() => {
    const now = storageRef.current;
    const stillOpen = (flow.step === "preparing" || flow.step === "confirm") ? isConfirmationCurrent(flow.scope, now) : flow.step !== "closed";
    if (stillOpen || settling || now.mode !== "cloud" || !now.account || accountRef.current !== now.account.id) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    show(null);
    void prepare({ generation: now.generation, accountId: now.account.id }, false);
  }, [flow, settling, prepare, show]);

  // An account change, signing out, or any new garden on screen ends an open confirmation at once.
  // Worked out on every render, so a stale confirmation is never shown, not even for one frame.
  const confirmationLost = (flow.step === "preparing" || flow.step === "confirm") &&
    (accountId !== flow.scope.accountId || !isConfirmationCurrent(flow.scope, storage));
  const workLost = flow.step === "importing" && flow.scope.accountId !== accountId;
  const scopeLost = confirmationLost || workLost;
  const shownFlow: Flow = scopeLost ? { step: "closed" } : flow;
  const shownResult = scopeLost
    ? { ...describeImportOutcome({ status: "cancelled" }, false)!, id: 0, accountId }
    : result && (result.accountId === undefined || result.accountId === accountId) ? result : null;

  function dismissResult() {
    close(null);
  }

  async function confirm() {
    if (shownFlow.step !== "confirm" || downloading || activeOperation.current) return;
    const { plan, scope } = shownFlow;
    const token = nextToken.current++;
    activeOperation.current = token;
    downloadToken.current += 1;
    const replacing = plan.expectedRevision !== null;
    replacingRef.current = replacing;
    setFlow({ step: "importing", replacing, scope });
    const outcome = await storageActions.importBrowserGarden(plan);
    if (activeOperation.current !== token || accountRef.current !== scope.accountId) return;
    activeOperation.current = 0;
    if (needsFreshReview(outcome)) {
      // The gardens moved on: show the current comparison and ask again. Never imported unconfirmed.
      const now = storageRef.current;
      if (now.account?.id === scope.accountId) {
        await prepare({ generation: now.generation, accountId: scope.accountId }, true);
        return;
      }
    }
    if (outcome.status === "unresolved") {
      // The unresolved-import card (storage-notices.tsx) takes over, with its ways forward.
      close(null);
      pendingFocus.current = "unresolved";
      return;
    }
    close(describeImportOutcome(outcome, replacing));
  }

  async function downloadCloudGarden() {
    // Only this account's cloud garden, while it's the one on screen.
    if (shownFlow.step !== "confirm" || downloading || !shownFlow.cloud ||
      accountRef.current !== shownFlow.scope.accountId || !isConfirmationCurrent(shownFlow.scope, storageRef.current)) return;
    const scope = shownFlow.scope;
    const token = ++downloadToken.current;
    setDownloading(true);
    setDownloadError(null);
    try {
      const snapshot = await storageActions.readCloudGardenForDownload();
      if (downloadToken.current !== token || accountRef.current !== scope.accountId ||
        !isConfirmationCurrent(scope, storageRef.current)) return;
      if (snapshot.status !== "ready") {
        setDownloadError("Your cloud garden couldn't be downloaded. Nothing was changed. Try again when you're connected.");
        return;
      }
      const exportedAt = new Date();
      // A cloud-only safety copy: never substitute React's older display data or local preferences.
      const json = JSON.stringify({ app: "Plantetary", exportVersion: 1, exportedAt: exportedAt.toISOString(),
        questData: snapshot.data, cloudRevision: snapshot.revision, schemaVersion: snapshot.schemaVersion }, null, 2);
      downloadText(json, `plantetary-cloud-garden-${getLocalDateKey(exportedAt)}.json`);
    } catch {
      if (downloadToken.current === token) setDownloadError("Your cloud garden couldn't be downloaded. Nothing was changed.");
    } finally {
      if (downloadToken.current === token) setDownloading(false);
    }
  }

  const settleUnresolved = useCallback((action: UnresolvedAction) => {
    if (settling || (activeOperation.current && settlingAccount === accountRef.current) || !accountRef.current) return;
    if (action === "leave") {
      if (storageActions.leaveUnresolvedImport()) {
        show({
          tone: "info",
          title: "Loading your cloud garden",
          message: "Plantetary stopped waiting and is loading your cloud garden. If the import finishes after this garden loads, a later save will detect the changed revision instead of overwriting it.",
        });
        pendingFocus.current = "result";
      }
      return;
    }
    const owner = accountRef.current;
    const token = nextToken.current++;
    activeOperation.current = token;
    setSettlingAccount(owner);
    show(null);
    const run = action === "verify" ? storageActions.verifyBrowserImport : storageActions.retryBrowserImport;
    void run().then((outcome) => {
      if (activeOperation.current !== token || accountRef.current !== owner) return;
      activeOperation.current = 0;
      setSettlingAccount(null);
      if (outcome.status === "unresolved") {
        show({
          tone: "warning",
          title: action === "verify" ? "Still couldn't confirm the import" : "The retry couldn't be confirmed either",
          message: "Gameplay and local cloud saves remain paused. The original import may still finish on the server. Check again when your connection is steady.",
        });
        pendingFocus.current = "unresolved";
        return;
      }
      show(describeImportOutcome(outcome, replacingRef.current));
      pendingFocus.current = "result";
    });
  }, [settling, settlingAccount, storageActions, show]);

  // After every render, children's effects (the dialog closing) have run first. Waits until the target
  // exists, for example the unresolved-import card, which appears with the controller's next update.
  useEffect(() => {
    if (!pendingFocus.current || shownFlow.step !== "closed" || scopeLost) return;
    let target = pendingFocus.current === "opener"
      ? openerRef.current
      : document.getElementById(pendingFocus.current === "result" ? "import-result-heading" : "import-unresolved-heading");
    if (pendingFocus.current === "opener" && !target?.isConnected) {
      // The flow survives route changes, but the button that opened it may no longer exist.
      target = document.querySelector<HTMLElement>('.nav-link.is-active, main button:not([disabled]), main a[href]');
    }
    if (!target || (target instanceof HTMLButtonElement && target.disabled)) return;
    target.focus();
    pendingFocus.current = null;
  });

  const availability = browserImportAvailability(browserPreview);
  const value: ImportFlowValue = {
    result: shownResult,
    dismissResult,
    browserPreview,
    availability,
    openImport,
    busy: shownFlow.step !== "closed" || settling,
    settleUnresolved,
  };

  return (
    <ImportFlowContext.Provider value={value}>
      <ImportDialog
        flow={shownFlow}
        browser={availability.summary}
        onCancel={() => close(null, true)}
        onClosed={() => { if (scopeLost) close(describeImportOutcome({ status: "cancelled" }, false), true); }}
        onConfirm={() => void confirm()}
        onDownload={() => void downloadCloudGarden()}
        downloading={downloading}
        downloadError={downloadError}
      />
      {children}
    </ImportFlowContext.Provider>
  );
}

/** Render the persistent flow's result inside the current page's workspace. */
export function ImportResult() {
  const { result, dismissResult } = useImportFlow();
  return result ? <ImportResultNotice key={result.id} result={result} onDismiss={dismissResult} /> : null;
}

/** The outcome, focused when it appears (see the provider), so keyboard and screen-reader users land on it. */
function ImportResultNotice({ result, onDismiss }: { result: ImportMessage; onDismiss: () => void }) {
  const urgent = result.tone === "error" || result.tone === "warning";
  return (
    <section className={`settings-section storage-notice import-result is-${result.tone}`} aria-labelledby="import-result-heading">
      <h2 id="import-result-heading" tabIndex={-1}>{result.title}</h2>
      <p className="settings-description" role={urgent ? "alert" : "status"}>{result.message}</p>
      <div className="storage-notice-actions">
        <button className="settings-action-button" type="button" onClick={onDismiss}>Dismiss</button>
      </div>
    </section>
  );
}

function ImportDialog({ flow, browser, onCancel, onClosed, onConfirm, onDownload, downloading, downloadError }: {
  onClosed: () => void;
  downloading: boolean;
  downloadError: string | null;
  flow: Flow;
  browser: BrowserGardenSummary | null;
  onCancel: () => void;
  onConfirm: () => void;
  onDownload: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const progressRef = useRef<HTMLHeadingElement>(null);
  const open = flow.step !== "closed";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // Modal: the page behind is inert, and focus stays in the dialog until it closes.
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Cancel is the default: it's focused whenever a comparison appears, so Enter or Space cancels.
  const shownPlan = flow.step === "confirm" ? flow.plan.planId : null;
  useEffect(() => {
    if (shownPlan !== null) cancelRef.current?.focus();
  }, [shownPlan]);

  useEffect(() => {
    if (flow.step === "importing") progressRef.current?.focus();
  }, [flow.step]);

  const replacing = flow.step === "confirm" ? flow.plan.expectedRevision !== null : flow.step === "importing" && flow.replacing;
  const summary = flow.step === "confirm" ? flow.plan.summary : browser;

  return (
    <dialog
      ref={dialogRef}
      className="import-dialog"
      aria-labelledby="import-dialog-title"
      aria-describedby="import-dialog-description"
      onClose={onClosed}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )).filter((element) => element.getClientRects().length > 0);
        const first = elements[0];
        const last = elements.at(-1);
        if (!first || !last) {
          event.preventDefault();
          progressRef.current?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        // Escape cancels, except while importing, which can't be stopped halfway.
        event.preventDefault();
        if (flow.step === "confirm" || flow.step === "preparing") onCancel();
      }}
    >
      {flow.step === "preparing" && (
        <>
          <h2 id="import-dialog-title">Getting your gardens ready…</h2>
          <p id="import-dialog-description" className="settings-description" role="status">
            Saving any waiting changes and reading the garden in this browser. Nothing is imported yet.
          </p>
          <div className="storage-notice-actions">
            <button ref={cancelRef} className="settings-action-button" type="button" onClick={onCancel}>Cancel</button>
          </div>
        </>
      )}

      {flow.step === "importing" && (
        <>
          <h2 id="import-dialog-title" ref={progressRef} tabIndex={-1}>Importing your browser garden…</h2>
          <p id="import-dialog-description" className="settings-description" role="status">
            Please keep this page open. This usually takes a moment.
          </p>
        </>
      )}

      {flow.step === "confirm" && (
        <>
          <h2 id="import-dialog-title">
            {replacing ? "Replace your cloud garden with this browser's garden?" : "Bring this browser's garden to your account?"}
          </h2>
          {flow.refreshed && (
            <p className="settings-message is-error" role="alert">
              Your gardens changed since you opened this. Here&apos;s the latest comparison: take a look and confirm again.
            </p>
          )}
          <div id="import-dialog-description">
            <ul className="import-facts">
              {replacing ? (
                <>
                  <li>Importing <strong>replaces</strong> your cloud garden with the one in this browser. The two aren&apos;t merged.</li>
                  <li>A backup copy of your current cloud garden is kept in your account first.</li>
                </>
              ) : (
                <li>The garden in this browser becomes your cloud garden, saved to your account.</li>
              )}
              <li>The garden in this browser stays exactly as it is.</li>
            </ul>
          </div>
          <div className="import-comparison">
            <GardenSummaryCard title="This browser" summary={summary} emptyText="No garden" />
            <span className="import-comparison-arrow" aria-hidden="true">→</span>
            <GardenSummaryCard
              title="Your account"
              summary={flow.cloud}
              emptyText={replacing ? "Couldn't summarize" : "No cloud garden yet"}
            />
          </div>
          {replacing && flow.cloud && (
            <p className="settings-description import-download">
              Want your own copy too?{" "}
              <button className="import-link-button" type="button" disabled={downloading} onClick={onDownload}>
                {downloading ? "Downloading…" : "Download your cloud garden"}
              </button>
              {" "}as a file before replacing it.
            </p>
          )}
          {downloadError && <p className="settings-message is-error" role="alert">{downloadError}</p>}
          <div className="storage-notice-actions import-dialog-actions">
            <button ref={cancelRef} className="settings-action-button" type="button" onClick={onCancel}>Cancel</button>
            <button className="settings-reset-button" type="button" disabled={downloading} onClick={onConfirm}>
              {replacing ? "Replace my cloud garden" : "Import my browser garden"}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
