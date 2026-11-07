import type { Page } from "@playwright/test";
import { expect, openApp, test } from "./support";

// Phones and tablets: a compact header whose menu button opens the links as a floating panel, and a
// Plant Journal that shows one page at a time. Desktop keeps its sidebar and two-page spreads.

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 768, height: 1024 };
const DESKTOP = { width: 1280, height: 800 };

const menuButton = (page: Page) => page.getByRole("button", { name: /^Menu/ });
const mainNav = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });
const book = (page: Page) => page.getByRole("region", { name: "Open botanical journal" });
const pageIndicator = (page: Page) => book(page).locator(".journal-page-indicator");
const plantHeading = (page: Page, name: string) => book(page).getByRole("heading", { name, level: 3, exact: true });

const DESTINATIONS = [
  { name: "All Quests", url: /\/all-quests$/ },
  { name: "Add quest", url: /\/quests\/new$/ },
  { name: /^Plant Journal/, url: /\/plant-journal$/ },
  { name: "Completion History", url: /\/completion-history$/ },
  { name: "Settings", url: /\/settings$/ },
  { name: "Home", url: /:\d+\/$/ },
] as const;

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("Phone header and menu", () => {
  test.use({ viewport: PHONE });

  test("a compact header with a menu button; the links stay hidden until it opens, then float over the page", async ({ page }) => {
    await openApp(page);
    const header = page.locator(".sidebar");
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(64);
    await expectNoSidewaysScroll(page);
    await expect(page.getByRole("link", { name: "Plantetary home" })).toBeVisible();
    await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
    await expect(mainNav(page)).toBeHidden();
    await expect(page.getByRole("link", { name: "All Quests" })).toBeHidden();

    const workspaceTop = (await page.locator(".workspace").boundingBox())!.y;
    await menuButton(page).click();
    await expect(menuButton(page)).toHaveAttribute("aria-expanded", "true");
    await expect(mainNav(page)).toBeVisible();
    // A floating panel: the page behind it doesn't move.
    expect((await page.locator(".workspace").boundingBox())!.y).toBe(workspaceTop);
    for (const { name } of DESTINATIONS) {
      const link = mainNav(page).getByRole("link", { name });
      await expect(link).toBeVisible();
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    // Settings appears once: in the menu, not also as the desktop sidebar's icon.
    await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(1);
    const box = (await mainNav(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    expect(box.y + box.height).toBeLessThanOrEqual(PHONE.height);
    await expectNoSidewaysScroll(page);
  });

  test("every destination is reachable from the menu, and choosing one closes it", async ({ page }) => {
    await openApp(page);
    for (const { name, url } of DESTINATIONS) {
      await menuButton(page).click();
      await mainNav(page).getByRole("link", { name }).click();
      await expect(page).toHaveURL(url);
      await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
      await expect(mainNav(page)).toBeHidden();
    }
  });

  test("from the keyboard: Tab enters the menu, Escape closes it and returns focus, and tabbing out closes it", async ({ page }) => {
    await openApp(page);
    await menuButton(page).focus();
    await page.keyboard.press("Enter");
    await expect(mainNav(page)).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(mainNav(page).getByRole("link", { name: "Home", exact: true })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(mainNav(page)).toBeHidden();
    await expect(menuButton(page)).toBeFocused();
    await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");

    await page.keyboard.press("Enter");
    for (let index = 0; index < DESTINATIONS.length; index += 1) await page.keyboard.press("Tab");
    await expect(mainNav(page).getByRole("link", { name: "Settings" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(mainNav(page)).toBeHidden();
    await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("clicking outside the menu closes it, and the button toggles it", async ({ page }) => {
    await openApp(page);
    await menuButton(page).click();
    await expect(mainNav(page)).toBeVisible();
    // The panel floats over the top of the page, so tap clear of it: the page margin near the bottom.
    await page.mouse.click(8, PHONE.height - 8);
    await expect(mainNav(page)).toBeHidden();

    await menuButton(page).click();
    await menuButton(page).click();
    await expect(mainNav(page)).toBeHidden();
  });

  test("marks the current page, and shows a waiting gift on the menu button", async ({ page }) => {
    await openApp(page, "/all-quests");
    // The starter gift is waiting in a fresh garden.
    await expect(page.getByRole("button", { name: "Menu, 1 gift waiting" })).toBeVisible();
    await expect(page.locator(".sidebar-menu-gift")).toBeVisible();
    await menuButton(page).click();
    await expect(mainNav(page).getByRole("link", { name: "All Quests" })).toHaveAttribute("aria-current", "page");
    await expect(mainNav(page).getByRole("link", { name: "Home", exact: true })).not.toHaveAttribute("aria-current", "page");
    await mainNav(page).getByRole("link", { name: "Plant Journal, 1 gift waiting" }).click();

    await page.getByRole("button", { name: "Unwrap gift" }).click();
    await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeVisible();
    await expect(page.locator(".sidebar-menu-gift")).toHaveCount(0);
  });
});

test.describe("Tablet header", () => {
  test.use({ viewport: TABLET });

  test("uses the same menu, with no sideways scrolling", async ({ page }) => {
    await openApp(page);
    await expectNoSidewaysScroll(page);
    await expect(mainNav(page)).toBeHidden();
    await menuButton(page).click();
    await expect(mainNav(page).getByRole("link", { name: "Completion History" })).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
});

test.describe("Desktop sidebar (unchanged)", () => {
  test.use({ viewport: DESKTOP });

  test("shows the sidebar links and Settings icon, with no menu button", async ({ page }) => {
    await openApp(page);
    await expect(menuButton(page)).toBeHidden();
    await expect(mainNav(page)).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");
    // One Settings link: the sidebar's icon, not the menu's row.
    await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(1);
    await expect(page.locator(".account-settings")).toBeVisible();
    expect((await page.locator(".sidebar").boundingBox())!.width).toBe(232);
  });

  test("the Plant Journal shows two pages, and the spread arrows turn both", async ({ page }) => {
    await openApp(page, "/plant-journal");
    await expect(book(page).locator(".journal-book-page")).toHaveCount(2);
    await expect(book(page).getByRole("button", { name: "Previous page" })).toHaveCount(0);
    await expect(plantHeading(page, "Daisy")).toBeVisible();
    await expect(plantHeading(page, "Lavender")).toBeVisible();

    await book(page).getByRole("button", { name: "Next spread" }).click();
    await expect(book(page).getByText("Page 3", { exact: true })).toBeVisible();
    await expect(book(page).getByText("Page 4", { exact: true })).toBeVisible();
    await expect(plantHeading(page, "Daisy")).toHaveCount(0);
    await book(page).getByRole("button", { name: "Previous spread" }).click();
    await expect(book(page).getByText("Page 1", { exact: true })).toBeVisible();
  });
});

test.describe("Plant Journal on a phone", () => {
  test.use({ viewport: PHONE });

  test("shows one page at a time, with Previous, Next and a page indicator", async ({ page }) => {
    await openApp(page, "/plant-journal");
    await expect(book(page).locator(".journal-book-page")).toHaveCount(1);
    await expect(book(page).getByRole("button", { name: "Next spread" })).toHaveCount(0);
    await expect(pageIndicator(page)).toHaveText("Page 1 of 4");
    const previous = book(page).getByRole("button", { name: "Previous page" });
    const next = book(page).getByRole("button", { name: "Next page" });
    await expect(previous).toBeDisabled();
    await expect(next).toBeEnabled();
    expect((await next.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    // Sprites, thresholds and progress are as on desktop.
    await expect(plantHeading(page, "Daisy")).toBeVisible();
    await expect(book(page).getByText("Discover at 25 XP")).toBeVisible();
    await expect(book(page).getByRole("progressbar", { name: "XP progress toward Daisy" })).toBeVisible();
    await expect(book(page).locator(".journal-plant-image").first()).toBeVisible();
    await expectNoSidewaysScroll(page);

    await next.click();
    await expect(pageIndicator(page)).toHaveText("Page 2 of 4");
    await expect(book(page).getByText("Page 2", { exact: true })).toBeVisible();
    // The starter Fern is still a wrapped gift, so page 1 is Daisy to Lavender and page 2 starts at Monstera.
    await expect(plantHeading(page, "Monstera")).toBeVisible();
    await expect(plantHeading(page, "Daisy")).toHaveCount(0);
    await expect(previous).toBeEnabled();

    await next.click();
    await next.click();
    await expect(pageIndicator(page)).toHaveText("Page 4 of 4");
    await expect(next).toBeDisabled();
    // Next is disabled on the last page, so focus moves to Previous instead of being lost.
    await expect(previous).toBeFocused();
    await previous.click();
    await expect(pageIndicator(page)).toHaveText("Page 3 of 4");
  });

  test("filters start again from page 1, and count only pages with plants", async ({ page }) => {
    await openApp(page, "/plant-journal");
    await book(page).getByRole("button", { name: "Next page" }).click();
    await expect(pageIndicator(page)).toHaveText("Page 2 of 4");

    // Only the waiting starter gift counts as collected: one page, not four.
    await page.getByRole("button", { name: "Collected" }).click();
    await expect(pageIndicator(page)).toHaveText("Page 1 of 1");
    await expect(book(page).getByRole("button", { name: "Previous page" })).toBeDisabled();
    await expect(book(page).getByRole("button", { name: "Next page" })).toBeDisabled();

    await page.getByRole("button", { name: "Locked" }).click();
    await expect(pageIndicator(page)).toHaveText("Page 1 of 4");
  });

  test("resizing keeps the reader's place", async ({ page }) => {
    await openApp(page, "/plant-journal");
    await book(page).getByRole("button", { name: "Next page" }).click();
    await book(page).getByRole("button", { name: "Next page" }).click();
    await expect(pageIndicator(page)).toHaveText("Page 3 of 4");

    await page.setViewportSize(DESKTOP);
    await expect(book(page).getByText("Page 3", { exact: true })).toBeVisible();
    await expect(book(page).getByText("Page 4", { exact: true })).toBeVisible();

    await page.setViewportSize(PHONE);
    await expect(pageIndicator(page)).toHaveText("Page 3 of 4");
  });
});
