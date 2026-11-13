/**
 * platform/auth/session-cookie.ts — the session cookie's name (ADR-057 D1)
 *
 * `__Host-pf_session` in a production build: the `__Host-` prefix makes the browser accept the
 * cookie only with `Secure`, `Path=/` and no `Domain`, so no sibling subdomain can set or
 * overwrite it. Browsers refuse a `__Host-` cookie that is not Secure, so plain-HTTP local work
 * and tests use `pf_session`.
 *
 * Kept apart from the session module because the page proxy needs the name too, and the proxy
 * imports nothing that reaches a database.
 *
 * No server-only imports.
 *
 * @module platform/auth
 */

export const SESSION_COOKIE = "__Host-pf_session";
/** Outside a production build: browsers refuse a `__Host-` cookie that is not Secure. */
export const LOCAL_SESSION_COOKIE = "pf_session";

/** Whether this build sets Secure cookies (a production build always does). */
export function secureCookies(): boolean {
  return process.env.NODE_ENV === "production";
}

/** The name the session cookie has in this build. */
export function sessionCookieName(): string {
  return secureCookies() ? SESSION_COOKIE : LOCAL_SESSION_COOKIE;
}
