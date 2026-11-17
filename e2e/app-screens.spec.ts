/**
 * e2e/app-screens.spec.ts — the signed-in app's screens on the production build, at a desk's width
 * and a phone's (TASK-224, TASK-225; Playform's copy has its own screens besides)
 *
 * Batch 56e-2 moved every user screen into the app's one frame (components/app/ui/AppShell.tsx)
 * and gave the account page its account actions (E-126). This walks them as the test double's own
 * user (one session for the whole run: e2e/helpers/session.ts — no sign-in of its own), at 1280 px
 * and at 390 px each, and runs axe on each:
 *
 *   1. home: one header, one main landmark, the account's pages linked, nothing sideways;
 *   2. the account page: every section, how the account signs in read from its route (and shown,
 *      never as "off" when unknown), Change password and Delete my account asking first — and
 *      Cancel sends nothing —, the copy of the data downloaded whole;
 *   3. the assistant page in the frame;
 *   4. an address that does not exist: the app's own page, with the way home;
 *   5. signed out, a page with a query: sign-in is asked to come back to it, query and all (E-113);
 *
 * Deleting an account end to end is the moderation journey's last step (e2e/moderation.spec.ts:
 * its member, whose session the run already holds — a sign-in of its own would exceed the run's
 * sign-in budget, AUTH_LOGIN).
 *
 * Nothing here changes the shared user's sign-in (turning two-step verification off or on moves the
 * session to a new id, which every other journey shares): those are the unit tests'
 * (__tests__/account-security.test.tsx), on the routes' own answers.
 */
import { expect, test, type Page } from "@playwright/test";
import { checkA11y } from "./helpers/a11y";
import { signInPage } from "./helpers/session";

const WIDTHS = [
  { name: "desk", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow, "the page scrolls sideways").toBe(0);
}

test.describe.configure({ mode: "serial" });

test("1. home: one header, one main landmark, the account's pages linked (SF-app-001)", async ({
  page,
}) => {
  await signInPage(page);
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "The app" });
    await expect(nav).toBeVisible({ timeout: 30000 });
    await expect(nav.getByRole("link", { name: "Home" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    await expect(nav.getByRole("link", { name: "Your account" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page.getByRole("main")).toHaveCount(1);
    await checkA11y(page);
    await noSidewaysScroll(page);
  }
});

test("2. the account page: its sections, its account actions asked first (E-126)", async ({
  page,
}) => {
  await signInPage(page);
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    const security = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/account/security" &&
        r.request().method() === "GET"
    );
    await page.goto("/account");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your account", {
      timeout: 30000,
    });
    const read = await security;
    expect(read.status()).toBe(200);
    const { mfaEnabled } = (await read.json()) as { mfaEnabled: boolean | null };
    for (const name of [
      "Sign-in and security",
      "Your data",
      "Decisions about your content",
      "Signed-in devices",
    ])
      await expect(page.getByRole("region", { name })).toBeVisible();
    await expect(page.getByTestId("mfa-state")).toHaveText(
      mfaEnabled === true
        ? "Two-step verification is on."
        : mfaEnabled === false
          ? "Two-step verification is off."
          : /could not tell/
    );
    await checkA11y(page);
    await noSidewaysScroll(page);

    // Change password asks first; Cancel sends nothing.
    let sent = 0;
    const count = (r: { url(): string }) => {
      const path = new URL(r.url()).pathname;
      if (path === "/api/auth/forgot-password" || path === "/api/account/delete")
        sent += 1;
    };
    page.on("request", count);
    await page.getByRole("button", { name: "Change password" }).click();
    const passwordDialog = page.getByRole("alertdialog", {
      name: "Change your password",
    });
    await expect(passwordDialog).toBeFocused();
    await checkA11y(page);
    await passwordDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(passwordDialog).toHaveCount(0);

    // Delete my account: in red, what happens said, nothing sent on Cancel.
    await page.getByRole("button", { name: "Delete my account" }).click();
    const deleteDialog = page.getByRole("alertdialog");
    await expect(deleteDialog).toContainText("This cannot be undone.");
    await expect(deleteDialog).toContainText("You cannot sign in to it again.");
    await checkA11y(page);
    await noSidewaysScroll(page);
    await page.keyboard.press("Escape");
    await expect(deleteDialog).toHaveCount(0);
    page.off("request", count);
    expect(sent, "a request went out before the person confirmed").toBe(0);
  }

  // A copy of the data: downloaded whole, from the route.
  await page.setViewportSize({ width: 1280, height: 900 });
  const exported = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/account/export" &&
      r.request().method() === "GET"
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download a copy of my data" }).click();
  expect((await exported).status()).toBe(200);
  const file = await download;
  expect(file.suggestedFilename()).toBe("my-data.json");
  await expect(page.getByText("Your copy was saved as my-data.json.")).toBeVisible();
});

test("3. the assistant page, in the app's frame", async ({ page }) => {
  await signInPage(page);
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.goto("/assistant");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Assistant", {
      timeout: 30000,
    });
    await expect(
      page
        .getByRole("navigation", { name: "The app" })
        .getByRole("link", { name: "Assistant" })
    ).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("main")).toHaveCount(1);
    await checkA11y(page);
    await noSidewaysScroll(page);
  }
});

test("4. an address that does not exist: the app's own page, with the way home (SF-app-004)", async ({
  page,
}) => {
  await signInPage(page);
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    const res = await page.goto("/no-such-page-here");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
    await expect(page.getByRole("link", { name: "Go to the home page" })).toHaveAttribute(
      "href",
      "/"
    );
    await checkA11y(page);
    await noSidewaysScroll(page);
  }
});

test("5. signed out: sign-in comes back to the page asked for, its query too (E-113)", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/account?from=e2e");
  await page.waitForURL("**/auth?**");
  expect(new URL(page.url()).searchParams.get("redirect")).toBe("/account?from=e2e");
  await context.close();
});
