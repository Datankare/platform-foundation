/**
 * platform/auth/legacy-session-cleanup.ts — remove what a browser signed in before ADR-057 kept
 * in its storage (TASK-214, SEC-016)
 *
 * Before ADR-057 the page kept the session's access token (`pf_access_token`), earlier still its
 * refresh token (`pf_refresh_token`), and the user's profile (`pf_user`) in localStorage. Nothing
 * reads them any more. On the first load after the deploy they are deleted — never read: a value
 * that script could read is not trusted to say who is signed in — and the caller is told only
 * whether a signed-in profile was there, so it can ask the server to move that browser's session
 * (its httpOnly legacy cookie) onto a server-side one.
 *
 * This is the only file allowed to name these keys, and it may only remove them
 * (__tests__/no-client-tokens.test.ts).
 *
 * Client-safe: no server imports.
 *
 * @module platform/auth
 */

const LEGACY_KEYS = ["pf_access_token", "pf_refresh_token", "pf_user"] as const;

/**
 * Delete the legacy keys. True when this browser held any of them (it was signed in, or a guest,
 * before the change); false when it held none, or storage cannot be reached.
 */
export function removeLegacyStoredSession(): boolean {
  if (typeof window === "undefined") return false;
  let found = false;
  try {
    const storage = window.localStorage;
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null && (LEGACY_KEYS as readonly string[]).includes(key)) found = true;
    }
    for (const key of LEGACY_KEYS) storage.removeItem(key);
  } catch {
    // Storage unavailable (private mode, disabled): nothing is kept there either.
    return false;
  }
  return found;
}
