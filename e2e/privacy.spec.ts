import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { parsePrivacyMarkdown, plainText } from "../src/app/privacy/privacy-markdown";
import { TEST_EMAIL, useFakeAuth } from "./auth-support";
import { clickNavLink, expect, openApp, test, QUEST_SAVE_KEY } from "./support";

// The Privacy Notice at /privacy, its links, and Settings → Your data.

const noticeSource = parsePrivacyMarkdown(readFileSync(join(process.cwd(), "src/app/privacy/privacy-notice.md"), "utf8"));
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
  test("opens without signing in and shows the whole notice source, word for word", async ({ page }) => {
    await openApp(page, "/privacy");
    await expect(page).toHaveTitle("Privacy Notice | Plantetary");
    await expect(page.getByRole("heading", { level: 1, name: "Plantetary Privacy Notice" })).toBeVisible();
    // The title is shown in capitals by CSS; its actual text is checked as written.
    const [title, ...rest] = noticeSource;
    await expect(notice(page).getByRole("heading", { level: 1 })).toHaveText(title.kind === "heading" ? title.text : "", { useInnerText: false });
    // Everything after the title, as a reader sees it: every word, in order.
    const shown = (await notice(page).innerText()).split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim();
    expect(shown).toBe(plainText(rest));
  });

  test("privacy stays accessible during garden read failure without enabling garden writes", async ({ page }) => {
    await page.addInitScript((key) => {
      const get = Storage.prototype.getItem;
      const set = Storage.prototype.setItem;
      Storage.prototype.getItem = function (name) {
        if (this === window.localStorage && name === key) throw new Error("Simulated garden read failure");
        return get.call(this, name);
      };
      Storage.prototype.setItem = function (name, value) {
        if (this === window.localStorage && name === key) {
          set.call(window.sessionStorage, "privacy-test-garden-write", "attempted");
          throw new Error("Unexpected garden write");
        }
        return set.call(this, name, value);
      };
    }, QUEST_SAVE_KEY);
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { name: "Your browser garden couldn't be loaded" })).toBeVisible();
    await expect(notice(page)).toBeVisible();
    await expect(notice(page).getByRole("heading", { level: 2 })).toHaveCount(12);
    await clickNavLink(page, "Home", { exact: true });
    await expect(page.getByRole("heading", { name: "Garden unavailable" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Complete|Mark incomplete):/ })).toHaveCount(0);
    await clickNavLink(page, "Settings", { exact: true });
    await expect(page.getByRole("button", { name: "Reset Plantetary data", exact: true })).toBeDisabled();
    await expect(yourData(page)).toContainText("Reset is currently blocked");
    await yourData(page).getByRole("link", { name: "Read the Privacy Notice" }).click();
    await expect(notice(page)).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("privacy-test-garden-write"))).toBeNull();
  });

  test("has one heading per section, in order, the effective-date placeholder, and working contact links", async ({ page }) => {
    await openApp(page, "/privacy");
    const expectedSections = noticeSource.filter((block) => block.kind === "heading" && block.level === 2).map((block) => block.kind === "heading" ? block.text : "");
    await expect(notice(page).getByRole("heading", { level: 2 })).toHaveText(expectedSections);
    for (const name of expectedSections) await expect(notice(page).getByRole("region", { name, exact: true })).toBeVisible();
    await expect(notice(page).getByText("Effective date: [DATE — to be set when published]")).toBeVisible();
    const contacts = notice(page).getByRole("link", { name: CONTACT });
    await expect(contacts).toHaveCount(5);
    for (const link of await contacts.all()) await expect(link).toHaveAttribute("href", `mailto:${CONTACT}`);
  });

  test("links to Supabase's and Vercel's privacy pages, over https", async ({ page }) => {
    await openApp(page, "/privacy");
    const services = notice(page).getByRole("region", { name: "Services we use", exact: true });
    await expect(services.getByRole("link", { name: "Supabase's privacy policy" })).toHaveAttribute("href", "https://supabase.com/privacy");
    await expect(services.getByRole("link", { name: "Vercel's privacy notice" })).toHaveAttribute("href", "https://vercel.com/legal/privacy-policy");
    // Every link on the page is to this site, an email address, or an https page.
    for (const href of await notice(page).getByRole("link").evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""))) {
      expect(href).toMatch(/^(https:\/\/|mailto:hello\.plantetary@gmail\.com$|\/)/);
    }
  });

  test("opens directly without a signed-in session", async ({ page }) => {
    // This checks a signed-out session, not a separate server configuration.
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
    await expect(account.getByRole("checkbox", { name: "By continuing, you confirm that you are at least 13 years old." })).toBeVisible();
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
    await expect(section).toContainText("As a guest, your garden stays in browser storage on this device.");
    await expect(section).toContainText("only when you explicitly choose to import it");
    await expect(section).toContainText("Profile and reminder preferences remain local even when you use a cloud garden.");
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
    await expect(section).toContainText("You're using a cloud garden. Changes are sent to your Plantetary account when saving succeeds; storage notices explain failures and conflicts.");
    await expect(section.getByRole("heading", { name: "Deleting your account" })).toBeVisible();
    await expect(section).toContainText("Deleting your account is different from resetting this browser.");
    await expect(section).toContainText(`from ${TEST_EMAIL} and say you'd like it deleted`);
    await expect(section).toContainText("It's done by hand once we've checked the request is yours, so it isn't immediate.");
    await expect(section.getByRole("link", { name: CONTACT })).toHaveAttribute("href", `mailto:${CONTACT}`);
    await expect(section).toContainText("You can also email to ask for a copy of the information connected to your account, or to correct something that's inaccurate. We aim to complete verified requests within 30 days.");
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

  test("a read-only follower is not told reset is available", async ({ page }) => {
    await openApp(page, "/settings");
    await expect(page.getByRole("button", { name: "Reset Plantetary data", exact: true })).toBeEnabled();
    const other = await page.context().newPage();
    await openApp(other, "/settings");
    await expect(other.getByRole("region", { name: "Browser garden editing" })).toBeVisible();
    await expect(other.getByRole("button", { name: "Reset Plantetary data", exact: true })).toBeDisabled();
    await expect(yourData(other)).toContainText("Reset is currently blocked");
    await expect(yourData(other)).not.toContainText("use Reset Plantetary data");
    await page.close();
    await expect(other.getByRole("button", { name: "Reset Plantetary data", exact: true })).toBeEnabled();
    await expect(yourData(other)).toContainText("use Reset Plantetary data");
    await expect(yourData(other)).not.toContainText("Reset is currently blocked");
  });

  test("sits just above Data management, whose Export and Reset are unchanged", async ({ page }) => {
    await openApp(page, "/settings");
    const headings = await page.getByRole("main").getByRole("heading", { level: 2 }).allTextContents();
    expect(headings.indexOf("Your data")).toBe(headings.indexOf("Data management") - 1);
    await expect(page.getByRole("button", { name: "Export data as JSON" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Reset Plantetary data" })).toBeEnabled();
  });
});
