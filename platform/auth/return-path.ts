/**
 * platform/auth/return-path.ts — the page a person asked for, kept through sign-in (TASK-222, E-113)
 *
 * A screen that needs a signed-in person sends them to `/auth?redirect=<the page>`. Sign-in used
 * to ignore it and always went to `/`, so someone following a link to an authorization request
 * or the console signed in and landed on the home page (E-113). Now sign-in — by password, after
 * two-step verification or a new password, and through single sign-on — returns to it.
 *
 * Only a page of this site is ever a return path: the value is read as a path, resolved against
 * this origin, and refused unless it stays on it — so `//evil.example`, `/\evil.example`,
 * `https://evil.example`, a tab or a newline smuggled into the slashes, or `javascript:` never
 * leave the site (an open redirect, OWASP ASVS 5.0 V3.7 / CWE-601). The sign-in page itself and
 * the API are refused too (a loop, or a JSON answer as a page). A refused value is ignored, never
 * reported: sign-in then goes home, as before.
 *
 * Single sign-on leaves the site for the provider and comes back to /auth/callback: the path goes
 * with the attempt — GET /api/auth/sso/<provider>?redirect=<path> keeps it in the attempt's own
 * httpOnly cookie, and POST /api/auth/sso/callback answers it once the session has started —
 * each checked here again. Nothing is kept in the browser's storage (platform/jobs/retention.ts:
 * the browser holds no localStorage or sessionStorage entry).
 *
 * Source: OWASP Cheat Sheet Series, "Unvalidated Redirects and Forwards Cheat Sheet" (allow only
 * local paths, resolved and compared by origin).
 *
 * @module platform/auth
 */

/** The query parameter a screen names the page with. */
export const RETURN_PARAM = "redirect";

/** Longer than any page of the site; a longer value is refused rather than cut. */
const MAX_LENGTH = 2048;

/**
 * The path to return to — `/page?query#hash` on `origin` — or null when `raw` is not a page of
 * this site that sign-in may return to.
 */
export function safeReturnPath(
  raw: string | null | undefined,
  origin: string
): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LENGTH) return null;
  // A path, written as one: one slash, then not a second slash or a backslash.
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;
  // Control characters (a tab, a newline) are dropped by URL parsing and could join slashes.
  // eslint-disable-next-line no-control-regex -- the control characters are what is refused
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin).origin) return null;
  const path = url.pathname;
  if (path === "/auth" || path.startsWith("/auth/") || path.startsWith("/api/"))
    return null;
  return `${path}${url.search}${url.hash}`;
}

/** The address that starts single sign-on with `provider`, asked to return to `path`. */
export function ssoStartPath(provider: string, path?: string | null): string {
  const start = `/api/auth/sso/${encodeURIComponent(provider)}`;
  return path
    ? `${start}?${new URLSearchParams({ [RETURN_PARAM]: path }).toString()}`
    : start;
}

/** The sign-in page, asked to return to `path` afterwards (the page itself when none). */
export function signInPath(path?: string | null): string {
  if (!path) return "/auth";
  return `/auth?${new URLSearchParams({ [RETURN_PARAM]: path }).toString()}`;
}

/** The return path the sign-in page's address names, or null. */
export function returnPathFromLocation(location: {
  readonly search: string;
  readonly origin: string;
}): string | null {
  return safeReturnPath(
    new URLSearchParams(location.search).get(RETURN_PARAM),
    location.origin
  );
}
