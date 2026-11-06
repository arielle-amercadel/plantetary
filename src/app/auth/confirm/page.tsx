"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import AppShell from "../../app-shell";
import {
  afterSignInPath,
  authConfirmPath,
  authProblemMessages,
  finishSignIn,
  parseConfirmLink,
  type AuthProblem,
  type ConfirmLink,
} from "../auth-session";
import { getSupabaseBrowserClient } from "../supabase-client";

type PageState =
  | { step: "reading" }
  | { step: "ready"; link: Extract<ConfirmLink, { kind: "token-hash" }> }
  | { step: "verifying" }
  | { step: "done" }
  | {
    step: "failed";
    problem: AuthProblem | "missing" | "unavailable";
    /** Kept when the link itself is still unused, so a dropped connection can be retried. */
    retry?: Extract<ConfirmLink, { kind: "token-hash" | "code" }>;
  };

const missingLinkMessage = "This page finishes signing in from an emailed link, but no link was found. Request one from Settings.";
const unavailableMessage = "Sign-in isn't set up for this version of Plantetary. You can keep playing as a guest.";

export default function AuthConfirmPage() {
  const router = useRouter();
  const [state, setState] = useState<PageState>({ step: "reading" });
  const started = useRef(false);

  async function finish(link: Extract<ConfirmLink, { kind: "token-hash" | "code" }>) {
    const client = getSupabaseBrowserClient();
    if (!client) {
      setState({ step: "failed", problem: "unavailable" });
      return;
    }
    setState({ step: "verifying" });
    const result = await finishSignIn(client.auth, link);
    if (result.ok) {
      setState({ step: "done" });
      router.replace(afterSignInPath);
    } else {
      setState({ step: "failed", problem: result.problem, retry: result.problem === "network" ? link : undefined });
    }
  }

  useEffect(() => {
    // Read once, even when React runs effects twice in development.
    if (started.current) return;
    started.current = true;

    const link = parseConfirmLink(window.location.search, window.location.hash);
    // Keep the one-time token out of the address bar and browser history.
    window.history.replaceState(null, "", authConfirmPath);

    queueMicrotask(() => {
      if (!getSupabaseBrowserClient()) setState({ step: "failed", problem: "unavailable" });
      else if (link.kind === "token-hash") setState({ step: "ready", link });
      // Supabase's default email has already used the token by the time the browser arrives here.
      else if (link.kind === "code") void finish(link);
      else if (link.kind === "error") setState({ step: "failed", problem: link.problem });
      else setState({ step: "failed", problem: "missing" });
    });
    // finish only uses stable values; this runs once per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AppShell page="settings">
      <main className="settings-content">
        <header className="settings-heading">
          <h1>Sign in</h1>
          <p>Finish signing in to Plantetary.</p>
        </header>

        <section className="settings-section auth-confirm" aria-labelledby="auth-confirm-heading" aria-busy={state.step === "reading" || state.step === "verifying"}>
          {(state.step === "reading" || state.step === "verifying") && (
            <>
              <h2 id="auth-confirm-heading">Checking your link</h2>
              <p className="settings-description" role="status">
                {state.step === "reading" ? "Reading your sign-in link…" : "Signing you in…"}
              </p>
            </>
          )}

          {state.step === "ready" && (
            <>
              <h2 id="auth-confirm-heading">Almost there</h2>
              <p className="settings-description">
                Press the button to finish signing in. Your progress in this browser stays exactly as it is.
              </p>
              <div className="settings-form-row">
                <span />
                <button className="settings-action-button" type="button" onClick={() => void finish(state.link)}>
                  Finish signing in
                </button>
              </div>
            </>
          )}

          {state.step === "done" && (
            <>
              <h2 id="auth-confirm-heading">You&apos;re signed in</h2>
              <p className="settings-description" role="status">Taking you back to Settings…</p>
            </>
          )}

          {state.step === "failed" && (
            <>
              <h2 id="auth-confirm-heading">
                {state.problem === "expired-link" ? "This link has expired" : "Sign-in didn't finish"}
              </h2>
              <p className="settings-message is-error" role="alert">
                {state.problem === "missing"
                  ? missingLinkMessage
                  : state.problem === "unavailable"
                    ? unavailableMessage
                    : authProblemMessages[state.problem]}
              </p>
              <p className="settings-description auth-confirm-note">
                You can keep playing as a guest. Your progress in this browser hasn&apos;t changed.
              </p>
              <div className="settings-form-row">
                <Link className="settings-action-button auth-confirm-link" href={afterSignInPath}>Back to Settings</Link>
                {state.retry && (
                  <button className="settings-action-button" type="button" onClick={() => void finish(state.retry!)}>
                    Try again
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      </main>
    </AppShell>
  );
}
