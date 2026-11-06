import type { Page } from "@playwright/test";
import {
  FAKE_PUBLISHABLE_KEY,
  TEST_EMAIL,
  authError,
  authRequests,
  fakeSession,
  fakeUser,
  readGameStorage,
  storedAccessToken,
  useFakeAuth,
  type FakeAuth,
  openApp,
  reloadApp,
} from "./auth-support";
import {
  QUEST_SAVE_KEY,
  completeQuest,
  expect,
  expectHomeXp,
  test,
} from "./support";

const SIGN_IN_LINK = "/auth/confirm?token_hash=pkce_0123456789abcdef&type=email";

function accountSection(page: Page) {
  return page.getByRole("region", { name: "Account" });
}

async function requestLink(page: Page, email = TEST_EMAIL) {
  await accountSection(page).getByLabel("Email address").fill(email);
  await accountSection(page).getByRole("button", { name: "Email me a sign-in link" }).click();
}

async function signIn(page: Page) {
  await openApp(page, SIGN_IN_LINK);
  await page.getByRole("button", { name: "Finish signing in" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);
}

/** A guest who has already played: one quest done, so there is real progress to protect. */
async function playAsGuest(page: Page) {
  await openApp(page);
  await completeQuest(page, "Drink a glass of water");
  await expectHomeXp(page, 5);
}

async function expectGuestProgress(page: Page) {
  await openApp(page);
  await expect(page.getByRole("button", { name: "Mark incomplete: Drink a glass of water", exact: true })).toBeVisible();
  await expectHomeXp(page, 5);
}

test.describe("Guest mode", () => {
  test("works as before, without contacting Supabase", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await playAsGuest(page);
    await reloadApp(page);
    await expectGuestProgress(page);

    await openApp(page, "/settings");
    await expect(accountSection(page)).toContainText("You're playing as a guest");
    expect(auth.requests).toHaveLength(0);
  });

  test("keeps sign-in and game saves apart: no session or Supabase data in localStorage", async ({ page }) => {
    await useFakeAuth(page);
    await signIn(page);

    const keys = Object.keys(await readGameStorage(page));
    expect(keys.every((key) => key.startsWith("plantetary-"))).toBe(true);
    const cookies = await page.context().cookies();
    expect(cookies.some((cookie) => cookie.name.startsWith("sb-") && cookie.name.endsWith("-auth-token"))).toBe(true);
  });
});

test.describe("Requesting a sign-in link", () => {
  test("sends the link to this site's confirm page with the publishable key", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await openApp(page, "/settings");

    await requestLink(page, "  Mira@Example.com ");

    await expect(accountSection(page)).toContainText("Check your inbox at Mira@Example.com");
    const [request] = authRequests(auth, "POST /otp");
    const url = new URL(request.url());
    expect(url.searchParams.get("redirect_to")).toBe(new URL("/auth/confirm", page.url()).toString());
    expect(request.postDataJSON()).toMatchObject({ email: "Mira@Example.com", create_user: true });
    expect(request.postDataJSON().code_challenge).toBeTruthy();
    expect(request.headers()["apikey"]).toBe(FAKE_PUBLISHABLE_KEY);
  });

  test("catches an invalid address without contacting Supabase", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await openApp(page, "/settings");

    await requestLink(page, "mira at example");

    await expect(accountSection(page)).toContainText("That email address can't be used");
    expect(auth.requests).toHaveLength(0);
  });

  test("explains a rate limit", async ({ page }) => {
    const auth = await useFakeAuth(page);
    auth.reply("POST /otp", { status: 429, body: authError("over_email_send_rate_limit", "email rate limit exceeded") });
    await openApp(page, "/settings");

    await requestLink(page);

    await expect(accountSection(page)).toContainText("Too many sign-in emails were requested");
  });

  test("explains a connection problem", async ({ page }) => {
    const auth = await useFakeAuth(page);
    auth.reply("POST /otp", "network-error");
    await openApp(page, "/settings");

    await requestLink(page);

    await expect(accountSection(page)).toContainText("couldn't reach the sign-in service");
    await expect(accountSection(page).getByRole("button", { name: "Email me a sign-in link" })).toBeEnabled();
  });
});

test.describe("Opening a sign-in link", () => {
  test("waits for the player, removes the token from the address bar, then signs in", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await openApp(page, SIGN_IN_LINK);

    await expect(page.getByRole("button", { name: "Finish signing in" })).toBeVisible();
    expect(new URL(page.url()).search).toBe("");
    // Nothing is verified until the button is pressed, so a link scanner can't use up the link.
    expect(authRequests(auth, "POST /verify")).toHaveLength(0);

    await page.getByRole("button", { name: "Finish signing in" }).click();

    await expect(page).toHaveURL(/\/settings$/);
    await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);
    expect(authRequests(auth, "POST /verify")[0].postDataJSON()).toMatchObject({
      token_hash: "pkce_0123456789abcdef",
      type: "email",
    });
  });

  test("explains a default code link opened in a different browser", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await openApp(page, "/auth/confirm?code=0b9c5d6e-1234-4abc-9def-1234567890ab");

    // The code verifier lives in the browser that asked for the link; this one never did.
    await expect(page.getByRole("main").getByRole("alert")).toContainText("requested in a different browser");
    expect(authRequests(auth, "POST /token")).toHaveLength(0);
  });

  test("explains an expired link reported by Supabase", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await openApp(page, "/auth/confirm?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");

    await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to Settings" })).toBeVisible();
    expect(auth.requests).toHaveLength(0);
  });

  test("explains a link that has already been used", async ({ page }) => {
    const auth = await useFakeAuth(page);
    auth.reply("POST /verify", { status: 403, body: authError("otp_expired", "Email link is invalid or has expired") });
    await openApp(page, SIGN_IN_LINK);

    await page.getByRole("button", { name: "Finish signing in" }).click();

    await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
    await openApp(page, "/settings");
    await expect(accountSection(page)).toContainText("You're playing as a guest");
  });

  test("rejects a malformed link without contacting Supabase", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await openApp(page, "/auth/confirm?token_hash=abc123def456&type=recovery");

    await expect(page.getByRole("main").getByRole("alert")).toContainText("This sign-in link isn't valid");
    expect(auth.requests).toHaveLength(0);
  });

  test("is forwarded to the confirm page if it lands on the home page", async ({ page }) => {
    await useFakeAuth(page);
    await page.goto("/?token_hash=pkce_0123456789abcdef&type=email");

    await expect(page.getByRole("button", { name: "Finish signing in" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/auth/confirm");
    expect(new URL(page.url()).search).toBe("");
  });

  test("explains a visit with no link", async ({ page }) => {
    await useFakeAuth(page);
    await openApp(page, "/auth/confirm");

    await expect(page.getByRole("main").getByRole("alert")).toContainText("no link was found");
  });

  test("offers a retry after a dropped connection, without a new email", async ({ page }) => {
    const auth = await useFakeAuth(page);
    auth.reply("POST /verify", "network-error");
    await openApp(page, SIGN_IN_LINK);
    await page.getByRole("button", { name: "Finish signing in" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("couldn't reach the sign-in service");

    auth.reply("POST /verify", { status: 200, body: fakeSession() });
    await page.getByRole("button", { name: "Try again" }).click();

    await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);
  });
});

test.describe("Staying signed in", () => {
  test("restores the session after a refresh, checking it with the server", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await signIn(page);
    const checksBefore = authRequests(auth, "GET /user").length;

    await reloadApp(page);

    await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);
    expect(authRequests(auth, "GET /user").length).toBeGreaterThan(checksBefore);
  });

  test("shows a session the server no longer accepts as ended, without deleting it, until the player removes it", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await signIn(page);
    const token = await storedAccessToken(page);
    auth.reply("GET /user", { status: 403, body: authError("user_not_found", "User from sub claim in JWT does not exist") });

    await reloadApp(page);

    await expect(accountSection(page)).toContainText(`Your sign-in for ${TEST_EMAIL} has ended`);
    await expect(accountSection(page).getByLabel("Email address")).toBeVisible();
    // Nothing was deleted automatically: the UI says it's still stored, and it is.
    expect(await storedAccessToken(page)).toBe(token);
    expect(authRequests(auth, "POST /logout")).toHaveLength(0);
    await reloadApp(page);
    await expect(accountSection(page)).toContainText("has ended");

    await accountSection(page).getByRole("button", { name: "Remove it from this browser" }).click();
    await expect(accountSection(page)).toContainText("You're signed out");
    expect(await storedAccessToken(page)).toBeNull();
    await reloadApp(page);
    await expect(accountSection(page)).toContainText("You're playing as a guest");
  });

  test("keeps the session through a brief outage, unconfirmed, and confirms it once back online", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await signIn(page);
    const token = await storedAccessToken(page);
    auth.reply("GET /user", "network-error");

    await reloadApp(page);

    // Kept, but not shown as signed in: nothing about it could be verified.
    await expect(accountSection(page)).toContainText(`couldn't confirm your sign-in for ${TEST_EMAIL}`);
    await expect(accountSection(page)).not.toContainText("Signed in as");
    await expect(accountSection(page).getByRole("button", { name: "Sign out" })).toBeVisible();
    expect(await storedAccessToken(page)).toBe(token);
    expect(authRequests(auth, "POST /logout")).toHaveLength(0);

    auth.reply("GET /user", { status: 200, body: fakeUser(TEST_EMAIL) });
    await reloadApp(page);

    await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);
  });
});

test.describe("Signing out", () => {
  test("signs out of this browser only", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await signIn(page);

    await accountSection(page).getByRole("button", { name: "Sign out" }).click();

    await expect(accountSection(page)).toContainText("You're signed out. Your progress on this device is unchanged.");
    expect(new URL(authRequests(auth, "POST /logout")[0].url()).searchParams.get("scope")).toBe("local");
    await reloadApp(page);
    await expect(accountSection(page)).toContainText("You're playing as a guest");
  });

  test("still signs out here when the server can't be reached", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await signIn(page);
    auth.reply("POST /logout", "network-error");

    await accountSection(page).getByRole("button", { name: "Sign out" }).click();

    await expect(accountSection(page)).toContainText("You're signed out on this device");
    await reloadApp(page);
    await expect(accountSection(page)).toContainText("You're playing as a guest");
  });
});

test.describe("Guest progress is never touched", () => {
  async function checkAround(page: Page, auth: FakeAuth, action: () => Promise<void>) {
    const before = await readGameStorage(page);
    await action();
    expect(await readGameStorage(page)).toEqual(before);
    // Signing in may read the account's cloud save, but it never writes or uploads anything.
    expect(auth.requests.filter((request) => request.url().includes("/rest/v1/") && request.method() !== "GET")).toEqual([]);
  }

  test("signing in and out leaves every game save and backup byte-for-byte the same", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await playAsGuest(page);
    const save = await page.evaluate((key) => window.localStorage.getItem(key), QUEST_SAVE_KEY);
    expect(save).toBeTruthy();

    await checkAround(page, auth, () => signIn(page));
    // The account has no cloud save, so it asks first, and the browser save is left alone.
    await openApp(page);
    await expect(page.getByRole("region", { name: "Start your cloud garden?" })).toBeVisible();
    expect(await page.evaluate((key) => window.localStorage.getItem(key), QUEST_SAVE_KEY)).toBe(save);

    await openApp(page, "/settings");
    await checkAround(page, auth, async () => {
      await accountSection(page).getByRole("button", { name: "Sign out" }).click();
      await expect(accountSection(page)).toContainText("You're signed out");
    });
    await expectGuestProgress(page);
  });

  test("a failed or expired sign-in leaves progress the same", async ({ page }) => {
    const auth = await useFakeAuth(page);
    auth.reply("POST /verify", { status: 403, body: authError("otp_expired") });
    await playAsGuest(page);

    await checkAround(page, auth, async () => {
      await openApp(page, SIGN_IN_LINK);
      await page.getByRole("button", { name: "Finish signing in" }).click();
      await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
    });
    await expectGuestProgress(page);
  });

  test("choosing to play on this device while signed in saves to this browser exactly as a guest does", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await signIn(page);
    await openApp(page);
    await page.getByRole("button", { name: "Keep playing on this device" }).click();

    await completeQuest(page, "Drink a glass of water");
    await expectHomeXp(page, 5);
    await reloadApp(page);
    await expectHomeXp(page, 5);
    // Nothing was written to the account: only its (missing) cloud save was read, once per load.
    expect(auth.requests.filter((request) => request.url().includes("/rest/v1/") && request.method() !== "GET")).toEqual([]);
    expect(JSON.parse((await page.evaluate((key) => window.localStorage.getItem(key), QUEST_SAVE_KEY)) ?? "{}").legacyXpBonus ?? 0).toBe(0);
  });
});
