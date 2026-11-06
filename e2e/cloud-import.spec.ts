import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import {
  TEST_EMAIL,
  answerSupabaseFor,
  cloudRequests,
  createFakeCloud,
  fakeSession,
  openOtherTab,
  useFakeAuth,
  type FakeAuth,
} from "./auth-support";
import { QUEST_SAVE_KEY, completeQuest, expect, expectHomeXp, openApp, readStorage, test } from "./support";

// Stage 8 Step 4: the guest-to-cloud import UI. Focused on what the screens show and do; the full
// browser test matrix is Step 5.

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
  await page.waitForTimeout(1000);
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
    await expect(page.getByText("40 XP", { exact: false })).toHaveCount(0);
    expect(imports(auth)).toEqual([]);
    expect(cloud.saveOf(OTHER_EMAIL)).toBeUndefined();
  });
});
