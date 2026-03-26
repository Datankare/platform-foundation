import { test, expect } from "@playwright/test";
import { checkA11y } from "./helpers/a11y";

test.describe("Platform baseline", () => {
  test("page loads and passes accessibility audit", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/./);
    await checkA11y(page);
  });

  test("health endpoint returns 200", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
  });
});
