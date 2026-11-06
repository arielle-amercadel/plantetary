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

function session(token: string, email: string) {
  return { access_token: token, user: { email } } as unknown as Session;
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
    const controller = createAuthController(fake.client, () => check.promise, states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);

    fake.signInElsewhere("new-token", "new@example.com");
    check.resolve({ status: "rejected" });
    await controller.restored;

    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(fake.current?.access_token).toBe("new-token");
    expect(states.last()).toEqual({ status: "signed-in", user: { email: "new@example.com" } });
  });

  it("a sign-out during the check wins over a late 'valid' result", async () => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const check = deferred<TokenCheck>();
    const states = track();
    const controller = createAuthController(fake.client, () => check.promise, states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);

    fake.signOutElsewhere();
    check.resolve({ status: "valid", email: "old@example.com" });
    await controller.restored;

    expect(states.last()).toEqual({ status: "signed-out" });
    expect(states.states).not.toContainEqual({ status: "signed-in", user: { email: "old@example.com" } });
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
      return { status: "valid", email: "other@example.com" };
    });
    const controller = createAuthController(fake.client, verify, states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);
    await controller.restored;

    expect(checks).toEqual(["old-token", "other-tab-token"]);
    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(states.last()).toEqual({ status: "signed-in", user: { email: "other@example.com" } });
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
    const controller = createAuthController(fake.client, async () => ({ status: "rejected" }), (state) => {
      states.push(state);
      queueMicrotask(otherTabSignsIn);
    });
    fake.emit("INITIAL_SESSION", fake.current);
    await controller.restored;
    await settle();

    expect(raced).toBe(true);
    expect(fake.current?.access_token).toBe("other-tab-token");
    expect(states.at(-1)).toEqual({ status: "signed-in", user: { email: "other@example.com" } });
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
    const controller = createAuthController(fake.client, async () => ({ status: "rejected" }), states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);
    await controller.restored;
    await settle();

    expect(reads).toBeGreaterThanOrEqual(2);
    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(fake.current?.access_token).toBe("other-tab-token");
    // The UI matches what supabase-js actually holds.
    expect(states.last()).toEqual({ status: "signed-in", user: { email: fake.current?.user.email } });
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
    const controller = createAuthController(fake.client, () => check.promise, states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);

    fake.signInElsewhere("tab-b-token", "b@example.com");
    fake.signOutElsewhere();
    fake.signInElsewhere("tab-c-token", "c@example.com");
    check.resolve({ status: "rejected" });
    await controller.restored;

    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(fake.current?.access_token).toBe("tab-c-token");
    expect(states.last()).toEqual({ status: "signed-in", user: { email: "c@example.com" } });
  });

  it.each([
    ["valid", { status: "valid", email: "old@example.com" }],
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
    const controller = createAuthController(fake.client, () => check.promise, states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);

    const signingIn = controller.completeSignIn(signInLink);
    await settle();
    expect(fake.client.verifyOtp).not.toHaveBeenCalled();

    check.resolve({ status: "rejected" });
    expect(await signingIn).toEqual({ ok: true, user: { email: "new@example.com" } });

    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(fake.current?.access_token).toBe("new-token");
    expect(states.last()).toEqual({ status: "signed-in", user: { email: "new@example.com" } });
  });

  it("a sign-in that stops waiting for a stuck check is never signed out by that check's late rejection", async () => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const check = deferred<TokenCheck>();
    const states = track();
    const controller = createAuthController(fake.client, () => check.promise, states.onChange, { restoreWaitMs: 0 });
    fake.emit("INITIAL_SESSION", fake.current);

    expect((await controller.completeSignIn(signInLink)).ok).toBe(true);
    check.resolve({ status: "rejected" });
    await controller.restored;

    expect(fake.client.signOut).not.toHaveBeenCalled();
    expect(fake.current?.access_token).toBe("new-token");
    expect(states.last()).toEqual({ status: "signed-in", user: { email: "new@example.com" } });
  });

  it("stops reporting changes once disposed", async () => {
    const fake = createFakeAuth(session("old-token", "old@example.com"));
    const check = deferred<TokenCheck>();
    const states = track();
    const controller = createAuthController(fake.client, () => check.promise, states.onChange);
    fake.emit("INITIAL_SESSION", fake.current);

    controller.dispose();
    check.resolve({ status: "valid", email: "old@example.com" });
    fake.signInElsewhere("new-token", "new@example.com");
    await settle();

    expect(states.states).toEqual([]);
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
    const verify = vi.fn(async (): Promise<TokenCheck> => ({ status: "valid", email: "mira@example.com" }));
    expect(await checkStoredSession(valid.client, verify)).toEqual({ status: "valid", user: { email: "mira@example.com" }, token: "token-1" });
    expect(verify).toHaveBeenCalledWith("token-1");
  });

  it("keeps a session it can't check, and never changes the session itself", async () => {
    const fake = createFakeAuth(session("token-1", "mira@example.com"));

    expect(await checkStoredSession(fake.client, async () => ({ status: "unreachable" }))).toEqual({
      status: "unreachable",
      user: { email: "mira@example.com" },
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

describe("verifying a symmetric (HS256) token", () => {
  const hsToken = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.e30.sig`;

  it("asks /auth/v1/user directly with the publishable key, and never uses getClaims", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ email: "mira@example.com" }), { status: 200 }));
    const fake = createFakeAuth(null);

    expect(await createTokenVerifier(fake.client, config, { fetch: fetchMock })(hsToken)).toEqual({ status: "valid", email: "mira@example.com" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${projectUrl}/auth/v1/user`);
    expect(init.headers).toEqual({ apikey: "sb_publishable_test", authorization: `Bearer ${hsToken}` });
    expect(fake.client.getClaims).not.toHaveBeenCalled();
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
    sub: "user-1",
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
    expect(await createTokenVerifier(real.auth, config, { fetch: verifierFetch })(token)).toEqual({ status: "valid", email: "mira@example.com" });
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
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ email: "mira@example.com" }), { status: 200 }));
    const fake = createFakeAuth(null);

    expect(await createTokenVerifier(fake.client, config, { fetch: fetchMock })(token)).toEqual({ status: "valid", email: "mira@example.com" });
    expect(fake.client.getClaims).not.toHaveBeenCalled();
  });
});
