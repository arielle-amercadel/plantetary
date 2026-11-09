import legacyFixture from "./fixtures/main-legacy-save.json";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { test, expect, openApp, completeQuest, readStorage, QUEST_SAVE_KEY, chooseOption, addQuestFromHome, clickNavLink, expectHomeXp, MONDAY, DAY_MS, seedStorage } from "./support";
import { openOtherTab, useFakeAuth, createFakeCloud } from "./auth-support";

const notice = (page: Page) => page.getByRole("region", { name: "Browser garden editing" });
const complete = (page: Page) => page.getByRole("button", { name: "Complete: Drink a glass of water", exact: true });
async function follower(page: Page, path = "/") {
  const other = await openOtherTab(page);
  await openApp(other, path);
  await expect(notice(other)).toBeVisible();
  return other;
}
async function createQuest(page: Page, title: string) {
  await addQuestFromHome(page, "personal", title);
}

test("the editor's new quest survives a stale follower; progress synchronizes and hands off", async ({ page }) => {
  await openApp(page); await expect(complete(page)).toBeEnabled();
  const other = await follower(page);
  await createQuest(page, "Protect the new quest");
  await expect(other.getByText("Protect the new quest", { exact: true })).toBeVisible();
  await expect(complete(other)).toBeDisabled();
  await other.evaluate(() => document.querySelector<HTMLButtonElement>('[aria-label="Complete: Drink a glass of water"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(await readStorage(other, QUEST_SAVE_KEY)).toContain("Protect the new quest");
  await completeQuest(page, "Drink a glass of water");
  await expectHomeXp(other, 5);
  await page.close();
  await expect(notice(other)).toBeHidden();
  await expect(other.getByRole("button", { name: "Complete: Morning skincare", exact: true })).toBeEnabled();
  await completeQuest(other, "Morning skincare");
  await other.reload();
  await expectHomeXp(other, 10);
  await expect(other.getByText("Protect the new quest", { exact: true })).toBeVisible();
});

test("a follower cannot save preferences or reset; editor reset cannot be resurrected", async ({ page }) => {
  await openApp(page); await expect(complete(page)).toBeEnabled();
  await createQuest(page, "Remove on reset");
  const other = await follower(page, "/settings");
  await expect(other.getByRole("button", { name: "Save profile", exact: true })).toBeDisabled();
  await expect(other.getByRole("button", { name: "Reset Plantetary data" })).toBeDisabled();
  await clickNavLink(page, "Settings", { exact: true });
  page.once("dialog", (dialog) => dialog.accept());
  // The follower must react while it stays on the same Settings page.
  await page.getByRole("button", { name: "Reset Plantetary data" }).click();
  await expect(page.getByText("Plantetary data was reset on this device.")).toBeVisible();
  await expect.poll(() => readStorage(other, "plantetary-browser-reset")).not.toBeNull();
  await expect.poll(() => readStorage(other, QUEST_SAVE_KEY)).not.toContain("Remove on reset");
  await page.close();
  await expect(notice(other)).toBeHidden();
  await clickNavLink(other, "Home", { exact: true });
  await expect(complete(other)).toBeEnabled();
  await completeQuest(other, "Drink a glass of water");
  await other.reload();
  expect(await readStorage(other, QUEST_SAVE_KEY)).not.toContain("Remove on reset");
  await expectHomeXp(other, 5);
});

test("unsupported Web Locks is read-only and never seeds or migrates storage", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "locks", { value: undefined }));
  await openApp(page);
  await expect(notice(page)).toContainText("read-only");
  await expect(complete(page)).toBeDisabled();
  expect(await readStorage(page, QUEST_SAVE_KEY)).toBeNull();
  await page.clock.fastForward(DAY_MS);
  expect(await readStorage(page, QUEST_SAVE_KEY)).toBeNull();
});

test("simultaneous first visits elect one writer, including daily rollover", async ({ page, context }) => {
  const other = await context.newPage();
  await other.clock.install({ time: MONDAY });
  await Promise.all([openApp(page), openApp(other)]);
  await expect.poll(async () => Number(await complete(page).isEnabled()) + Number(await complete(other).isEnabled())).toBe(1);
  const editor = await complete(page).isEnabled() ? page : other;
  const reader = editor === page ? other : page;
  await completeQuest(editor, "Drink a glass of water");
  await expectHomeXp(reader, 5);
  // Playwright's clock is shared by pages in this context: advance once, not once per tab.
  await editor.clock.fastForward(DAY_MS);
  await expect(editor.getByText("Tuesday, October 20", { exact: true })).toBeVisible();
  await expect(reader.getByText("Tuesday, October 20", { exact: true })).toBeVisible();
  await expect(complete(reader)).toBeDisabled();
  await completeQuest(editor, "Drink a glass of water");
  await expectHomeXp(reader, 10);
  const persisted = JSON.parse((await readStorage(reader, QUEST_SAVE_KEY))!);
  expect(persisted.completionHistory["2026-10-19"].xpAwardedByQuestId.water).toBe(5);
  expect(persisted.completionHistory["2026-10-20"].xpAwardedByQuestId.water).toBe(5);
  expect(persisted.completionHistory["2026-10-19"].completedQuestIds).toContain("water");
  expect(persisted.completionHistory["2026-10-20"].completedQuestIds).toContain("water");
  await editor.reload();
  await expectHomeXp(editor, 10);
  expect(JSON.parse((await readStorage(editor, QUEST_SAVE_KEY))!).completionHistory).toEqual(persisted.completionHistory);
});

test("unexpected external changes pause the editor and preserve changes for download", async ({ page }) => {
  await openApp(page); await expect(complete(page)).toBeEnabled();
  const other = await follower(page);
  await page.evaluate(() => {
    sessionStorage.setItem("block-guest-test-writes", "1");
    const originalRead = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {
      if (this === localStorage && key === "plantetary-quest-data" && originalRead.call(sessionStorage, "block-guest-test-reads")) throw new Error("Test read refusal");
      return originalRead.call(this, key);
    };
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (this === localStorage && key === "plantetary-quest-data" && sessionStorage.getItem("block-guest-test-writes")) throw new Error("Test storage refusal");
      return original.call(this, key, value);
    };
  });
  await completeQuest(page, "Drink a glass of water");
  await expect(page.getByRole("heading", { name: "Your latest changes haven't been saved" })).toBeVisible();
  await other.evaluate((key) => {
    const garden = JSON.parse(localStorage.getItem(key)!);
    garden.questLists.personal.push({ id: "external", title: "External quest", category: "Home", difficulty: "Easy", completed: false });
    localStorage.setItem(key, JSON.stringify(garden));
  }, QUEST_SAVE_KEY);
  await expect(page.getByRole("heading", { name: "Your garden changed somewhere else" })).toBeVisible();
  await expect(complete(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mark incomplete: Drink a glass of water", exact: true })).toBeDisabled();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download my changes", exact: true }).click();
  const file = await downloaded;
  const recovered = JSON.parse(await readFile((await file.path())!, "utf8"));
  expect(Object.values(recovered.completionHistory).some((snapshot) => (snapshot as { completedQuestIds: string[] }).completedQuestIds.includes("water"))).toBe(true);
  await page.evaluate(() => {
    sessionStorage.removeItem("block-guest-test-writes");
    sessionStorage.setItem("block-guest-test-reads", "1");
  });
  await page.getByRole("button", { name: "Load latest garden", exact: true }).click();
  await page.getByRole("button", { name: "Load latest anyway" }).click();
  await expect(page.getByRole("heading", { name: "Your browser garden couldn't be loaded" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Your progress", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Player progress", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Complete|Mark incomplete):/ })).toHaveCount(0);
  const secondDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download my changes", exact: true }).click();
  expect(JSON.parse(await readFile((await (await secondDownload).path())!, "utf8"))).toEqual(recovered);
  await page.getByRole("button", { name: "Try loading latest garden", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download my changes", exact: true })).toBeVisible();
  await page.evaluate(() => sessionStorage.removeItem("block-guest-test-reads"));
  await page.getByRole("button", { name: "Try loading latest garden", exact: true }).click();
  await page.getByRole("button", { name: "Load latest anyway" }).click();
  await expect(page.getByText("External quest", { exact: true })).toBeVisible();
  await expect(complete(page)).toBeEnabled();
});

test("signed-in device-only play shares guest ownership", async ({ page }) => {
  const cloud = createFakeCloud();
  await useFakeAuth(page, cloud);
  await page.goto("/auth/confirm?token_hash=pkce_0123456789abcdef&type=email");
  await page.getByRole("button", { name: "Finish signing in" }).click();
  await page.getByRole("button", { name: "Keep playing on this device", exact: true }).click();
  await clickNavLink(page, "Home", { exact: true });
  await expect(complete(page)).toBeEnabled();
  const other = await openOtherTab(page);
  await useFakeAuth(other, cloud);
  await other.goto("/settings");
  await other.getByRole("button", { name: "Keep playing on this device", exact: true }).click();
  await clickNavLink(other, "Home", { exact: true });
  await expect(notice(other)).toBeVisible();
  await expect(complete(other)).toBeDisabled();
  await completeQuest(page, "Drink a glass of water");
  await expectHomeXp(other, 5);
});

test("a stale quest form cannot save after the follower becomes editor", async ({ page }) => {
  await openApp(page); await expect(complete(page)).toBeEnabled();
  const other = await follower(page, "/quests/new?type=personal");
  await other.getByLabel("Quest title").fill("Keep my draft visible");
  await chooseOption(other, "Category", "Personal");
  await chooseOption(other, "Difficulty", "Easy · 5 XP");
  await createQuest(page, "A newer saved quest");
  await expect(other.getByRole("alert").filter({ hasText: "Your garden changed while this form was open" })).toBeVisible();
  await page.close();
  await expect(notice(other)).toBeHidden();
  await expect(other.getByLabel("Quest title")).toHaveValue("Keep my draft visible");
  await expect(other.getByRole("button", { name: "Save quest", exact: true })).toBeDisabled();
  expect(await readStorage(other, QUEST_SAVE_KEY)).toContain("A newer saved quest");
});

test("refreshing the editor hands control to the waiting tab", async ({ page }) => {
  await openApp(page); await expect(complete(page)).toBeEnabled();
  const other = await follower(page);
  await page.reload();
  await expect(complete(other)).toBeEnabled();
  await expect(notice(page)).toBeVisible();
  await completeQuest(other, "Drink a glass of water");
  await expectHomeXp(page, 5);
  await expect(page.getByRole("button", { name: "Mark incomplete: Drink a glass of water", exact: true })).toBeDisabled();
});

async function fillPersonalDraft(page: Page, title: string) {
  await page.getByLabel("Quest title").fill(title);
  await chooseOption(page, "Category", "Personal");
  await chooseOption(page, "Difficulty", "Easy · 5 XP");
}

test("an identical-content reset invalidates an already-open follower draft", async ({ page }) => {
  await openApp(page); await expect(complete(page)).toBeEnabled();
  const other = await follower(page, "/quests/new?type=personal");
  await fillPersonalDraft(other, "Draft from before reset");
  await clickNavLink(page, "Settings", { exact: true });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset Plantetary data" }).click();
  await expect(other.getByRole("alert").filter({ hasText: "Your garden changed while this form was open" })).toBeVisible();
  await page.close();
  await expect(notice(other)).toBeHidden();
  await expect(other.getByLabel("Quest title")).toHaveValue("Draft from before reset");
  await expect(other.getByRole("button", { name: "Save quest", exact: true })).toBeDisabled();
  expect(await readStorage(other, QUEST_SAVE_KEY)).not.toContain("Draft from before reset");
});

test("normal ownership handoff preserves a current draft and allows saving", async ({ page }) => {
  await openApp(page); await expect(complete(page)).toBeEnabled();
  const other = await follower(page, "/quests/new?type=personal");
  await fillPersonalDraft(other, "Draft without reset");
  await page.close();
  await expect(notice(other)).toBeHidden();
  await expect(other.getByLabel("Quest title")).toHaveValue("Draft without reset");
  await expect(other.getByRole("button", { name: "Save quest", exact: true })).toBeEnabled();
  await other.getByRole("button", { name: "Save quest", exact: true }).click();
  await expect(other).toHaveURL(/\/$/);
  expect(await readStorage(other, QUEST_SAVE_KEY)).toContain("Draft without reset");
});

test("a migration-backup quota failure permits only an explicitly confirmed reset", async ({ page }) => {
  const original = JSON.stringify(legacyFixture.save);
  await seedStorage(page, { [QUEST_SAVE_KEY]: original });
  await page.addInitScript(() => {
    const originalWrite = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (this === localStorage && key === "plantetary-quest-data-backup-v1") throw new Error("QuotaExceededError");
      return originalWrite.call(this, key, value);
    };
  });
  // The failed garden deliberately does not satisfy openApp's loaded-date helper.
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Your browser garden couldn't be loaded" })).toBeVisible();
  await expect(page.getByText(/Your older garden was validated, but its safety copy could not be stored/)).toBeVisible();
  const reset = page.getByRole("button", { name: "Reset Plantetary data", exact: true });
  await expect(reset).toBeEnabled();
  await expect(page.getByRole("button", { name: "Export data as JSON", exact: true })).toBeEnabled();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export data as JSON", exact: true }).click();
  const exported = JSON.parse(await readFile((await (await download).path())!, "utf8"));
  expect(exported.questData.questLists.personal).toHaveLength(legacyFixture.save.questLists.personal.length);
  page.once("dialog", (dialog) => dialog.dismiss());
  await reset.click();
  expect(await readStorage(page, QUEST_SAVE_KEY)).toBe(original);
  page.once("dialog", (dialog) => dialog.accept());
  await reset.click();
  await expect(page.getByText("Plantetary data was reset on this device.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your browser garden couldn't be loaded" })).toHaveCount(0);
  expect(await readStorage(page, "plantetary-browser-reset")).toBeTruthy();
  expect(await readStorage(page, QUEST_SAVE_KEY)).not.toBe(original);
});

for (const rollbackFails of [true, false]) {
  test(`failed reset with rollback failure ${rollbackFails} preserves recovery safety`, async ({ page }) => {
    await openApp(page);
    await completeQuest(page, "Drink a glass of water");
    const original = await readStorage(page, QUEST_SAVE_KEY);
    await clickNavLink(page, "Settings", { exact: true });
    await page.getByLabel("Display name").fill("Robin");
    await page.getByRole("radio", { name: "Leaf" }).check();
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await expect(page.locator(".player-account .account-copy strong")).toHaveText("Robin");
    await page.evaluate(({ key, rollbackFails }) => {
      const remove = Storage.prototype.removeItem;
      const set = Storage.prototype.setItem;
      let restoring = false;
      Storage.prototype.removeItem = function (name) {
        if (name === "plantetary-quest-data-backup-v1") {
          restoring = true;
          throw new Error("Simulated deletion failure");
        }
        return remove.call(this, name);
      };
      Storage.prototype.setItem = function (name, value) {
        if (restoring && rollbackFails && name === key) throw new Error("Simulated rollback failure");
        return set.call(this, name, value);
      };
    }, { key: QUEST_SAVE_KEY, rollbackFails });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Reset Plantetary data", exact: true }).click();
    await expect(page.getByText(/Plantetary could not safely complete the reset/)).toBeVisible();
    await expect(page.locator(".player-account .account-copy strong")).toHaveText("Robin");
    await expect(page.getByLabel("Display name")).toHaveValue("Robin");
    const warning = page.getByRole("heading", { name: "Your progress may not be saved", exact: true });
    if (rollbackFails) {
      await expect(warning).toBeVisible();
      expect(await readStorage(page, QUEST_SAVE_KEY)).toBeNull();
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download my changes", exact: true }).click();
      expect(JSON.parse(await readFile((await (await download).path())!, "utf8"))).toEqual(JSON.parse(original!));
      // Probe the real registered unload handler without navigating or dropping the retained garden.
      expect(await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      })).toBe(true);
      await expect(page.getByRole("button", { name: "Reset Plantetary data", exact: true })).toBeDisabled();
    } else {
      expect(await readStorage(page, QUEST_SAVE_KEY)).toBe(original);
      await expect(warning).toHaveCount(0);
      expect(await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      })).toBe(false);
    }
  });
}
