import { test, expect } from "@playwright/test";
import { checkA11y } from "./helpers/a11y";
import { signInPage } from "./helpers/session";

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

  // TASK-210 (found by its walk): at 390 px the three buttons ran past their card's edge.
  test("on a phone the home's buttons stay inside their card", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInPage(page);
    await page.goto("/");
    const submit = page.getByRole("button", { name: "Submit and translate" });
    await expect(submit).toBeVisible({ timeout: 30000 });
    const card = submit.locator(
      "xpath=ancestor::div[contains(@class, 'rounded-2xl')][1]"
    );
    const [button, box] = [await submit.boundingBox(), await card.boundingBox()];
    expect(button && box).toBeTruthy();
    // Inside the card's padding (24 px): never past its right edge.
    expect(button!.x + button!.width).toBeLessThanOrEqual(box!.x + box!.width - 16);
  });
});
