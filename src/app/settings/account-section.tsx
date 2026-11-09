"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth, type AuthState } from "../auth/auth-provider";
import { ageAcknowledgmentText, authProblemMessages } from "../auth/auth-session";
import type { SaveSnapshot } from "../game-data-session";
import type { AccountChangeTicket } from "../game-storage-controller";
import { useQuestStore } from "../quest-store";
import { describeUnsavedChanges } from "../storage-messages";
import CloudImportSection from "./cloud-import-section";

const progressNote = "Your quests, XP, streaks and plants stay saved in this browser, exactly as they are now. Signing in or out doesn't move, upload or reset them.";
const cloudNote = "Your quests, XP, streaks and plants are saved to your account. The progress saved in this browser stays here, unchanged, and isn't uploaded.";
const deviceNote = "You chose to keep playing with the progress saved in this browser, so nothing is saved to your account.";

/** Who's signed in, as far as signing out is concerned. A different value means a different account or state. */
function identityKey(auth: AuthState): string {
  if (auth.status === "signed-in") return `signed-in:${auth.user.id}`;
  if (auth.status === "unverified" || auth.status === "session-ended") return `${auth.status}:${auth.user.email ?? ""}`;
  return auth.status;
}

/** A sign-out warning, tied to the session and identity whose unsaved changes it shows. */
type SignOutWarning = { ticket: AccountChangeTicket | null; save: SaveSnapshot | null; identity: string };
/** Asked before signing out while an import's outcome isn't confirmed, for that session and identity. */
type UnresolvedImportWarning = { ticket: AccountChangeTicket | null; identity: string };

const accountChangedMessage = "Your account changed in the meantime, so signing out was cancelled. Nothing was signed out.";

export default function AccountSection() {
  const { auth, sendMagicLink, signOut } = useAuth();
  const { storage, storageActions } = useQuestStore();
  const [email, setEmail] = useState("");
  /** The 13+ acknowledgment for this request only. Never stored or sent anywhere. */
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [ageMissing, setAgeMissing] = useState(false);
  const ageCheckboxRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  /** Set when signing out would leave changes unsaved; the player decides what happens next. */
  const [unsavedWarning, setUnsavedWarning] = useState<SignOutWarning | null>(null);
  /** Set when signing out while an import is unresolved; the player decides what happens next. */
  const [importWarning, setImportWarning] = useState<UnresolvedImportWarning | null>(null);
  const identity = identityKey(auth);
  // The newest identity, for async steps that must not act on an account that has changed since.
  const identityRef = useRef(identity);
  // The newest storage phase, read after the save check below has finished.
  const phaseRef = useRef(storage.phase);
  useEffect(() => {
    identityRef.current = identity;
    phaseRef.current = storage.phase;
  }, [identity, storage.phase]);
  // Recomputed on every render: an account or session change anywhere invalidates the warning at once.
  const warningIsCurrent = unsavedWarning !== null &&
    unsavedWarning.identity === identity &&
    storageActions.isTicketCurrent(unsavedWarning.ticket);
  // Only while that import is still unresolved: once it's settled (or anything else changed), the question
  // no longer applies and isn't shown. Signing out again asks again if needed.
  const importWarningIsCurrent = importWarning !== null &&
    importWarning.identity === identity &&
    storage.phase === "import-unresolved" &&
    storageActions.isTicketCurrent(importWarning.ticket);

  const signOutRef = useRef<HTMLButtonElement>(null);
  /** The open prompt's Cancel: the safe choice, focused when a prompt opens. Only one prompt shows at a time. */
  const promptCancelRef = useRef<HTMLButtonElement>(null);
  /**
   * Where focus goes after the next render: into a prompt that just opened (Sign out is disabled while it
   * shows, so focus would otherwise be lost), or back to Sign out after Cancel. Waits until the target
   * exists and is enabled, as in import-flow-provider.tsx.
   */
  const pendingFocus = useRef<"prompt" | "sign-out" | null>(null);
  useEffect(() => {
    const target = pendingFocus.current === "prompt" ? promptCancelRef.current
      : pendingFocus.current === "sign-out" ? signOutRef.current
        : null;
    if (!target || target.disabled) return;
    target.focus();
    pendingFocus.current = null;
  });

  function show(text: string, error: boolean) {
    setMessage(text);
    setIsError(error);
  }

  async function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // No link (and so no account) until the player confirms they're at least 13.
    if (!ageConfirmed) {
      show("", false);
      setAgeMissing(true);
      ageCheckboxRef.current?.focus();
      return;
    }
    setBusy(true);
    show("", false);
    const result = await sendMagicLink(email, ageConfirmed);
    setBusy(false);
    if (result.ok) {
      show(`Check your inbox at ${result.email}. The sign-in link works once and expires after an hour.`, false);
    } else {
      show(authProblemMessages[result.problem], true);
    }
  }

  /** Signs out only if `ticket` and `forIdentity` still describe what's signed in now. */
  async function finishSignOut(ticket: AccountChangeTicket | null, forIdentity: string) {
    if (identityRef.current !== forIdentity || !storageActions.isTicketCurrent(ticket)) {
      setBusy(false);
      show(accountChangedMessage, true);
      return;
    }
    const result = await signOut();
    setBusy(false);
    if (!result.ok) {
      show(`Plantetary couldn't sign you out. ${authProblemMessages[result.problem]}`, true);
    } else if (result.warning) {
      show("You're signed out on this device. Plantetary couldn't reach the server to end the session there, so it will expire on its own.", false);
    } else {
      show("You're signed out. Your progress on this device is unchanged.", false);
    }
  }

  /** Saves anything waiting first, and only signs out straight away if nothing is left unsaved. */
  async function submitSignOut() {
    const forIdentity = identityRef.current;
    setBusy(true);
    setUnsavedWarning(null);
    setImportWarning(null);
    show("", false);
    const { outcome, ticket, save } = await storageActions.prepareForAccountChange();
    // Saving took a moment; if the account or session changed meanwhile, this sign-out no longer applies.
    if (outcome === "stale" || identityRef.current !== forIdentity) {
      setBusy(false);
      show(accountChangedMessage, true);
      return;
    }
    if (outcome === "unsaved") {
      setBusy(false);
      setUnsavedWarning({ ticket, save, identity: forIdentity });
      pendingFocus.current = "prompt";
      return;
    }
    if (phaseRef.current === "import-unresolved") {
      setBusy(false);
      setImportWarning({ ticket, identity: forIdentity });
      pendingFocus.current = "prompt";
      return;
    }
    await finishSignOut(ticket, forIdentity);
  }

  async function signOutDespiteImport() {
    const warning = importWarning;
    setImportWarning(null);
    if (!warning || !importWarningIsCurrent) return;
    setBusy(true);
    await finishSignOut(warning.ticket, warning.identity);
  }

  function keepImportAndStay() {
    setImportWarning(null);
    pendingFocus.current = "sign-out";
    show("You're still signed in. Nothing was changed.", false);
  }

  async function retryThenSignOut() {
    if (!unsavedWarning || !warningIsCurrent) return;
    storageActions.retrySave();
    await submitSignOut();
  }

  async function signOutAnyway() {
    const warning = unsavedWarning;
    setUnsavedWarning(null);
    // Only for the session and account whose unsaved changes the warning showed. The player chose to
    // leave those exact changes behind, so they aren't offered again afterwards.
    if (!warning || warning.identity !== identityRef.current || !storageActions.acknowledgeUnsavedLoss(warning.ticket)) {
      show(accountChangedMessage, true);
      return;
    }
    setBusy(true);
    await finishSignOut(warning.ticket, warning.identity);
  }

  function cancelSignOut() {
    setUnsavedWarning(null);
    pendingFocus.current = "sign-out";
    show("You're still signed in. Nothing was changed.", false);
  }

  const signOutButton = (
    <div className="settings-form-row">
      <span />
      <button ref={signOutRef} className="settings-reset-button" type="button" disabled={busy || warningIsCurrent || importWarningIsCurrent} onClick={submitSignOut}>
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );

  const unsavedPrompt = unsavedWarning && !warningIsCurrent ? (
    <p className="settings-message is-error" role="alert">{accountChangedMessage}</p>
  ) : unsavedWarning && (
    <div
      className="storage-sign-out-warning"
      role="alertdialog"
      aria-labelledby="unsaved-sign-out-heading"
      onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.preventDefault(); cancelSignOut(); } }}
      aria-describedby="unsaved-sign-out-text"
      data-save-status={unsavedWarning.save?.status}
    >
      <p className="settings-message is-error" id="unsaved-sign-out-heading"><strong>Sign out with unsaved changes?</strong></p>
      <p className="settings-description" id="unsaved-sign-out-text">
        {describeUnsavedChanges(unsavedWarning.save)} If you sign out now, they&apos;ll be lost from this screen.
      </p>
      <div className="storage-notice-actions">
        {unsavedWarning.save?.status === "error" && (
          <button className="settings-action-button" type="button" disabled={busy} onClick={retryThenSignOut}>
            Try saving again
          </button>
        )}
        <button className="settings-reset-button" type="button" disabled={busy} onClick={signOutAnyway}>
          Sign out anyway
        </button>
        <button ref={promptCancelRef} className="settings-action-button" type="button" disabled={busy} onClick={cancelSignOut}>
          Cancel
        </button>
      </div>
    </div>
  );

  const importPrompt = importWarningIsCurrent && (
    <div
      className="storage-sign-out-warning"
      role="alertdialog"
      aria-labelledby="import-sign-out-heading"
      onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.preventDefault(); keepImportAndStay(); } }}
      aria-describedby="import-sign-out-text"
    >
      <p className="settings-message is-error" id="import-sign-out-heading"><strong>Sign out before your import is confirmed?</strong></p>
      <p className="settings-description" id="import-sign-out-text">
        Plantetary couldn&apos;t confirm whether your browser garden was imported into this account. If you sign out now, the
        import may still complete in this account, after backing up its previous cloud garden. Nothing goes to any other
        account, and the garden in this browser stays unchanged. To find out first, choose Cancel, then Check my cloud garden.
      </p>
      <div className="storage-notice-actions">
        <button className="settings-reset-button" type="button" disabled={busy} onClick={signOutDespiteImport}>
          Sign out anyway
        </button>
        <button ref={promptCancelRef} className="settings-action-button" type="button" disabled={busy} onClick={keepImportAndStay}>
          Cancel
        </button>
      </div>
    </div>
  );

  const playingOnDevice = storage.mode === "browser" && storage.account !== null;

  return (
    <section className="settings-section" aria-labelledby="settings-account-heading">
      <h2 id="settings-account-heading">Account</h2>

      {auth.status === "unavailable" && (
        <p className="settings-description">
          Sign-in isn&apos;t set up for this version of Plantetary. You can keep playing as a guest, and your progress stays saved in this browser.
        </p>
      )}

      {auth.status === "loading" && (
        <p className="settings-description" role="status">Checking whether you&apos;re signed in…</p>
      )}

      {(auth.status === "signed-out" || auth.status === "session-ended") && (
        <>
          {auth.status === "session-ended" ? (
            <p className="settings-description">
              Your sign-in for <strong className="account-email">{auth.user.email ?? "your account"}</strong> has ended, so
              you&apos;re playing as a guest. It&apos;s still stored in this browser until you sign in again or remove it. {progressNote}
            </p>
          ) : (
            <p className="settings-description">
              You&apos;re playing as a guest. An account is optional: enter your email and we&apos;ll send you a sign-in link, with no password needed. {progressNote}
            </p>
          )}
          {auth.status === "signed-out" && auth.sessionEnded && (
            <p className="settings-message is-error" role="status">Your sign-in had ended, so you&apos;re playing as a guest. Sign in again any time.</p>
          )}
          <form onSubmit={submitEmail} noValidate>
            <fieldset disabled={busy}>
              <div className="settings-form-row account-form-row">
                <label className="settings-field account-email-field" htmlFor="account-email">
                  Email address
                  <input
                    id="account-email"
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    maxLength={254}
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>
              </div>
              <div className="settings-form-row account-form-row account-age-row">
                <label className="account-age-confirmation" htmlFor="account-age-confirmed">
                  <input
                    ref={ageCheckboxRef}
                    id="account-age-confirmed"
                    type="checkbox"
                    checked={ageConfirmed}
                    aria-invalid={ageMissing || undefined}
                    aria-describedby={ageMissing ? "account-age-missing" : undefined}
                    onChange={(event) => {
                      setAgeConfirmed(event.target.checked);
                      if (event.target.checked) setAgeMissing(false);
                    }}
                  />
                  <span>{ageAcknowledgmentText}</span>
                </label>
                <button className="settings-action-button" type="submit">
                  {busy ? "Sending…" : "Email me a sign-in link"}
                </button>
              </div>
              {ageMissing && (
                <p className="settings-message is-error" id="account-age-missing" role="alert">
                  {authProblemMessages["age-not-confirmed"]}
                </p>
              )}
            </fieldset>
          </form>
          <p className="settings-description account-privacy-note">
            Signing in stores your email address with Supabase, and your garden too if you use a cloud garden.{" "}
            <Link className="text-link" href="/privacy">Read the Privacy Notice</Link>
          </p>
          {auth.status === "session-ended" && (
            <div className="settings-form-row">
              <span />
              <button className="settings-reset-button" type="button" disabled={busy} onClick={submitSignOut}>
                Remove it from this browser
              </button>
            </div>
          )}
        </>
      )}

      {auth.status === "unverified" && (
        <>
          <p className="settings-description">
            Plantetary couldn&apos;t confirm your sign-in for <strong className="account-email">{auth.user.email ?? "your account"}</strong> right
            now, usually because it can&apos;t reach the sign-in service. It will check again when you come back to this page or reload.
            Until then, you&apos;re playing with the progress saved in this browser, and nothing is saved to your account.
          </p>
          {signOutButton}
        </>
      )}

      {auth.status === "signed-in" && (
        <>
          <p className="settings-description">
            Signed in as <strong className="account-email">{auth.user.email ?? "your account"}</strong>. {playingOnDevice ? deviceNote : cloudNote}
          </p>
          {playingOnDevice && (
            <div className="settings-form-row">
              <span />
              <button className="settings-action-button" type="button" disabled={busy} onClick={storageActions.useCloudGarden}>
                Use my cloud garden instead
              </button>
            </div>
          )}
          {signOutButton}
          <CloudImportSection accountId={auth.user.id} />
        </>
      )}

      {unsavedPrompt}
      {importPrompt}

      <p className={`settings-message${isError ? " is-error" : ""}`} role="status" aria-live="polite">{message}</p>
    </section>
  );
}
