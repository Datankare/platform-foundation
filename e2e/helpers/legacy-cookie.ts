/**
 * e2e/helpers/legacy-cookie.ts — the refresh cookie a browser held before ADR-057, for the
 * journey that proves such a browser is moved onto a server-side session (TASK-214)
 *
 * Before ADR-057 the refresh token was in the httpOnly cookie `pf_refresh`
 * (`<user id>.<HMAC-SHA256>.<refresh token>`, review 17 M1), signed with REFRESH_COOKIE_KEY. The
 * E2E harness gives its server the key below (playwright.config.ts), so a journey can make the
 * cookie a pre-ADR-057 deployment would have issued. The key is fixed and public: it signs
 * nothing but this test double's cookie, and a deployment's key is never this one (the harness
 * runs only where DEPLOYMENT_HOST is ci or local).
 *
 * No Playwright import: playwright.config.ts loads this file.
 */
import { createHmac } from "node:crypto";

export const E2E_LEGACY_REFRESH_COOKIE_KEY =
  "e2e-harness-legacy-refresh-cookie-key-not-a-secret";

/** The `pf_refresh` value a deployment before ADR-057 issued for `userId` and `refreshToken`. */
export function legacyRefreshCookieValue(userId: string, refreshToken: string): string {
  const mac = createHmac("sha256", E2E_LEGACY_REFRESH_COOKIE_KEY)
    .update(`pf_refresh.v1\0${userId}\0${refreshToken}`)
    .digest("base64url");
  return `${userId}.${mac}.${refreshToken}`;
}
