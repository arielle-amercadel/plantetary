import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkStoredSession,
  finishSignIn,
  requestMagicLink,
  signOutOfThisDevice,
  type AuthClient,
  type ConfirmLink,
  type FinishSignInResult,
  type MagicLinkResult,
  type SignedInUser,
  type SignOutResult,
  type VerifyToken,
} from "./auth-session";

/**
 * - `unavailable`: sign-in isn't configured for this build; everyone plays as a guest.
 * - `loading`: checking for a saved session.
 * - `signed-out`: playing as a guest.
 * - `signed-in`: signed in. Game progress is still saved only in this browser, exactly as for a guest.
 * - `session-ended`: Supabase rejected the saved session (for example, the account was removed), but it
 *   is still stored in this browser. It's never cleared automatically (see checkStoredSession); the
 *   player can sign in again, or remove it with an explicit sign-out.
 *
 * `signed-out` with `sessionEnded` means supabase-js itself has already removed a session it couldn't
 * refresh, so nothing is stored any more.
 */
export type AuthState =
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "signed-out"; sessionEnded?: boolean }
  | { status: "signed-in"; user: SignedInUser }
  | { status: "session-ended"; user: SignedInUser };

export type ControllerClient = AuthClient & Pick<SupabaseClient["auth"], "onAuthStateChange">;

export type AuthController = {
  /** Resolves once the saved session has been checked (or a newer change made the check moot). */
  readonly restored: Promise<void>;
  sendMagicLink: (email: string, origin: string) => Promise<MagicLinkResult>;
  /** Finishes a sign-in link, after the saved-session check, so the two never overlap in this tab. */
  completeSignIn: (link: Extract<ConfirmLink, { kind: "token-hash" | "code" }>) => Promise<FinishSignInResult>;
  signOut: () => Promise<SignOutResult>;
  dispose: () => void;
};

/** How long a sign-in waits for the saved-session check before going ahead anyway. */
const defaultRestoreWaitMs = 8_000;

/**
 * Tracks who is signed in, without touching game saves.
 *
 * Every sign-in, sign-out or refresh after startup bumps a generation number. The saved-session check
 * that runs on load notes the generation when it starts, and its result is dropped if anything changed
 * since: an outdated check can never overwrite a newer sign-in or sign-out.
 *
 * The check never deletes anything. Only the player's own sign-out clears a session, so a check that
 * finishes late can't remove a session another tab has just saved.
 */
export function createAuthController(
  client: ControllerClient,
  verify: VerifyToken,
  onChange: (state: AuthState) => void,
  options: { restoreWaitMs?: number } = {},
): AuthController {
  let disposed = false;
  let generation = 0;
  // supabase-js announces the stored session as SIGNED_IN while it starts up, before anyone has checked
  // it. Those announcements end with INITIAL_SESSION, and the check below decides instead.
  let startedUp = false;

  const set = (state: AuthState) => {
    if (!disposed) onChange(state);
  };

  const { data: { subscription } } = client.onAuthStateChange((event, session) => {
    if (disposed) return;
    if (event === "INITIAL_SESSION") {
      startedUp = true;
      return;
    }
    if (!startedUp) return;

    if (event === "SIGNED_OUT" || !session) {
      generation += 1;
      set({ status: "signed-out" });
      return;
    }
    if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
      generation += 1;
      set({ status: "signed-in", user: { email: session.user.email ?? null } });
    }
  });

  async function restore() {
    // A session that keeps changing mid-check is re-checked, a few times at most.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = generation;
      const result = await checkStoredSession(client, verify);
      if (disposed || generation !== startedAt) return;

      switch (result.status) {
        case "superseded":
          continue;
        case "none":
          set({ status: "signed-out" });
          return;
        case "ended":
          set({ status: "signed-out", sessionEnded: true });
          return;
        case "valid":
        case "unreachable":
          set({ status: "signed-in", user: result.user });
          return;
        case "rejected":
          // Left in place on purpose: clearing it here could delete a newer session (see above).
          set({ status: "session-ended", user: result.user });
          return;
      }
    }
    // Still changing after several checks: the most recent auth event has already set the state.
  }

  const restored = restore().catch(() => {
    if (generation === 0) set({ status: "signed-out" });
  });

  return {
    restored,
    sendMagicLink: (email, origin) => requestMagicLink(client, email, origin),
    async completeSignIn(link) {
      const waitMs = options.restoreWaitMs ?? defaultRestoreWaitMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([restored, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]);
      if (timer !== undefined) clearTimeout(timer);
      // SIGNED_IN from supabase-js then updates the state.
      return finishSignIn(client, link);
    },
    async signOut() {
      const result = await signOutOfThisDevice(client);
      if (result.ok) {
        generation += 1;
        set({ status: "signed-out" });
      }
      return result;
    },
    dispose() {
      disposed = true;
      subscription.unsubscribe();
    },
  };
}
