import { test as base, expect, type Page } from "@playwright/test";

export { expect };

export const QUEST_SAVE_KEY = "plantetary-quest-data";
export const VALID_BACKUP_KEY = "plantetary-quest-data-backup-v1";
export const INVALID_BACKUP_KEY = "plantetary-quest-data-invalid-backup";
export const PROFILE_KEY = "plantetary-profile-preferences-v1";

/** Every test starts on this Monday, in UTC, so dates and weekdays never depend on the real calendar. */
export const MONDAY = "2026-10-19T10:00:00Z";
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The four starter Daily Quests, worth 25 XP together. */
export const STARTER_DAILY = [
  "Drink a glass of water",
  "Morning skincare",
  "Read for 20 minutes",
  "Evening stretch",
];
export const STARTER_PERSONAL = [
  "Review biology notes",
  "Finish portfolio moodboard",
  "Tidy the desk",
];

export const test = base.extend({
  timezoneId: "UTC",
  locale: "en-US",
  page: async ({ page }, runTest) => {
    const uncaughtErrors: string[] = [];
    page.on("pageerror", (error) => uncaughtErrors.push(error.message));
    await page.clock.install({ time: MONDAY });

    await runTest(page);

    expect(uncaughtErrors, "uncaught errors in the browser").toEqual([]);
  },
});

/**
 * The top-bar date is set by the store after it restores saved data, so once it is visible the
 * page has hydrated and is showing real data rather than the prerendered starter quests.
 */
export async function waitForApp(page: Page) {
  await expect(page.getByText(/^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}$/)).toBeVisible();
}

export async function openApp(page: Page, path = "/") {
  await page.goto(path);
  await waitForApp(page);
}

export async function reloadApp(page: Page) {
  await page.reload();
  await waitForApp(page);
}

/** Moves time forward like reopening a laptop: the app's one-minute timer notices the new day. */
export async function advanceToDay(page: Page, days: number, expectedDate: string) {
  await page.clock.fastForward(days * DAY_MS);
  await expect(page.getByText(expectedDate, { exact: true })).toBeVisible();
}

/** Writes values to browser storage before the first page load only, so a reload or reset keeps its effect. */
export async function seedStorage(page: Page, entries: Record<string, string>) {
  await page.addInitScript((values) => {
    if (window.sessionStorage.getItem("e2e-storage-seeded")) return;
    window.sessionStorage.setItem("e2e-storage-seeded", "true");
    for (const [key, value] of Object.entries(values)) window.localStorage.setItem(key, value);
  }, entries);
}

export function readStorage(page: Page, key: string) {
  return page.evaluate((storageKey) => window.localStorage.getItem(storageKey), key);
}

type SeedQuest = {
  id: string;
  title: string;
  category: string;
  schedule?: string;
  difficulty: "Easy" | "Medium" | "Hard";
  completed: boolean;
  repeatSchedule?: "Every day" | "Selected days";
  selectedDays?: string[];
  dueDate?: string;
};

/** Builds a current-format save, for states that would take too many clicks to reach. */
export function buildSave(overrides: {
  daily?: SeedQuest[];
  personal?: SeedQuest[];
  legacyXpBonus?: number;
  discoveredPlantIds?: string[];
  pendingPlantGiftIds?: string[];
} = {}) {
  return JSON.stringify({
    schemaVersion: 5,
    questLists: { daily: overrides.daily ?? [], personal: overrides.personal ?? [] },
    categoryLists: { daily: ["Wellness"], personal: ["Study"] },
    completionHistory: {},
    legacyXpBonus: overrides.legacyXpBonus ?? 0,
    discoveredPlantIds: overrides.discoveredPlantIds ?? [],
    pendingPlantGiftIds: overrides.pendingPlantGiftIds ?? [],
    starterPlantGiftPending: false,
  });
}

export function dailyPanel(page: Page) {
  return page.getByRole("region", { name: "Daily Quests" });
}

export function personalPanel(page: Page) {
  return page.getByRole("region", { name: "Personal Quests" });
}

export function questRow(panel: ReturnType<typeof dailyPanel>, title: string) {
  return panel.getByRole("listitem").filter({ hasText: title });
}

/**
 * Clicks a main navigation link the way a player would at this screen size: on phones and tablets the
 * links are in the header's menu, so it's opened first; on desktop the sidebar shows them.
 */
export async function clickNavLink(page: Page, name: string | RegExp, options: { exact?: boolean } = {}) {
  const menu = page.getByRole("button", { name: /^Menu/ });
  if (await menu.isVisible() && (await menu.getAttribute("aria-expanded")) !== "true") await menu.click();
  await page.getByRole("link", { name, ...options }).click();
}

const difficultyXp = { Easy: 5, Medium: 10, Hard: 20 } as const;

/**
 * Adds a quest from Home the way a player would: the panel's add link opens the full form with the quest
 * type already chosen (checked here), then the title, category, difficulty and, for a Daily Quest, "Every
 * day" are filled in. A Personal Quest gets no due date. Ends back on Home with the quest shown.
 */
export async function addQuestFromHome(
  page: Page,
  list: "daily" | "personal",
  title: string,
  { category, difficulty = "Easy" }: { category?: string; difficulty?: keyof typeof difficultyXp } = {},
) {
  await page.getByRole("link", { name: list === "daily" ? "Add habit to Daily Quests" : "Add quest to Personal Quests", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/quests/new\\?type=${list}$`));
  await expect(page.getByRole("button", { name: list === "daily" ? /Daily Quest/ : /Personal Quest/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Quest title").fill(title);
  await chooseOption(page, "Category", category ?? (list === "daily" ? "Wellness" : "Personal"));
  if (list === "daily") await chooseOption(page, "Repeat", "Every day");
  await chooseOption(page, "Difficulty", `${difficulty} · ${difficultyXp[difficulty]} XP`);
  await page.getByRole("button", { name: "Save quest" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(questRow(list === "daily" ? dailyPanel(page) : personalPanel(page), title)).toBeVisible();
}

export async function completeQuest(page: Page, title: string) {
  await page.getByRole("button", { name: `Complete: ${title}`, exact: true }).click();
  await expect(page.getByRole("button", { name: `Mark incomplete: ${title}`, exact: true })).toBeVisible();
}

export async function uncompleteQuest(page: Page, title: string) {
  await page.getByRole("button", { name: `Mark incomplete: ${title}`, exact: true }).click();
  await expect(page.getByRole("button", { name: `Complete: ${title}`, exact: true })).toBeVisible();
}

export async function deleteQuest(page: Page, title: string) {
  await page.getByRole("button", { name: `Remove ${title}`, exact: true }).click();
  await expect(page.getByRole("button", { name: `Remove ${title}`, exact: true })).toHaveCount(0);
}

export async function chooseOption(page: Page, field: string, option: string) {
  await page.getByRole("combobox", { name: field, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(page.getByRole("combobox", { name: field, exact: true })).toContainText(option);
}

/** Checks XP on Home while it is still within level 1 (under 100 XP). */
export async function expectHomeXp(page: Page, xp: number) {
  await expect(page.getByRole("region", { name: "Your progress" }).getByText(`${xp} / 100 XP`, { exact: true })).toBeVisible();
}

/** The Home stat cards have no accessible name of their own, so these find them by class and title. */
function statCard(page: Page, title: string) {
  return page.getByRole("region", { name: "Your progress" }).locator(".stat-card", { hasText: title });
}

export async function expectCompletedToday(page: Page, count: number) {
  await expect(statCard(page, "Completed today").locator(".stat-value")).toHaveText(String(count));
}

export async function expectCompletedOverall(page: Page, count: number) {
  await expect(statCard(page, "Quests completed").locator(".stat-value")).toHaveText(String(count));
}

export async function expectStreak(page: Page, days: number) {
  await expect(statCard(page, "Current streak").locator(".stat-value")).toHaveText(days === 1 ? "1 day" : `${days} days`);
}

export function historyCard(page: Page, title: string) {
  return page.getByRole("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

export function historyDateSection(page: Page, date: string) {
  return page.locator("details").filter({ has: page.locator("summary", { hasText: date }) });
}
