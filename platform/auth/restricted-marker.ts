/**
 * platform/auth/restricted-marker.ts — A restricted account cannot continue as a guest (X-20)
 *
 * A banned or suspended user could sign out and carry on as a guest, minting a new guest token
 * whenever its allowance ran out. Two things now stand in the way:
 *
 *   - when a request is refused because its account is banned or suspended, the response marks
 *     the browser (an httpOnly cookie for the auth routes, 30 days); the guest route refuses a new
 *     guest token to a marked browser;
 *   - the guest route refuses a request that carries a signed-in user's token whose account is
 *     not in good standing (and marks it).
 *
 * A marker is a cookie, so a user who clears cookies is no longer marked: what then bounds them is
 * the per-address allowance every guest shares (GUEST_PAID_PER_ADDRESS, platform/auth/
 * guest-allowance.ts). The marker grants nothing and can only refuse its own browser, so it is
 * not signed: forging one only locks oneself out of guest mode.
 *
 * @module platform/auth
 */

export const RESTRICTED_MARKER = "pf_restricted";
export const RESTRICTED_MARKER_MAX_AGE = 30 * 24 * 60 * 60;

interface CookieWriter {
  readonly cookies: {
    set(name: string, value: string, options: Record<string, unknown>): unknown;
  };
}

interface CookieReader {
  readonly cookies: { get(name: string): { value: string } | undefined };
}

/** Mark the browser this response goes to as belonging to a restricted account. */
export function markRestricted(response: CookieWriter): void {
  response.cookies.set(RESTRICTED_MARKER, "1", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth",
    maxAge: RESTRICTED_MARKER_MAX_AGE,
  });
}

/** Whether the request comes from a browser marked restricted. */
export function isMarkedRestricted(request: CookieReader): boolean {
  return request.cookies.get(RESTRICTED_MARKER) !== undefined;
}

/** Account statuses whose holder may not continue as a guest. */
export const NO_GUEST_STATUSES: ReadonlySet<string> = new Set(["banned", "suspended"]);
