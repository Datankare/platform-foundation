/**
 * E2E auth helper — sets session cookie + localStorage for protected routes.
 * Middleware checks cookie, React components check localStorage.
 */

import { Page } from "@playwright/test";

export async function setAuthSession(page: Page, baseURL: string): Promise<void> {
  // Set cookie for middleware
  await page.context().addCookies([
    {
      name: "pf_has_session",
      value: "true",
      domain: new URL(baseURL).hostname,
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);

  // Set localStorage for React AuthContext
  await page.addInitScript(() => {
    localStorage.setItem("pf_access_token", "mock-access-token");
    localStorage.setItem("pf_refresh_token", "mock-refresh-token");
    localStorage.setItem(
      "pf_user",
      JSON.stringify({
        userId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        email: "e2e@test.com",
        emailVerified: true,
        isGuest: false,
      })
    );
  });
}

export const AUTH_HEADERS = {
  Authorization: "Bearer mock-access-token",
};
