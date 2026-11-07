import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import {
  TEST_EMAIL,
  answerSupabaseFor,
  authRequests,
  cloudRequests,
  createFakeCloud,
  fakeSession,
  fakeUserId,
  openOtherTab,
  readGameStorage,
  useFakeAuth,
  userIdFromBearer,
  type FakeAuth,
} from "./auth-support";
import { QUEST_SAVE_KEY, buildSave, completeQuest, expect, expectHomeXp, openApp, readStorage, seedStorage, test } from "./support";

// Stage 8 Step 4: the guest-to-cloud import UI, what the screens show and do. Step 5 (further down):
// reliability, lost replies, late commits, account changes and reloads while an import is under way.

const SIGN_IN_LINK = "/auth/confirm?token_hash=pkce_0123456789abcdef&type=email";
const OTHER_EMAIL = "other-player@example.com";

const accountSection = (page: Page) => page.getByRole("region", { name: "Account" });
const choiceCard = (page: Page) => page.getByRole("region", { name: "Start your cloud garden?" });
const importDialog = (page: Page) => page.getByRole("dialog");
const resultNotice = (page: Page) => page.locator(".import-result");
const unresolvedCard = (page: Page) => page.getByRole("region", { name: "We couldn't confirm whether your import finished" });
const importSection = (page: Page) => page.getByRole("group", { name: "Bring this browser's garden to your account" });

async function signIn(page: Page) {
  await page.goto(SIGN_IN_LINK);
  await page.getByRole("button", { name: "Finish signing in" }).click();
  await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);
}

/** A guest who has played: one quest done, 5 XP, saved in this browser. */
async function playAsGuest(page: Page) {
  await openApp(page);
  await completeQuest(page, "Drink a glass of water");
  await expectHomeXp(page, 5);
  return readStorage(page, QUEST_SAVE_KEY);
}

/**
 * Goes Home and waits until Home is the page shown. The storage notices (and the first-time card) are on
 * every page, so without the wait a click could land on the previous page just before it's replaced.
 */
async function openHome(page: Page) {
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL(/:\d+\/$/);
  await expect(page.getByRole("link", { name: "Home", exact: true })).toHaveClass(/is-active/);
}

/** Whether the account's cloud garden records this daily quest as done on the tests' Monday. */
function cloudCompleted(auth: FakeAuth, questId: string) {
  const data = auth.cloud.saveOf()?.data as { completionHistory?: Record<string, { completedQuestIds?: string[] }> } | undefined;
  return data?.completionHistory?.["2026-10-19"]?.completedQuestIds?.includes(questId) ?? false;
}

/** A guest with 5 XP, signed in to an account whose cloud garden has 45 XP; on Settings. */
async function guestAndCloudGarden(page: Page) {
  const cloud = createFakeCloud();
  const auth = await answerSupabaseFor(page, cloud);
  const guestSave = await playAsGuest(page);
  cloud.seed({ ...JSON.parse(guestSave ?? "{}"), legacyXpBonus: 40, completionHistory: {} });
  await signIn(page);
  await openHome(page);
  await expectHomeXp(page, 40);
  // Loading this garden records today's starting state, which is saved straight away (one PATCH). Wait
  // until that save has been sent and answered, so it can't overlap anything the test does next.
  await expect.poll(() => cloudRequests(auth, "PATCH quest_saves").length).toBe(1);
  await expect(page.locator(".save-status")).toHaveAttribute("data-save-status", "saved");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(importSection(page)).toBeVisible();
  return { auth, cloud, guestSave };
}

const imports = (auth: FakeAuth) => cloudRequests(auth, "POST rpc/import_browser_save");
/** Backups made by imports (loading an older-format garden can add `upgrade` backups, which don't count). */
const importBackups = (auth: FakeAuth) => auth.cloud.backups.filter((backup) => backup.reason === "browser_import");

test.describe("The first-time card", () => {
  test("offers importing only when this browser has real progress", async ({ page }) => {
    await useFakeAuth(page);
    // A visit with no play: only the starter quests are saved in this browser.
    await openApp(page);
    await signIn(page);
    await openHome(page);
    await expect(choiceCard(page)).toBeVisible();
    await expect(choiceCard(page).getByRole("button", { name: "Start a fresh cloud garden" })).toBeVisible();
    await expect(choiceCard(page).getByRole("button", { name: "Import my browser garden" })).toHaveCount(0);
  });

  test("imports into a new account: Cancel is the default, Escape cancels, confirming imports", async ({ page }) => {
    const auth = await useFakeAuth(page);
    const guestSave = await playAsGuest(page);
    await signIn(page);
    await openHome(page);

    const card = choiceCard(page);
    await expect(card.getByRole("group", { name: /^The garden in this browser: Level 1, 5 XP/ })).toBeVisible();
    const open = card.getByRole("button", { name: "Import my browser garden" });
    await open.click();

    const dialog = importDialog(page);
    await expect(dialog).toHaveAccessibleName("Bring this browser's garden to your account?");
    await expect(dialog).toContainText("The garden in this browser stays exactly as it is.");
    await expect(dialog.getByRole("group", { name: "Your account: No cloud garden yet" })).toBeVisible();
    // Cancel is focused, so Enter or Space would cancel. Escape cancels too, and focus goes back.
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Import my browser garden" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();
    expect(imports(auth)).toEqual([]);

    await open.click();
    await importDialog(page).getByRole("button", { name: "Import my browser garden" }).click();

    await expect(resultNotice(page)).toContainText("Your browser garden is now your cloud garden");
    await expect(resultNotice(page).getByRole("heading")).toBeFocused();
    await expectHomeXp(page, 5);
    await expect(page.getByRole("button", { name: "Mark incomplete: Drink a glass of water", exact: true })).toBeVisible();
    expect(cloudCompleted(auth, "water")).toBe(true);
    expect(importBackups(auth)).toEqual([]);
    expect(await readStorage(page, QUEST_SAVE_KEY)).toBe(guestSave);

    // The new cloud garden saves as usual.
    await completeQuest(page, "Morning skincare");
    await expect.poll(() => cloudCompleted(auth, "skincare")).toBe(true);
  });
});

test.describe("Settings → Account", () => {
  test("mobile dialog stays within the viewport and traps keyboard focus", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const { auth } = await guestAndCloudGarden(page);
    const opener = importSection(page).getByRole("button", { name: "Review and import…" });
    await opener.click();
    const dialog = importDialog(page);
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    const contrast = await dialog.getByRole("button", { name: "Cancel" }).evaluate((el) => {
      const luminance = (color: string) => {
        const [r, g, b] = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const style = getComputedStyle(el);
      const light = luminance(style.color);
      const dark = luminance(style.backgroundColor);
      return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Download your cloud garden" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Replace my cloud garden" })).toBeFocused();
    // The document behind showModal is inert, including programmatic focus attempts.
    await page.locator('a[href="/"]').first().evaluate((el: HTMLElement) => el.focus());
    await expect(dialog.getByRole("button", { name: "Replace my cloud garden" })).toBeFocused();
    await page.screenshot({ path: "/tmp/plantetary-import-mobile.png" });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    expect(imports(auth)).toEqual([]);
  });

  test("Cancel after navigation focuses the current page when the original opener is gone", async ({ page }) => {
    const { auth } = await guestAndCloudGarden(page);
    await importSection(page).getByRole("button", { name: "Review and import…" }).click();
    await expect(importDialog(page).getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.goBack();
    await expect(page).toHaveURL(/:\d+\/$/);
    await importDialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(importDialog(page)).toBeHidden();
    await expect(page.getByRole("link", { name: "Home", exact: true })).toBeFocused();
    expect(imports(auth)).toEqual([]);
  });

  test("a failed download explains the error and never downloads the stale displayed garden", async ({ page }) => {
    const { auth } = await guestAndCloudGarden(page);
    await importSection(page).getByRole("button", { name: "Review and import…" }).click();
    auth.reply("GET quest_saves", "network-error");
    const downloads: unknown[] = [];
    page.on("download", (file) => downloads.push(file));
    await importDialog(page).getByRole("button", { name: "Download your cloud garden" }).click();
    await expect(importDialog(page).getByRole("alert")).toContainText("couldn't be downloaded");
    expect(downloads).toEqual([]);
    expect(imports(auth)).toEqual([]);
    await expect(importDialog(page).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  test("a changed browser garden requires reviewing and confirming a new plan", async ({ page }) => {
    const { auth, guestSave } = await guestAndCloudGarden(page);
    await importSection(page).getByRole("button", { name: "Review and import…" }).click();
    await page.evaluate(({ key, raw }) => localStorage.setItem(key, JSON.stringify({ ...JSON.parse(raw!), legacyXpBonus: 50 })), { key: QUEST_SAVE_KEY, raw: guestSave });
    await importDialog(page).getByRole("button", { name: "Replace my cloud garden" }).click();
    await expect(importDialog(page).getByRole("alert")).toContainText("latest comparison");
    await expect(importDialog(page).getByRole("group", { name: /^This browser: Level 1, 55 XP/ })).toBeVisible();
    expect(imports(auth)).toEqual([]);
    await importDialog(page).getByRole("button", { name: "Cancel" }).click();
    expect(imports(auth)).toEqual([]);
  });

  test("an import and its result survive client-side navigation", async ({ page }) => {
    const { auth, guestSave } = await guestAndCloudGarden(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    auth.reply("POST rpc/import_browser_save", async (request) => {
      await gate;
      const args = request.postDataJSON();
      const previous = auth.cloud.saveOf()!;
      auth.cloud.backups.push({ user_id: args.p_user_id, reason: "browser_import", raw_data: JSON.stringify(previous.data), schema_version: previous.schema_version, source_revision: previous.revision });
      const revision = auth.cloud.nextRevision(args.p_user_id);
      auth.cloud.saves.set(args.p_user_id, { data: args.p_data, schema_version: args.p_schema_version, revision });
      return { status: 200, body: [{ outcome: "imported", revision }] };
    });
    await importSection(page).getByRole("button", { name: "Review and import…" }).click();
    await importDialog(page).getByRole("button", { name: "Replace my cloud garden" }).click();
    await expect(importDialog(page)).toContainText("Please keep this page open");
    await page.goBack();
    await expect(page).toHaveURL(/:\d+\/$/);
    await expect(importDialog(page)).toBeVisible();
    release();
    await expect(resultNotice(page)).toContainText("now your cloud garden");
    await expectHomeXp(page, 5);
    expect(await readStorage(page, QUEST_SAVE_KEY)).toBe(guestSave);
    expect(importBackups(auth)).toHaveLength(1);
  });

  test("downloads the latest persisted cloud garden rather than the older garden on screen", async ({ page }) => {
    const { auth, cloud, guestSave } = await guestAndCloudGarden(page);
    await importSection(page).getByRole("button", { name: "Review and import…" }).click();
    cloud.seed({ ...JSON.parse(guestSave ?? "{}"), legacyXpBonus: 90, completionHistory: {} });
    const download = page.waitForEvent("download");
    await importDialog(page).getByRole("button", { name: "Download your cloud garden" }).click();
    const file = JSON.parse(await readFile(await (await download).path(), "utf8"));
    expect(file.questData.legacyXpBonus).toBe(90);
    expect(imports(auth)).toEqual([]);
  });

  test("an identical garden reports unchanged without a replacement backup", async ({ page }) => {
    const cloud = createFakeCloud();
    const auth = await useFakeAuth(page, cloud);
    const guestSave = await playAsGuest(page);
    cloud.seed(JSON.parse(guestSave ?? "{}"));
    await signIn(page);
    await expect(importSection(page)).toBeVisible();
    await importSection(page).getByRole("button", { name: "Review and import…" }).click();
    await importDialog(page).getByRole("button", { name: "Replace my cloud garden" }).click();
    await expect(resultNotice(page)).toContainText("already matches this browser");
    expect(importBackups(auth)).toEqual([]);
    expect(await readStorage(page, QUEST_SAVE_KEY)).toBe(guestSave);
  });

  test("compares both gardens, downloads the cloud garden, then replaces it after a backup", async ({ page }) => {
    const { auth, guestSave } = await guestAndCloudGarden(page);
    const section = importSection(page);
    await expect(section.getByRole("group", { name: /^This browser: Level 1, 5 XP/ })).toBeVisible();
    await expect(section.getByRole("group", { name: /^Your cloud garden: Level 1, 40 XP/ })).toBeVisible();
    await section.getByRole("button", { name: "Review and import…" }).click();

    const dialog = importDialog(page);
    await expect(dialog).toHaveAccessibleName("Replace your cloud garden with this browser's garden?");
    await expect(dialog).toContainText("The two aren't merged.");
    await expect(dialog).toContainText("A backup copy of your current cloud garden is kept in your account first.");
    await expect(dialog.getByRole("group", { name: /^Your account: Level 1, 40 XP/ })).toBeVisible();

    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download your cloud garden" }).click();
    const file = JSON.parse(await readFile(await (await download).path(), "utf8")) as { questData: { legacyXpBonus?: number } };
    expect(file.questData.legacyXpBonus).toBe(40);

    await dialog.getByRole("button", { name: "Replace my cloud garden" }).click();
    await expect(resultNotice(page)).toContainText("Your previous cloud garden was backed up in your account first.");
    expect(importBackups(auth)).toHaveLength(1);
    expect(cloudCompleted(auth, "water")).toBe(true);
    expect(await readStorage(page, QUEST_SAVE_KEY)).toBe(guestSave);
    await openHome(page);
    await expectHomeXp(page, 5);
  });

  test("Cancel replaces nothing", async ({ page }) => {
    const { auth } = await guestAndCloudGarden(page);
    await importSection(page).getByRole("button", { name: "Review and import…" }).click();
    await importDialog(page).getByRole("button", { name: "Cancel" }).click();

    await expect(importDialog(page)).toBeHidden();
    await expect(importSection(page).getByRole("button", { name: "Review and import…" })).toBeFocused();
    expect(imports(auth)).toEqual([]);
    expect(importBackups(auth)).toEqual([]);
  });

  test("explains why importing isn't offered when this browser only has the starter quests", async ({ page }) => {
    const cloud = createFakeCloud();
    await useFakeAuth(page, cloud);
    await openApp(page);
    cloud.seed({ ...JSON.parse((await readStorage(page, QUEST_SAVE_KEY)) ?? "{}"), legacyXpBonus: 40 });
    await signIn(page);
    await openHome(page);
    await expectHomeXp(page, 40);
    await page.getByRole("link", { name: "Settings" }).click();

    await expect(importSection(page)).toContainText("only has the starter quests");
    await expect(importSection(page).getByRole("button", { name: "Review and import…" })).toHaveCount(0);
  });
});

test.describe("Imports that don't go through", () => {
  test("another device saving during the confirmation is a conflict: nothing imported, the latest loaded", async ({ page }) => {
    const { auth, cloud, guestSave } = await guestAndCloudGarden(page);
    await importSection(page).getByRole("button", { name: "Review and import…" }).click();
    await expect(importDialog(page).getByRole("button", { name: "Cancel" })).toBeFocused();
    cloud.seed({ ...JSON.parse(guestSave ?? "{}"), legacyXpBonus: 90, completionHistory: {} });

    await importDialog(page).getByRole("button", { name: "Replace my cloud garden" }).click();
    await expect(resultNotice(page)).toContainText("Your cloud garden changed somewhere else");
    expect(importBackups(auth)).toEqual([]);
    await openHome(page);
    await expectHomeXp(page, 90);
  });

  test("a backup failure replaces nothing, and the cloud garden comes back", async ({ page }) => {
    const { auth } = await guestAndCloudGarden(page);
    auth.reply("POST rpc/import_browser_save", { status: 200, body: [{ outcome: "backup_failed", revision: null }] });
    await importSection(page).getByRole("button", { name: "Review and import…" }).click();
    await importDialog(page).getByRole("button", { name: "Replace my cloud garden" }).click();

    await expect(resultNotice(page)).toContainText("couldn't back up your cloud garden first");
    await openHome(page);
    await expectHomeXp(page, 40);
  });

  test("a definite server failure says so, and changes nothing", async ({ page }) => {
    const { auth } = await guestAndCloudGarden(page);
    auth.reply("POST rpc/import_browser_save", { status: 500, body: { code: "57014", message: "canceling statement due to statement timeout" } });
    await importSection(page).getByRole("button", { name: "Review and import…" }).click();
    await importDialog(page).getByRole("button", { name: "Replace my cloud garden" }).click();

    await expect(resultNotice(page)).toContainText("The import didn't go through");
    await openHome(page);
    await expectHomeXp(page, 40);
  });
});

test.describe("An import whose outcome isn't known", () => {
  test("shows no garden, can be checked, and the same import retried", async ({ page }) => {
    const { auth } = await guestAndCloudGarden(page);
    auth.reply("POST rpc/import_browser_save", "network-error");
    await importSection(page).getByRole("button", { name: "Review and import…" }).click();
    await importDialog(page).getByRole("button", { name: "Replace my cloud garden" }).click();

    const card = unresolvedCard(page);
    await expect(card).toContainText("You can retry the same import");
    await expect(card.getByRole("heading")).toBeFocused();
    await openHome(page);
    await expect(unresolvedCard(page)).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Complete|Mark incomplete): / })).toHaveCount(0);
    expect(imports(auth)).toHaveLength(1);

    // Checking reads the cloud and sends nothing; it's still as it was.
    await unresolvedCard(page).getByRole("button", { name: "Check my cloud garden" }).click();
    await expect(resultNotice(page)).toContainText("Still couldn't confirm the import");
    expect(imports(auth)).toHaveLength(1);

    // The connection is back: the very same import goes through.
    auth.restoreDatabaseReply("POST rpc/import_browser_save");
    await unresolvedCard(page).getByRole("button", { name: "Try the same import again" }).click();
    await expect(resultNotice(page)).toContainText("Your browser garden is now your cloud garden");
    expect(imports(auth)).toHaveLength(2);
    expect(cloudCompleted(auth, "water")).toBe(true);
    expect(importBackups(auth)).toHaveLength(1);
    await openHome(page);
    await expectHomeXp(page, 5);
  });

  test("can be left: the cloud garden loads without waiting", async ({ page }) => {
    const { auth } = await guestAndCloudGarden(page);
    auth.reply("POST rpc/import_browser_save", "network-error");
    await importSection(page).getByRole("button", { name: "Review and import…" }).click();
    await importDialog(page).getByRole("button", { name: "Replace my cloud garden" }).click();
    await expect(unresolvedCard(page)).toBeVisible();

    await unresolvedCard(page).getByRole("button", { name: "Load my cloud garden without waiting" }).click();
    await expect(resultNotice(page)).toContainText("Plantetary stopped waiting and is loading your cloud garden");
    await openHome(page);
    await expectHomeXp(page, 40);
    expect(imports(auth)).toHaveLength(1);
  });
});

test.describe("An account change during the confirmation", () => {
  test("a delayed download from A is discarded when B signs in", async ({ page }) => {
    const { auth, cloud } = await guestAndCloudGarden(page);
    await importSection(page).getByRole("button", { name: "Review and import…" }).click();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    auth.reply("GET quest_saves", async () => {
      const old = cloud.saveOf()!;
      started();
      await gate;
      return { status: 200, body: [old] };
    });
    const downloads: unknown[] = [];
    page.on("download", (file) => downloads.push(file));
    await importDialog(page).getByRole("button", { name: "Download your cloud garden" }).click();
    await expect(importDialog(page).getByRole("button", { name: "Downloading…" })).toBeVisible();
    await readStarted;
    auth.restoreDatabaseReply("GET quest_saves");
    const other = await openOtherTab(page);
    const otherAuth = await answerSupabaseFor(other, cloud);
    otherAuth.reply("POST /verify", { status: 200, body: fakeSession(OTHER_EMAIL) });
    otherAuth.reply("POST /token", { status: 200, body: fakeSession(OTHER_EMAIL) });
    await other.goto(SIGN_IN_LINK);
    await other.getByRole("button", { name: "Finish signing in" }).click();
    await expect(accountSection(other)).toContainText(OTHER_EMAIL);
    await other.close();
    await expect(importDialog(page)).toBeHidden();
    release();
    await expect(accountSection(page)).toContainText(OTHER_EMAIL);
    await expect(resultNotice(page)).toContainText("Import cancelled");
    await expect(resultNotice(page)).not.toContainText("may still have completed");
    expect(downloads).toEqual([]);
    expect(imports(auth)).toEqual([]);
    await expect(page.getByText("40 XP", { exact: false })).toHaveCount(0);
  });

  test("signing out in another tab closes confirmation, restores focus, and sends no import", async ({ page }) => {
    const { auth, cloud } = await guestAndCloudGarden(page);
    await importSection(page).getByRole("button", { name: "Review and import…" }).click();
    await expect(importDialog(page)).toBeVisible();
    const other = await openOtherTab(page);
    await answerSupabaseFor(other, cloud);
    await other.goto("/settings");
    await accountSection(other).getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(accountSection(other)).toContainText("You're signed out");
    await other.close();
    await expect(importDialog(page)).toBeHidden();
    await expect(resultNotice(page)).toContainText("Import cancelled");
    await expect(resultNotice(page)).not.toContainText("may still have completed");
    await expect(resultNotice(page).getByRole("heading")).toBeFocused();
    expect(imports(auth)).toEqual([]);
    expect(importBackups(auth)).toEqual([]);
  });

  test("another account signing in closes it, imports nothing, and never shows the first account's garden", async ({ page }) => {
    const { auth, cloud } = await guestAndCloudGarden(page);
    await importSection(page).getByRole("button", { name: "Review and import…" }).click();
    await expect(importDialog(page)).toBeVisible();

    const otherTab = await openOtherTab(page);
    const otherAuth = await answerSupabaseFor(otherTab, cloud);
    otherAuth.reply("POST /verify", { status: 200, body: fakeSession(OTHER_EMAIL) });
    otherAuth.reply("POST /token", { status: 200, body: fakeSession(OTHER_EMAIL) });
    await otherTab.goto(SIGN_IN_LINK);
    await otherTab.getByRole("button", { name: "Finish signing in" }).click();
    await expect(otherTab.getByRole("region", { name: "Account" })).toContainText(`Signed in as ${OTHER_EMAIL}`);
    await otherTab.close();

    await expect(importDialog(page)).toBeHidden();
    await expect(resultNotice(page)).toContainText("Import cancelled");
    await expect(resultNotice(page)).not.toContainText("may still have completed");
    await expect(page.getByText("40 XP", { exact: false })).toHaveCount(0);
    expect(imports(auth)).toEqual([]);
    expect(cloud.saveOf(OTHER_EMAIL)).toBeUndefined();
  });
});

// Stage 8 Step 5: reliability. Lost replies, late commits, duplicates, account changes and navigation
// while an import is under way, reloading or closing during an unresolved import, a large garden, and
// saving afterwards.

/** Holds the next import until the test releases it, then answers as the database would. */
function holdImport(auth: FakeAuth) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  auth.reply("POST rpc/import_browser_save", async (request) => {
    await released;
    return auth.answerAsDatabase(request);
  });
  return release;
}

/** Signs `email` in from a second tab of this browser, which this tab then follows. */
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

/**
 * The import reached `email`'s account and no other: sent once, with that account's ID and token; that
 * account's cloud garden is now exactly the browser garden that was sent (5 XP, water done); and its
 * earlier 40 XP garden was backed up exactly once, as that account's browser_import backup.
 */
function expectImportedOnlyInto(auth: FakeAuth, cloud: FakeAuth["cloud"], email: string) {
  const sent = auth.requests.filter((request) => new URL(request.url()).pathname === "/rest/v1/rpc/import_browser_save");
  expect(sent).toHaveLength(1);
  const owner = fakeUserId(email);
  const args = sent[0].postDataJSON() as { p_user_id: string; p_data: unknown };
  expect(args.p_user_id).toBe(owner);
  expect(userIdFromBearer(sent[0])).toBe(owner);
  const saved = cloud.saveOf(email)?.data as { legacyXpBonus?: number; completionHistory?: Record<string, { completedQuestIds?: string[] }> };
  expect(saved).toEqual(args.p_data);
  expect(saved.legacyXpBonus ?? 0).toBe(0);
  expect(saved.completionHistory?.["2026-10-19"]?.completedQuestIds).toContain("water");
  const backups = importBackups(auth);
  expect(backups).toHaveLength(1);
  expect(backups[0].user_id).toBe(owner);
  expect((JSON.parse(backups[0].raw_data) as { legacyXpBonus?: number }).legacyXpBonus).toBe(40);
  // No backup of any kind was made in any other account.
  expect(cloud.backups.filter((backup) => backup.user_id !== owner)).toEqual([]);
}

async function confirmReplace(page: Page) {
  await importSection(page).getByRole("button", { name: "Review and import…" }).click();
  await importDialog(page).getByRole("button", { name: "Replace my cloud garden" }).click();
}

test.describe("Lost replies and late commits (Step 5)", () => {
  test("a reply lost after the import was saved is verified from the cloud: imported once, backed up once", async ({ page }) => {
    const { auth } = await guestAndCloudGarden(page);
    auth.reply("POST rpc/import_browser_save", (request) => {
      auth.answerAsDatabase(request);
      return "network-error";
    });
    await confirmReplace(page);

    await expect(resultNotice(page)).toContainText("Your browser garden is now your cloud garden");
    expect(imports(auth)).toHaveLength(1);
    expect(importBackups(auth)).toHaveLength(1);
    expect(cloudCompleted(auth, "water")).toBe(true);
    await expect(unresolvedCard(page)).toHaveCount(0);
  });

  test("an import that commits only after the reply was lost is found by Check, without sending it again", async ({ page }) => {
    const { auth } = await guestAndCloudGarden(page);
    let held: Parameters<FakeAuth["answerAsDatabase"]>[0] | null = null;
    auth.reply("POST rpc/import_browser_save", (request) => {
      held = request;
      return "network-error";
    });
    await confirmReplace(page);
    await expect(unresolvedCard(page)).toBeVisible();
    expect(cloudCompleted(auth, "water")).toBe(false);

    // The original transaction commits late, after the app's own check saw the old garden.
    auth.answerAsDatabase(held!);
    await unresolvedCard(page).getByRole("button", { name: "Check my cloud garden" }).click();

    await expect(resultNotice(page)).toContainText("Your browser garden is now your cloud garden");
    expect(imports(auth)).toHaveLength(1);
    expect(importBackups(auth)).toHaveLength(1);
    await openHome(page);
    await expectHomeXp(page, 5);
  });
});

test.describe("Duplicate requests (Step 5)", () => {
  test("a double click on Replace sends one import", async ({ page }) => {
    const { auth } = await guestAndCloudGarden(page);
    const release = holdImport(auth);
    await importSection(page).getByRole("button", { name: "Review and import…" }).click();
    await importDialog(page).getByRole("button", { name: "Replace my cloud garden" }).click({ clickCount: 2 });
    await expect(importDialog(page)).toContainText("Please keep this page open");
    release();

    await expect(resultNotice(page)).toContainText("now your cloud garden");
    expect(imports(auth)).toHaveLength(1);
    expect(importBackups(auth)).toHaveLength(1);
  });

  test("importing again after a successful import changes nothing and adds no backup", async ({ page }) => {
    const { auth } = await guestAndCloudGarden(page);
    await confirmReplace(page);
    await expect(resultNotice(page)).toContainText("now your cloud garden");
    await resultNotice(page).getByRole("button", { name: "Dismiss" }).click();

    await confirmReplace(page);
    await expect(resultNotice(page)).toContainText("already matches this browser");
    expect(imports(auth)).toHaveLength(2);
    expect(importBackups(auth)).toHaveLength(1);
  });
});

test.describe("Account changes while an import is under way (Step 5)", () => {
  test("signing out mid-import: the guest garden comes back unchanged, and the import only ever reached its own account", async ({ page }) => {
    const { auth, cloud, guestSave } = await guestAndCloudGarden(page);
    const guestStorage = await readGameStorage(page);
    const release = holdImport(auth);
    await confirmReplace(page);
    await expect(importDialog(page)).toContainText("Please keep this page open");

    const otherTab = await openOtherTab(page);
    await answerSupabaseFor(otherTab, auth.cloud);
    await otherTab.goto("/settings");
    await otherTab.getByRole("region", { name: "Account" }).getByRole("button", { name: "Sign out" }).click();
    await expect(otherTab.getByRole("region", { name: "Account" })).toContainText("You're signed out");
    await otherTab.close();
    release();

    await expect(resultNotice(page)).toContainText("Import interrupted");
    await expect(resultNotice(page)).toContainText("may still have completed in the account that started it");
    await expect(accountSection(page)).toContainText("You're playing as a guest");
    await openHome(page);
    await expectHomeXp(page, 5);
    expect(await readStorage(page, QUEST_SAVE_KEY)).toBe(guestSave);
    expect(await readGameStorage(page)).toEqual(guestStorage);
    expectImportedOnlyInto(auth, cloud, TEST_EMAIL);
  });

  test("another account signing in mid-import never shows or receives the first account's gardens", async ({ page }) => {
    const { auth, cloud } = await guestAndCloudGarden(page);
    const release = holdImport(auth);
    await confirmReplace(page);
    await expect(importDialog(page)).toContainText("Please keep this page open");

    await signInElsewhere(page, cloud, OTHER_EMAIL);
    release();

    await expect(resultNotice(page)).toContainText("Import interrupted");
    await expect(choiceCard(page)).toBeVisible();
    await expect(page.getByText(/40 \/ 100 XP/)).toHaveCount(0);
    expectImportedOnlyInto(auth, cloud, TEST_EMAIL);
    expect(cloud.saveOf(OTHER_EMAIL)).toBeUndefined();
  });
});

test.describe("Reloading or closing during an unresolved import (Step 5)", () => {
  test("a reload never resends it; the cloud garden loads; a late commit then shows as a conflict, never an overwrite", async ({ page }) => {
    const { auth } = await guestAndCloudGarden(page);
    let held: Parameters<FakeAuth["answerAsDatabase"]>[0] | null = null;
    auth.reply("POST rpc/import_browser_save", (request) => {
      held = request;
      return "network-error";
    });
    await confirmReplace(page);
    await expect(unresolvedCard(page)).toBeVisible();

    await page.reload();
    await openHome(page);
    await expectHomeXp(page, 40);
    await expect(unresolvedCard(page)).toHaveCount(0);
    expect(imports(auth)).toHaveLength(1);

    // The import commits after all. This page still has the older garden: its next save is refused.
    auth.answerAsDatabase(held!);
    await completeQuest(page, "Morning skincare");
    await expect(page.getByRole("region", { name: "Your garden changed somewhere else" })).toBeVisible({ timeout: 20_000 });
    expect(cloudCompleted(auth, "water")).toBe(true);
    expect(cloudCompleted(auth, "skincare")).toBe(false);
    expect(imports(auth)).toHaveLength(1);
  });

  test("closing the page and coming back loads the cloud garden, and sends nothing more", async ({ page, context }) => {
    const { auth, guestSave } = await guestAndCloudGarden(page);
    auth.reply("POST rpc/import_browser_save", "network-error");
    await confirmReplace(page);
    await expect(unresolvedCard(page)).toBeVisible();
    await page.close();

    const next = await context.newPage();
    await next.clock.install({ time: "2026-10-19T10:00:00Z" });
    const nextAuth = await answerSupabaseFor(next, auth.cloud);
    await next.goto("/");
    await expectHomeXp(next, 40);
    await expect(unresolvedCard(next)).toHaveCount(0);
    expect(cloudRequests(nextAuth, "POST rpc/import_browser_save")).toEqual([]);
    expect(await readStorage(next, QUEST_SAVE_KEY)).toBe(guestSave);
  });
});

test.describe("A large browser garden (Step 5)", () => {
  test("a garden of about 3 MB, close to what a browser can store, imports intact", async ({ page }) => {
    const notes = "A long journal entry about the garden. ".repeat(20_000);
    const large = JSON.parse(buildSave({ legacyXpBonus: 25 })) as { questLists: { personal: unknown[] } };
    large.questLists.personal = Array.from({ length: 4 }, (_, index) => ({
      id: `journal-${index}`, title: `Journal ${index}`, category: "Study", difficulty: "Easy", completed: false, notes,
    }));
    const text = JSON.stringify(large);
    expect(text.length).toBeGreaterThan(3_000_000);
    await seedStorage(page, { [QUEST_SAVE_KEY]: text });
    const cloud = createFakeCloud();
    const auth = await useFakeAuth(page, cloud);
    await openApp(page);
    await signIn(page);
    await openHome(page);

    await choiceCard(page).getByRole("button", { name: "Import my browser garden" }).click();
    await importDialog(page).getByRole("button", { name: "Import my browser garden" }).click();

    await expect(resultNotice(page)).toContainText("Your browser garden is now your cloud garden", { timeout: 20_000 });
    const saved = cloud.saveOf()?.data as { legacyXpBonus?: number; questLists: { personal: Array<{ notes?: string }> } };
    expect(saved.legacyXpBonus).toBe(25);
    expect(saved.questLists.personal.map((quest) => quest.notes)).toEqual([notes, notes, notes, notes]);
    expect(imports(auth)).toHaveLength(1);
    await expectHomeXp(page, 25);
  });
});

test.describe("A server without the import function (Step 5 review)", () => {
  test("before the migration is applied, the import fails plainly: no unresolved card, nothing changed, saving continues", async ({ page }) => {
    const { auth, guestSave } = await guestAndCloudGarden(page);
    // What PostgREST answers for a function it doesn't have (hosted Supabase before the Step 2 migration).
    auth.reply("POST rpc/import_browser_save", {
      status: 404,
      body: { code: "PGRST202", details: null, hint: null, message: "Could not find the function public.import_browser_save(p_data, p_expected_revision, p_schema_version, p_user_id) in the schema cache" },
    });
    await confirmReplace(page);

    await expect(resultNotice(page)).toContainText("The import didn't go through");
    await expect(resultNotice(page)).toContainText("Importing isn't set up on the server yet. Nothing was imported.");
    await expect(unresolvedCard(page)).toHaveCount(0);
    expect(imports(auth)).toHaveLength(1);
    expect(importBackups(auth)).toEqual([]);
    expect(cloudCompleted(auth, "water")).toBe(false);
    expect(await readStorage(page, QUEST_SAVE_KEY)).toBe(guestSave);

    // Not held back: the cloud garden is playable and saves as usual.
    await openHome(page);
    await expectHomeXp(page, 40);
    await completeQuest(page, "Morning skincare");
    await expect.poll(() => cloudCompleted(auth, "skincare")).toBe(true);
    await expect(page.locator(".save-status")).toHaveAttribute("data-save-status", "saved");
    expect(imports(auth)).toHaveLength(1);
  });
});

test.describe("Saving after an import (Step 5)", () => {
  test("after replacing the cloud garden, changes save to it normally and survive a reload", async ({ page }) => {
    const { auth } = await guestAndCloudGarden(page);
    await confirmReplace(page);
    await expect(resultNotice(page)).toContainText("now your cloud garden");
    await openHome(page);
    await expectHomeXp(page, 5);

    await completeQuest(page, "Morning skincare");
    await expect.poll(() => cloudCompleted(auth, "skincare")).toBe(true);
    await expect(page.locator(".save-status")).toHaveAttribute("data-save-status", "saved");
    await page.reload();
    await expectHomeXp(page, 10);
    await expect(page.getByRole("button", { name: "Mark incomplete: Morning skincare", exact: true })).toBeVisible();
  });
});

// Stage 8 Step 6: the page asks before it's left, and signing out asks first, while an import is being
// sent or its outcome is unconfirmed.

/** Every dialog the page opens from here on, dismissed (so a "Leave site?" prompt keeps the page). */
function collectDialogs(page: Page) {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  return dialogs;
}

async function expectLeavePrompt(page: Page) {
  const dialog = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const prompt = await dialog;
  expect(prompt.type()).toBe("beforeunload");
  // Dismissing it keeps the page open.
  await prompt.dismiss();
}

const importSignOutPrompt = (page: Page) => page.getByRole("alertdialog", { name: "Sign out before your import is confirmed?" });

test.describe("Leaving the page during an import (Step 6)", () => {
  test("the browser asks before leaving while an import is being sent, and not once it's done", async ({ page }) => {
    const { auth } = await guestAndCloudGarden(page);
    const release = holdImport(auth);
    await confirmReplace(page);
    await expect(importDialog(page)).toContainText("Please keep this page open");

    await expectLeavePrompt(page);
    release();
    await expect(resultNotice(page)).toContainText("now your cloud garden");

    const dialogs = collectDialogs(page);
    await page.reload();
    await openHome(page);
    await expectHomeXp(page, 5);
    expect(dialogs).toEqual([]);
  });

  test("the browser asks before leaving while an import is unresolved, and not once the cloud garden is loaded", async ({ page }) => {
    const { auth } = await guestAndCloudGarden(page);
    auth.reply("POST rpc/import_browser_save", "network-error");
    await confirmReplace(page);
    await expect(unresolvedCard(page)).toBeVisible();

    await expectLeavePrompt(page);
    await expect(unresolvedCard(page)).toBeVisible();

    await unresolvedCard(page).getByRole("button", { name: "Load my cloud garden without waiting" }).click();
    await expect(unresolvedCard(page)).toHaveCount(0);
    await expect(page.locator(".save-status")).toHaveAttribute("data-save-status", "saved");
    const dialogs = collectDialogs(page);
    await page.reload();
    await openHome(page);
    await expectHomeXp(page, 40);
    expect(dialogs).toEqual([]);
  });
});

test.describe("Signing out during an unresolved import (Step 6)", () => {
  test("asks first and says the import may still complete in this account; Cancel stays signed in, Sign out anyway signs out", async ({ page }) => {
    const { auth, guestSave } = await guestAndCloudGarden(page);
    auth.reply("POST rpc/import_browser_save", "network-error");
    await confirmReplace(page);
    await expect(unresolvedCard(page)).toBeVisible();

    await accountSection(page).getByRole("button", { name: "Sign out", exact: true }).click();
    const prompt = importSignOutPrompt(page);
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText("couldn't confirm whether your browser garden was imported into this account");
    await expect(prompt).toContainText("the import may still complete in this account");
    await expect(prompt).toContainText("Nothing goes to any other account");
    await expect(accountSection(page).getByRole("button", { name: "Sign out", exact: true })).toBeDisabled();

    await prompt.getByRole("button", { name: "Cancel" }).click();
    await expect(prompt).toHaveCount(0);
    await expect(accountSection(page)).toContainText("You're still signed in. Nothing was changed.");
    await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);
    await expect(unresolvedCard(page)).toBeVisible();
    expect(authRequests(auth, "POST /logout")).toHaveLength(0);

    await accountSection(page).getByRole("button", { name: "Sign out", exact: true }).click();
    await importSignOutPrompt(page).getByRole("button", { name: "Sign out anyway" }).click();
    await expect(accountSection(page)).toContainText("You're playing as a guest");
    await expect(unresolvedCard(page)).toHaveCount(0);
    expect(authRequests(auth, "POST /logout")).toHaveLength(1);
    expect(imports(auth)).toHaveLength(1);
    expect(await readStorage(page, QUEST_SAVE_KEY)).toBe(guestSave);
  });

  test("the question goes away once the import is confirmed, and signing out is then as usual", async ({ page }) => {
    const { auth } = await guestAndCloudGarden(page);
    let held: Parameters<FakeAuth["answerAsDatabase"]>[0] | null = null;
    auth.reply("POST rpc/import_browser_save", (request) => {
      held = request;
      return "network-error";
    });
    await confirmReplace(page);
    await expect(unresolvedCard(page)).toBeVisible();
    await accountSection(page).getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(importSignOutPrompt(page)).toBeVisible();

    // The import commits after all, and the check finds it.
    auth.answerAsDatabase(held!);
    await unresolvedCard(page).getByRole("button", { name: "Check my cloud garden" }).click();
    await expect(resultNotice(page)).toContainText("Your browser garden is now your cloud garden");
    await expect(importSignOutPrompt(page)).toHaveCount(0);
    await expect(accountSection(page)).toContainText(`Signed in as ${TEST_EMAIL}`);
    expect(authRequests(auth, "POST /logout")).toHaveLength(0);

    await expect(page.locator(".save-status")).toHaveAttribute("data-save-status", "saved");
    await accountSection(page).getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(accountSection(page)).toContainText("You're playing as a guest");
    await expect(importSignOutPrompt(page)).toHaveCount(0);
  });

  test("works from the keyboard: focus moves to Cancel, Escape returns to Sign out, and Sign out anyway is reachable", async ({ page }) => {
    const { auth } = await guestAndCloudGarden(page);
    auth.reply("POST rpc/import_browser_save", "network-error");
    await confirmReplace(page);
    await expect(unresolvedCard(page)).toBeVisible();
    const signOut = accountSection(page).getByRole("button", { name: "Sign out", exact: true });
    const prompt = importSignOutPrompt(page);

    await signOut.focus();
    await page.keyboard.press("Enter");
    await expect(prompt.getByRole("button", { name: "Cancel" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(prompt).toHaveCount(0);
    await expect(signOut).toBeFocused();
    expect(authRequests(auth, "POST /logout")).toHaveLength(0);

    await page.keyboard.press("Enter");
    await expect(prompt.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(prompt.getByRole("button", { name: "Sign out anyway" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(accountSection(page)).toContainText("You're playing as a guest");
    expect(authRequests(auth, "POST /logout")).toHaveLength(1);
  });

  test("signing out with no import pending doesn't ask about one", async ({ page }) => {
    const { auth } = await guestAndCloudGarden(page);
    await accountSection(page).getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(accountSection(page)).toContainText("You're playing as a guest");
    await expect(importSignOutPrompt(page)).toHaveCount(0);
    expect(authRequests(auth, "POST /logout")).toHaveLength(1);
  });
});
