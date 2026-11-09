import type { Session, SupabaseClient } from "@supabase/supabase-js";
import {
  checkStoredSession,
  finishSignIn,
  readUnverifiedTokenSubject,
  requestMagicLink,
  signedInUserFromSession,
  signOutOfThisDevice,
  type AuthClient,
  type ConfirmLink,
  type FinishSignInResult,
  type MagicLinkResult,
  type SignedInUser,
  type SignOutResult,
  type UnverifiedUser,
  type VerifyToken,
} from "./auth-session";

/**
 * - `unavailable`: sign-in isn't configured for this build; everyone plays as a guest.
 * - `loading`: checking a session: the saved one on startup, or a new one announced later.
 * - `signed-out`: playing as a guest.
 * - `signed-in`: signed in, verified with Supabase. The game save can then live in the account (see
 *   game-storage-controller.ts). `user.id` is the verified Supabase user ID (`auth.uid()` in the database), and
 *   is never empty. This is the only state with a user ID.
 * - `unverified`: a session is stored, but it couldn't be checked (usually because Supabase couldn't be
 *   reached). It's kept, and checked again when the tab is shown again, when supabase-js refreshes it, or
 *   on the next load. Nothing about it is verified, so it has no user ID.
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
  | { status: "unverified"; user: UnverifiedUser }
  | { status: "session-ended"; user: UnverifiedUser };

export type ControllerClient = AuthClient & Pick<SupabaseClient["auth"], "onAuthStateChange">;

export type AuthController = {
  /** Resolves once the saved session has been checked (or a newer change made the check moot). */
  readonly restored: Promise<void>;
  /** `ageConfirmed`: the player confirmed they're at least 13. Without it, nothing is sent. */
  sendMagicLink: (email: string, origin: string, ageConfirmed: boolean) => Promise<MagicLinkResult>;
  /** Finishes a sign-in link, after the saved-session check, so the two never overlap in this tab. */
  completeSignIn: (link: Extract<ConfirmLink, { kind: "token-hash" | "code" }>) => Promise<FinishSignInResult>;
  signOut: () => Promise<SignOutResult>;
  dispose: () => void;
};

/** How long a sign-in waits for the saved-session check before going ahead anyway. */
const defaultRestoreWaitMs = 8_000;

/** True when both the session's user record and its token claim this user ID. Neither is verified. */
function sessionClaimsUser(session: Session, userId: string): boolean {
  return signedInUserFromSession(session)?.id === userId && readUnverifiedTokenSubject(session.access_token) === userId;
}

/**
 * Tracks who is signed in, without touching game saves.
 *
 * Nobody is ever shown as signed in from what a session says about itself: only a check that verified
 * its token with Supabase can publish `signed-in`, and the user ID comes from that verification. This
 * covers the saved session on startup, and every session announced later (a sign-in, a refresh, or
 * another tab's session), so a token for one account paired with another account's user record can
 * never sign anyone in as either.
 *
 * Every sign-in, sign-out or refresh after startup bumps a generation number. Each check notes the
 * generation when it starts, and its result is dropped if anything changed since: an outdated check can
 * never overwrite a newer sign-in or sign-out.
 *
 * Checks never delete anything. Only the player's own sign-out clears a session, so a check that
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
  let current: AuthState = { status: "loading" };
  // supabase-js announces the stored session as SIGNED_IN while it starts up, before anyone has checked
  // it. Those announcements end with INITIAL_SESSION, and the startup check decides instead.
  let startedUp = false;
  // Tokens supabase-js may announce again, for example whenever the tab is shown again, which mustn't
  // start another check: the one being checked right now, the one behind `signed-in`, and the one the
  // last check rejected. An `unverified` token isn't listed, so showing the tab again re-checks it.
  let checkingToken: string | null = null;
  let verifiedToken: string | null = null;
  let rejectedToken: string | null = null;

  const set = (state: AuthState) => {
    if (disposed) return;
    current = state;
    onChange(state);
  };

  /**
   * Checks the stored session and publishes the result, unless something newer happens first.
   *
   * `keepUserId` is the verified account already shown, when the session being checked claims that same
   * account (a refreshed token, for example). If Supabase can't be reached, that account stays shown;
   * otherwise only a verified result changes what's shown.
   */
  async function check(keepUserId: string | null) {
    // A session that keeps changing mid-check is re-checked, a few times at most.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = generation;
      let ownToken: string | null = null;
      const result = await checkStoredSession(client, verify, (token) => {
        ownToken = token;
        checkingToken = token;
      });
      if (ownToken !== null && checkingToken === ownToken) checkingToken = null;
      if (disposed || generation !== startedAt) return;

      switch (result.status) {
        case "superseded":
          continue;
        case "none":
          verifiedToken = null;
          set({ status: "signed-out" });
          return;
        case "ended":
          verifiedToken = null;
          set({ status: "signed-out", sessionEnded: true });
          return;
        case "valid":
          verifiedToken = result.token;
          rejectedToken = null;
          set({ status: "signed-in", user: result.user });
          return;
        case "unreachable":
          // The same verified account, with a token that couldn't be checked yet: nothing new is trusted,
          // and nothing is taken away because of an outage. The new token is checked again later.
          if (keepUserId !== null && result.claimedUserId === keepUserId && current.status === "signed-in" && current.user.id === keepUserId) return;
          verifiedToken = null;
          set({ status: "unverified", user: result.user });
          return;
        case "rejected":
          // Left in place on purpose: clearing it here could delete a newer session (see above).
          verifiedToken = null;
          rejectedToken = result.token;
          set({ status: "session-ended", user: result.user });
          return;
      }
    }
    // Still changing after several checks: each change bumped the generation, and the newest announced
    // session is checked by its own call.
  }

  const { data: { subscription } } = client.onAuthStateChange((event, session) => {
    if (disposed) return;
    if (event === "INITIAL_SESSION") {
      startedUp = true;
      return;
    }
    if (!startedUp) return;

    if (event === "SIGNED_OUT" || !session) {
      generation += 1;
      verifiedToken = null;
      rejectedToken = null;
      set({ status: "signed-out" });
      return;
    }
    // A session announced again (for example, the tab was shown again) that is already settled or being
    // checked: nothing changed.
    const token = session.access_token;
    if (token === checkingToken || token === verifiedToken || token === rejectedToken) return;

    if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
      // A different token: a new sign-in, a refresh, another tab's session, or an unverified session
      // announced again. It's checked before anyone is shown as signed in with it.
      generation += 1;
      rejectedToken = null;
      const keepUserId = current.status === "signed-in" && sessionClaimsUser(session, current.user.id)
        ? current.user.id
        : null;
      if (keepUserId === null) {
        // A different (or unknown) account: the previous one must not stay on screen meanwhile.
        verifiedToken = null;
        set({ status: "loading" });
      }
      // Not awaited: supabase-js may still hold its lock while it announces, and the check reads the session.
      const startedAt = generation;
      check(keepUserId).catch(() => {
        // A check that failed unexpectedly verified nothing: show the session as unconfirmed, never as signed in.
        if (generation !== startedAt) return;
        verifiedToken = null;
        set({ status: "unverified", user: { email: null } });
      });
    }
  });

  const restored = check(null).catch(() => {
    if (generation === 0) set({ status: "signed-out" });
  });

  return {
    restored,
    sendMagicLink: (email, origin, ageConfirmed) => requestMagicLink(client, email, origin, ageConfirmed),
    async completeSignIn(link) {
      const waitMs = options.restoreWaitMs ?? defaultRestoreWaitMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([restored, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]);
      if (timer !== undefined) clearTimeout(timer);
      // SIGNED_IN from supabase-js then starts a check, which updates the state.
      return finishSignIn(client, link);
    },
    async signOut() {
      const result = await signOutOfThisDevice(client);
      if (result.ok) {
        generation += 1;
        verifiedToken = null;
        rejectedToken = null;
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
