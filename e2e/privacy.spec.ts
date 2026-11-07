import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { parsePrivacyMarkdown, plainText } from "../src/app/privacy/privacy-markdown";
import { TEST_EMAIL, useFakeAuth } from "./auth-support";
import { clickNavLink, expect, openApp, test } from "./support";

// The Privacy Notice at /privacy, its links, and Settings → Your data.

const approved = parsePrivacyMarkdown(readFileSync(join(process.cwd(), "src/app/privacy/privacy-notice.md"), "utf8"));
const SIGN_IN_LINK = "/auth/confirm?token_hash=pkce_0123456789abcdef&type=email";
const CONTACT = "hello.plantetary@gmail.com";

const notice = (page: Page) => page.getByRole("article", { name: "Plantetary Privacy Notice" });
const yourData = (page: Page) => page.getByRole("region", { name: "Your data" });
const menuButton = (page: Page) => page.getByRole("button", { name: /^Menu/ });
const choiceCard = (page: Page) => page.getByRole("region", { name: "Start your cloud garden?" });

async function signIn(page: Page) {
  await page.goto(SIGN_IN_LINK);
  await page.getByRole("button", { name: "Finish signing in" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("region", { name: "Account" })).toContainText(`Signed in as ${TEST_EMAIL}`);
}

test.describe("The Privacy Notice page", () => {
  test("opens without signing in and shows the whole approved notice, word for word", async ({ page }) => {
    await openApp(page, "/privacy");
    await expect(page).toHaveTitle("Privacy Notice | Plantetary");
    await expect(page.getByRole("heading", { level: 1, name: "Plantetary Privacy Notice" })).toBeVisible();
    // The title is shown in capitals by CSS; its actual text is checked as written.
    const [title, ...rest] = approved;
    await expect(notice(page).getByRole("heading", { level: 1 })).toHaveText(title.kind === "heading" ? title.text : "", { useInnerText: false });
    // Everything after the title, as a reader sees it: every word, in order.
    const shown = (await notice(page).innerText()).split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim();
    expect(shown).toBe(plainText(rest));
  });

  test("has one heading per section, in order, the effective-date placeholder, and working contact links", async ({ page }) => {
    await openApp(page, "/privacy");
    const expectedSections = approved.filter((block) => block.kind === "heading" && block.level === 2).map((block) => block.kind === "heading" ? block.text : "");
    await expect(notice(page).getByRole("heading", { level: 2 })).toHaveText(expectedSections);
    for (const name of expectedSections) await expect(notice(page).getByRole("region", { name, exact: true })).toBeVisible();
    await expect(notice(page).getByText("Effective date: [DATE — to be set when published]")).toBeVisible();
    const contacts = notice(page).getByRole("link", { name: CONTACT });
    await expect(contacts).toHaveCount(4);
    for (const link of await contacts.all()) await expect(link).toHaveAttribute("href", `mailto:${CONTACT}`);
  });

  test("works without sign-in set up at all, too", async ({ page }) => {
    // The browser tests' server has sign-in set up; the page reads nothing from it, so it's the same either way.
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { level: 1, name: "Plantetary Privacy Notice" })).toBeVisible();
    await expect(notice(page).getByRole("heading", { level: 2 })).toHaveCount(12);
  });
});

test.describe("Links to the Privacy Notice", () => {
  test("desktop: the sidebar's Privacy link opens it, and marks it as the current page", async ({ page }) => {
    await openApp(page);
    await expect(menuButton(page)).toBeHidden();
    const link = page.locator(".sidebar").getByRole("link", { name: "Privacy", exact: true });
    await expect(link).toHaveCount(1);
    await link.click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.locator(".sidebar").getByRole("link", { name: "Privacy", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".breadcrumb")).toContainText("Privacy");
  });

  test("phone: the menu's Privacy row opens it; the page fits the screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);
    await expect(page.getByRole("link", { name: "Privacy", exact: true })).toBeHidden();
    await clickNavLink(page, "Privacy", { exact: true });
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("heading", { level: 1, name: "Plantetary Privacy Notice" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await menuButton(page).click();
    await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Privacy", exact: true }))
      .toHaveAttribute("aria-current", "page");
  });

  test("the sign-in form explains what's stored, and links to the notice", async ({ page }) => {
    await useFakeAuth(page);
    await openApp(page, "/settings");
    const account = page.getByRole("region", { name: "Account" });
    await expect(account.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
    await expect(account).toContainText("Signing in stores your email address with Supabase, and your garden too if you use a cloud garden.");
    await account.getByRole("link", { name: "Read the Privacy Notice" }).click();
    await expect(page).toHaveURL(/\/privacy$/);
  });

  test("the page that finishes signing in links to it", async ({ page }) => {
    await useFakeAuth(page);
    await page.goto(SIGN_IN_LINK);
    await expect(page.getByRole("button", { name: "Finish signing in" })).toBeVisible();
    await expect(page.getByRole("link", { name: "How Plantetary handles your data" })).toHaveAttribute("href", "/privacy");
  });

  test("keyboard: the sidebar's Privacy link can be reached and followed", async ({ page }) => {
    await openApp(page);
    const link = page.locator(".sidebar").getByRole("link", { name: "Privacy", exact: true });
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/privacy$/);
  });
});

test.describe("Settings → Your data", () => {
  test("a guest sees how browser data works, Export and Reset, and no account-deletion steps", async ({ page }) => {
    await openApp(page, "/settings");
    const section = yourData(page);
    await expect(section).toContainText("Your garden, profile and reminder settings are saved in this browser on this device.");
    await expect(section).toContainText("Export data as JSON");
    await expect(section).toContainText("Reset Plantetary data");
    await expect(section).toContainText("If you have a Plantetary account, the Privacy Notice explains how to ask for it to be deleted.");
    await expect(section.getByRole("heading", { name: "Deleting your account" })).toHaveCount(0);
    await expect(section.getByRole("link", { name: CONTACT })).toHaveCount(0);
    await section.getByRole("link", { name: "Read the Privacy Notice" }).click();
    await expect(page).toHaveURL(/\/privacy$/);
  });

  test("a signed-in player is told how to ask for deletion, from their own address, and that it's done by hand", async ({ page }) => {
    await useFakeAuth(page);
    await openApp(page);
    await signIn(page);
    // No cloud garden yet: nothing is claimed to be in the account.
    await expect(choiceCard(page)).toBeVisible();
    await expect(yourData(page)).toContainText("your account doesn't have a cloud garden yet");
    await expect(yourData(page)).not.toContainText("Reset Plantetary data");

    await choiceCard(page).getByRole("button", { name: "Start a fresh cloud garden" }).click();
    const section = yourData(page);
    await expect(section).toContainText("Your garden is saved to your Plantetary account, with its backups.");
    await expect(section.getByRole("heading", { name: "Deleting your account" })).toBeVisible();
    await expect(section).toContainText("Deleting your account is different from resetting this browser.");
    await expect(section).toContainText(`from ${TEST_EMAIL} and say you'd like it deleted`);
    await expect(section).toContainText("It's done by hand once we've checked the request is yours, so it isn't immediate.");
    await expect(section.getByRole("link", { name: CONTACT })).toHaveAttribute("href", `mailto:${CONTACT}`);
    // Reset can't change a cloud garden, so it isn't offered for it.
    await expect(section).not.toContainText("Reset Plantetary data");
    await expect(page.getByRole("button", { name: "Reset Plantetary data" })).toBeDisabled();
  });

  test("a signed-in player playing on this device is told nothing is saved to the account, with deletion steps", async ({ page }) => {
    await useFakeAuth(page);
    await openApp(page);
    await signIn(page);
    await choiceCard(page).getByRole("button", { name: "Keep playing on this device" }).click();
    const section = yourData(page);
    await expect(section).toContainText("You're playing the garden saved in this browser on this device, so nothing is being saved to your account.");
    await expect(section).toContainText("Reset Plantetary data");
    await expect(section.getByRole("heading", { name: "Deleting your account" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reset Plantetary data" })).toBeEnabled();
  });

  test("sits just above Data management, whose Export and Reset are unchanged", async ({ page }) => {
    await openApp(page, "/settings");
    const headings = await page.getByRole("main").getByRole("heading", { level: 2 }).allTextContents();
    expect(headings.indexOf("Your data")).toBe(headings.indexOf("Data management") - 1);
    await expect(page.getByRole("button", { name: "Export data as JSON" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Reset Plantetary data" })).toBeEnabled();
  });
});
