import { createHash } from "node:crypto";
import type { Page, Request, Route } from "@playwright/test";
import { MONDAY, expect } from "./support";

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

/**
 * Each email gets its own stable user ID, so tests can tell accounts apart, as the database does. It's
 * derived from the whole address: two different emails never share an ID.
 */
function fakeUserId(email: string) {
  const hex = createHash("sha256").update(email).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function fakeUser(email = TEST_EMAIL) {
  return {
    id: fakeUserId(email),
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

/** The email a fake token was issued for, read from the request's bearer token. */
function emailFromBearer(request: Request): string | null {
  const token = request.headers()["authorization"]?.replace(/^Bearer /, "") ?? "";
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}
type Handler = (request: Request) => Reply | Promise<Reply>;

export type FakeAuth = {
  /** Every Auth and database request the app made, apart from CORS preflights. */
  requests: Request[];
  /**
   * Replaces the reply for one endpoint: Auth ones such as "POST /otp" or "GET /user", or database ones
   * such as "GET quest_saves" or "PATCH quest_saves".
   */
  reply: (endpoint: string, handler: Handler | Reply) => void;
  /** The fake project's database, shared by every tab given the same one. */
  cloud: FakeCloud;
};

type CloudSave = { data: unknown; schema_version: number; revision: number };
type CloudBackup = { user_id: string; reason: string; raw_data: string; schema_version: number | null; source_revision: number | null };

/**
 * The fake project's `quest_saves` and `save_backups` tables, with their real rules: each request sees
 * only its token's own account (RLS), the database sets revisions (never reused), there's one save per
 * account, and an update only matches the given user and revision.
 */
export type FakeCloud = {
  saves: Map<string, CloudSave>;
  backups: CloudBackup[];
  /** The account's save, by email. */
  saveOf: (email?: string) => CloudSave | undefined;
  /** Puts a save in an account, as another device would. Its revision moves on, like any save. */
  seed: (data: unknown, email?: string, schemaVersion?: number) => void;
  /** The account's next revision. Revisions never repeat for an account, as in the real database. */
  nextRevision: (userId: string) => number;
};

export function createFakeCloud(): FakeCloud {
  const saves = new Map<string, CloudSave>();
  const lastRevision = new Map<string, number>();
  const nextRevision = (userId: string) => {
    const revision = (lastRevision.get(userId) ?? 0) + 1;
    lastRevision.set(userId, revision);
    return revision;
  };
  return {
    saves,
    backups: [],
    saveOf: (email = TEST_EMAIL) => saves.get(fakeUserId(email)),
    seed(data, email = TEST_EMAIL, schemaVersion = 5) {
      const userId = fakeUserId(email);
      saves.set(userId, { data: structuredClone(data), schema_version: schemaVersion, revision: nextRevision(userId) });
    },
    nextRevision,
  };
}

/** The account a request's bearer token was issued for, or null for no sign-in. */
function userIdFromBearer(request: Request): string | null {
  const token = request.headers()["authorization"]?.replace(/^Bearer /, "") ?? "";
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown };
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

/** Answers a PostgREST request against the fake tables, as Supabase would. */
function answerDatabase(cloud: FakeCloud, request: Request, table: string): Reply {
  const userId = userIdFromBearer(request);
  // The publishable key alone carries no account: no sign-in, no access.
  if (!userId || userId === "anon") return { status: 401, body: { code: "42501", message: "permission denied" } };
  const url = new URL(request.url());
  const filter = (column: string) => url.searchParams.get(column)?.replace(/^eq\./, "") ?? null;
  const wantsObject = (request.headers()["accept"] ?? "").includes("vnd.pgrst.object");
  const rows = (list: unknown[]) => (wantsObject ? list[0] ?? null : list);
  const { nextRevision } = cloud;

  if (table === "save_backups" && request.method() === "POST") {
    const backup = request.postDataJSON() as CloudBackup;
    if (backup.user_id !== userId) return { status: 403, body: { code: "42501", message: "new row violates row-level security policy" } };
    cloud.backups.push(backup);
    return { status: 201 };
  }
  if (table !== "quest_saves") return { status: 404, body: { code: "PGRST205", message: "Not mocked" } };

  const own = cloud.saves.get(userId);
  if (request.method() === "GET") {
    const visible = own && filter("user_id") === userId ? [{ data: own.data, schema_version: own.schema_version, revision: own.revision }] : [];
    return { status: 200, body: rows(visible) };
  }
  if (request.method() === "POST") {
    const body = request.postDataJSON() as { user_id: string; data: unknown; schema_version: number };
    if (body.user_id !== userId) return { status: 403, body: { code: "42501", message: "new row violates row-level security policy" } };
    if (own) return { status: 409, body: { code: "23505", message: "duplicate key value violates unique constraint \"quest_saves_pkey\"" } };
    const created = { data: body.data, schema_version: body.schema_version, revision: nextRevision(userId) };
    cloud.saves.set(userId, created);
    return { status: 201, body: rows([{ revision: created.revision }]) };
  }
  if (request.method() === "PATCH") {
    const body = request.postDataJSON() as { data: unknown; schema_version: number };
    if (!own || filter("user_id") !== userId || filter("revision") !== String(own.revision)) return { status: 200, body: [] };
    const updated = { data: body.data, schema_version: body.schema_version, revision: nextRevision(userId) };
    cloud.saves.set(userId, updated);
    return { status: 200, body: [{ revision: updated.revision }] };
  }
  return { status: 405, body: { code: "PGRST000", message: "Not mocked" } };
}

/**
 * Answers the app's Supabase Auth requests in the browser, so no real project is involved.
 * The defaults behave like a working project; tests swap in failures with `reply`.
 */
export async function useFakeAuth(page: Page, cloud: FakeCloud = createFakeCloud()): Promise<FakeAuth> {
  const requests: Request[] = [];
  const handlers = new Map<string, Handler>([
    ["POST /otp", () => ({ status: 200, body: {} })],
    ["POST /verify", () => ({ status: 200, body: fakeSession() })],
    ["POST /token", () => ({ status: 200, body: fakeSession() })],
    // Like the real server, /user describes the account the token was issued for.
    ["GET /user", (request) => ({ status: 200, body: fakeUser(emailFromBearer(request) ?? TEST_EMAIL) })],
    ["POST /logout", () => ({ status: 204 })],
  ]);

  await page.route(`${FAKE_SUPABASE_URL}/**`, async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    requests.push(request);

    const pathname = new URL(request.url()).pathname;
    const table = pathname.startsWith("/rest/v1/") ? pathname.slice("/rest/v1/".length) : null;
    const path = table ?? pathname.replace(/^\/auth\/v1/, "");
    const handler = handlers.get(`${request.method()} ${path}`);
    const reply: Reply = handler
      ? await handler(request)
      : table
        ? answerDatabase(cloud, request, table)
        : { status: 404, body: { code: "not_found", msg: "Not mocked" } };
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
    cloud,
  };
}

/** The database requests the app made, as "METHOD table", optionally only one kind. */
export function cloudRequests(fake: FakeAuth, endpoint?: string) {
  return fake.requests
    .filter((request) => new URL(request.url()).pathname.startsWith("/rest/v1/"))
    .map((request) => `${request.method()} ${new URL(request.url()).pathname.slice("/rest/v1/".length)}`)
    .filter((entry) => !endpoint || entry === endpoint);
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

/**
 * Waits for the app to finish starting up: a loaded garden (its date appears), or, for a signed-in
 * player, the cloud garden's first-time choice or its load error. The auth tests use these instead of
 * support.ts's openApp, which waits for a garden only.
 */
export async function waitForAppOrStorageChoice(page: Page) {
  const date = page.getByText(/^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}$/);
  const card = page.getByRole("region", { name: /^(Start your cloud garden\?|Your cloud garden couldn't be loaded)$/ });
  await expect(date.or(card).first()).toBeVisible();
}

export async function openApp(page: Page, path = "/") {
  await page.goto(path);
  await waitForAppOrStorageChoice(page);
}

export async function reloadApp(page: Page) {
  await page.reload();
  await waitForAppOrStorageChoice(page);
}

/**
 * Another tab in the same browser, on the same clock as the tests' first tab. Without the clock, a
 * token issued on the tests' Monday would already have expired there, and that tab would refresh it.
 */
export async function openOtherTab(page: Page) {
  const otherTab = await page.context().newPage();
  await otherTab.clock.install({ time: MONDAY });
  return otherTab;
}

/** useFakeAuth under a name React's hooks lint rule doesn't mistake for a hook, for use inside helpers. */
export const answerSupabaseFor = useFakeAuth;
