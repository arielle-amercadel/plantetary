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

export function fakeSession(email = TEST_EMAIL) {
  const issuedAt = nowSeconds();
  const user = fakeUser(email);
  // HS256 with no key ID, so supabase-js checks the token by asking /user, which these tests answer.
  const accessToken = `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url({
    sub: user.id,
    email,
    role: "authenticated",
    aud: "authenticated",
    iat: issuedAt,
    exp: issuedAt + 3600,
    session_id: "session-1",
  })}.fake-signature`;
  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: issuedAt + 3600,
    refresh_token: "fake-refresh-token",
    user,
  };
}

type Reply = { status: number; body?: unknown } | "network-error";
type Handler = (request: Request) => Reply;

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
    const reply: Reply = handler ? handler(request) : { status: 404, body: { code: "not_found", msg: "Not mocked" } };
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
