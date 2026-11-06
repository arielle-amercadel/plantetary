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

export type RestoredSession =
  | { status: "signed-in"; user: SignedInUser }
  | { status: "signed-out"; ended?: boolean };

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

/**
 * Restores the session saved in this browser, checking it with the Auth server's keys.
 * - Valid: signed in.
 * - Rejected (expired, revoked or deleted user): cleared from this browser, then signed out.
 * - Unreachable (offline): kept, so a brief outage doesn't sign anyone out. It's checked again next load.
 */
export async function restoreSession(client: AuthClient): Promise<RestoredSession> {
  let claimsError: unknown;
  try {
    const { data, error } = await client.getClaims();
    if (data?.claims) {
      const email = typeof data.claims.email === "string" ? data.claims.email : null;
      return { status: "signed-in", user: { email } };
    }
    if (!error) return { status: "signed-out" };
    claimsError = error;
  } catch (error) {
    claimsError = error;
  }

  if (describeAuthError(claimsError) === "network") {
    try {
      const { data: stored } = await client.getSession();
      return stored.session
        ? { status: "signed-in", user: { email: stored.session.user.email ?? null } }
        : { status: "signed-out" };
    } catch {
      return { status: "signed-out" };
    }
  }

  try {
    await client.signOut({ scope: "local" });
  } catch {
    // The session was already rejected; clearing it is best effort.
  }
  return { status: "signed-out", ended: true };
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
