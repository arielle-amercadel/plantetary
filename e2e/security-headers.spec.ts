import { expect, test } from "./support";

// The security headers from next.config.ts, on pages, the sign-in page and static files alike.
const expected = {
  "content-security-policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

test.describe("Security headers", () => {
  for (const path of ["/", "/settings", "/plant-journal", "/auth/confirm", "/quests/new?type=daily", "/plantetary-garden.png"]) {
    test(`are sent for ${path}`, async ({ request }) => {
      const response = await request.get(path);
      expect(response.ok()).toBe(true);
      expect(response.headers()).toMatchObject(expected);
    });
  }

  test("another site can't show Plantetary in a frame", async ({ page }) => {
    await page.goto("/");
    // A page from a different origin, framing the app.
    const blocked = new Promise<boolean>((resolve) => {
      page.on("console", (message) => {
        if (/frame-ancestors|Refused to (display|frame)/i.test(message.text())) resolve(true);
      });
      setTimeout(() => resolve(false), 5000);
    });
    await page.setContent(`<iframe src="${new URL("/", page.url()).href}" title="framed"></iframe>`);
    expect(await blocked).toBe(true);
    // Nothing of the app rendered inside the frame.
    const frame = page.frameLocator("iframe");
    await expect(frame.getByRole("heading", { name: "A little progress, a little magic." })).toHaveCount(0);
  });
});
