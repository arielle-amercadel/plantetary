import type { Page, Request, Route } from "@playwright/test";
import { MONDAY } from "./support";

/** Matches NEXT_PUBLIC_SUPABASE_URL in playwright.config.ts. Nothing listens there. */
export const FAKE_SUPABASE_URL = "http://127.0.0.1:54999";
export const FAKE_PUBLISHABLE_KEY = "sb_publishable_plantetary-e2e";
export const TEST_EMAIL = "mira@example.com";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
};

function base64url(value: object) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** The tests' clock starts on MONDAY, so tokens expire an hour after that, not after real time. */
function nowSeconds() {
  return Math.floor(Date.parse(MONDAY) / 1000);
}

export function fakeUser(email = TEST_EMAIL) {
  return {
    id: "6f1d4c58-0000-4000-8000-000000000001",
    aud: "authenticated",
    role: "authenticated",
    email,
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    created_at: MONDAY,
  };
}

/** `expiresIn` is in seconds from the tests' clock; a negative value makes an already-expired token. */
function tokenClaims(email: string, expiresIn = 3600) {
  const issuedAt = nowSeconds();
  return {
    sub: fakeUser(email).id,
    email,
    role: "authenticated",
    aud: "authenticated",
    iat: issuedAt - Math.max(0, -expiresIn),
    exp: issuedAt + expiresIn,
    session_id: `session-${email}`,
  };
}

function sessionFor(email: string, accessToken: string, expiresIn = 3600) {
  const issuedAt = nowSeconds();
  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: expiresIn,
    expires_at: issuedAt + expiresIn,
    refresh_token: `fake-refresh-token-${email}`,
    user: fakeUser(email),
  };
}

/**
 * An ES256 signing key like an asymmetric Supabase project's. `jwks` is what the project would publish
 * at /auth/v1/.well-known/jwks.json, so the app can verify tokens locally.
 */
export async function createSigningKey(kid = "plantetary-e2e-key") {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "ES256", use: "sig" };
  return {
    jwks: { keys: [publicJwk] },
    async session(email = TEST_EMAIL) {
      const input = `${base64url({ alg: "ES256", typ: "JWT", kid })}.${base64url(tokenClaims(email))}`;
      const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(input));
      return sessionFor(email, `${input}.${Buffer.from(signature).toString("base64url")}`);
    },
  };
}

export function fakeSession(email = TEST_EMAIL, expiresIn = 3600) {
  // HS256 with no key ID, so the app checks the token by asking /user, which these tests answer.
  const accessToken = `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url(tokenClaims(email, expiresIn))}.fake-signature`;
  return sessionFor(email, accessToken, expiresIn);
}

type Reply = { status: number; body?: unknown } | "network-error";
type Handler = (request: Request) => Reply | Promise<Reply>;

export type FakeAuth = {
  /** Every Auth request the app made, apart from CORS preflights. */
  requests: Request[];
  /** Replaces the reply for one endpoint, such as "POST /otp" or "GET /user". */
  reply: (endpoint: string, handler: Handler | Reply) => void;
};

/**
 * Answers the app's Supabase Auth requests in the browser, so no real project is involved.
 * The defaults behave like a working project; tests swap in failures with `reply`.
 */
export async function useFakeAuth(page: Page): Promise<FakeAuth> {
  const requests: Request[] = [];
  const handlers = new Map<string, Handler>([
    ["POST /otp", () => ({ status: 200, body: {} })],
    ["POST /verify", () => ({ status: 200, body: fakeSession() })],
    ["POST /token", () => ({ status: 200, body: fakeSession() })],
    ["GET /user", () => ({ status: 200, body: fakeUser() })],
    ["POST /logout", () => ({ status: 204 })],
  ]);

  await page.route(`${FAKE_SUPABASE_URL}/**`, async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    requests.push(request);

    const path = new URL(request.url()).pathname.replace(/^\/auth\/v1/, "");
    const handler = handlers.get(`${request.method()} ${path}`);
    const reply: Reply = handler ? await handler(request) : { status: 404, body: { code: "not_found", msg: "Not mocked" } };
    if (reply === "network-error") {
      await route.abort("connectionrefused");
      return;
    }
    await route.fulfill({
      status: reply.status,
      headers: { ...corsHeaders, "content-type": "application/json" },
      body: reply.body === undefined ? "" : JSON.stringify(reply.body),
    });
  });

  return {
    requests,
    reply(endpoint, handler) {
      handlers.set(endpoint, typeof handler === "function" ? handler : () => handler);
    },
  };
}

/** An Auth API error body, as Supabase sends it. */
export function authError(code: string, message = "Request rejected") {
  return { code, error_code: code, msg: message };
}

export function authRequests(fake: FakeAuth, endpoint: string) {
  return fake.requests.filter((request) => {
    const path = new URL(request.url()).pathname.replace(/^\/auth\/v1/, "");
    return `${request.method()} ${path}` === endpoint;
  });
}

/** The access token supabase-js has stored in this browser's session cookie, or null if there is none. */
export async function storedAccessToken(page: Page) {
  const cookies = await page.context().cookies();
  const chunks = cookies
    .filter((cookie) => /^sb-.+-auth-token(\.\d+)?$/.test(cookie.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (chunks.length === 0) return null;
  const raw = chunks.map((cookie) => cookie.value).join("");
  const json = Buffer.from(raw.replace(/^base64-/, ""), "base64url").toString("utf8");
  return (JSON.parse(json) as { access_token?: string }).access_token ?? null;
}

/** Every Plantetary game key in localStorage, to prove sign-in leaves them untouched. */
export function readGameStorage(page: Page) {
  return page.evaluate(() => {
    const entries: Record<string, string> = {};
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key) entries[key] = window.localStorage.getItem(key) ?? "";
    }
    return entries;
  });
}
