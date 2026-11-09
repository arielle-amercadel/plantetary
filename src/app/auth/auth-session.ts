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

/**
 * `id` is the Supabase user ID: the same value as `auth.uid()` in the database's access rules, and the
 * `sub` claim of the access token. Cloud saves are tied to it, so it is never empty.
 */
export type SignedInUser = { id: string; email: string | null };

/**
 * Who a session claims to belong to, for display only, when that claim hasn't been verified: the session
 * was rejected, or couldn't be checked. It carries no ID on purpose: nothing may be read or saved for an
 * account that hasn't been verified.
 */
export type UnverifiedUser = { email: string | null };

/** A usable user ID, or null. Stored sessions come from cookies, so their contents aren't trusted blindly. */
export function readUserId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** The signed-in user from a Supabase session, or null if it has no usable ID. */
export function signedInUserFromSession(session: { user?: { id?: unknown; email?: unknown } | null }): SignedInUser | null {
  const id = readUserId(session.user?.id);
  if (!id) return null;
  return { id, email: typeof session.user?.email === "string" ? session.user.email : null };
}

export type AuthProblem =
  | "age-not-confirmed"
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
  "age-not-confirmed": "Please confirm that you're at least 13 years old to get a sign-in link.",
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

/**
 * Plantetary accounts are for people 13 and older. Before a link is requested, the player confirms they
 * are: a plain acknowledgment, not age verification. Nothing about age is asked, sent or stored.
 */
export const ageAcknowledgmentText = "By continuing, you confirm that you are at least 13 years old.";

/**
 * Asks Supabase to email a sign-in link. Asking creates an account for a new address (`shouldCreateUser`),
 * so nothing is sent unless the player has confirmed the age requirement (`ageConfirmed`).
 */
export async function requestMagicLink(client: AuthClient, input: string, origin: string, ageConfirmed: boolean): Promise<MagicLinkResult> {
  if (ageConfirmed !== true) return { ok: false, problem: "age-not-confirmed" };
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
    const user = signedInUserFromSession(data.session);
    // Supabase always sends a user ID; without one, nothing could be tied to this account.
    if (!user) return { ok: false, problem: "unknown" };
    return { ok: true, user };
  } catch (error) {
    return { ok: false, problem: describeAuthError(error) };
  }
}

/** The project settings the token check needs: the same public URL and key the browser client uses. */
export type TokenCheckConfig = { url: string; key: string };

export type TokenCheck =
  /** `userId` is the verified token's own user ID, or null if the reply didn't include one. */
  | { status: "valid"; userId: string | null; email: string | null }
  | { status: "rejected" }
  | { status: "unreachable" };

export type VerifyToken = (accessToken: string) => Promise<TokenCheck>;

function readJwtPart(token: string, index: 0 | 1): Record<string, unknown> | undefined {
  const part = token.split(".")[index];
  if (!part) return undefined;
  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const value: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function readJwtHeader(token: string): { alg?: unknown; kid?: unknown } | undefined {
  return readJwtPart(token, 0);
}

/**
 * The user ID an access token claims (`sub`), read WITHOUT checking its signature. Only for telling
 * whether two claims agree; never a reason to trust either of them.
 */
export function readUnverifiedTokenSubject(token: string): string | null {
  return readUserId(readJwtPart(token, 1)?.sub);
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
      if (data?.claims) {
        return {
          status: "valid",
          userId: readUserId(data.claims.sub),
          email: typeof data.claims.email === "string" ? data.claims.email : null,
        };
      }
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
        const fields = body && typeof body === "object" ? body as { id?: unknown; email?: unknown } : {};
        return {
          status: "valid",
          userId: readUserId(fields.id),
          email: typeof fields.email === "string" ? fields.email : null,
        };
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
  /**
   * Couldn't be checked, so nothing about it is verified. `claimedUserId` is the ID that both the stored
   * user and the token claim, or null if they disagree or either is missing. It's only good for keeping an
   * account that was already verified in this tab; it must never establish an identity by itself.
   */
  | { status: "unreachable"; user: UnverifiedUser; claimedUserId: string | null; token: string }
  | { status: "rejected"; user: UnverifiedUser; token: string }
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
 * - Valid: signed in, as the user the verifier vouched for.
 * - Unreachable (offline): kept, so a brief outage doesn't sign anyone out, but nothing about it is
 *   verified. It's checked again when the tab is shown again, when supabase-js refreshes it, or next load.
 * - Rejected: reported, but left in place. Nothing here ever clears a session: supabase-js has no way to
 *   clear one only if it is still current, so a "check, then sign out" could delete a newer session
 *   another tab had just saved. Only an explicit sign-out by the player clears it.
 */
export async function checkStoredSession(
  client: Pick<AuthClient, "getSession">,
  verify: VerifyToken,
  /** Told which token is about to be checked, before the check starts. */
  onChecking?: (token: string) => void,
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
  onChecking?.(token);
  let check: TokenCheck;
  try {
    check = await verify(token);
  } catch {
    check = { status: "unreachable" };
  }
  if ((await readCurrentAccessToken(client)) !== token) return { status: "superseded" };

  const storedUser = signedInUserFromSession(session);
  const storedEmail = typeof session.user?.email === "string" ? session.user.email : null;

  if (check.status === "valid") {
    const email = check.email || storedEmail;
    // Only the verifier's own answer establishes who this is; the stored user record is never trusted for
    // that. A verified reply without an ID, or a stored user that disagrees with it, is inconsistent, so
    // it's reported as rejected (which removes nothing).
    if (!check.userId || (storedUser && storedUser.id !== check.userId)) return { status: "rejected", user: { email }, token };
    return { status: "valid", user: { id: check.userId, email }, token };
  }

  if (check.status === "unreachable") {
    const tokenSubject = readUnverifiedTokenSubject(token);
    const claimedUserId = storedUser && storedUser.id === tokenSubject ? storedUser.id : null;
    return { status: "unreachable", user: { email: storedEmail }, claimedUserId, token };
  }
  return { status: "rejected", user: { email: storedEmail }, token };
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
