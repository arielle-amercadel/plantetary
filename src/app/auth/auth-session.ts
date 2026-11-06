import {
  isAuthApiError,
  isAuthError,
  isAuthPKCECodeVerifierMissingError,
  isAuthRetryableFetchError,
  type EmailOtpType,
  type SupabaseClient,
} from "@supabase/supabase-js";

/**
 * Sign-in steps, written against the few Auth methods they use so each can be tested with a fake.
 * Nothing here reads or writes game saves: signing in or out never changes guest progress.
 */
export type AuthClient = Pick<
  SupabaseClient["auth"],
  "getClaims" | "getSession" | "signInWithOtp" | "verifyOtp" | "exchangeCodeForSession" | "signOut"
>;

/** The only page a sign-in link may land on, relative to this site. */
export const authConfirmPath = "/auth/confirm";
/** Where a finished sign-in goes. Fixed, so a link can never send players to another site. */
export const afterSignInPath = "/settings";

export type SignedInUser = { email: string | null };

export type AuthProblem =
  | "network"
  | "rate-limited"
  | "invalid-email"
  | "email-not-allowed"
  | "signups-disabled"
  | "email-sign-in-disabled"
  | "expired-link"
  | "invalid-link"
  | "other-browser"
  | "unknown";

export const authProblemMessages: Record<AuthProblem, string> = {
  network: "Plantetary couldn't reach the sign-in service. Check your connection and try again.",
  "rate-limited": "Too many sign-in emails were requested. Please wait a minute, then try again.",
  "invalid-email": "That email address can't be used. Check it and try again.",
  "email-not-allowed": "Sign-in emails can't be sent to that address yet.",
  "signups-disabled": "New accounts can't be created right now.",
  "email-sign-in-disabled": "Email sign-in is turned off right now.",
  "expired-link": "This sign-in link has expired or has already been used. Request a new one from Settings.",
  "invalid-link": "This sign-in link isn't valid. Request a new one from Settings.",
  "other-browser":
    "This sign-in link was requested in a different browser. Open it in the browser where you asked for it, or request a new one from Settings.",
  unknown: "Something went wrong with sign-in. Please try again.",
};

export function describeAuthError(error: unknown): AuthProblem {
  if (isAuthRetryableFetchError(error) || error instanceof TypeError) return "network";
  if (isAuthPKCECodeVerifierMissingError(error)) return "other-browser";
  if (!isAuthError(error)) return "unknown";

  switch (error.code) {
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
      return "rate-limited";
    case "email_address_invalid":
    case "validation_failed":
      return "invalid-email";
    case "email_address_not_authorized":
      return "email-not-allowed";
    case "signup_disabled":
      return "signups-disabled";
    case "otp_disabled":
    case "email_provider_disabled":
      return "email-sign-in-disabled";
    case "otp_expired":
    case "flow_state_expired":
    case "flow_state_not_found":
      return "expired-link";
    case "bad_code_verifier":
    case "bad_jwt":
      return "invalid-link";
  }
  if (isAuthApiError(error) && error.status === 429) return "rate-limited";
  return "unknown";
}

/** A deliberately simple check: the email service makes the final decision. */
export function normalizeEmail(input: string): string | null {
  const email = input.trim();
  if (email.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export type MagicLinkResult = { ok: true; email: string } | { ok: false; problem: AuthProblem };

export async function requestMagicLink(client: AuthClient, input: string, origin: string): Promise<MagicLinkResult> {
  const email = normalizeEmail(input);
  if (!email) return { ok: false, problem: "invalid-email" };

  try {
    const { error } = await client.signInWithOtp({
      email,
      options: { emailRedirectTo: `${origin}${authConfirmPath}`, shouldCreateUser: true },
    });
    return error ? { ok: false, problem: describeAuthError(error) } : { ok: true, email };
  } catch (error) {
    return { ok: false, problem: describeAuthError(error) };
  }
}

/** What a sign-in link carries. Anything else is treated as invalid. */
export type ConfirmLink =
  | { kind: "token-hash"; tokenHash: string; type: EmailOtpType }
  | { kind: "code"; code: string }
  | { kind: "error"; problem: AuthProblem }
  | { kind: "missing" };

const linkOtpTypes = new Set<EmailOtpType>(["email", "magiclink", "signup"]);

/** Reads `?token_hash=…&type=email` (our email template), `?code=…` (Supabase's default) or an error. */
export function parseConfirmLink(search: string, hash: string): ConfirmLink {
  const query = new URLSearchParams(search);
  const fragment = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const read = (name: string) => query.get(name) ?? fragment.get(name);

  const errorCode = read("error_code");
  if (errorCode || read("error")) {
    return { kind: "error", problem: errorCode === "otp_expired" ? "expired-link" : "invalid-link" };
  }

  const tokenHash = read("token_hash");
  const type = read("type");
  if (tokenHash !== null || type !== null) {
    if (tokenHash && /^[A-Za-z0-9_-]{8,256}$/.test(tokenHash) && type && linkOtpTypes.has(type as EmailOtpType)) {
      return { kind: "token-hash", tokenHash, type: type as EmailOtpType };
    }
    return { kind: "error", problem: "invalid-link" };
  }

  const code = read("code");
  if (code !== null) {
    return /^[A-Za-z0-9_-]{8,256}$/.test(code) ? { kind: "code", code } : { kind: "error", problem: "invalid-link" };
  }
  return { kind: "missing" };
}

/**
 * If a redirect URL isn't on the project's allowlist, Supabase sends the link to the Site URL instead,
 * so it can land on any page. This returns /auth/confirm with the same link, or null if there's none.
 */
export function getMisplacedSignInLinkTarget(pathname: string, search: string, hash: string): string | null {
  if (pathname === authConfirmPath) return null;
  const query = new URLSearchParams(search);
  const fragment = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const has = (name: string) => query.has(name) || fragment.has(name);
  // `code` is only trusted on the home page, where Supabase's fallback would put it.
  const looksLikeSignIn = has("token_hash") || has("error_code") || (pathname === "/" && query.has("code"));
  return looksLikeSignIn ? `${authConfirmPath}${search}${hash}` : null;
}

export type FinishSignInResult = { ok: true; user: SignedInUser } | { ok: false; problem: AuthProblem };

export async function finishSignIn(
  client: AuthClient,
  link: Extract<ConfirmLink, { kind: "token-hash" | "code" }>,
): Promise<FinishSignInResult> {
  try {
    const { data, error } = link.kind === "token-hash"
      ? await client.verifyOtp({ token_hash: link.tokenHash, type: link.type })
      : await client.exchangeCodeForSession(link.code);
    if (error) return { ok: false, problem: describeAuthError(error) };
    if (!data.session) return { ok: false, problem: "invalid-link" };
    return { ok: true, user: { email: data.session.user.email ?? null } };
  } catch (error) {
    return { ok: false, problem: describeAuthError(error) };
  }
}

/** The project settings the token check needs: the same public URL and key the browser client uses. */
export type TokenCheckConfig = { url: string; key: string };

export type TokenCheck =
  | { status: "valid"; email: string | null }
  | { status: "rejected" }
  | { status: "unreachable" };

export type VerifyToken = (accessToken: string) => Promise<TokenCheck>;

function readJwtHeader(token: string): { alg?: unknown; kid?: unknown } | undefined {
  const [header] = token.split(".");
  if (!header) return undefined;
  try {
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
  } catch {
    return undefined;
  }
}

/** True for a token signed with an asymmetric key that can be checked locally against the project's public keys. */
export function canVerifyLocally(token: string): boolean {
  const header = readJwtHeader(token);
  const hasWebCrypto = typeof globalThis.crypto !== "undefined" && Boolean(globalThis.crypto.subtle);
  return Boolean(
    header && typeof header.alg === "string" && !header.alg.startsWith("HS") && typeof header.kid === "string" && hasWebCrypto,
  );
}

/**
 * Checks one specific access token, and never changes the stored session.
 *
 * supabase-js's `getUser` isn't used, directly or through `getClaims`: when the server answers
 * `session_not_found`, it clears whichever session is current, which could be newer than the token
 * being checked. `getClaims` falls back to `getUser` whenever it has no matching key, so it's only
 * ever given the exact key to use.
 *
 * - Asymmetric tokens: the project's public keys are fetched here, and the token is verified locally
 *   against its own key. A key the project no longer publishes means the token is rejected.
 * - Other tokens: Supabase's `/auth/v1/user` is asked directly.
 */
export function createTokenVerifier(
  client: Pick<AuthClient, "getClaims">,
  config: TokenCheckConfig,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): VerifyToken {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const unreachable: TokenCheck = { status: "unreachable" };
  const rejected: TokenCheck = { status: "rejected" };

  async function verifyLocally(accessToken: string, kid: string): Promise<TokenCheck> {
    let keys: unknown;
    try {
      const response = await fetchImpl(`${config.url}/auth/v1/.well-known/jwks.json`, {
        headers: { apikey: config.key },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return unreachable;
      keys = ((await response.json()) as { keys?: unknown }).keys;
    } catch {
      return unreachable;
    }

    const key = Array.isArray(keys)
      ? keys.find((candidate): candidate is { kid: string } => Boolean(candidate) && (candidate as { kid?: unknown }).kid === kid)
      : undefined;
    if (!key) return rejected;

    try {
      const { data, error } = await client.getClaims(accessToken, { keys: [key as never] });
      if (data?.claims) return { status: "valid", email: typeof data.claims.email === "string" ? data.claims.email : null };
      return describeAuthError(error) === "network" ? unreachable : rejected;
    } catch (error) {
      return describeAuthError(error) === "network" ? unreachable : rejected;
    }
  }

  return async (accessToken) => {
    if (canVerifyLocally(accessToken)) {
      return verifyLocally(accessToken, readJwtHeader(accessToken)?.kid as string);
    }

    try {
      const response = await fetchImpl(`${config.url}/auth/v1/user`, {
        headers: { apikey: config.key, authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        const body: unknown = await response.json().catch(() => ({}));
        const email = body && typeof body === "object" && typeof (body as { email?: unknown }).email === "string"
          ? (body as { email: string }).email
          : null;
        return { status: "valid", email };
      }
      // 401 and 403 mean the token or its user is no longer accepted; anything else is an outage.
      return response.status === 401 || response.status === 403 ? { status: "rejected" } : { status: "unreachable" };
    } catch {
      return { status: "unreachable" };
    }
  };
}

/**
 * The result of checking the session saved in this browser. `superseded` means it changed while it was
 * being checked (a new sign-in, a sign-out, or another tab), so this result says nothing about it.
 */
export type StoredSessionCheck =
  | { status: "none" }
  | { status: "ended" }
  | { status: "valid"; user: SignedInUser; token: string }
  | { status: "unreachable"; user: SignedInUser; token: string }
  | { status: "rejected"; user: SignedInUser; token: string }
  | { status: "superseded" };

async function readCurrentAccessToken(client: Pick<AuthClient, "getSession">): Promise<string | null> {
  try {
    const { data } = await client.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Checks the session saved in this browser without changing it.
 * - Valid: signed in.
 * - Unreachable (offline): kept, so a brief outage doesn't sign anyone out; it's checked again next load.
 * - Rejected: reported, but left in place. Nothing here ever clears a session: supabase-js has no way to
 *   clear one only if it is still current, so a "check, then sign out" could delete a newer session
 *   another tab had just saved. Only an explicit sign-out by the player clears it.
 */
export async function checkStoredSession(
  client: Pick<AuthClient, "getSession">,
  verify: VerifyToken,
): Promise<StoredSessionCheck> {
  let session: Awaited<ReturnType<AuthClient["getSession"]>>["data"]["session"];
  try {
    const { data, error } = await client.getSession();
    session = data.session;
    // A refresh the server refused has already cleared the session.
    if (!session) return error && describeAuthError(error) !== "network" ? { status: "ended" } : { status: "none" };
  } catch {
    return { status: "none" };
  }

  const token = session.access_token;
  const check = await verify(token);
  if ((await readCurrentAccessToken(client)) !== token) return { status: "superseded" };

  const user = { email: check.status === "valid" && check.email ? check.email : session.user.email ?? null };
  if (check.status === "valid") return { status: "valid", user, token };
  if (check.status === "unreachable") return { status: "unreachable", user, token };
  return { status: "rejected", user, token };
}

export type SignOutResult =
  | { ok: true; warning?: "server-unreachable" }
  | { ok: false; problem: AuthProblem };

/**
 * Signs out of this browser only, so other devices stay signed in. Supabase clears the session here
 * before telling the server, so the player is signed out even when the server can't be reached.
 */
export async function signOutOfThisDevice(client: AuthClient): Promise<SignOutResult> {
  let signOutError: unknown = null;
  try {
    const { error } = await client.signOut({ scope: "local" });
    signOutError = error;
  } catch (error) {
    signOutError = error ?? new Error("Sign-out failed");
  }

  let stillSignedIn = false;
  try {
    const { data } = await client.getSession();
    stillSignedIn = Boolean(data.session);
  } catch {
    stillSignedIn = true;
  }

  if (stillSignedIn) return { ok: false, problem: signOutError ? describeAuthError(signOutError) : "unknown" };
  return signOutError ? { ok: true, warning: "server-unreachable" } : { ok: true };
}
