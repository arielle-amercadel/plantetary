import {
  QUEST_SAVE_KEY,
  STARTER_DAILY,
  buildSave,
  completeQuest,
  expect,
  expectHomeXp,
  openApp,
  reloadApp,
  seedStorage,
  test,
  uncompleteQuest,
} from "./support";
import type { Page } from "@playwright/test";

function journalSummary(page: Page) {
  return page.getByRole("region", { name: "Plant collection progress" });
}

async function unwrapGift(page: Page, plantName: string) {
  await page.getByRole("button", { name: "Unwrap gift" }).click();
  await expect(page.getByText(`${plantName} has joined your collection!`)).toBeVisible();
}

const ALL_PLANT_IDS = [
  "fern", "daisy", "cactus", "sunflower", "lavender", "monstera", "moonflower", "golden-bonsai",
  "tulip", "aloe-vera", "hydrangea", "string-of-pearls", "orchid", "venus-flytrap", "anthurium", "calathea",
];
const allPlantsExcept = (...plantIds: string[]) => ALL_PLANT_IDS.filter((id) => !plantIds.includes(id));

test.describe("Plant rewards", () => {
  test("the starter gift can be unwrapped once and stays collected", async ({ page }) => {
    await openApp(page, "/plant-journal");
    await expect(page.getByText("A little mystery gift is waiting")).toBeVisible();
    await expect(page.getByRole("link", { name: "Plant Journal, 1 gift waiting" })).toBeVisible();
    await expect(journalSummary(page)).toContainText("0 of 16 plants");

    await unwrapGift(page, "Fern");

    await expect(journalSummary(page)).toContainText("1 of 16 plants");
    await expect(page.getByRole("button", { name: "Unwrap gift" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Plant Journal", exact: true })).toBeVisible();

    await reloadApp(page);
    await expect(journalSummary(page)).toContainText("1 of 16 plants");
    await expect(page.getByRole("button", { name: "Unwrap gift" })).toHaveCount(0);
  });

  test("earning a gift shows it as waiting, and both screens name the same next plant", async ({ page }) => {
    await openApp(page, "/plant-journal");
    await unwrapGift(page, "Fern");

    await openApp(page);
    await expect(page.getByRole("progressbar", { name: "XP progress toward Daisy" })).toBeVisible();
    for (const title of STARTER_DAILY) await completeQuest(page, title);
    await expectHomeXp(page, 25);

    // Daisy (25 XP) is earned but still wrapped, so the next plant to work toward is Cactus.
    await expect(page.getByRole("link", { name: "Plant Journal, 1 gift waiting" })).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "XP progress toward Cactus" })).toBeVisible();
    await expect(page.getByText("Discover at 60 XP.")).toBeVisible();
    await expect(page.getByText("25 / 60 XP · 35 to go")).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "XP progress toward Daisy" })).toHaveCount(0);
    await expect(page.getByText("1 of 16 plants discovered")).toBeVisible();

    await openApp(page, "/plant-journal");
    await expect(journalSummary(page)).toContainText("Cactus");
    await expect(journalSummary(page)).toContainText("35 XP until discovery");
    await expect(journalSummary(page)).toContainText("25 XP in your ledger");

    await unwrapGift(page, "Daisy");
    await expect(journalSummary(page)).toContainText("2 of 16 plants");
    await expect(journalSummary(page)).toContainText("Cactus");

    await page.getByRole("button", { name: "Collected" }).click();
    await expect(page.getByRole("heading", { name: "Daisy", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Fern", exact: true })).toBeVisible();
    await expect(page.getByText("Showing 2 plants")).toBeVisible();

    await openApp(page);
    await expect(page.getByText("2 of 16 plants discovered")).toBeVisible();
    await expect(page.getByRole("img", { name: "Daisy", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Plant Journal", exact: true })).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "XP progress toward Cactus" })).toBeVisible();

    await reloadApp(page);
    await expect(page.getByText("2 of 16 plants discovered")).toBeVisible();
  });

  test("an earned gift stays waiting even if the XP behind it is removed", async ({ page }) => {
    await openApp(page, "/plant-journal");
    await unwrapGift(page, "Fern");

    await openApp(page);
    for (const title of STARTER_DAILY) await completeQuest(page, title);
    await expect(page.getByRole("link", { name: "Plant Journal, 1 gift waiting" })).toBeVisible();

    await uncompleteQuest(page, STARTER_DAILY[0]);
    await expectHomeXp(page, 20);
    await reloadApp(page);
    await expect(page.getByRole("link", { name: "Plant Journal, 1 gift waiting" })).toBeVisible();
  });

  test("the final wrapped gift is not called a complete collection until it is unwrapped", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: buildSave({
        legacyXpBonus: 1800,
        discoveredPlantIds: allPlantsExcept("calathea"),
        pendingPlantGiftIds: ["calathea"],
      }),
    });

    await openApp(page);
    await expect(page.getByRole("heading", { name: "Your collection is almost complete" })).toBeVisible();
    await expect(page.getByText("A gift is waiting to be unwrapped in your Plant Journal.")).toBeVisible();
    await expect(page.getByText("15 of 16 plants discovered")).toBeVisible();
    await expect(page.getByText("All 16 plants have been discovered.")).toHaveCount(0);

    await openApp(page, "/plant-journal");
    await expect(journalSummary(page)).toContainText("A gift is waiting");
    await expect(journalSummary(page)).toContainText("Ready to be unwrapped");
    await expect(journalSummary(page)).not.toContainText("All plants discovered");

    await unwrapGift(page, "Calathea");
    await expect(journalSummary(page)).toContainText("All plants discovered");
    await expect(journalSummary(page)).toContainText("Your collection is complete");
    await expect(journalSummary(page)).toContainText("16 of 16 plants");

    await openApp(page);
    await expect(page.getByRole("heading", { name: "Your collection is complete" })).toBeVisible();
    await expect(page.getByText("All 16 plants have been discovered.")).toBeVisible();

    await reloadApp(page);
    await expect(page.getByRole("heading", { name: "Your collection is complete" })).toBeVisible();
  });

  test("several final wrapped gifts are counted, and each must be unwrapped", async ({ page }) => {
    await seedStorage(page, {
      [QUEST_SAVE_KEY]: buildSave({
        legacyXpBonus: 1800,
        discoveredPlantIds: allPlantsExcept("orchid", "calathea"),
        pendingPlantGiftIds: ["orchid", "calathea"],
      }),
    });

    await openApp(page);
    await expect(page.getByText("2 gifts are waiting to be unwrapped in your Plant Journal.")).toBeVisible();

    await openApp(page, "/plant-journal");
    await expect(journalSummary(page)).toContainText("2 gifts are waiting");

    await unwrapGift(page, "Orchid");
    await expect(journalSummary(page)).toContainText("A gift is waiting");

    await unwrapGift(page, "Calathea");
    await expect(journalSummary(page)).toContainText("Your collection is complete");
  });
});
