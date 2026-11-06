"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import {
  getMisplacedSignInLinkTarget,
  requestMagicLink,
  restoreSession,
  signOutOfThisDevice,
  type MagicLinkResult,
  type SignOutResult,
  type SignedInUser,
} from "./auth-session";
import { getSupabaseBrowserClient } from "./supabase-client";
import { getSupabaseBrowserConfig } from "./supabase-config";

/**
 * - `unavailable`: sign-in isn't configured for this build; everyone plays as a guest.
 * - `loading`: checking for a saved session.
 * - `signed-out`: playing as a guest.
 * - `signed-in`: signed in. Game progress is still saved only in this browser, exactly as for a guest.
 */
export type AuthState =
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "signed-out"; sessionEnded?: boolean }
  | { status: "signed-in"; user: SignedInUser };

type AuthContextValue = {
  auth: AuthState;
  sendMagicLink: (email: string) => Promise<MagicLinkResult>;
  signOut: () => Promise<SignOutResult>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

/** Kept apart from the quest store on purpose: nothing here reads, writes or resets game saves. */
export function AuthProvider({ children }: { children: ReactNode }) {
  // The config is fixed when the app is built, so the server and browser agree on this first state.
  const [auth, setAuth] = useState<AuthState>(() =>
    getSupabaseBrowserConfig() ? { status: "loading" } : { status: "unavailable" },
  );

  useEffect(() => {
    const client = getSupabaseBrowserClient();
    if (!client) return;

    const misplacedLink = getMisplacedSignInLinkTarget(window.location.pathname, window.location.search, window.location.hash);
    if (misplacedLink) {
      window.location.replace(misplacedLink);
      return;
    }

    let active = true;
    // While starting up, supabase-js announces the stored session as SIGNED_IN before anyone has
    // checked it. Those announcements end with INITIAL_SESSION and are ignored: restoreSession decides.
    let startedUp = false;
    let restoring = true;
    // A real sign-in (such as from /auth/confirm) while the stored session is being checked wins over that check.
    let signedInDuringRestore = false;

    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === "INITIAL_SESSION") {
        startedUp = true;
        return;
      }
      if (!startedUp) return;

      if (event === "SIGNED_OUT" || !session) {
        // The check itself signs out a rejected session, and its result says why, so wait for it.
        if (!restoring) setAuth({ status: "signed-out" });
        return;
      }
      if (event === "SIGNED_IN") {
        if (restoring) signedInDuringRestore = true;
        setAuth({ status: "signed-in", user: { email: session.user.email ?? null } });
        return;
      }
      // A refresh during the check is part of that check.
      if (!restoring && (event === "TOKEN_REFRESHED" || event === "USER_UPDATED")) {
        setAuth({ status: "signed-in", user: { email: session.user.email ?? null } });
      }
    });

    void restoreSession(client.auth).then((restored) => {
      restoring = false;
      if (!active || signedInDuringRestore) return;
      setAuth(restored.status === "signed-in"
        ? { status: "signed-in", user: restored.user }
        : { status: "signed-out", sessionEnded: restored.ended });
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const sendMagicLink = useCallback(async (email: string): Promise<MagicLinkResult> => {
    const client = getSupabaseBrowserClient();
    if (!client) return { ok: false, problem: "email-sign-in-disabled" };
    return requestMagicLink(client.auth, email, window.location.origin);
  }, []);

  const signOut = useCallback(async (): Promise<SignOutResult> => {
    const client = getSupabaseBrowserClient();
    if (!client) return { ok: true };
    const result = await signOutOfThisDevice(client.auth);
    if (result.ok) setAuth({ status: "signed-out" });
    return result;
  }, []);

  return (
    <AuthContext.Provider value={{ auth, sendMagicLink, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
