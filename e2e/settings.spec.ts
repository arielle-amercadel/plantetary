import { readFile } from "node:fs/promises";
import {
  INVALID_BACKUP_KEY,
  PROFILE_KEY,
  QUEST_SAVE_KEY,
  STARTER_DAILY,
  VALID_BACKUP_KEY,
  buildSave,
  completeQuest,
  dailyPanel,
  expect,
  expectHomeXp,
  openApp,
  questRow,
  readStorage,
  reloadApp,
  seedStorage,
  test,
} from "./support";
import type { Page } from "@playwright/test";

const QUEST_TITLE = STARTER_DAILY[0];

function displayNameField(page: Page) {
  return page.getByLabel("Display name");
}

async function openSettings(page: Page) {
  await openApp(page, "/settings");
  await expect(displayNameField(page)).toBeEnabled();
}

async function saveDisplayName(page: Page, name: string) {
  await displayNameField(page).fill(name);
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved on this device.")).toBeVisible();
}

test.describe("Settings", () => {
  test("the profile name and avatar persist and appear across the app", async ({ page }) => {
    await openSettings(page);
    await page.getByRole("radio", { name: "Leaf" }).check();
    await saveDisplayName(page, "Robin");
    await expect(page.getByRole("heading", { name: "Robin’s adventure" })).toBeVisible();

    await reloadApp(page);
    await expect(displayNameField(page)).toHaveValue("Robin");
    await expect(page.getByRole("radio", { name: "Leaf" })).toBeChecked();

    await openApp(page);
    await expect(page.getByText("Welcome back, Robin.")).toBeVisible();
    await expect(page.getByRole("img", { name: "Robin's Garden" })).toBeVisible();
  });

  test("an empty display name is rejected and the saved name is kept", async ({ page }) => {
    await openSettings(page);
    await saveDisplayName(page, "Robin");

    await displayNameField(page).fill("   ");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText("Enter a display name before saving.")).toBeVisible();

    await reloadApp(page);
    await expect(displayNameField(page)).toHaveValue("Robin");
  });

  test("reminder preferences persist after a reload", async ({ page }) => {
    await openSettings(page);
    await page.getByRole("checkbox", { name: "Save a reminder preference" }).check();
    await page.getByRole("checkbox", { name: "Personal Quests" }).uncheck();
    await page.getByLabel("Preferred time").fill("07:30");
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(page.getByText(/^Reminder preferences saved on this device/)).toBeVisible();

    await reloadApp(page);
    await expect(displayNameField(page)).toBeEnabled();
    await expect(page.getByRole("checkbox", { name: "Save a reminder preference" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Daily Quests" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Personal Quests" })).not.toBeChecked();
    await expect(page.getByLabel("Preferred time")).toHaveValue("07:30");
  });

  test("export downloads a backup of the current progress", async ({ page }) => {
    await openApp(page);
    await completeQuest(page, QUEST_TITLE);
    await openSettings(page);
    await saveDisplayName(page, "Robin");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export data as JSON" }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe("plantetary-backup-2026-10-19.json");
    const backup = JSON.parse(await readFile(await download.path(), "utf8"));
    expect(backup).toMatchObject({
      app: "Plantetary",
      totalXp: 5,
      profilePreferences: { displayName: "Robin" },
    });
    expect(backup.questData.completionHistory["2026-10-19"].completedQuestIds).toEqual(["water"]);
    await expect(page.getByText("Your Plantetary backup was downloaded.")).toBeVisible();
  });
});

test.describe("Resetting progress", () => {
  test("canceling keeps everything", async ({ page }) => {
    await openApp(page);
    await completeQuest(page, QUEST_TITLE);
    await openSettings(page);

    await page.getByRole("radio", { name: "Leaf" }).check();
    await saveDisplayName(page, "Robin");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "Reset Plantetary data" }).click();
    await expect(page.getByText("Reset canceled. Your saved data is unchanged.")).toBeVisible();

    await expect(page.locator(".player-account .account-copy strong")).toHaveText("Robin");
    await expect(displayNameField(page)).toHaveValue("Robin");
    await openApp(page);
    await expectHomeXp(page, 5);
  });

  test("confirming returns the app to a fresh start", async ({ page }) => {
    await openApp(page);
    await completeQuest(page, QUEST_TITLE);
    await page.getByRole("button", { name: `Remove ${STARTER_DAILY[1]}` }).click();
    await openSettings(page);
    await page.getByRole("radio", { name: "Leaf" }).check();
    await saveDisplayName(page, "Robin");

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Reset Plantetary data" }).click();
    await expect(page.getByText("Plantetary data was reset on this device.")).toBeVisible();
    await expect(displayNameField(page)).toHaveValue("Mira");
    expect(await readStorage(page, PROFILE_KEY)).toBeNull();
    await expect(page.locator(".player-account .account-copy strong")).toHaveText("Mira");
    await expect(page.locator(".player-account .player-avatar")).toHaveText("M");

    await openApp(page);
    await expectHomeXp(page, 0);
    await expect(dailyPanel(page).getByText("0 / 4 done")).toBeVisible();
    await expect(questRow(dailyPanel(page), STARTER_DAILY[1])).toBeVisible();
    await expect(page.getByText("Welcome back, Mira.")).toBeVisible();

    await openApp(page, "/completion-history");
    await expect(page.getByRole("heading", { name: "Your story is just beginning" })).toBeVisible();

    // The reset must stick rather than being overwritten by the previous session's data.
    await openApp(page);
    await reloadApp(page);
    await expectHomeXp(page, 0);
  });
});

test.describe("Corrupted browser save data", () => {
  for (const [description, rawSave] of [
    ["unreadable JSON", "{not valid json"],
    ["the wrong shape", JSON.stringify({ questLists: "nope", categoryLists: 42 })],
  ] as const) {
    test(`a save with ${description} falls back to starter quests and keeps a backup`, async ({ page }) => {
      await seedStorage(page, { [QUEST_SAVE_KEY]: rawSave });

      await openApp(page);
      await expect(dailyPanel(page).getByText("0 / 4 done")).toBeVisible();
      await expectHomeXp(page, 0);
      expect(await readStorage(page, INVALID_BACKUP_KEY)).toBe(rawSave);

      // The app keeps working and saves normally afterward, without replacing the backup.
      await completeQuest(page, QUEST_TITLE);
      await expectHomeXp(page, 5);
      await reloadApp(page);
      await expectHomeXp(page, 5);
      expect(await readStorage(page, INVALID_BACKUP_KEY)).toBe(rawSave);
    });
  }

  test("corrupted history is dropped while valid quests are kept and the original is backed up", async ({ page }) => {
    const title = "My own quest";
    const validSave = JSON.parse(buildSave({
      daily: [{ id: "mine", title, category: "Wellness", schedule: "Every day", difficulty: "Easy", completed: false, repeatSchedule: "Every day" }],
    }));
    const rawSave = JSON.stringify({ ...validSave, completionHistory: "garbage" });
    await seedStorage(page, { [QUEST_SAVE_KEY]: rawSave });

    await openApp(page);
    await expect(questRow(dailyPanel(page), title)).toBeVisible();
    await expectHomeXp(page, 0);
    expect(await readStorage(page, VALID_BACKUP_KEY)).toBe(rawSave);

    await completeQuest(page, title);
    await expectHomeXp(page, 5);
  });

  test("corrupted profile preferences fall back to the default name", async ({ page }) => {
    await seedStorage(page, { [PROFILE_KEY]: "{oops" });

    await openApp(page);
    await expect(page.getByText("Welcome back, Mira.")).toBeVisible();

    await openSettings(page);
    await expect(displayNameField(page)).toHaveValue("Mira");
    await saveDisplayName(page, "Robin");
    await reloadApp(page);
    await expect(displayNameField(page)).toHaveValue("Robin");
  });
});
