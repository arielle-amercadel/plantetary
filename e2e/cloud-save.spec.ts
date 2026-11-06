import { readFile } from "node:fs/promises";
import type { Download, Page, Request } from "@playwright/test";
import {
  TEST_EMAIL,
  cloudRequests,
  createFakeCloud,
  fakeSession,
  fakeUser,
  useFakeAuth,
  type FakeAuth,
  openOtherTab,
  storedAccessToken,
  answerSupabaseFor,
} from "./auth-support";
import {
  QUEST_SAVE_KEY,
  completeQuest,
  expect,
  expectHomeXp,
  openApp,
  readStorage,
  reloadApp,
  test,
} from "./support";

const SIGN_IN_LINK = "/auth/confirm?token_hash=pkce_0123456789abcdef&type=email";
const OTHER_EMAIL = "other-player@example.com";
const THIRD_EMAIL = "third-player@example.com";

function deferred() {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { released, release };
}

/** Signs in as `email` in a second tab of the same browser, which every open tab then follows. */
async function signInElsewhere(page: Page, cloud: FakeAuth["cloud"], email: string) {
  const otherTab = await openOtherTab(page);
  const otherAuth = await answerSupabaseFor(otherTab, cloud);
  otherAuth.reply("POST /verify", { status: 200, body: fakeSession(email) });
  otherAuth.reply("POST /token", { status: 200, body: fakeSession(email) });
  await otherTab.goto(SIGN_IN_LINK);
  await otherTab.getByRole("button", { name: "Finish signing in" }).click();
  await expect(otherTab.getByRole("region", { name: "Account" })).toContainText(`Signed in as ${email}`);
  await otherTab.close();
}

/** Nothing on the page can be played: no quest can be completed, added, edited or removed. */
async function expectNothingPlayable(page: Page) {
  await expect(page.getByRole("button", { name: /^(Complete|Mark incomplete): / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Add habit|Add quest|Edit |Remove )/ })).toHaveCount(0);
}

const accountSection = (page: Page) => page.getByRole("region", { name: "Account" });
const choiceCard = (page: Page) => page.getByRole("region", { name: "Start your cloud garden?" });
const failedCard = (page: Page) => page.getByRole("region", { name: "Your cloud garden couldn't be loaded" });

/** A guest who has played: one quest done, 5 XP, saved in this browser. */
async function playAsGuest(page: Page) {
  await openApp(page);
  await completeQuest(page, "Drink a glass of water");
  await expectHomeXp(page, 5);
  return readStorage(page, QUEST_SAVE_KEY);
}

/** Finishes a sign-in link and lands on Settings. The garden then loads from the account. */
async function signIn(page: Page) {
  await page.goto(SIGN_IN_LINK);
  await page.getByRole("button", { name: "Finish signing in" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);
}

/** Goes Home and waits for a loaded garden (the date appears once it's loaded). */
async function openGarden(page: Page) {
  await page.goto("/");
  await expect(page.getByText(/^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}$/)).toBeVisible();
}

/** A cloud garden that differs from the guest's: 45 XP instead of 5. */
function cloudGardenFrom(guestSave: string | null) {
  return { ...JSON.parse(guestSave ?? "{}"), legacyXpBonus: 40 };
}

/** Whether the account's cloud save records this daily quest as done on the tests' Monday. */
function cloudCompleted(auth: FakeAuth, questId: string, email = TEST_EMAIL) {
  const data = auth.cloud.saveOf(email)?.data as { completionHistory?: Record<string, { completedQuestIds?: string[] }> } | undefined;
  return data?.completionHistory?.["2026-10-19"]?.completedQuestIds?.includes(questId) ?? false;
}

/** Account A with a cloud garden and a change that couldn't be saved (saving fails), on Settings. */
async function makeUnsavedCloudChange(page: Page, auth: FakeAuth) {
  const { cloud } = auth;
  cloud.seed(cloudGardenFrom(await playAsGuest(page)));
  await signIn(page);
  await openGarden(page);
  await expectHomeXp(page, 45);
  auth.reply("PATCH quest_saves", "network-error");
  await completeQuest(page, "Morning skincare");
  // The in-app link keeps the page (and the unsaved change) loaded; a full reload would start over.
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);
  return { auth, cloud };
}

/** Every write the app sent to the database. */
const cloudWrites = (auth: FakeAuth) => cloudRequests(auth).filter((request) => !request.startsWith("GET"));

test.describe("Guests", () => {
  test("never contact the database", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await playAsGuest(page);
    await reloadApp(page);
    await expectHomeXp(page, 5);

    expect(cloudRequests(auth)).toEqual([]);
  });
});

test.describe("A verified account with no cloud save", () => {
  test("is asked first: nothing is shown as its garden, and nothing is written", async ({ page }) => {
    const auth = await useFakeAuth(page);
    const guestSave = await playAsGuest(page);
    await signIn(page);
    await page.goto("/");

    await expect(choiceCard(page)).toBeVisible();
    await expect(page.getByText("Growing your garden")).toBeVisible();
    await page.waitForTimeout(1500);
    expect(cloudWrites(auth)).toEqual([]);
    expect(auth.cloud.saveOf()).toBeUndefined();
    expect(await readStorage(page, QUEST_SAVE_KEY)).toBe(guestSave);
  });

  test("keeping on this device plays the browser save and uploads nothing", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await playAsGuest(page);
    await signIn(page);
    await page.goto("/");

    await choiceCard(page).getByRole("button", { name: "Keep playing on this device" }).click();
    await expectHomeXp(page, 5);
    await completeQuest(page, "Morning skincare");
    await expectHomeXp(page, 10);
    await reloadApp(page);
    await expectHomeXp(page, 10);

    expect(cloudWrites(auth)).toEqual([]);
    expect(auth.cloud.saveOf()).toBeUndefined();
    expect(JSON.parse((await readStorage(page, QUEST_SAVE_KEY)) ?? "{}").completionHistory).toBeTruthy();
    await page.goto("/settings");
    await expect(accountSection(page)).toContainText("keep playing with the progress saved in this browser");
  });

  test("starting fresh saves starter data to the account, never the guest's progress", async ({ page }) => {
    const auth = await useFakeAuth(page);
    const guestSave = await playAsGuest(page);
    await signIn(page);
    await page.goto("/");

    await choiceCard(page).getByRole("button", { name: "Start a fresh cloud garden" }).click();
    await expectHomeXp(page, 0);
    await expect(page.getByRole("button", { name: "Complete: Drink a glass of water", exact: true })).toBeVisible();
    await expect.poll(() => auth.cloud.saveOf()?.revision).toBeGreaterThanOrEqual(1);
    expect(cloudRequests(auth, "POST quest_saves")).toHaveLength(1);

    await completeQuest(page, "Evening stretch");
    await expectHomeXp(page, 5);
    await expect.poll(() => cloudCompleted(auth, "stretch")).toBe(true);

    // The cloud garden comes back after a reload; the guest's own save was never changed.
    await openGarden(page);
    await expectHomeXp(page, 5);
    await expect(page.getByRole("button", { name: "Mark incomplete: Evening stretch", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Complete: Drink a glass of water", exact: true })).toBeVisible();
    expect(await readStorage(page, QUEST_SAVE_KEY)).toBe(guestSave);
  });
});

test.describe("A verified account with a cloud save", () => {
  test("loads its own garden, saves only conditional updates, and never touches the browser save", async ({ page }) => {
    const cloud = createFakeCloud();
    const auth = await useFakeAuth(page, cloud);
    const guestSave = await playAsGuest(page);
    cloud.seed(cloudGardenFrom(guestSave));
    await signIn(page);

    await openGarden(page);
    await expectHomeXp(page, 45);
    await completeQuest(page, "Morning skincare");
    await expectHomeXp(page, 50);
    await expect.poll(() => cloudCompleted(auth, "skincare")).toBe(true);

    expect(cloudRequests(auth, "POST quest_saves")).toEqual([]);
    expect(cloudRequests(auth, "PATCH quest_saves").length).toBeGreaterThan(0);
    expect(await readStorage(page, QUEST_SAVE_KEY)).toBe(guestSave);
  });

  test("signing out goes back to the browser garden, and the cloud garden stays as it was", async ({ page }) => {
    const cloud = createFakeCloud();
    await useFakeAuth(page, cloud);
    const guestSave = await playAsGuest(page);
    cloud.seed(cloudGardenFrom(guestSave));
    await signIn(page);
    await openGarden(page);
    await expectHomeXp(page, 45);
    // Loading may save once (a plant gift that became due at 45 XP); wait for that before comparing.
    await page.waitForTimeout(1500);
    const saved = JSON.stringify(cloud.saveOf());

    await page.goto("/settings");
    await accountSection(page).getByRole("button", { name: "Sign out" }).click();
    await expect(accountSection(page)).toContainText("You're signed out");
    await openGarden(page);

    await expectHomeXp(page, 5);
    expect(JSON.stringify(cloud.saveOf())).toBe(saved);
  });

  test("Reset is turned off for a cloud garden, so it can't seem to reset it", async ({ page }) => {
    const cloud = createFakeCloud();
    await useFakeAuth(page, cloud);
    cloud.seed(cloudGardenFrom(await playAsGuest(page)));
    await signIn(page);
    await openGarden(page);
    await page.goto("/settings");

    await expect(page.getByRole("button", { name: "Reset Plantetary data" })).toBeDisabled();
    await expect(page.getByRole("region", { name: "Data management" })).toContainText("Reset can't change yet");
  });
});

test.describe("When the cloud garden can't be loaded", () => {
  test("says so, shows no starter garden in its place, writes nothing, and can try again", async ({ page }) => {
    const cloud = createFakeCloud();
    const auth = await useFakeAuth(page, cloud);
    const guestSave = await playAsGuest(page);
    cloud.seed(cloudGardenFrom(guestSave));
    auth.reply("GET quest_saves", { status: 503, body: { code: "PGRST000", message: "Service unavailable" } });
    await signIn(page);
    await page.goto("/");

    await expect(failedCard(page)).toBeVisible({ timeout: 20_000 });
    await expect(failedCard(page)).toContainText("The server had a problem");
    await expect(page.getByText("Growing your garden")).toBeVisible();
    expect(cloudWrites(auth)).toEqual([]);

    // The server recovers.
    auth.reply("GET quest_saves", () => {
      const own = cloud.saveOf();
      return { status: 200, body: own ? [{ data: own.data, schema_version: own.schema_version, revision: own.revision }] : [] };
    });
    await failedCard(page).getByRole("button", { name: "Try again" }).click();
    await expectHomeXp(page, 45);
  });
});

test.describe("Conflicts", () => {
  test("a change from another device is never overwritten, and saving stops", async ({ page }) => {
    const cloud = createFakeCloud();
    const auth = await useFakeAuth(page, cloud);
    const guestSave = await playAsGuest(page);
    cloud.seed(cloudGardenFrom(guestSave));
    await signIn(page);
    await openGarden(page);
    await expectHomeXp(page, 45);
    // Any save from loading (the cloud's short pause is 750 ms) finishes first.
    await page.waitForTimeout(1500);

    // Another device saves.
    const theirs = { ...cloudGardenFrom(guestSave), legacyXpBonus: 90 };
    cloud.seed(theirs);
    await completeQuest(page, "Morning skincare");
    await expect.poll(() => cloud.backups.filter((backup) => backup.reason === "conflict").length).toBe(1);
    const patches = cloudRequests(auth, "PATCH quest_saves").length;

    await completeQuest(page, "Read for 20 minutes");
    await page.waitForTimeout(2000);

    expect(cloudRequests(auth, "PATCH quest_saves")).toHaveLength(patches);
    expect(cloud.saveOf()?.data).toEqual(theirs);
  });
});

test.describe("Signing out with unsaved changes", () => {
  test("warns first, and Cancel keeps the player signed in", async ({ page }) => {
    await makeUnsavedCloudChange(page, await useFakeAuth(page));

    await accountSection(page).getByRole("button", { name: "Sign out" }).click();
    const warning = accountSection(page).getByRole("alertdialog");
    await expect(warning).toContainText("Sign out with unsaved changes?");
    await expect(warning).toHaveAttribute("data-save-status", "error");
    await expect(warning).toContainText("Plantetary couldn't reach the server");
    await warning.getByRole("button", { name: "Cancel" }).click();

    await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);
    await expect(accountSection(page)).toContainText("You're still signed in");
  });

  test("Try saving again saves them, then signs out", async ({ page }) => {
    const auth = await useFakeAuth(page);
    const { cloud } = await makeUnsavedCloudChange(page, auth);
    await accountSection(page).getByRole("button", { name: "Sign out" }).click();
    await expect(accountSection(page).getByRole("alertdialog")).toBeVisible();

    // The connection is back.
    auth.reply("PATCH quest_saves", (request) => {
      const own = cloud.saveOf();
      if (!own) return { status: 200, body: [] };
      const body = request.postDataJSON() as { data: unknown; schema_version: number };
      const revision = cloud.nextRevision(fakeUser().id);
      cloud.saves.set(fakeUser().id, { data: body.data, schema_version: body.schema_version, revision });
      return { status: 200, body: [{ revision }] };
    });
    await accountSection(page).getByRole("button", { name: "Try saving again" }).click();

    await expect(accountSection(page)).toContainText("You're signed out");
    expect(cloudCompleted(auth, "skincare")).toBe(true);
  });

  test("Sign out anyway signs out, without a later notice about the same changes", async ({ page }) => {
    await makeUnsavedCloudChange(page, await useFakeAuth(page));
    await accountSection(page).getByRole("button", { name: "Sign out" }).click();

    await accountSection(page).getByRole("button", { name: "Sign out anyway" }).click();

    await expect(accountSection(page)).toContainText("You're signed out");
    await expect(page.getByRole("region", { name: "Some changes weren't saved" })).toHaveCount(0);
  });
});

test.describe("Another account signing in from another tab", () => {
  test("replaces this tab's garden without showing or saving the first account's data for it", async ({ page }) => {
    const cloud = createFakeCloud();
    const auth = await useFakeAuth(page, cloud);
    const guestSave = await playAsGuest(page);
    cloud.seed(cloudGardenFrom(guestSave));
    await signIn(page);
    await openGarden(page);
    await expectHomeXp(page, 45);

    const otherTab = await openOtherTab(page);
    const otherAuth = await useFakeAuth(otherTab, cloud);
    otherAuth.reply("POST /verify", { status: 200, body: fakeSession(OTHER_EMAIL) });
    otherAuth.reply("POST /token", { status: 200, body: fakeSession(OTHER_EMAIL) });
    await otherTab.goto(SIGN_IN_LINK);
    await otherTab.getByRole("button", { name: "Finish signing in" }).click();
    await expect(otherTab.getByRole("region", { name: "Account" })).toContainText(`Signed in as ${OTHER_EMAIL}`);

    // This tab follows the new account: it has no cloud save, so the choice appears, and A's garden is gone.
    await expect(choiceCard(page)).toBeVisible();
    await expect(page.getByText("45 / 100 XP", { exact: true })).toHaveCount(0);
    await page.waitForTimeout(1500);
    expect(cloud.saveOf(OTHER_EMAIL)).toBeUndefined();
    expect(cloudWrites(auth).filter((request) => request === "POST quest_saves")).toEqual([]);
    await otherTab.close();
  });
});

test.describe("Nothing can be played before the garden has loaded (Codex Step 5 finding 1)", () => {
  test("while the cloud save is still loading", async ({ page }) => {
    const cloud = createFakeCloud();
    const auth = await useFakeAuth(page, cloud);
    cloud.seed(cloudGardenFrom(await playAsGuest(page)));
    await signIn(page);
    // The sign-in page loaded the garden too, and may still be saving it (after the 750 ms pause).
    await page.waitForTimeout(1500);
    const garden = (writes: string[]) => writes.filter((request) => request.endsWith(" quest_saves"));
    const writesBefore = garden(cloudWrites(auth)).length;
    const gate = deferred();
    auth.reply("GET quest_saves", async () => {
      await gate.released;
      const own = cloud.saveOf();
      return { status: 200, body: own ? [{ data: own.data, schema_version: own.schema_version, revision: own.revision }] : [] };
    });

    await page.goto("/");
    await expect(page.getByRole("region", { name: "Daily Quests" })).toContainText("Your quests will appear once your garden has loaded");
    await expectNothingPlayable(page);
    await page.getByRole("link", { name: "All Quests" }).click();
    await expect(page.getByRole("region", { name: "Personal Quests" })).toContainText("once your garden has loaded");
    await expectNothingPlayable(page);
    await page.getByRole("link", { name: "Add quest" }).first().click();
    await expect(page.getByLabel("Quest title *")).toHaveCount(0);
    // No garden was written while it was loading.
    expect(garden(cloudWrites(auth))).toHaveLength(writesBefore);

    gate.release();
    await page.getByRole("link", { name: "Home", exact: true }).click();
    await expectHomeXp(page, 45);
    await completeQuest(page, "Morning skincare");
    await expect.poll(() => cloudCompleted(auth, "skincare")).toBe(true);
  });

  test("before the first-time choice", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await playAsGuest(page);
    await signIn(page);

    await page.goto("/");
    await expect(choiceCard(page)).toBeVisible();
    await expectNothingPlayable(page);
    await page.getByRole("link", { name: "All Quests" }).click();
    await expect(choiceCard(page)).toBeVisible();
    await expectNothingPlayable(page);
    await page.waitForTimeout(1000);
    expect(cloudWrites(auth)).toEqual([]);

    await choiceCard(page).getByRole("button", { name: "Start a fresh cloud garden" }).click();
    await expect(page.getByRole("button", { name: "Complete: Drink a glass of water", exact: true })).toBeVisible();
  });

  test("after the cloud save failed to load", async ({ page }) => {
    const cloud = createFakeCloud();
    const auth = await useFakeAuth(page, cloud);
    cloud.seed(cloudGardenFrom(await playAsGuest(page)));
    auth.reply("GET quest_saves", { status: 500, body: { code: "XX000", message: "boom" } });
    await signIn(page);

    await page.goto("/");
    await expect(failedCard(page)).toBeVisible({ timeout: 20_000 });
    await expectNothingPlayable(page);
    await page.getByRole("link", { name: "All Quests" }).click();
    await expectNothingPlayable(page);
    expect(cloudWrites(auth)).toEqual([]);
  });

  test("guests can play as soon as their garden loads", async ({ page }) => {
    await useFakeAuth(page);
    await openApp(page);
    await completeQuest(page, "Drink a glass of water");
    await expectHomeXp(page, 5);
  });
});

test.describe("Unsaved changes from several accounts (Codex Step 5 finding 2, Step 6 follow-up)", () => {
  test("each account's unsaved changes get their own notice, shown only to that account, and none replaces another", async ({ page }) => {
    // Four sign-ins across tabs: more time than one page's test.
    test.slow();
    const cloud = createFakeCloud();
    const auth = await useFakeAuth(page, cloud);
    cloud.seed(cloudGardenFrom(await playAsGuest(page)));
    await signIn(page);
    await openGarden(page);
    await expectHomeXp(page, 45);
    // Saving fails from here on, so changes stay unsaved.
    auth.reply("PATCH quest_saves", "network-error");
    await completeQuest(page, "Morning skincare");

    await signInElsewhere(page, cloud, OTHER_EMAIL);
    await choiceCard(page).getByRole("button", { name: "Start a fresh cloud garden" }).click();
    await expect.poll(() => cloud.saveOf(OTHER_EMAIL)).toBeTruthy();
    await completeQuest(page, "Evening stretch");

    await signInElsewhere(page, cloud, THIRD_EMAIL);
    await expect(choiceCard(page)).toBeVisible();

    // The third account sees neither, not even partly hidden.
    const notices = page.getByRole("region", { name: "Some changes weren't saved" });
    await page.waitForTimeout(500);
    await expect(notices).toHaveCount(0);
    await expect(page.getByText(/(mi|ot)•••@example\.com/)).toHaveCount(0);

    // Back to A: only A's, downloadable, then dismissed.
    await signInElsewhere(page, cloud, TEST_EMAIL);
    await expect(notices.first()).toContainText("mi•••@example.com");
    await expect(page.getByText("ot•••@example.com")).toHaveCount(0);
    const download = page.waitForEvent("download");
    await notices.first().getByRole("button", { name: "Download unsaved changes" }).click();
    expect(await downloadedCompletions(download)).toContain("skincare");
    const aNotices = await notices.count();
    await notices.first().getByRole("button", { name: "Dismiss" }).click();
    await expect(notices).toHaveCount(aNotices - 1);

    // Then the other account: only its own, still there.
    await signInElsewhere(page, cloud, OTHER_EMAIL);
    await expect(notices.first()).toContainText("ot•••@example.com");
    await expect(page.getByText("mi•••@example.com")).toHaveCount(0);
    // Nothing from either was written to the third account.
    expect(cloud.saveOf(THIRD_EMAIL)).toBeUndefined();
  });
});

test.describe("A sign-out belongs to the account that started it (Codex Step 5 finding 3)", () => {
  test("an account change while the warning is open cancels it, and the new account stays signed in", async ({ page }) => {
    const auth = await useFakeAuth(page);
    await makeUnsavedCloudChange(page, auth);
    await accountSection(page).getByRole("button", { name: "Sign out" }).click();
    await expect(accountSection(page).getByRole("alertdialog")).toBeVisible();

    await signInElsewhere(page, auth.cloud, OTHER_EMAIL);

    await expect(accountSection(page)).toContainText(`Signed in as ${OTHER_EMAIL}`);
    await expect(accountSection(page).getByRole("alertdialog")).toHaveCount(0);
    await expect(accountSection(page).getByRole("button", { name: "Sign out anyway" })).toHaveCount(0);
    await expect(accountSection(page)).toContainText("Your account changed in the meantime, so signing out was cancelled");
    expect(auth.requests.filter((request) => request.url().endsWith("/logout"))).toEqual([]);
    expect(await storedAccessToken(page)).toBe(fakeSession(OTHER_EMAIL).access_token);
    // The first account's unsaved changes are kept, for that account only: hidden from this one.
    await expect(page.getByRole("region", { name: "Some changes weren't saved" })).toHaveCount(0);
    expect(await page.evaluate(() => window.sessionStorage.getItem("plantetary-unsaved-cloud-changes"))).toContain(fakeUser().id);
  });

  test("an account change while saving before sign-out cancels the sign-out", async ({ page }) => {
    const cloud = createFakeCloud();
    const auth = await useFakeAuth(page, cloud);
    cloud.seed(cloudGardenFrom(await playAsGuest(page)));
    await signIn(page);
    await openGarden(page);
    await expectHomeXp(page, 45);
    await page.waitForTimeout(1500);
    // Every save from here waits until the test releases it, then fails.
    const gate = deferred();
    auth.reply("PATCH quest_saves", async () => {
      await gate.released;
      return "network-error" as const;
    });
    await completeQuest(page, "Morning skincare");
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);

    await accountSection(page).getByRole("button", { name: "Sign out" }).click();
    await expect(accountSection(page).getByRole("button", { name: "Signing out…" })).toBeVisible();
    await signInElsewhere(page, auth.cloud, OTHER_EMAIL);
    gate.release();

    await expect(accountSection(page)).toContainText("Your account changed in the meantime, so signing out was cancelled");
    await expect(accountSection(page)).toContainText(`Signed in as ${OTHER_EMAIL}`);
    await page.waitForTimeout(500);
    expect(auth.requests.filter((request) => request.url().endsWith("/logout"))).toEqual([]);
    expect(await storedAccessToken(page)).toBe(fakeSession(OTHER_EMAIL).access_token);
  });
});

// Stage 7 Step 6: save status, conflict recovery, and unsaved-progress protection.

const saveStatus = (page: Page) => page.locator(".save-status");
const conflictNotice = (page: Page) => page.getByRole("region", { name: "Your garden changed somewhere else" });
const failedSaveNotice = (page: Page) => page.getByRole("region", { name: "Your latest changes haven't been saved" });
const unsavedNotice = (page: Page) => page.getByRole("region", { name: "Some changes weren't saved" });

/** Saves fail with "too large", which isn't retried on its own, so the error shows at once. */
const tooLarge = { status: 413, body: { code: "PGRST000", message: "Payload too large" } };

/** The completed daily quest IDs on the tests' Monday, in a downloaded garden. */
async function downloadedCompletions(download: Promise<Download>) {
  const file = await (await download).path();
  const data = JSON.parse(await readFile(file, "utf8")) as { completionHistory?: Record<string, { completedQuestIds?: string[] }> };
  return data.completionHistory?.["2026-10-19"]?.completedQuestIds ?? [];
}

/** Applies a conditional update to account A's save, as the real database would, and returns its reply. */
function applyPatch(auth: FakeAuth, request: Request) {
  const own = auth.cloud.saveOf();
  const url = new URL(request.url());
  if (!own || url.searchParams.get("revision") !== `eq.${own.revision}`) return { status: 200, body: [] };
  const body = request.postDataJSON() as { data: unknown; schema_version: number };
  const revision = auth.cloud.nextRevision(fakeUser().id);
  auth.cloud.saves.set(fakeUser().id, { data: body.data, schema_version: body.schema_version, revision });
  return { status: 200, body: [{ revision }] };
}

/** Saving works again, as the real database would answer. */
function saveNormally(auth: FakeAuth) {
  auth.reply("PATCH quest_saves", (request) => applyPatch(auth, request));
}

/** Account A's cloud garden on Home, loaded and settled (45 XP). */
async function openSettledCloudGarden(page: Page) {
  const cloud = createFakeCloud();
  const auth = await answerSupabaseFor(page, cloud);
  const guestSave = await playAsGuest(page);
  cloud.seed(cloudGardenFrom(guestSave));
  await signIn(page);
  await openGarden(page);
  await expectHomeXp(page, 45);
  // Any save from loading (a plant gift that became due) finishes first.
  await expect(saveStatus(page)).toHaveAttribute("data-save-status", "saved");
  await page.waitForTimeout(1000);
  return { auth, cloud, guestSave };
}

/** Another device saves a garden with 90 XP of bonus, so this page's next save conflicts. */
async function conflictWithAnotherDevice(page: Page, cloud: FakeAuth["cloud"], guestSave: string | null) {
  cloud.seed({ ...cloudGardenFrom(guestSave), legacyXpBonus: 90 });
  await completeQuest(page, "Morning skincare");
  await expect(conflictNotice(page)).toBeVisible();
}

test.describe("The save-status indicator (Step 6)", () => {
  test("shows saving, then saved, for a cloud garden", async ({ page }) => {
    const { auth } = await openSettledCloudGarden(page);
    // Held until checked, so "Saving…" can be seen.
    const gate = deferred();
    auth.reply("PATCH quest_saves", async (request) => {
      await gate.released;
      const body = request.postDataJSON() as { data: unknown; schema_version: number };
      const revision = auth.cloud.nextRevision(fakeUser().id);
      auth.cloud.saves.set(fakeUser().id, { data: body.data, schema_version: body.schema_version, revision });
      return { status: 200, body: [{ revision }] };
    });

    await completeQuest(page, "Morning skincare");
    await expect(saveStatus(page)).toHaveAttribute("data-save-status", "saving");
    await expect(saveStatus(page)).toContainText("Saving…");
    gate.release();

    await expect(saveStatus(page)).toHaveAttribute("data-save-status", "saved");
    await expect(saveStatus(page).getByRole("status")).toContainText("All changes saved to your account.");
    expect(cloudCompleted(auth, "skincare")).toBe(true);
  });

  test("shows nothing for a guest, whose saves work as before", async ({ page }) => {
    await useFakeAuth(page);
    await playAsGuest(page);

    await expect(saveStatus(page)).toHaveAttribute("data-save-status", "none");
    await expect(saveStatus(page).getByRole("status")).toHaveText("");
  });

  test("says it's retrying while automatic retries wait, then that it's not saved, with a way to try again", async ({ page }) => {
    const { auth } = await openSettledCloudGarden(page);
    auth.reply("PATCH quest_saves", "network-error");

    await completeQuest(page, "Morning skincare");
    await expect(saveStatus(page)).toHaveAttribute("data-save-status", "error");
    await expect(saveStatus(page)).toContainText("Retrying…");
    // No notice while it's still trying on its own.
    await expect(failedSaveNotice(page)).toHaveCount(0);

    // All three automatic retries (2, 5 and 15 seconds) fail, each after the one before.
    const patches = () => cloudRequests(auth, "PATCH quest_saves").length;
    const first = patches();
    for (const [index, wait] of [2_000, 5_000, 15_000].entries()) {
      await expect(saveStatus(page)).toContainText("Retrying…");
      await page.clock.fastForward(wait + 100);
      await expect.poll(patches).toBe(first + index + 1);
    }
    await expect(saveStatus(page)).toContainText("Not saved");
    await expect(failedSaveNotice(page)).toContainText("Plantetary couldn't reach the server.");

    saveNormally(auth);
    await failedSaveNotice(page).getByRole("button", { name: "Try saving again" }).click();
    await expect(saveStatus(page)).toHaveAttribute("data-save-status", "saved");
    await expect(failedSaveNotice(page)).toHaveCount(0);
    expect(cloudCompleted(auth, "skincare")).toBe(true);
  });

  test("a save that can't be retried on its own offers a download of the unsaved changes", async ({ page }) => {
    const { auth } = await openSettledCloudGarden(page);
    auth.reply("PATCH quest_saves", tooLarge);

    await completeQuest(page, "Morning skincare");
    await expect(saveStatus(page)).toContainText("Not saved");
    await expect(failedSaveNotice(page)).toContainText("Your garden is too large to save.");

    const download = page.waitForEvent("download");
    await failedSaveNotice(page).getByRole("button", { name: "Download my changes" }).click();
    expect(await downloadedCompletions(download)).toContain("skincare");
    expect(cloudCompleted(auth, "skincare")).toBe(false);
  });
});

test.describe("Recovering from a conflict (Step 6)", () => {
  test("explains it, pauses saving, and downloads exactly the unsaved changes", async ({ page }) => {
    const { auth, cloud, guestSave } = await openSettledCloudGarden(page);
    await conflictWithAnotherDevice(page, cloud, guestSave);

    await expect(saveStatus(page)).toHaveAttribute("data-save-status", "conflict");
    await expect(saveStatus(page)).toContainText("Saving paused");
    await expect(conflictNotice(page)).toContainText("A backup copy of them was kept in your account.");
    const patches = cloudRequests(auth, "PATCH quest_saves").length;

    const download = page.waitForEvent("download");
    await conflictNotice(page).getByRole("button", { name: "Download my changes" }).click();
    expect(await downloadedCompletions(download)).toContain("skincare");
    // The other device's garden was never overwritten.
    expect((cloud.saveOf()?.data as { legacyXpBonus?: number }).legacyXpBonus).toBe(90);
    expect(cloudRequests(auth, "PATCH quest_saves")).toHaveLength(patches);
  });

  test("Load latest garden asks first, and Cancel keeps this page's garden", async ({ page }) => {
    const { cloud, guestSave } = await openSettledCloudGarden(page);
    await conflictWithAnotherDevice(page, cloud, guestSave);

    await conflictNotice(page).getByRole("button", { name: "Load latest garden" }).click();
    const confirm = conflictNotice(page).getByRole("alertdialog", { name: "Load the latest garden?" });
    await expect(confirm).toContainText("including every change here that hasn't been saved");
    await confirm.getByRole("button", { name: "Cancel" }).click();

    await expect(confirm).toHaveCount(0);
    await expectHomeXp(page, 50);
    await expect(page.getByRole("button", { name: "Mark incomplete: Morning skincare", exact: true })).toBeVisible();
  });

  test("Load latest anyway replaces this page's garden with the latest, and saving resumes", async ({ page }) => {
    const { auth, cloud, guestSave } = await openSettledCloudGarden(page);
    await conflictWithAnotherDevice(page, cloud, guestSave);

    await conflictNotice(page).getByRole("button", { name: "Load latest garden" }).click();
    await conflictNotice(page).getByRole("button", { name: "Load latest anyway" }).click();

    await expect(conflictNotice(page)).toHaveCount(0);
    await expectHomeXp(page, 95);
    await expect(page.getByRole("button", { name: "Complete: Morning skincare", exact: true })).toBeVisible();
    await expect(saveStatus(page)).toHaveAttribute("data-save-status", "saved");

    await completeQuest(page, "Evening stretch");
    await expect.poll(() => cloudCompleted(auth, "stretch")).toBe(true);
    expect((cloud.saveOf()?.data as { legacyXpBonus?: number }).legacyXpBonus).toBe(90);
  });

  test("after a download and more changes, Load latest garden still asks, and Cancel keeps every change", async ({ page }) => {
    const { auth, cloud, guestSave } = await openSettledCloudGarden(page);
    await conflictWithAnotherDevice(page, cloud, guestSave);
    const download = page.waitForEvent("download");
    await conflictNotice(page).getByRole("button", { name: "Download my changes" }).click();
    expect(await downloadedCompletions(download)).not.toContain("stretch");

    // A change made after the download isn't in it.
    await completeQuest(page, "Evening stretch");
    await expectHomeXp(page, 55);
    await conflictNotice(page).getByRole("button", { name: "Load latest garden" }).click();

    const confirm = conflictNotice(page).getByRole("alertdialog", { name: "Load the latest garden?" });
    await expect(confirm).toContainText("replaces the garden on this page, including every change here that hasn't been saved");
    await expect(confirm).toContainText("A copy you downloaded earlier doesn't include changes made since");
    await confirm.getByRole("button", { name: "Cancel" }).click();

    await expect(confirm).toHaveCount(0);
    await expectHomeXp(page, 55);
    await expect(page.getByRole("button", { name: "Mark incomplete: Morning skincare", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark incomplete: Evening stretch", exact: true })).toBeVisible();
    expect((cloud.saveOf()?.data as { legacyXpBonus?: number }).legacyXpBonus).toBe(90);

    // Downloading again includes the newer change; then loading replaces this page's garden.
    const again = page.waitForEvent("download");
    await conflictNotice(page).getByRole("button", { name: "Download my changes" }).click();
    expect(await downloadedCompletions(again)).toEqual(expect.arrayContaining(["skincare", "stretch"]));
    await conflictNotice(page).getByRole("button", { name: "Load latest garden" }).click();
    await conflictNotice(page).getByRole("button", { name: "Load latest anyway" }).click();
    await expectHomeXp(page, 95);
    await expect(conflictNotice(page)).toHaveCount(0);
    expect(cloudCompleted(auth, "stretch")).toBe(false);
  });

  test("if loading the latest fails, the unsaved changes can still be downloaded", async ({ page }) => {
    const { auth, cloud, guestSave } = await openSettledCloudGarden(page);
    await conflictWithAnotherDevice(page, cloud, guestSave);
    auth.reply("GET quest_saves", { status: 500, body: { code: "XX000", message: "boom" } });

    await conflictNotice(page).getByRole("button", { name: "Load latest garden" }).click();
    await conflictNotice(page).getByRole("button", { name: "Load latest anyway" }).click();

    await expect(failedCard(page)).toBeVisible({ timeout: 20_000 });
    await expect(failedCard(page)).toContainText("Your changes from before haven't been saved");
    const download = page.waitForEvent("download");
    await failedCard(page).getByRole("button", { name: "Download unsaved changes" }).click();
    expect(await downloadedCompletions(download)).toContain("skincare");
  });
});

test.describe("Leaving the page with unsaved changes (Step 6)", () => {
  test("the browser asks before leaving while a cloud change isn't saved", async ({ page }) => {
    const { auth } = await openSettledCloudGarden(page);
    auth.reply("PATCH quest_saves", tooLarge);
    await completeQuest(page, "Morning skincare");
    await expect(saveStatus(page)).toContainText("Not saved");

    const dialog = page.waitForEvent("dialog");
    await page.close({ runBeforeUnload: true });
    const prompt = await dialog;
    expect(prompt.type()).toBe("beforeunload");
    await prompt.dismiss();
  });

  test("the browser doesn't ask once everything is saved", async ({ page }) => {
    const { auth } = await openSettledCloudGarden(page);
    await completeQuest(page, "Morning skincare");
    await expect.poll(() => cloudCompleted(auth, "skincare")).toBe(true);
    await expect(saveStatus(page)).toHaveAttribute("data-save-status", "saved");
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.type());
      void dialog.dismiss();
    });

    await reloadApp(page);

    expect(dialogs).toEqual([]);
    await expectHomeXp(page, 50);
  });

  test("a guest is never asked, as before", async ({ page }) => {
    await useFakeAuth(page);
    await playAsGuest(page);
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.type());
      void dialog.dismiss();
    });

    await reloadApp(page);

    expect(dialogs).toEqual([]);
  });

  test("unsaved changes left by a reload are offered for download afterwards, and never uploaded", async ({ page }) => {
    const { auth } = await openSettledCloudGarden(page);
    auth.reply("PATCH quest_saves", tooLarge);
    await completeQuest(page, "Morning skincare");
    await expect(saveStatus(page)).toContainText("Not saved");

    page.once("dialog", (dialog) => void dialog.accept());
    await page.reload();
    await expectHomeXp(page, 45);

    await expect(unsavedNotice(page)).toContainText("hadn't been saved when this page was closed or reloaded");
    await expect(unsavedNotice(page)).toContainText("mi•••@example.com");
    const download = page.waitForEvent("download");
    await unsavedNotice(page).getByRole("button", { name: "Download unsaved changes" }).click();
    expect(await downloadedCompletions(download)).toContain("skincare");
    expect(cloudCompleted(auth, "skincare")).toBe(false);

    // Dismissed, it's gone for good.
    await unsavedNotice(page).getByRole("button", { name: "Dismiss" }).click();
    await reloadApp(page);
    await expectHomeXp(page, 45);
    await page.waitForTimeout(500);
    await expect(unsavedNotice(page)).toHaveCount(0);
  });

  test("changes left by a reload are hidden, never downloadable, while another account is signed in, and kept for their own", async ({ page }) => {
    const { auth } = await openSettledCloudGarden(page);
    auth.reply("PATCH quest_saves", tooLarge);
    await completeQuest(page, "Morning skincare");
    await expect(saveStatus(page)).toContainText("Not saved");
    page.once("dialog", (dialog) => void dialog.accept());
    await page.reload();
    await expect(unsavedNotice(page)).toContainText("hadn't been saved when this page was closed or reloaded");

    await signInElsewhere(page, auth.cloud, OTHER_EMAIL);
    await expect(choiceCard(page)).toBeVisible();

    // Gone from the screen at once, for B, but still kept in the tab for A.
    await expect(unsavedNotice(page)).toHaveCount(0);
    await expect(page.getByText("mi•••@example.com")).toHaveCount(0);
    expect(await page.evaluate(() => window.sessionStorage.getItem("plantetary-unsaved-cloud-changes"))).not.toBeNull();
    await page.reload();
    await expect(choiceCard(page)).toBeVisible();
    await page.waitForTimeout(500);
    await expect(unsavedNotice(page)).toHaveCount(0);

    // A signs in again: A's kept changes are offered again, and still never uploaded.
    await signInElsewhere(page, auth.cloud, TEST_EMAIL);
    await expectHomeXp(page, 45);
    await expect(unsavedNotice(page)).toContainText("mi•••@example.com");
    const download = page.waitForEvent("download");
    await unsavedNotice(page).getByRole("button", { name: "Download unsaved changes" }).click();
    expect(await downloadedCompletions(download)).toContain("skincare");
    expect(cloudCompleted(auth, "skincare")).toBe(false);
    expect(auth.cloud.saveOf(OTHER_EMAIL)).toBeUndefined();
  });

  test("signing out hides changes left by a reload, and signing back in offers them again", async ({ page }) => {
    const { auth } = await openSettledCloudGarden(page);
    auth.reply("PATCH quest_saves", tooLarge);
    await completeQuest(page, "Morning skincare");
    await expect(saveStatus(page)).toContainText("Not saved");
    page.once("dialog", (dialog) => void dialog.accept());
    await page.reload();
    await expect(unsavedNotice(page)).toBeVisible();

    await page.getByRole("link", { name: "Settings" }).click();
    await accountSection(page).getByRole("button", { name: "Sign out" }).click();
    await expect(accountSection(page)).toContainText("You're signed out");
    await expect(unsavedNotice(page)).toHaveCount(0);

    await signIn(page);
    await expect(unsavedNotice(page)).toContainText("mi•••@example.com");
  });
});

// Stage 7 Step 7: whole flows across steps 1–6.

test.describe("Stage 7 integration (Step 7)", () => {
  test("a guest who starts a cloud garden, signs out and back in: each garden keeps its own progress", async ({ page }) => {
    // A long flow across sign-ins and tabs: more time than one page's test.
    test.slow();
    const auth = await useFakeAuth(page);
    await playAsGuest(page);
    await signIn(page);
    await page.goto("/");
    await choiceCard(page).getByRole("button", { name: "Start a fresh cloud garden" }).click();
    await expectHomeXp(page, 0);
    await completeQuest(page, "Evening stretch");
    await expect.poll(() => cloudCompleted(auth, "stretch")).toBe(true);
    await expect(saveStatus(page)).toHaveAttribute("data-save-status", "saved");

    // Signed out: the browser garden is back, as the guest left it, and plays as before.
    await page.goto("/settings");
    await accountSection(page).getByRole("button", { name: "Sign out" }).click();
    await expect(accountSection(page)).toContainText("You're signed out");
    await openGarden(page);
    await expectHomeXp(page, 5);
    await completeQuest(page, "Morning skincare");
    await expectHomeXp(page, 10);
    const guestSave = await readStorage(page, QUEST_SAVE_KEY);
    expect(cloudCompleted(auth, "skincare")).toBe(false);

    // Signed in again: straight to the cloud garden (no first-time choice), exactly as it was saved.
    await signIn(page);
    await openGarden(page);
    await expect(choiceCard(page)).toHaveCount(0);
    await expectHomeXp(page, 5);
    await expect(page.getByRole("button", { name: "Mark incomplete: Evening stretch", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Complete: Morning skincare", exact: true })).toBeVisible();
    expect(await readStorage(page, QUEST_SAVE_KEY)).toBe(guestSave);
    expect(cloudRequests(auth, "POST quest_saves")).toHaveLength(1);
  });

  test("account A → B → A: each account's cloud garden keeps only its own changes", async ({ page }) => {
    // A long flow across sign-ins and tabs: more time than one page's test.
    test.slow();
    const { auth, cloud } = await openSettledCloudGarden(page);
    await completeQuest(page, "Morning skincare");
    await expect.poll(() => cloudCompleted(auth, "skincare")).toBe(true);

    await signInElsewhere(page, cloud, OTHER_EMAIL);
    await choiceCard(page).getByRole("button", { name: "Start a fresh cloud garden" }).click();
    await expectHomeXp(page, 0);
    await completeQuest(page, "Evening stretch");
    await expect.poll(() => cloudCompleted(auth, "stretch", OTHER_EMAIL)).toBe(true);

    await signInElsewhere(page, cloud, TEST_EMAIL);
    await expectHomeXp(page, 50);
    await expect(page.getByRole("button", { name: "Mark incomplete: Morning skincare", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Complete: Evening stretch", exact: true })).toBeVisible();
    await expect(saveStatus(page)).toHaveAttribute("data-save-status", "saved");

    expect(cloudCompleted(auth, "stretch")).toBe(false);
    expect(cloudCompleted(auth, "skincare", OTHER_EMAIL)).toBe(false);
    await expect(unsavedNotice(page)).toHaveCount(0);
  });

  test("two tabs on one account: neither overwrites the other, and each recovers by loading the latest", async ({ page }) => {
    // A long flow across sign-ins and tabs: more time than one page's test.
    test.slow();
    const { auth, cloud } = await openSettledCloudGarden(page);
    const second = await openOtherTab(page);
    await answerSupabaseFor(second, cloud);
    await second.goto("/");
    await expectHomeXp(second, 45);
    await expect(saveStatus(second)).toHaveAttribute("data-save-status", "saved");
    await second.waitForTimeout(1000);

    // The first tab saves.
    await completeQuest(page, "Morning skincare");
    await expect.poll(() => cloudCompleted(auth, "skincare")).toBe(true);

    // The second tab, still on the older revision, saves too: a conflict, never an overwrite.
    await completeQuest(second, "Evening stretch");
    await expect(conflictNotice(second)).toContainText("A backup copy of them was kept in your account.");
    await expect(saveStatus(second)).toContainText("Saving paused");
    expect(cloudCompleted(auth, "skincare")).toBe(true);
    expect(cloudCompleted(auth, "stretch")).toBe(false);
    expect(cloud.backups.filter((backup) => backup.reason === "conflict").map((backup) => backup.raw_data.includes("stretch"))).toEqual([true]);
    const download = second.waitForEvent("download");
    await conflictNotice(second).getByRole("button", { name: "Download my changes" }).click();
    const downloaded = await downloadedCompletions(download);
    expect(downloaded).toContain("stretch");
    expect(downloaded).not.toContain("skincare");

    // The second tab loads the latest (the first tab's), then saves on top of it.
    await conflictNotice(second).getByRole("button", { name: "Load latest garden" }).click();
    await conflictNotice(second).getByRole("button", { name: "Load latest anyway" }).click();
    await expect(second.getByRole("button", { name: "Mark incomplete: Morning skincare", exact: true })).toBeVisible();
    await expect(second.getByRole("button", { name: "Complete: Evening stretch", exact: true })).toBeVisible();
    await completeQuest(second, "Evening stretch");
    await expect.poll(() => cloudCompleted(auth, "stretch")).toBe(true);
    expect(cloudCompleted(auth, "skincare")).toBe(true);

    // Now the first tab is the stale one: its next change conflicts, and both earlier changes stay saved.
    await completeQuest(page, "Read for 20 minutes");
    await expect(conflictNotice(page)).toBeVisible();
    expect(cloudCompleted(auth, "reading")).toBe(false);
    expect(cloudCompleted(auth, "skincare")).toBe(true);
    expect(cloudCompleted(auth, "stretch")).toBe(true);
    await second.close();
  });
});

test.describe("Interrupted saves (Step 7)", () => {
  /**
   * The next write reaches the database, but its reply is lost (the connection drops on the way back).
   * Later requests are answered as the database would.
   */
  function loseNextReply(auth: FakeAuth) {
    let lost = false;
    auth.reply("PATCH quest_saves", (request) => {
      const reply = applyPatch(auth, request);
      if (lost) return reply;
      lost = true;
      return "network-error";
    });
  }

  test("a reload after a lost reply shows the saved change, with nothing offered as unsaved", async ({ page }) => {
    const { auth } = await openSettledCloudGarden(page);
    loseNextReply(auth);
    await completeQuest(page, "Morning skincare");
    await expect.poll(() => cloudCompleted(auth, "skincare")).toBe(true);
    await expect(saveStatus(page)).toContainText("Retrying…");

    page.once("dialog", (dialog) => void dialog.accept());
    await page.reload();
    await expectHomeXp(page, 50);
    await expect(page.getByRole("button", { name: "Mark incomplete: Morning skincare", exact: true })).toBeVisible();

    // The tab's emergency copy matched the cloud save exactly, so it was dropped unseen.
    await page.waitForTimeout(500);
    await expect(unsavedNotice(page)).toHaveCount(0);
    await expect(conflictNotice(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.sessionStorage.getItem("plantetary-unsaved-cloud-changes"))).toBeNull();
  });

  test("without a reload, the retry after a lost reply is a conflict, never a second write over it", async ({ page }) => {
    const { auth, cloud } = await openSettledCloudGarden(page);
    loseNextReply(auth);
    await completeQuest(page, "Morning skincare");
    await expect.poll(() => cloudCompleted(auth, "skincare")).toBe(true);
    const revision = cloud.saveOf()?.revision;

    await page.clock.fastForward(2_100);
    await expect(conflictNotice(page)).toBeVisible();
    expect(cloud.saveOf()?.revision).toBe(revision);

    // Loading the latest shows the change: it was saved all along.
    await conflictNotice(page).getByRole("button", { name: "Load latest garden" }).click();
    await conflictNotice(page).getByRole("button", { name: "Load latest anyway" }).click();
    await expectHomeXp(page, 50);
    await expect(page.getByRole("button", { name: "Mark incomplete: Morning skincare", exact: true })).toBeVisible();
    await expect(saveStatus(page)).toHaveAttribute("data-save-status", "saved");
  });
});

test.describe("An access token that expires while offline (Codex Stage 7 final review P1)", () => {
  /**
   * Waits for the save status, moving the tests' clock on a few seconds at a time, so supabase-js's refresh
   * back-off (up to about 30 seconds) and the session's retries (2, 5 and 15 seconds) happen quickly.
   */
  async function waitForSaveStatus(page: Page, text: string) {
    await expect.poll(async () => {
      const current = (await saveStatus(page).textContent()) ?? "";
      if (!current.includes(text)) await page.clock.fastForward(3_000);
      return current;
    }, { timeout: 45_000, intervals: [250] }).toContain(text);
  }

  test("edits stay playable and kept, nothing is sent without a token, and reconnecting saves them all", async ({ page }) => {
    test.slow();
    const { auth } = await openSettledCloudGarden(page);
    const patches = () => cloudRequests(auth, "PATCH quest_saves").length;
    const before = patches();

    // The sign-in service is unreachable, and the token expires: supabase-js can't refresh it, so
    // getSession() returns no session with a retryable fetch error.
    auth.reply("POST /token", "network-error");
    await page.clock.fastForward("02:00:00");

    await completeQuest(page, "Morning skincare");
    // supabase-js keeps retrying the refresh for up to about 30 seconds before getSession() gives up.
    await waitForSaveStatus(page, "Retrying…");
    // More play while offline: still allowed, and still the account's cloud garden.
    await completeQuest(page, "Evening stretch");
    await expectHomeXp(page, 55);
    await expect(failedCard(page)).toHaveCount(0);
    await expect(unsavedNotice(page)).toHaveCount(0);
    // Nothing was written without a valid token.
    expect(patches()).toBe(before);

    // Still offline, the automatic retries run out. The storage is still open, so the edits stay on
    // screen, and the player is told and offered a way to try again (before this fix, it had closed).
    await waitForSaveStatus(page, "Not saved");
    await expect(failedSaveNotice(page)).toContainText("Plantetary couldn't reach the server.");
    await expectHomeXp(page, 55);
    expect(patches()).toBe(before);

    // Back online: once supabase-js refreshes the token (after its cooldown for a failed refresh), the
    // account is announced again and the waiting save goes, with both edits. No button needed.
    auth.reply("POST /token", { status: 200, body: fakeSession(TEST_EMAIL, 3 * 3600) });
    await waitForSaveStatus(page, "Saved");
    expect(cloudCompleted(auth, "skincare")).toBe(true);
    expect(cloudCompleted(auth, "stretch")).toBe(true);

    // And saving carries on as normal.
    await completeQuest(page, "Read for 20 minutes");
    await expect.poll(() => cloudCompleted(auth, "reading")).toBe(true);
    await reloadApp(page);
    await expectHomeXp(page, 65);
  });
});
