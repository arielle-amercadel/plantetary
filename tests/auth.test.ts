import {
  AuthApiError,
  AuthPKCECodeVerifierMissingError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
} from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  afterSignInPath,
  describeAuthError,
  finishSignIn,
  normalizeEmail,
  getMisplacedSignInLinkTarget,
  parseConfirmLink,
  requestMagicLink,
  signOutOfThisDevice,
  type AuthClient,
} from "../src/app/auth/auth-session";
import { readSupabaseConfig } from "../src/app/auth/supabase-config";

function jwtWithRole(role: string) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role, iss: "supabase" })}.signature`;
}

const session = { user: { email: "mira@example.com" } };

/** A fake Auth client: each method returns what the test sets, and records its calls. */
function createClient(overrides: Partial<Record<keyof AuthClient, (...args: never[]) => unknown>> = {}) {
  const client = {
    getClaims: vi.fn(async () => ({ data: null, error: null })),
    getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    signInWithOtp: vi.fn(async () => ({ data: {}, error: null })),
    verifyOtp: vi.fn(async () => ({ data: { session, user: session.user }, error: null })),
    exchangeCodeForSession: vi.fn(async () => ({ data: { session, user: session.user }, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    ...overrides,
  };
  return client as typeof client & AuthClient;
}

const networkError = () => new AuthRetryableFetchError("Failed to fetch", 0);
const apiError = (code: string, status = 400) => new AuthApiError("Rejected", status, code);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Supabase browser config", () => {
  it("accepts a publishable key and an https project URL", () => {
    expect(readSupabaseConfig("https://abcd.supabase.co/", " sb_publishable_123 ")).toEqual({
      ok: true,
      config: { url: "https://abcd.supabase.co", key: "sb_publishable_123" },
    });
  });

  it("accepts a legacy anon key", () => {
    expect(readSupabaseConfig("https://abcd.supabase.co", jwtWithRole("anon")).ok).toBe(true);
  });

  it("is off, not broken, when the values are missing", () => {
    expect(readSupabaseConfig(undefined, undefined)).toEqual({ ok: false, reason: "missing" });
    expect(readSupabaseConfig("https://abcd.supabase.co", "")).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses a secret key", () => {
    expect(readSupabaseConfig("https://abcd.supabase.co", "sb_secret_abc")).toEqual({ ok: false, reason: "secret-key" });
  });

  it("refuses a service-role key", () => {
    expect(readSupabaseConfig("https://abcd.supabase.co", jwtWithRole("service_role"))).toEqual({
      ok: false,
      reason: "secret-key",
    });
  });

  it("refuses keys it doesn't recognise", () => {
    expect(readSupabaseConfig("https://abcd.supabase.co", "not-a-key")).toEqual({ ok: false, reason: "invalid-key" });
  });

  it("allows plain http only for a Supabase stack on this computer", () => {
    expect(readSupabaseConfig("http://127.0.0.1:54321", "sb_publishable_1").ok).toBe(true);
    expect(readSupabaseConfig("http://localhost:54321", "sb_publishable_1").ok).toBe(true);
    expect(readSupabaseConfig("http://abcd.supabase.co", "sb_publishable_1")).toEqual({ ok: false, reason: "invalid-url" });
    expect(readSupabaseConfig("javascript:alert(1)", "sb_publishable_1")).toEqual({ ok: false, reason: "invalid-url" });
    expect(readSupabaseConfig("https://user:pass@abcd.supabase.co", "sb_publishable_1")).toEqual({ ok: false, reason: "invalid-url" });
  });
});

describe("Supabase project URL", () => {
  const key = "sb_publishable_123";

  it.each([
    ["https://abcdefghijklmnopqrst.supabase.co", "https://abcdefghijklmnopqrst.supabase.co"],
    ["https://abcdefghijklmnopqrst.supabase.co/", "https://abcdefghijklmnopqrst.supabase.co"],
    ["https://abcdefghijklmnopqrst.supabase.co//", "https://abcdefghijklmnopqrst.supabase.co"],
    ["https://ABCDEFGHIJKLMNOPQRST.supabase.co", "https://abcdefghijklmnopqrst.supabase.co"],
    ["https://db.example.com", "https://db.example.com"],
    ["http://127.0.0.1:54321", "http://127.0.0.1:54321"],
    ["http://localhost:54321/", "http://localhost:54321"],
  ])("accepts the project base URL %s", (url, expected) => {
    expect(readSupabaseConfig(url, key)).toEqual({ ok: true, config: { url: expected, key } });
  });

  it.each([
    "https://abcdefghijklmnopqrst.supabase.co/rest/v1",
    "https://abcdefghijklmnopqrst.supabase.co/rest/v1/",
    "https://abcdefghijklmnopqrst.supabase.co/auth/v1",
    "https://abcdefghijklmnopqrst.supabase.co/auth/v1/",
    "https://abcdefghijklmnopqrst.supabase.co/storage/v1",
    "https://abcdefghijklmnopqrst.supabase.co/functions/v1",
    "https://abcdefghijklmnopqrst.supabase.co/graphql/v1",
    "http://127.0.0.1:54321/rest/v1",
    "https://supabase.com/dashboard/project/abcdefghijklmnopqrst",
    "https://abcdefghijklmnopqrst.supabase.co?apikey=sb_publishable_123",
    "https://abcdefghijklmnopqrst.supabase.co#auth",
    "https://abcdefghijklmnopqrst.supabase.co?",
    "https://abcdefghijklmnopqrst.supabase.co/#",
  ])("refuses %s, which has more than the project URL", (url) => {
    expect(readSupabaseConfig(url, key)).toEqual({ ok: false, reason: "url-has-path" });
  });

  it("still refuses URLs that aren't valid at all", () => {
    expect(readSupabaseConfig("abcdefghijklmnopqrst.supabase.co", key)).toEqual({ ok: false, reason: "invalid-url" });
    expect(readSupabaseConfig("ftp://abcdefghijklmnopqrst.supabase.co", key)).toEqual({ ok: false, reason: "invalid-url" });
  });

  it("checks the URL before the key, so a bad URL never turns sign-in on", () => {
    expect(readSupabaseConfig("https://abcdefghijklmnopqrst.supabase.co/auth/v1", "sb_secret_abc")).toEqual({
      ok: false,
      reason: "url-has-path",
    });
  });

  it("explains the problem in the server log without repeating the URL or key", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://secretprojectref1234.supabase.co/rest/v1");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_do-not-print-me");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { getSupabaseConfigForBrowser } = await import("../src/app/auth/server-config");

      expect(getSupabaseConfigForBrowser()).toBeNull();
      expect(consoleError).toHaveBeenCalledTimes(1);
      const message = String(consoleError.mock.calls[0][0]);
      expect(message).toContain("NEXT_PUBLIC_SUPABASE_URL should be just the project URL");
      expect(message).toContain("/rest/v1");
      expect(message).not.toContain("secretprojectref1234");
      expect(message).not.toContain("do-not-print-me");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("requesting a magic link", () => {
  it("sends the link to this site's confirm page, and nowhere else", async () => {
    const client = createClient();

    const result = await requestMagicLink(client, "  mira@example.com ", "https://plantetary.example");

    expect(result).toEqual({ ok: true, email: "mira@example.com" });
    expect(client.signInWithOtp).toHaveBeenCalledWith({
      email: "mira@example.com",
      options: { emailRedirectTo: "https://plantetary.example/auth/confirm", shouldCreateUser: true },
    });
  });

  it("checks the address before contacting Supabase", async () => {
    const client = createClient();

    expect(await requestMagicLink(client, "not an email", "https://plantetary.example")).toEqual({
      ok: false,
      problem: "invalid-email",
    });
    expect(client.signInWithOtp).not.toHaveBeenCalled();
    expect(normalizeEmail("a@b")).toBeNull();
    expect(normalizeEmail(`${"a".repeat(250)}@b.co`)).toBeNull();
  });

  it.each([
    [apiError("over_email_send_rate_limit", 429), "rate-limited"],
    [apiError("email_address_invalid"), "invalid-email"],
    [apiError("email_address_not_authorized"), "email-not-allowed"],
    [apiError("signup_disabled", 422), "signups-disabled"],
    [apiError("otp_disabled", 422), "email-sign-in-disabled"],
    [apiError("something_new", 429), "rate-limited"],
    [apiError("something_new", 500), "unknown"],
    [networkError(), "network"],
  ])("explains %s as %s", async (error, problem) => {
    const client = createClient({ signInWithOtp: async () => ({ data: {}, error }) });

    expect(await requestMagicLink(client, "mira@example.com", "https://plantetary.example")).toEqual({ ok: false, problem });
  });

  it("treats a thrown fetch failure as a network problem", async () => {
    const client = createClient({ signInWithOtp: async () => { throw new TypeError("Failed to fetch"); } });

    expect(await requestMagicLink(client, "mira@example.com", "https://plantetary.example")).toEqual({
      ok: false,
      problem: "network",
    });
  });
});

describe("reading a sign-in link", () => {
  it("reads Plantetary's email link", () => {
    expect(parseConfirmLink("?token_hash=pkce_abc123def456&type=email", "")).toEqual({
      kind: "token-hash",
      tokenHash: "pkce_abc123def456",
      type: "email",
    });
  });

  it("reads Supabase's default email link", () => {
    expect(parseConfirmLink("?code=0b9c5d6e-1234-4abc-9def-1234567890ab", "")).toEqual({
      kind: "code",
      code: "0b9c5d6e-1234-4abc-9def-1234567890ab",
    });
  });

  it("recognises an expired link from the query or the fragment", () => {
    const expired = { kind: "error", problem: "expired-link" };
    expect(parseConfirmLink("?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid", "")).toEqual(expired);
    expect(parseConfirmLink("", "#error=access_denied&error_code=otp_expired")).toEqual(expired);
  });

  it("treats other errors and malformed links as invalid", () => {
    const invalid = { kind: "error", problem: "invalid-link" };
    expect(parseConfirmLink("?error=server_error", "")).toEqual(invalid);
    expect(parseConfirmLink("?token_hash=abc123def456", "")).toEqual(invalid);
    expect(parseConfirmLink("?token_hash=abc123def456&type=recovery", "")).toEqual(invalid);
    expect(parseConfirmLink("?token_hash=<script>&type=email", "")).toEqual(invalid);
    expect(parseConfirmLink("?code=../../evil", "")).toEqual(invalid);
  });

  it("ignores any redirect a link tries to add", () => {
    expect(parseConfirmLink("?token_hash=abc123def456&type=email&next=https://evil.example", "")).toEqual({
      kind: "token-hash",
      tokenHash: "abc123def456",
      type: "email",
    });
    expect(afterSignInPath).toBe("/settings");
  });

  it("reports a missing link", () => {
    expect(parseConfirmLink("", "")).toEqual({ kind: "missing" });
  });
});

describe("a sign-in link that lands on the wrong page", () => {
  it("is sent on to /auth/confirm with the same link", () => {
    expect(getMisplacedSignInLinkTarget("/", "?token_hash=abc123def456&type=email", "")).toBe(
      "/auth/confirm?token_hash=abc123def456&type=email",
    );
    expect(getMisplacedSignInLinkTarget("/settings", "", "#error=access_denied&error_code=otp_expired")).toBe(
      "/auth/confirm#error=access_denied&error_code=otp_expired",
    );
    expect(getMisplacedSignInLinkTarget("/", "?code=abc123def456", "")).toBe("/auth/confirm?code=abc123def456");
  });

  it("leaves ordinary pages and the confirm page alone", () => {
    expect(getMisplacedSignInLinkTarget("/", "", "")).toBeNull();
    expect(getMisplacedSignInLinkTarget("/quests/new", "?edit=water", "")).toBeNull();
    expect(getMisplacedSignInLinkTarget("/settings", "?code=abc123def456", "")).toBeNull();
    expect(getMisplacedSignInLinkTarget("/auth/confirm", "?token_hash=abc123def456&type=email", "")).toBeNull();
  });
});

describe("finishing sign-in", () => {
  it("verifies a token-hash link", async () => {
    const client = createClient();

    expect(await finishSignIn(client, { kind: "token-hash", tokenHash: "abc123def456", type: "email" })).toEqual({
      ok: true,
      user: { email: "mira@example.com" },
    });
    expect(client.verifyOtp).toHaveBeenCalledWith({ token_hash: "abc123def456", type: "email" });
  });

  it("exchanges a code link", async () => {
    const client = createClient();

    expect((await finishSignIn(client, { kind: "code", code: "abc123def456" })).ok).toBe(true);
    expect(client.exchangeCodeForSession).toHaveBeenCalledWith("abc123def456");
  });

  it.each([
    [apiError("otp_expired", 403), "expired-link"],
    [apiError("flow_state_not_found", 404), "expired-link"],
    [apiError("bad_code_verifier"), "invalid-link"],
    [new AuthPKCECodeVerifierMissingError(), "other-browser"],
    [networkError(), "network"],
  ])("explains %s as %s", async (error, problem) => {
    const client = createClient({
      verifyOtp: async () => ({ data: { session: null, user: null }, error }),
      exchangeCodeForSession: async () => { throw error; },
    });

    expect(await finishSignIn(client, { kind: "token-hash", tokenHash: "abc123def456", type: "email" })).toEqual({ ok: false, problem });
    expect(await finishSignIn(client, { kind: "code", code: "abc123def456" })).toEqual({ ok: false, problem });
  });

  it("doesn't count a reply without a session as signed in", async () => {
    const client = createClient({ verifyOtp: async () => ({ data: { session: null, user: null }, error: null }) });

    expect(await finishSignIn(client, { kind: "token-hash", tokenHash: "abc123def456", type: "email" })).toEqual({
      ok: false,
      problem: "invalid-link",
    });
  });
});

describe("signing out", () => {
  it("signs out of this browser only", async () => {
    const client = createClient();

    expect(await signOutOfThisDevice(client)).toEqual({ ok: true });
    expect(client.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("is still signed out here when the server can't be reached", async () => {
    const client = createClient({ signOut: async () => ({ error: networkError() }) });

    expect(await signOutOfThisDevice(client)).toEqual({ ok: true, warning: "server-unreachable" });
  });

  it("reports a failure when the session is still here", async () => {
    const client = createClient({
      signOut: async () => ({ error: networkError() }),
      getSession: async () => ({ data: { session }, error: null }),
    });

    expect(await signOutOfThisDevice(client)).toEqual({ ok: false, problem: "network" });
  });

  it("reports a failure when signing out throws and the session remains", async () => {
    const client = createClient({
      signOut: async () => { throw new Error("cookie write failed"); },
      getSession: async () => ({ data: { session }, error: null }),
    });

    expect(await signOutOfThisDevice(client)).toEqual({ ok: false, problem: "unknown" });
  });

  it("treats an already-ended session as signed out", async () => {
    const client = createClient({ signOut: async () => ({ error: new AuthSessionMissingError() }) });

    expect((await signOutOfThisDevice(client)).ok).toBe(true);
  });
});

describe("describing errors", () => {
  it("never claims an unknown value is a network problem", () => {
    expect(describeAuthError(undefined)).toBe("unknown");
    expect(describeAuthError("boom")).toBe("unknown");
  });
});
