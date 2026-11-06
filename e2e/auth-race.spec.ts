import type { Page } from "@playwright/test";
import {
  TEST_EMAIL,
  authError,
  authRequests,
  createSigningKey,
  fakeSession,
  fakeUser,
  readGameStorage,
  storedAccessToken,
  useFakeAuth,
  type FakeAuth,
} from "./auth-support";
import { completeQuest, expect, openApp, reloadApp, test } from "./support";

const NEW_EMAIL = "new-player@example.com";
const SIGN_IN_LINK = "/auth/confirm?token_hash=pkce_0123456789abcdef&type=email";

function accountSection(page: Page) {
  return page.getByRole("region", { name: "Account" });
}

function deferred() {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { released, release };
}

test.describe("Signing in while an old session is still being checked", () => {
  test("the new sign-in wins, and the old session's late rejection never signs it out", async ({ page }) => {
    const auth = await useFakeAuth(page);
    const oldSession = fakeSession(TEST_EMAIL);
    const newSession = fakeSession(NEW_EMAIL);
    auth.reply("POST /verify", { status: 200, body: oldSession });
    await openApp(page, SIGN_IN_LINK);
    await page.getByRole("button", { name: "Finish signing in" }).click();
    await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);
    await openApp(page);
    await completeQuest(page, "Drink a glass of water");
    const progress = await readGameStorage(page);

    // On the next visit the old session's check is held open, and the server will reject it.
    const gate = deferred();
    auth.reply("GET /user", async (request) => {
      if (request.headers()["authorization"] !== `Bearer ${oldSession.access_token}`) {
        return { status: 200, body: fakeUser(NEW_EMAIL) };
      }
      await gate.released;
      return { status: 403, body: authError("session_not_found", "Session from session_id claim in JWT does not exist") };
    });
    auth.reply("POST /verify", { status: 200, body: newSession });

    await openApp(page, SIGN_IN_LINK);
    await page.getByRole("button", { name: "Finish signing in" }).click();
    await expect(page.getByText("Signing you in…")).toBeVisible();
    gate.release();

    await expect(page).toHaveURL(/\/settings$/);
    await expect(accountSection(page)).toContainText(`Signed in as ${NEW_EMAIL}`);
    expect(await storedAccessToken(page)).toBe(newSession.access_token);
    // Nothing was signed out automatically: the new session simply replaced the old one.
    expect(authRequests(auth, "POST /logout")).toHaveLength(0);

    await reloadApp(page);
    await expect(accountSection(page)).toContainText(`Signed in as ${NEW_EMAIL}`);
    expect(await storedAccessToken(page)).toBe(newSession.access_token);
    expect(await readGameStorage(page)).toEqual(progress);
  });
});

test.describe("Signing out in another tab while this tab is still checking", () => {
  test("this tab follows the sign-out, and the late 'valid' answer doesn't sign it back in", async ({ page }) => {
    const firstTab = await useFakeAuth(page);
    await openApp(page, SIGN_IN_LINK);
    await page.getByRole("button", { name: "Finish signing in" }).click();
    await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);

    const otherTab = await page.context().newPage();
    const gate = deferred();
    const otherAuth = await useFakeAuth(otherTab);
    otherAuth.reply("GET /user", async () => {
      await gate.released;
      return { status: 200, body: fakeUser(TEST_EMAIL) };
    });
    await openApp(otherTab, "/settings");
    await expect(accountSection(otherTab)).toContainText("Checking whether you're signed in");

    await openApp(page, "/settings");
    await accountSection(page).getByRole("button", { name: "Sign out" }).click();
    await expect(accountSection(page)).toContainText("You're signed out");
    await expect(accountSection(otherTab)).toContainText("You're playing as a guest");

    gate.release();
    await expect.poll(() => authRequests(otherAuth, "GET /user").length).toBeGreaterThan(0);
    // Give the late answer time to land, then make sure it changed nothing.
    await otherTab.waitForTimeout(500);
    await expect(accountSection(otherTab)).toContainText("You're playing as a guest");
    expect(authRequests(firstTab, "POST /logout")).toHaveLength(1);
    await otherTab.close();
  });
});

test.describe("Projects that sign tokens with an asymmetric key", () => {
  test("a session is checked locally against the project's public key, without asking /user", async ({ page }) => {
    const key = await createSigningKey();
    const auth = await useFakeAuth(page);
    auth.reply("POST /verify", { status: 200, body: await key.session() });
    auth.reply("GET /.well-known/jwks.json", { status: 200, body: key.jwks });

    await openApp(page, SIGN_IN_LINK);
    await page.getByRole("button", { name: "Finish signing in" }).click();
    await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);
    await reloadApp(page);

    await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);
    expect(authRequests(auth, "GET /.well-known/jwks.json").length).toBeGreaterThan(0);
    expect(authRequests(auth, "GET /user")).toHaveLength(0);
  });

  test("a token the project's key didn't sign is shown as ended, and left for the player to remove", async ({ page }) => {
    const projectKey = await createSigningKey();
    const otherKey = await createSigningKey();
    const auth = await useFakeAuth(page);
    auth.reply("POST /verify", { status: 200, body: await otherKey.session() });
    auth.reply("GET /.well-known/jwks.json", { status: 200, body: projectKey.jwks });

    await openApp(page, SIGN_IN_LINK);
    await page.getByRole("button", { name: "Finish signing in" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await reloadApp(page);

    await expect(accountSection(page)).toContainText(`Your sign-in for ${TEST_EMAIL} has ended`);
    expect(authRequests(auth, "GET /user")).toHaveLength(0);
    expect(authRequests(auth, "POST /logout")).toHaveLength(0);
    expect(await storedAccessToken(page)).not.toBeNull();
  });

  test("an outage fetching the public keys keeps the session, unconfirmed", async ({ page }) => {
    const key = await createSigningKey();
    const auth = await useFakeAuth(page);
    auth.reply("POST /verify", { status: 200, body: await key.session() });
    auth.reply("GET /.well-known/jwks.json", "network-error");

    await openApp(page, SIGN_IN_LINK);
    await page.getByRole("button", { name: "Finish signing in" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await reloadApp(page);

    await expect(accountSection(page)).toContainText(`couldn't confirm your sign-in for ${TEST_EMAIL}`);
    await expect(accountSection(page)).not.toContainText("Signed in as");
    expect(authRequests(auth, "GET /user")).toHaveLength(0);
  });
});

test.describe("Signing in from another tab while this tab is checking an old session", () => {
  test("the other tab's new session survives this tab's late rejection, and this tab shows it", async ({ page }) => {
    const auth = await useFakeAuth(page);
    const oldSession = fakeSession(TEST_EMAIL);
    const newSession = fakeSession(NEW_EMAIL);
    auth.reply("POST /verify", { status: 200, body: oldSession });
    await openApp(page, SIGN_IN_LINK);
    await page.getByRole("button", { name: "Finish signing in" }).click();
    await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);

    // This tab reloads; its check of the old session is held open and will be rejected.
    const gate = deferred();
    auth.reply("GET /user", async (request) => {
      if (request.headers()["authorization"] !== `Bearer ${oldSession.access_token}`) {
        return { status: 200, body: fakeUser(NEW_EMAIL) };
      }
      await gate.released;
      return { status: 403, body: authError("session_not_found", "Session from session_id claim in JWT does not exist") };
    });
    await openApp(page, "/settings");
    await expect(accountSection(page)).toContainText("Checking whether you're signed in");

    // Meanwhile another tab finishes a new sign-in.
    const otherTab = await page.context().newPage();
    const otherAuth = await useFakeAuth(otherTab);
    otherAuth.reply("POST /verify", { status: 200, body: newSession });
    otherAuth.reply("GET /user", { status: 200, body: fakeUser(NEW_EMAIL) });
    await openApp(otherTab, SIGN_IN_LINK);
    await otherTab.getByRole("button", { name: "Finish signing in" }).click();
    await expect(accountSection(otherTab)).toContainText(`Signed in as ${NEW_EMAIL}`);
    await expect(accountSection(page)).toContainText(`Signed in as ${NEW_EMAIL}`);

    // Now the old session's rejection arrives in the first tab.
    gate.release();
    await expect.poll(() => authRequests(auth, "GET /user").length).toBeGreaterThan(0);
    await page.waitForTimeout(500);

    expect(await storedAccessToken(page)).toBe(newSession.access_token);
    await expect(accountSection(page)).toContainText(`Signed in as ${NEW_EMAIL}`);
    await expect(accountSection(otherTab)).toContainText(`Signed in as ${NEW_EMAIL}`);
    expect(authRequests(auth, "POST /logout")).toHaveLength(0);
    expect(authRequests(otherAuth, "POST /logout")).toHaveLength(0);
    await otherTab.close();
  });
});

test.describe("Expired sessions", () => {
  /**
   * Signs in, then lets the token expire, as if the player came back two hours later. `refresh` is how the
   * server answers supabase-js's refresh, which may happen as soon as the clock moves or on the next load.
   */
  async function signInWithExpiredToken(page: Page, auth: FakeAuth, refresh: { status: number; body?: unknown }) {
    auth.reply("POST /verify", { status: 200, body: fakeSession(TEST_EMAIL) });
    await openApp(page, SIGN_IN_LINK);
    await page.getByRole("button", { name: "Finish signing in" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);
    auth.reply("POST /token", refresh);
    await page.clock.fastForward("02:00:00");
  }

  test("an expired session whose refresh is refused ends, and the app itself signs nothing out", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await signInWithExpiredToken(page, auth, { status: 400, body: authError("refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found") });

    await reloadApp(page);

    await expect(accountSection(page)).toContainText("You're playing as a guest");
    // supabase-js removed the session it couldn't refresh; Plantetary never called sign-out.
    expect(await storedAccessToken(page)).toBeNull();
    expect(authRequests(auth, "POST /logout")).toHaveLength(0);
  });

  test("an expired session that refreshes stays signed in", async ({ page }) => {
    const auth = await useFakeAuth(page);
    // Valid until three hours after the start, so it's still good after the clock moves on two hours. Its
    // token also differs from the original's, so the refresh is visible.
    const refreshed = fakeSession(TEST_EMAIL, 3 * 3600);
    await signInWithExpiredToken(page, auth, { status: 200, body: refreshed });

    await reloadApp(page);

    await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);
    expect(await storedAccessToken(page)).toBe(refreshed.access_token);
  });
});

/** Hides the tab, then shows it again, the way switching tabs does. supabase-js re-announces its session on "visible". */
async function hideAndShowTab(page: Page) {
  for (const state of ["hidden", "visible"] as const) {
    await page.evaluate((visibility) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => visibility === "hidden" });
      window.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);
  }
}

test.describe("Returning to a tab after a sign-in has ended", () => {
  async function endSignIn(page: Page, auth: FakeAuth) {
    const session = fakeSession(TEST_EMAIL);
    auth.reply("POST /verify", { status: 200, body: session });
    await openApp(page, SIGN_IN_LINK);
    await page.getByRole("button", { name: "Finish signing in" }).click();
    await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);
    auth.reply("GET /user", { status: 403, body: authError("user_not_found", "User from sub claim in JWT does not exist") });
    await reloadApp(page);
    await expect(accountSection(page)).toContainText(`Your sign-in for ${TEST_EMAIL} has ended`);
    return session;
  }

  test("the same rejected session re-announced when the tab is shown again stays ended", async ({ page }) => {
    const auth = await useFakeAuth(page);
    const session = await endSignIn(page, auth);

    await hideAndShowTab(page);
    await page.waitForTimeout(500);
    await hideAndShowTab(page);
    await page.waitForTimeout(500);

    await expect(accountSection(page)).toContainText(`Your sign-in for ${TEST_EMAIL} has ended`);
    await expect(accountSection(page)).not.toContainText("Signed in as");
    expect(await storedAccessToken(page)).toBe(session.access_token);
    expect(authRequests(auth, "POST /logout")).toHaveLength(0);
  });

  test("a new sign-in after the old one ended still signs in", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await endSignIn(page, auth);
    const newSession = fakeSession(NEW_EMAIL);
    auth.reply("POST /verify", { status: 200, body: newSession });
    auth.reply("GET /user", { status: 200, body: fakeUser(NEW_EMAIL) });

    await openApp(page, SIGN_IN_LINK);
    await page.getByRole("button", { name: "Finish signing in" }).click();

    await expect(accountSection(page)).toContainText(`Signed in as ${NEW_EMAIL}`);
    expect(await storedAccessToken(page)).toBe(newSession.access_token);
    await hideAndShowTab(page);
    await page.waitForTimeout(500);
    await expect(accountSection(page)).toContainText(`Signed in as ${NEW_EMAIL}`);
  });

  test("another tab's new sign-in replaces the ended session here too", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await endSignIn(page, auth);

    const otherTab = await page.context().newPage();
    const otherAuth = await useFakeAuth(otherTab);
    const newSession = fakeSession(NEW_EMAIL);
    otherAuth.reply("POST /verify", { status: 200, body: newSession });
    otherAuth.reply("GET /user", { status: 200, body: fakeUser(NEW_EMAIL) });
    // This tab checks the new session itself before showing it. The server still rejects the old token,
    // but accepts the one it has just issued.
    auth.reply("GET /user", (request) => request.headers()["authorization"] === `Bearer ${newSession.access_token}`
      ? { status: 200, body: fakeUser(NEW_EMAIL) }
      : { status: 403, body: authError("user_not_found", "User from sub claim in JWT does not exist") });
    await openApp(otherTab, SIGN_IN_LINK);
    await otherTab.getByRole("button", { name: "Finish signing in" }).click();
    await expect(accountSection(otherTab)).toContainText(`Signed in as ${NEW_EMAIL}`);

    await expect(accountSection(page)).toContainText(`Signed in as ${NEW_EMAIL}`);
    expect(await storedAccessToken(page)).toBe(newSession.access_token);
    await otherTab.close();
  });
});
