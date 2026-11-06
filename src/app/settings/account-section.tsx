"use client";

import { useState, type FormEvent } from "react";
import { useAuth } from "../auth/auth-provider";
import { authProblemMessages } from "../auth/auth-session";

const progressNote = "Your quests, XP, streaks and plants stay saved in this browser, exactly as they are now. Signing in or out doesn't move, upload or reset them.";

export default function AccountSection() {
  const { auth, sendMagicLink, signOut } = useAuth();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  function show(text: string, error: boolean) {
    setMessage(text);
    setIsError(error);
  }

  async function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    show("", false);
    const result = await sendMagicLink(email);
    setBusy(false);
    if (result.ok) {
      show(`Check your inbox at ${result.email}. The sign-in link works once and expires after an hour.`, false);
    } else {
      show(authProblemMessages[result.problem], true);
    }
  }

  async function submitSignOut() {
    setBusy(true);
    show("", false);
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
                <button className="settings-action-button" type="submit">
                  {busy ? "Sending…" : "Email me a sign-in link"}
                </button>
              </div>
            </fieldset>
          </form>
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

      {auth.status === "signed-in" && (
        <>
          <p className="settings-description">
            Signed in as <strong className="account-email">{auth.user.email ?? "your account"}</strong>. {progressNote}
          </p>
          <div className="settings-form-row">
            <span />
            <button className="settings-reset-button" type="button" disabled={busy} onClick={submitSignOut}>
              {busy ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </>
      )}

      <p className={`settings-message${isError ? " is-error" : ""}`} role="status" aria-live="polite">{message}</p>
    </section>
  );
}
