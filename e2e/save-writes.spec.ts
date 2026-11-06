import type { Page } from "@playwright/test";
import {
  QUEST_SAVE_KEY,
  completeQuest,
  expect,
  openApp,
  readStorage,
  reloadApp,
  test,
} from "./support";

/** Counts writes to the game save, kept in session storage so the count survives reloads. */
async function countSaveWrites(page: Page) {
  await page.addInitScript((saveKey) => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === window.localStorage && key === saveKey) {
        const writes = Number(window.sessionStorage.getItem("e2e-save-writes") ?? "0");
        window.sessionStorage.setItem("e2e-save-writes", String(writes + 1));
      }
      return originalSetItem.call(this, key, value);
    };
  }, QUEST_SAVE_KEY);
}

function saveWrites(page: Page) {
  return page.evaluate(() => Number(window.sessionStorage.getItem("e2e-save-writes") ?? "0"));
}

test.describe("Saving only when something changed", () => {
  test("a first visit saves once, and reloading without changes saves nothing", async ({ page }) => {
    await countSaveWrites(page);
    await openApp(page);
    expect(await saveWrites(page)).toBe(1);
    const firstSave = await readStorage(page, QUEST_SAVE_KEY);

    await reloadApp(page);
    await reloadApp(page);

    expect(await saveWrites(page)).toBe(1);
    expect(await readStorage(page, QUEST_SAVE_KEY)).toBe(firstSave);
  });

  test("a change is saved once and survives a reload", async ({ page }) => {
    await countSaveWrites(page);
    await openApp(page);
    await completeQuest(page, "Drink a glass of water");
    expect(await saveWrites(page)).toBe(2);

    await reloadApp(page);

    await expect(page.getByRole("button", { name: "Mark incomplete: Drink a glass of water", exact: true })).toBeVisible();
    expect(await saveWrites(page)).toBe(2);
  });
});
