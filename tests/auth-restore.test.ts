import { createClient, AuthApiError, AuthInvalidJwtError, AuthRetryableFetchError } from "@supabase/supabase-js";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthController, type AuthState, type ControllerClient } from "../src/app/auth/auth-controller";
import {
  canVerifyLocally,
  checkStoredSession,
  createTokenVerifier,
  type TokenCheck,
} from "../src/app/auth/auth-session";

const projectUrl = "https://abcdefghijklmnopqrst.supabase.co";
const config = { url: projectUrl, key: "sb_publishable_test" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Lets every pending promise callback run. */
async function settle() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

/** Each test email gets its own stable user ID, so tests can tell accounts apart by ID. */
function idFor(email: string) {
  return `user-id-${email}`;
}

/** Which account each token was issued for, as the real server knows. A forged token isn't listed. */
const issuedTokens = new Map<string, string>();

function session(token: string, email: string) {
  issuedTokens.set(token, email);
  return { access_token: token, user: { id: idFor(email), email } } as unknown as Session;
}

/** A verifier that answers like a reachable Supabase: tokens it issued are valid, for their own account. */
async function serverCheck(token: string): Promise<TokenCheck> {
  const email = issuedTokens.get(token);
  return email ? { status: "valid", userId: idFor(email), email } : { status: "rejected" };
}

/** Holds the check of "old-token" until the test decides it; any other token is checked by the server. */
function holdingOldToken(result: Promise<TokenCheck>) {
  return (token: string) => (token === "old-token" ? result : serverCheck(token));
}

/** A token shaped like a real one, so the account it claims (`sub`) can be read, unverified. */
function jwtFor(name: string, userId: string) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: userId, name })}.signature`;
}

/**
 * A fake Auth client holding one current session. Sign-in and sign-out change it and announce the
 * change, as supabase-js does, so tests can stage the exact order of events.
 */
function createFakeAuth(initial: Session | null) {
  let current = initial;
  const listeners = new Set<(event: AuthChangeEvent, value: Session | null) => void>();
  const emit = (event: AuthChangeEvent, value: Session | null) => listeners.forEach((listener) => listener(event, value));

  const client = {
    getSession: vi.fn(async () => ({ data: { session: current }, error: null })),
    getClaims: vi.fn(async () => ({ data: null, error: null })),
    signInWithOtp: vi.fn(async () => ({ data: {}, error: null })),
    verifyOtp: vi.fn(async () => {
      current = session("new-token", "new@example.com");
      emit("SIGNED_IN", current);
      return { data: { session: current, user: current.user }, error: null };
    }),
    exchangeCodeForSession: vi.fn(async () => ({ data: { session: null, user: null }, error: null })),
    signOut: vi.fn(async () => {
      current = null;
      emit("SIGNED_OUT", null);
      return { error: null };
    }),
    onAuthStateChange: vi.fn((listener: (event: AuthChangeEvent, value: Session | null) => void) => {
      listeners.add(listener);
      return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
    }),
  };

  return {
    client: client as typeof client & ControllerClient,
    emit,
    get current() {
      return current;
    },
    /** Replaces the session without an event, as a cookie written by another tab would. */
    replaceQuietly(value: Session | null) {
      current = value;
    },
    /** Another tab or a sign-in on this page: the session changes and supabase-js announces it. */
    signInElsewhere(token: string, email: string) {
      current = session(token, email);
      emit("SIGNED_IN", current);
    },
    signOutElsewhere() {
      current = null;
      emit("SIGNED_OUT", null);
    },
  };
}

function track() {
  const states: AuthState[] = [];
  return { states, onChange: (state: AuthState) => states.push(state), last: () => states.at(-1) };
}

const signInLink = { kind: "token-hash", tokenHash: "abc123def456", type: "email" } as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("restoring while a sign-in or sign-out happens", () => {
  it("ignores startup announcements and trusts only the check", async () => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const check = deferred<TokenCheck>();
    const states = track();
    const controller = createAuthController(fake.client, () => check.promise, states.onChange);

    // supabase-js announces the stored session before it has been checked.
    fake.emit("SIGNED_IN", fake.current);
    fake.emit("INITIAL_SESSION", fake.current);
    expect(states.states).toEqual([]);

    check.resolve({ status: "rejected" });
    await controller.restored;
    expect(states.last()).toEqual({ status: "session-ended", user: { email: "old@example.com" } });
  });

  it("a sign-in during the check wins, and the old session's rejection signs nothing out", async () => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const check = deferred<TokenCheck>();
    const states = track();
    const controller = createAuthController(fake.client, holdingOldToken(check.promise), states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);

    fake.signInElsewhere("new-token", "new@example.com");
    check.resolve({ status: "rejected" });
    await controller.restored;
    await settle();

    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(fake.current?.access_token).toBe("new-token");
    expect(states.last()).toEqual({ status: "signed-in", user: { id: idFor("new@example.com"), email: "new@example.com" } });
  });

  it("a sign-out during the check wins over a late 'valid' result", async () => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const check = deferred<TokenCheck>();
    const states = track();
    const controller = createAuthController(fake.client, () => check.promise, states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);

    fake.signOutElsewhere();
    check.resolve({ status: "valid", userId: idFor("old@example.com"), email: "old@example.com" });
    await controller.restored;

    expect(states.last()).toEqual({ status: "signed-out" });
    expect(states.states).not.toContainEqual({ status: "signed-in", user: { id: idFor("old@example.com"), email: "old@example.com" } });
  });

  it("a sign-out during the check isn't repeated when the old session is then rejected", async () => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const check = deferred<TokenCheck>();
    const states = track();
    const controller = createAuthController(fake.client, () => check.promise, states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);

    fake.signOutElsewhere();
    check.resolve({ status: "rejected" });
    await controller.restored;

    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(states.last()).toEqual({ status: "signed-out" });
  });

  it("a session replaced without an event is checked again with the new token", async () => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const checks: string[] = [];
    const states = track();
    const verify = vi.fn(async (token: string): Promise<TokenCheck> => {
      checks.push(token);
      if (token === "old-token") {
        fake.replaceQuietly(session("other-tab-token", "other@example.com"));
        return { status: "rejected" };
      }
      return { status: "valid", userId: idFor("other@example.com"), email: "other@example.com" };
    });
    const controller = createAuthController(fake.client, verify, states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);
    await controller.restored;

    expect(checks).toEqual(["old-token", "other-tab-token"]);
    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(states.last()).toEqual({ status: "signed-in", user: { id: idFor("other@example.com"), email: "other@example.com" } });
  });

  it("never signs out a rejected session: it is reported as ended and left for the player to remove", async () => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const states = track();
    const controller = createAuthController(fake.client, async () => ({ status: "rejected" }), states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);
    await controller.restored;

    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(fake.current?.access_token).toBe("old-token");
    expect(states.states).toEqual([{ status: "session-ended", user: { email: "old@example.com" } }]);
  });

  it("Codex's exact race: another tab's session saved between the final comparison and any cleanup survives", async () => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const states: AuthState[] = [];
    let raced = false;
    // Another tab signs in at the last possible moment: when cleanup would start (signOut), or when the
    // controller has made its decision, whichever comes first.
    const otherTabSignsIn = () => {
      if (raced) return;
      raced = true;
      fake.signInElsewhere("other-tab-token", "other@example.com");
    };
    const signOut = fake.client.signOut.getMockImplementation()!;
    fake.client.signOut.mockImplementation(async (...args) => {
      otherTabSignsIn();
      return signOut(...args);
    });
    const verify = (token: string) => (token === "old-token" ? Promise.resolve<TokenCheck>({ status: "rejected" }) : serverCheck(token));
    const controller = createAuthController(fake.client, verify, (state) => {
      states.push(state);
      queueMicrotask(otherTabSignsIn);
    });
    fake.emit("INITIAL_SESSION", fake.current);
    await controller.restored;
    await settle();

    expect(raced).toBe(true);
    expect(fake.current?.access_token).toBe("other-tab-token");
    expect(states.at(-1)).toEqual({ status: "signed-in", user: { id: idFor("other@example.com"), email: "other@example.com" } });
  });

  it("Codex's race: a new session saved after the final comparison survives, and the UI follows it", async () => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const states = track();
    let reads = 0;
    const getSession = fake.client.getSession.getMockImplementation()!;
    fake.client.getSession.mockImplementation(async () => {
      const result = await getSession();
      reads += 1;
      // Read 2 is the comparison after the check. Right after it, another tab signs in.
      if (reads === 2) queueMicrotask(() => fake.signInElsewhere("other-tab-token", "other@example.com"));
      return result;
    });
    const verify = (token: string) => (token === "old-token" ? Promise.resolve<TokenCheck>({ status: "rejected" }) : serverCheck(token));
    const controller = createAuthController(fake.client, verify, states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);
    await controller.restored;
    await settle();

    expect(reads).toBeGreaterThanOrEqual(2);
    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(fake.current?.access_token).toBe("other-tab-token");
    // The UI matches what supabase-js actually holds.
    expect(states.last()).toEqual({ status: "signed-in", user: { id: fake.current?.user.id, email: fake.current?.user.email } });
  });

  it("Codex's race without an event: a session written quietly after the comparison still survives", async () => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    let reads = 0;
    const getSession = fake.client.getSession.getMockImplementation()!;
    fake.client.getSession.mockImplementation(async () => {
      const result = await getSession();
      reads += 1;
      if (reads === 2) queueMicrotask(() => fake.replaceQuietly(session("other-tab-token", "other@example.com")));
      return result;
    });
    const controller = createAuthController(fake.client, async () => ({ status: "rejected" }), track().onChange);
    fake.emit("INITIAL_SESSION", fake.current);
    await controller.restored;
    await settle();

    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(fake.current?.access_token).toBe("other-tab-token");
  });

  it("follows several changes from other tabs during one check, ending on the last", async () => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const check = deferred<TokenCheck>();
    const states = track();
    const controller = createAuthController(fake.client, holdingOldToken(check.promise), states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);

    fake.signInElsewhere("tab-b-token", "b@example.com");
    fake.signOutElsewhere();
    fake.signInElsewhere("tab-c-token", "c@example.com");
    check.resolve({ status: "rejected" });
    await controller.restored;
    await settle();

    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(fake.current?.access_token).toBe("tab-c-token");
    expect(states.last()).toEqual({ status: "signed-in", user: { id: idFor("c@example.com"), email: "c@example.com" } });
  });

  it.each([
    ["valid", { status: "valid", userId: idFor("old@example.com"), email: "old@example.com" }],
    ["unreachable", { status: "unreachable" }],
    ["rejected", { status: "rejected" }],
  ] as const)("never signs anything out when the check is %s", async (_label, result) => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const controller = createAuthController(fake.client, async () => result, track().onChange);
    fake.emit("INITIAL_SESSION", fake.current);
    await controller.restored;

    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(fake.current?.access_token).toBe("old-token");
  });

  it("an expired session supabase-js couldn't refresh is reported as ended, without signing anything out", async () => {
    const fake = createFakeAuth(null);
    fake.client.getSession.mockResolvedValueOnce({
      data: { session: null },
      error: new AuthApiError("Invalid Refresh Token: Refresh Token Not Found", 400, "refresh_token_not_found"),
    } as never);
    const states = track();
    const controller = createAuthController(fake.client, vi.fn(), states.onChange);
    fake.emit("INITIAL_SESSION", null);
    await controller.restored;

    expect(states.last()).toEqual({ status: "signed-out", sessionEnded: true });
    expect(fake.client.signOut).not.toHaveBeenCalled();
  });

  it("an explicit sign-out still clears the session, including an ended one", async () => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const states = track();
    const controller = createAuthController(fake.client, async () => ({ status: "rejected" }), states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);
    await controller.restored;
    expect(states.last()?.status).toBe("session-ended");

    expect(await controller.signOut()).toEqual({ ok: true });

    expect(fake.client.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(fake.current).toBeNull();
    expect(states.last()).toEqual({ status: "signed-out" });
  });

  it("finishing a sign-in waits for the check, then replaces the old session without signing anything out", async () => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const check = deferred<TokenCheck>();
    const states = track();
    const controller = createAuthController(fake.client, holdingOldToken(check.promise), states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);

    const signingIn = controller.completeSignIn(signInLink);
    await settle();
    expect(fake.client.verifyOtp).not.toHaveBeenCalled();

    check.resolve({ status: "rejected" });
    expect(await signingIn).toEqual({ ok: true, user: { id: idFor("new@example.com"), email: "new@example.com" } });
    await settle();

    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(fake.current?.access_token).toBe("new-token");
    expect(states.last()).toEqual({ status: "signed-in", user: { id: idFor("new@example.com"), email: "new@example.com" } });
  });

  it("a sign-in that stops waiting for a stuck check is never signed out by that check's late rejection", async () => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const check = deferred<TokenCheck>();
    const states = track();
    const controller = createAuthController(fake.client, holdingOldToken(check.promise), states.onChange, { restoreWaitMs: 0 });
    fake.emit("INITIAL_SESSION", fake.current);

    expect((await controller.completeSignIn(signInLink)).ok).toBe(true);
    check.resolve({ status: "rejected" });
    await controller.restored;
    await settle();

    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(fake.current?.access_token).toBe("new-token");
    expect(states.last()).toEqual({ status: "signed-in", user: { id: idFor("new@example.com"), email: "new@example.com" } });
  });

  it("stops reporting changes once disposed", async () => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const check = deferred<TokenCheck>();
    const states = track();
    const controller = createAuthController(fake.client, () => check.promise, states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);

    controller.dispose();
    check.resolve({ status: "valid", userId: idFor("old@example.com"), email: "old@example.com" });
    fake.signInElsewhere("new-token", "new@example.com");
    await settle();

    expect(states.states).toEqual([]);
  });
});

describe("the same session announced again, as when a tab is shown again", () => {
  /** A rejected session, then whatever the test does next. */
  async function endedSession() {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const states = track();
    const verify = (token: string) => (token === "old-token" ? Promise.resolve<TokenCheck>({ status: "rejected" }) : serverCheck(token));
    const controller = createAuthController(fake.client, verify, states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);
    await controller.restored;
    expect(states.last()).toEqual({ status: "session-ended", user: { email: "old@example.com" } });
    return { fake, states, controller };
  }

  it("rejected, tab hidden, tab visible, same-token SIGNED_IN: stays ended", async () => {
    const { fake, states } = await endedSession();

    // supabase-js re-announces the unchanged stored session each time the tab becomes visible.
    fake.emit("SIGNED_IN", fake.current);
    fake.emit("SIGNED_IN", fake.current);

    expect(states.last()).toEqual({ status: "session-ended", user: { email: "old@example.com" } });
    expect(states.states.some((state) => state.status === "signed-in")).toBe(false);
    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(fake.current?.access_token).toBe("old-token");
  });

  it("the same token announced while it is still being checked doesn't count as signed in", async () => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const check = deferred<TokenCheck>();
    const states = track();
    const controller = createAuthController(fake.client, () => check.promise, states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);
    await settle();

    fake.emit("SIGNED_IN", fake.current);
    expect(states.states).toEqual([]);
    check.resolve({ status: "rejected" });
    await controller.restored;

    expect(states.states).toEqual([{ status: "session-ended", user: { email: "old@example.com" } }]);
  });

  it("a new sign-in after the rejection signs in", async () => {
    const { fake, states } = await endedSession();

    fake.signInElsewhere("new-token", "new@example.com");
    // Checked before it counts.
    expect(states.last()).toEqual({ status: "loading" });
    await settle();

    expect(states.last()).toEqual({ status: "signed-in", user: { id: idFor("new@example.com"), email: "new@example.com" } });
    // And that new session, announced again, stays signed in without another check.
    const shown = states.states.length;
    fake.emit("SIGNED_IN", fake.current);
    await settle();
    expect(states.states).toHaveLength(shown);
    expect(states.last()).toEqual({ status: "signed-in", user: { id: idFor("new@example.com"), email: "new@example.com" } });
  });

  it("a refresh the server accepted, with a new token, signs in", async () => {
    const { fake, states } = await endedSession();

    fake.replaceQuietly(session("refreshed-token", "old@example.com"));
    fake.emit("TOKEN_REFRESHED", fake.current);
    await settle();

    expect(states.last()).toEqual({ status: "signed-in", user: { id: idFor("old@example.com"), email: "old@example.com" } });
  });

  it("another tab signing out, then signing in again, is followed", async () => {
    const { fake, states } = await endedSession();

    fake.signOutElsewhere();
    expect(states.last()).toEqual({ status: "signed-out" });
    fake.signInElsewhere("tab-b-token", "b@example.com");
    await settle();
    expect(states.last()).toEqual({ status: "signed-in", user: { id: idFor("b@example.com"), email: "b@example.com" } });
  });

  it("an explicit sign-out from the ended state still works", async () => {
    const { fake, states, controller } = await endedSession();

    expect(await controller.signOut()).toEqual({ ok: true });

    expect(fake.client.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(states.last()).toEqual({ status: "signed-out" });
  });

  it("a valid session announced again stays signed in", async () => {
    const fake = createFakeAuth(session("good-token", "mira@example.com"));
    const states = track();
    const controller = createAuthController(fake.client, async () => ({ status: "valid", userId: idFor("mira@example.com"), email: "mira@example.com" }), states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);
    await controller.restored;

    fake.emit("SIGNED_IN", fake.current);

    expect(states.last()).toEqual({ status: "signed-in", user: { id: idFor("mira@example.com"), email: "mira@example.com" } });
  });
});

describe("checking the stored session", () => {
  it("reports no session, an ended one, and a valid one", async () => {
    const none = createFakeAuth(null);
    expect(await checkStoredSession(none.client, vi.fn())).toEqual({ status: "none" });

    const ended = createFakeAuth(null);
    ended.client.getSession.mockResolvedValueOnce({ data: { session: null }, error: new AuthApiError("Invalid Refresh Token", 400, "refresh_token_not_found") } as never);
    expect(await checkStoredSession(ended.client, vi.fn())).toEqual({ status: "ended" });

    const valid = createFakeAuth(session("token-1", "mira@example.com"));
    const verify = vi.fn(async (): Promise<TokenCheck> => ({ status: "valid", userId: idFor("mira@example.com"), email: "mira@example.com" }));
    expect(await checkStoredSession(valid.client, verify)).toEqual({ status: "valid", user: { id: idFor("mira@example.com"), email: "mira@example.com" }, token: "token-1" });
    expect(verify).toHaveBeenCalledWith("token-1");
  });

  it("keeps a session it can't check, and never changes the session itself", async () => {
    const fake = createFakeAuth(session("token-1", "mira@example.com"));

    expect(await checkStoredSession(fake.client, async () => ({ status: "unreachable" }))).toEqual({
      status: "unreachable",
      user: { email: "mira@example.com" },
      claimedUserId: null,
      token: "token-1",
    });
    expect(await checkStoredSession(fake.client, async () => ({ status: "rejected" }))).toEqual({
      status: "rejected",
      user: { email: "mira@example.com" },
      token: "token-1",
    });
    expect(fake.client.signOut).not.toHaveBeenCalled();
  });

  it("reports superseded when the session changes during the check", async () => {
    const fake = createFakeAuth(session("token-1", "mira@example.com"));
    const verify = async (): Promise<TokenCheck> => {
      fake.replaceQuietly(session("token-2", "new@example.com"));
      return { status: "rejected" };
    };

    expect(await checkStoredSession(fake.client, verify)).toEqual({ status: "superseded" });
  });
});

/** A stored session whose user record can be shaped freely, as a hand-edited cookie could be. */
function forgedSession(token: string, user: Record<string, unknown> | null) {
  return { access_token: token, user } as unknown as Session;
}

describe("the stored session's identity (Codex finding 2: only a verified ID counts)", () => {
  it("comes from the verifier, matching the stored session", async () => {
    const fake = createFakeAuth(session("token-1", "mira@example.com"));

    expect(await checkStoredSession(fake.client, serverCheck)).toEqual({
      status: "valid",
      user: { id: idFor("mira@example.com"), email: "mira@example.com" },
      token: "token-1",
    });
  });

  it("uses the verified ID when the stored session has none", async () => {
    const fake = createFakeAuth(forgedSession("token-1", { email: "mira@example.com" }));
    const verify = async (): Promise<TokenCheck> => ({ status: "valid", userId: "verified-id", email: "mira@example.com" });

    expect(await checkStoredSession(fake.client, verify)).toEqual({
      status: "valid",
      user: { id: "verified-id", email: "mira@example.com" },
      token: "token-1",
    });
  });

  it("never falls back to the stored ID: a verified reply without an ID is rejected", async () => {
    const fake = createFakeAuth(session("token-1", "mira@example.com"));
    const verify = async (): Promise<TokenCheck> => ({ status: "valid", userId: null, email: "mira@example.com" });

    expect(await checkStoredSession(fake.client, verify)).toEqual({
      status: "rejected",
      user: { email: "mira@example.com" },
      token: "token-1",
    });
    expect(fake.client.signOut).not.toHaveBeenCalled();
  });

  it("rejects a stored user that doesn't match the verified token, without removing it", async () => {
    // The token is mira's; the stored user record claims to be someone else.
    const fake = createFakeAuth(forgedSession("token-1", { id: idFor("other@example.com"), email: "other@example.com" }));
    const verify = async (): Promise<TokenCheck> => ({ status: "valid", userId: idFor("mira@example.com"), email: "mira@example.com" });

    expect(await checkStoredSession(fake.client, verify)).toEqual({
      status: "rejected",
      user: { email: "mira@example.com" },
      token: "token-1",
    });
    expect(fake.client.signOut).not.toHaveBeenCalled();
  });

  it.each([
    ["a matching user record and token", { id: "user-a", email: "a@example.com" }, jwtFor("t", "user-a"), "user-a"],
    ["a user record for another account", { id: "user-b", email: "a@example.com" }, jwtFor("t", "user-a"), null],
    ["no user ID", { email: "a@example.com" }, jwtFor("t", "user-a"), null],
    ["a token that claims no account", { id: "user-a", email: "a@example.com" }, "not-a-jwt", null],
  ])("offline, has no verified ID, even with %s", async (_, user, token, claimedUserId) => {
    const fake = createFakeAuth(forgedSession(token, user));

    expect(await checkStoredSession(fake.client, async () => ({ status: "unreachable" }))).toEqual({
      status: "unreachable",
      user: { email: "a@example.com" },
      claimedUserId,
      token,
    });
    expect(fake.client.signOut).not.toHaveBeenCalled();
  });

  it("treats a verifier that fails unexpectedly as unreachable", async () => {
    const fake = createFakeAuth(session("token-1", "mira@example.com"));
    const verify = async (): Promise<TokenCheck> => { throw new Error("bug"); };

    expect((await checkStoredSession(fake.client, verify)).status).toBe("unreachable");
  });

  it("restores an unchecked session as unverified, with no ID, and never as signed in", async () => {
    const fake = createFakeAuth(session("token-1", "mira@example.com"));
    const states = track();
    const controller = createAuthController(fake.client, async () => ({ status: "unreachable" }), states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);
    await controller.restored;

    expect(states.states).toEqual([{ status: "unverified", user: { email: "mira@example.com" } }]);
    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(fake.current?.access_token).toBe("token-1");
  });

  it("checks an unverified session again when it's announced again, as when the tab is shown again", async () => {
    const fake = createFakeAuth(session("token-1", "mira@example.com"));
    const states = track();
    let online = false;
    const verify = vi.fn((token: string) => (online ? serverCheck(token) : Promise.resolve<TokenCheck>({ status: "unreachable" })));
    const controller = createAuthController(fake.client, verify, states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);
    await controller.restored;
    expect(states.last()?.status).toBe("unverified");

    // Still offline: still unverified, and nothing is removed.
    fake.emit("SIGNED_IN", fake.current);
    await settle();
    expect(states.last()).toEqual({ status: "unverified", user: { email: "mira@example.com" } });

    online = true;
    fake.emit("SIGNED_IN", fake.current);
    await settle();
    expect(states.last()).toEqual({ status: "signed-in", user: { id: idFor("mira@example.com"), email: "mira@example.com" } });
    expect(verify).toHaveBeenCalledTimes(3);
    expect(fake.client.signOut).not.toHaveBeenCalled();
  });

  it("is never part of an ended session", async () => {
    const fake = createFakeAuth(session("token-1", "mira@example.com"));
    const states = track();
    const controller = createAuthController(fake.client, async () => ({ status: "rejected" }), states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);
    await controller.restored;

    expect(states.last()).toEqual({ status: "session-ended", user: { email: "mira@example.com" } });
  });
});

describe("sessions announced after startup (Codex finding 1: identity is verified before it's shown)", () => {
  /** Signed in and verified as A, with a real-shaped token, ready for the next announcement. */
  async function signedInAsA(verify: (token: string) => Promise<TokenCheck> = serverCheck) {
    const tokenA = jwtFor("a-1", idFor("a@example.com"));
    const fake = createFakeAuth(session(tokenA, "a@example.com"));
    const states = track();
    const controller = createAuthController(fake.client, verify, states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);
    await controller.restored;
    expect(states.last()).toEqual({ status: "signed-in", user: { id: idFor("a@example.com"), email: "a@example.com" } });
    return { fake, states, controller };
  }

  /** Announces a session as supabase-js would after another tab wrote it. */
  function announce(fake: ReturnType<typeof createFakeAuth>, value: Session, event: AuthChangeEvent = "SIGNED_IN") {
    fake.replaceQuietly(value);
    fake.emit(event, value);
  }

  const signedInAs = (email: string) => ({ status: "signed-in", user: { id: idFor(email), email } });

  it("a token for A with a stored user record for B never signs in as B, and A isn't kept on screen", async () => {
    const { fake, states } = await signedInAsA();
    const shown = states.states.length;
    const tokenA2 = jwtFor("a-2", idFor("a@example.com"));
    issuedTokens.set(tokenA2, "a@example.com");

    announce(fake, forgedSession(tokenA2, { id: idFor("b@example.com"), email: "b@example.com" }));
    expect(states.last()).toEqual({ status: "loading" });
    await settle();

    expect(states.states.slice(shown)).toEqual([{ status: "loading" }, { status: "session-ended", user: { email: "a@example.com" } }]);
    expect(states.states).not.toContainEqual(signedInAs("b@example.com"));
    expect(fake.client.signOut).not.toHaveBeenCalled();
  });

  it("a forged token claiming B, with B's user record, is rejected and A isn't kept on screen", async () => {
    const { fake, states } = await signedInAsA();
    const forgedToken = jwtFor("forged", idFor("b@example.com"));

    announce(fake, forgedSession(forgedToken, { id: idFor("b@example.com"), email: "b@example.com" }));
    expect(states.last()).toEqual({ status: "loading" });
    await settle();

    expect(states.last()).toEqual({ status: "session-ended", user: { email: "b@example.com" } });
    expect(states.states).not.toContainEqual(signedInAs("b@example.com"));
    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(fake.current?.access_token).toBe(forgedToken);
  });

  it("a token whose own claim is A, with B's user record, isn't treated as the same account", async () => {
    // Offline, so nothing can be verified: A must not stay shown, and B must not appear.
    let online = true;
    const verify = (token: string) => (online ? serverCheck(token) : Promise.resolve<TokenCheck>({ status: "unreachable" }));
    const { fake, states } = await signedInAsA(verify);
    online = false;

    announce(fake, forgedSession(jwtFor("a-2", idFor("a@example.com")), { id: idFor("b@example.com"), email: "b@example.com" }));
    await settle();

    expect(states.last()).toEqual({ status: "unverified", user: { email: "b@example.com" } });
    expect(states.states).not.toContainEqual(signedInAs("b@example.com"));
  });

  it.each([
    ["no user", null],
    ["no user ID", { email: "a@example.com" }],
    ["a blank user ID", { id: " ", email: "a@example.com" }],
  ])("a session with %s after a sign-in is verified first, and gets its ID only from the verifier", async (_, user) => {
    const { fake, states } = await signedInAsA();
    const tokenA2 = jwtFor("a-2", idFor("a@example.com"));
    issuedTokens.set(tokenA2, "a@example.com");

    announce(fake, forgedSession(tokenA2, user));
    // Not the same account as far as the session can show, so A isn't kept while it's checked.
    expect(states.last()).toEqual({ status: "loading" });
    await settle();

    expect(states.last()).toEqual(signedInAs("a@example.com"));
  });

  it.each([
    ["no user", null],
    ["no user ID", { email: "a@example.com" }],
  ])("a session with %s after a sign-in, while offline, is unverified and has no ID", async (_, user) => {
    let online = true;
    const verify = (token: string) => (online ? serverCheck(token) : Promise.resolve<TokenCheck>({ status: "unreachable" }));
    const { fake, states } = await signedInAsA(verify);
    online = false;

    announce(fake, forgedSession(jwtFor("a-2", idFor("a@example.com")), user));
    await settle();

    expect(states.last()?.status).toBe("unverified");
    expect(states.last()).not.toHaveProperty("user.id");
  });

  it("a refreshed token for the same account keeps the account shown while it's checked", async () => {
    const { fake, states } = await signedInAsA();
    const shown = states.states.length;

    announce(fake, session(jwtFor("a-2", idFor("a@example.com")), "a@example.com"), "TOKEN_REFRESHED");
    expect(states.states).toHaveLength(shown);
    await settle();

    expect(states.states.slice(shown)).toEqual([signedInAs("a@example.com")]);
  });

  it("a refreshed token for the same account keeps the account through an outage, and is checked again later", async () => {
    let online = true;
    const verify = vi.fn((token: string) => (online ? serverCheck(token) : Promise.resolve<TokenCheck>({ status: "unreachable" })));
    const { fake, states } = await signedInAsA(verify);
    const shown = states.states.length;
    online = false;

    const refreshed = session(jwtFor("a-2", idFor("a@example.com")), "a@example.com");
    announce(fake, refreshed, "TOKEN_REFRESHED");
    await settle();
    expect(states.states).toHaveLength(shown);
    expect(states.last()).toEqual(signedInAs("a@example.com"));

    // Shown again once the connection is back: the new token is checked this time.
    online = true;
    fake.emit("SIGNED_IN", refreshed);
    await settle();
    expect(verify).toHaveBeenLastCalledWith(refreshed.access_token);
    expect(states.last()).toEqual(signedInAs("a@example.com"));
  });

  it("a refreshed token for the same account that the server rejects ends the session", async () => {
    const { fake, states } = await signedInAsA();

    announce(fake, forgedSession(jwtFor("a-forged", idFor("a@example.com")), { id: idFor("a@example.com"), email: "a@example.com" }), "TOKEN_REFRESHED");
    await settle();

    expect(states.last()).toEqual({ status: "session-ended", user: { email: "a@example.com" } });
    expect(fake.client.signOut).not.toHaveBeenCalled();
  });

  it("another account's real sign-in switches to that account once verified", async () => {
    const { fake, states } = await signedInAsA();
    const shown = states.states.length;

    fake.signInElsewhere("token-b", "b@example.com");
    await settle();

    expect(states.states.slice(shown)).toEqual([{ status: "loading" }, signedInAs("b@example.com")]);
  });

  it("a newer sign-out wins over a check still running for an announced session", async () => {
    const check = deferred<TokenCheck>();
    const verify = (token: string) => (token === "token-b" ? check.promise : serverCheck(token));
    const { fake, states } = await signedInAsA(verify);

    fake.signInElsewhere("token-b", "b@example.com");
    fake.signOutElsewhere();
    check.resolve({ status: "valid", userId: idFor("b@example.com"), email: "b@example.com" });
    await settle();

    expect(states.last()).toEqual({ status: "signed-out" });
    expect(states.states).not.toContainEqual(signedInAs("b@example.com"));
  });

  it("an announced session that can't be read back is never shown as signed in", async () => {
    const { fake, states } = await signedInAsA();
    fake.client.getSession.mockImplementation(async () => { throw new Error("bug"); });

    fake.signInElsewhere("token-b", "b@example.com");
    await settle();

    // As on startup, a session that can't be read counts as none.
    expect(states.last()).toEqual({ status: "signed-out" });
    expect(states.states).not.toContainEqual(signedInAs("b@example.com"));
  });
});

describe("verifying a symmetric (HS256) token", () => {
  const hsToken = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.e30.sig`;

  it("asks /auth/v1/user directly with the publishable key, and never uses getClaims", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: idFor("mira@example.com"), email: "mira@example.com" }), { status: 200 }));
    const fake = createFakeAuth(null);

    expect(await createTokenVerifier(fake.client, config, { fetch: fetchMock })(hsToken)).toEqual({ status: "valid", userId: idFor("mira@example.com"), email: "mira@example.com" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${projectUrl}/auth/v1/user`);
    expect(init.headers).toEqual({ apikey: "sb_publishable_test", authorization: `Bearer ${hsToken}` });
    expect(fake.client.getClaims).not.toHaveBeenCalled();
  });

  it.each([
    ["no ID", { email: "mira@example.com" }],
    ["a blank ID", { id: "", email: "mira@example.com" }],
    ["an ID that isn't text", { id: 7, email: "mira@example.com" }],
  ])("reports a reply with %s as having no verified ID", async (_, body) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    expect(await createTokenVerifier(createFakeAuth(null).client, config, { fetch: fetchMock })(hsToken)).toEqual({
      status: "valid",
      userId: null,
      email: "mira@example.com",
    });
  });

  it.each([
    [401, "rejected"],
    [403, "rejected"],
    [404, "unreachable"],
    [429, "unreachable"],
    [500, "unreachable"],
  ])("treats HTTP %i as %s", async (status, expected) => {
    const fetchMock = vi.fn(async () => new Response("{}", { status }));
    expect((await createTokenVerifier(createFakeAuth(null).client, config, { fetch: fetchMock })(hsToken)).status).toBe(expected);
  });

  it("treats a failed request as unreachable", async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    expect(await createTokenVerifier(createFakeAuth(null).client, config, { fetch: fetchMock })(hsToken)).toEqual({ status: "unreachable" });
  });
});

/** A real ES256 signing key, and tokens signed with it, as an asymmetric Supabase project issues. */
async function createSigningKey(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "ES256", use: "sig" };
  async function sign(payload: object, headerKid = kid) {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "ES256", typ: "JWT", kid: headerKid })}.${encode(payload)}`;
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(signature).toString("base64url")}`;
  }
  return { publicJwk, sign };
}

describe("verifying an asymmetric (ES256) token", () => {
  const claims = () => ({
    sub: idFor("mira@example.com"),
    email: "mira@example.com",
    role: "authenticated",
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  /**
   * A real supabase-js client that must never touch the network: the verifier fetches the public keys
   * itself and hands getClaims the exact key, so getClaims can't fall back to getUser.
   */
  function realClient() {
    const clientFetch = vi.fn(async () => new Response("{}", { status: 500 }));
    const client = createClient(projectUrl, "sb_publishable_test", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: clientFetch },
    });
    return { auth: client.auth, clientFetch };
  }

  /** The verifier's own requests: only the project's public keys, never /user. */
  function jwksFetch(reply: () => Response) {
    return vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`${projectUrl}/auth/v1/.well-known/jwks.json`);
      return reply();
    });
  }

  it("is checked locally against the project's public key, without asking /user", async () => {
    const key = await createSigningKey("key-1");
    const token = await key.sign(claims());
    const real = realClient();
    const verifierFetch = jwksFetch(() => new Response(JSON.stringify({ keys: [key.publicJwk] }), { status: 200 }));

    expect(canVerifyLocally(token)).toBe(true);
    expect(await createTokenVerifier(real.auth, config, { fetch: verifierFetch })(token)).toEqual({ status: "valid", userId: idFor("mira@example.com"), email: "mira@example.com" });
    expect(verifierFetch).toHaveBeenCalledTimes(1);
    expect(real.clientFetch).not.toHaveBeenCalled();
  });

  it("rejects a token signed by another key", async () => {
    const projectKey = await createSigningKey("key-1");
    const attackerKey = await createSigningKey("key-1");
    const forged = await attackerKey.sign(claims());
    const real = realClient();
    const verifierFetch = jwksFetch(() => new Response(JSON.stringify({ keys: [projectKey.publicJwk] }), { status: 200 }));

    expect(await createTokenVerifier(real.auth, config, { fetch: verifierFetch })(forged)).toEqual({ status: "rejected" });
    expect(real.clientFetch).not.toHaveBeenCalled();
  });

  it("rejects a token whose key the project no longer publishes, without falling back to /user", async () => {
    const key = await createSigningKey("key-1");
    const token = await key.sign(claims(), "rotated-out-key");
    const real = realClient();
    const verifierFetch = jwksFetch(() => new Response(JSON.stringify({ keys: [key.publicJwk] }), { status: 200 }));

    expect(await createTokenVerifier(real.auth, config, { fetch: verifierFetch })(token)).toEqual({ status: "rejected" });
    expect(real.clientFetch).not.toHaveBeenCalled();
  });

  it("rejects an expired token", async () => {
    const key = await createSigningKey("key-1");
    const token = await key.sign({ ...claims(), exp: Math.floor(Date.now() / 1000) - 60 });
    const real = realClient();
    const verifierFetch = jwksFetch(() => new Response(JSON.stringify({ keys: [key.publicJwk] }), { status: 200 }));

    expect(await createTokenVerifier(real.auth, config, { fetch: verifierFetch })(token)).toEqual({ status: "rejected" });
  });

  it.each([
    ["can't be reached", () => { throw new TypeError("Failed to fetch"); }],
    ["answer with an error", () => new Response("{}", { status: 503 })],
  ])("keeps the session when the public keys %s", async (_label, reply) => {
    const key = await createSigningKey("key-1");
    const token = await key.sign(claims());
    const real = realClient();

    expect(await createTokenVerifier(real.auth, config, { fetch: jwksFetch(reply as () => Response) })(token)).toEqual({ status: "unreachable" });
    expect(real.clientFetch).not.toHaveBeenCalled();
  });

  it("maps getClaims errors: an invalid token is rejected, a network failure is unreachable", async () => {
    const token = `${Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "key-1" })).toString("base64url")}.e30.sig`;
    const fake = createFakeAuth(null);
    const keysFetch = vi.fn(async () => new Response(JSON.stringify({ keys: [{ kid: "key-1", kty: "EC" }] }), { status: 200 }));
    const verify = createTokenVerifier(fake.client, config, { fetch: keysFetch });

    fake.client.getClaims.mockResolvedValueOnce({ data: null, error: new AuthInvalidJwtError("Invalid JWT signature") } as never);
    expect(await verify(token)).toEqual({ status: "rejected" });
    fake.client.getClaims.mockResolvedValueOnce({ data: null, error: new AuthRetryableFetchError("Failed to fetch", 0) } as never);
    expect(await verify(token)).toEqual({ status: "unreachable" });
    expect(fake.client.getClaims).toHaveBeenCalledWith(token, { keys: [{ kid: "key-1", kty: "EC" }] });
  });

  it("is checked with /user when the browser has no Web Crypto (an insecure page)", async () => {
    const key = await createSigningKey("key-1");
    const token = await key.sign(claims());
    vi.stubGlobal("crypto", undefined);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: idFor("mira@example.com"), email: "mira@example.com" }), { status: 200 }));
    const fake = createFakeAuth(null);

    expect(await createTokenVerifier(fake.client, config, { fetch: fetchMock })(token)).toEqual({ status: "valid", userId: idFor("mira@example.com"), email: "mira@example.com" });
    expect(fake.client.getClaims).not.toHaveBeenCalled();
  });
});
