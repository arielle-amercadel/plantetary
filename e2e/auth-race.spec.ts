import type { Page } from "@playwright/test";
import {
  TEST_EMAIL,
  authError,
  authRequests,
  createSigningKey,
  fakeSession,
  fakeUser,
  readGameStorage,
  useFakeAuth,
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

/** The access token stored in this browser's session cookie, or null. */
async function storedAccessToken(page: Page) {
  const cookies = await page.context().cookies();
  const chunks = cookies
    .filter((cookie) => /^sb-.+-auth-token(\.\d+)?$/.test(cookie.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (chunks.length === 0) return null;
  const raw = chunks.map((cookie) => cookie.value).join("");
  const json = Buffer.from(raw.replace(/^base64-/, ""), "base64url").toString("utf8");
  return (JSON.parse(json) as { access_token?: string }).access_token ?? null;
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
    // Only the rejected session was ever revoked.
    for (const logout of authRequests(auth, "POST /logout")) {
      expect(logout.headers()["authorization"]).toBe(`Bearer ${oldSession.access_token}`);
    }

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

  test("a token the project's key didn't sign is cleared", async ({ page }) => {
    const projectKey = await createSigningKey();
    const otherKey = await createSigningKey();
    const auth = await useFakeAuth(page);
    auth.reply("POST /verify", { status: 200, body: await otherKey.session() });
    auth.reply("GET /.well-known/jwks.json", { status: 200, body: projectKey.jwks });

    await openApp(page, SIGN_IN_LINK);
    await page.getByRole("button", { name: "Finish signing in" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await reloadApp(page);

    await expect(accountSection(page)).toContainText("Your sign-in had ended");
    expect(authRequests(auth, "GET /user")).toHaveLength(0);
    expect(await storedAccessToken(page)).toBeNull();
  });

  test("an outage fetching the public keys keeps the player signed in", async ({ page }) => {
    const key = await createSigningKey();
    const auth = await useFakeAuth(page);
    auth.reply("POST /verify", { status: 200, body: await key.session() });
    auth.reply("GET /.well-known/jwks.json", "network-error");

    await openApp(page, SIGN_IN_LINK);
    await page.getByRole("button", { name: "Finish signing in" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await reloadApp(page);

    await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);
    expect(authRequests(auth, "GET /user")).toHaveLength(0);
  });
});
