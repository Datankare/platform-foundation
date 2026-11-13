/**
 * platform/auth/api-fetch.ts — fetch for the platform's own API, as the signed-in user
 *
 * The server authenticates an API call by the session cookie the browser sends with it
 * (ADR-057) — a cookie script cannot read, so this module holds no credential. What it adds to a
 * call to this origin:
 *
 *   - `credentials: "same-origin"`, so the cookie goes with the call (and never to another
 *     origin, whatever URL a caller passes);
 *   - on a state-changing call (anything but GET, HEAD, OPTIONS), the session's forgery token in
 *     `x-csrf-token` — the server requires it (platform/auth/session.ts). A page whose session
 *     is still being read waits for that read.
 *
 * To another origin, or on the server, it is exactly `fetch(input, init)`.
 *
 * Two refusals are handled here, for every screen (HANDLED_CODES):
 *   auth.csrf_failed    the token held is not the session's (it moved to a new id in another
 *                       tab): the session is read again and the call made once more with its
 *                       current token. A body that is a stream cannot be sent twice, so such a
 *                       call is not retried.
 *   auth.token_invalid, auth.required
 *                       the session has ended (signed out elsewhere, expired, revoked) or its
 *                       cookie is gone: the page forgets it, and the screen shows sign-in. The
 *                       response is returned as it is, for the screen's own refusal handling.
 */

import {
  currentSession,
  loadSession,
  noteSessionEnded,
  pendingSessionLoad,
} from "./context";

/** The refusals this transport handles itself, for every caller (refusal-coverage.test.ts). */
export const HANDLED_CODES = ["auth.csrf_failed"] as const;

const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const isRequest = (input: unknown): input is Request =>
  typeof Request !== "undefined" && input instanceof Request;

/**
 * True when `input` addresses this origin. Always decided by the URL parser, the same one fetch
 * uses — never by the text's prefix: the parser removes tabs and newlines and reads a backslash
 * as "/", so "/\t/evil.example" is the scheme-relative "//evil.example".
 */
function isSameOrigin(input: RequestInfo | URL): boolean {
  if (typeof window === "undefined") return false;
  const raw =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (isRequest(input) ? input.method : "GET")).toUpperCase();
}

/** The caller's options with the cookie sent and, when there is one, the forgery token added. */
function withSession(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  csrfToken: string | null
): RequestInit {
  const own = init?.headers ?? (isRequest(input) ? input.headers : undefined);
  if (!csrfToken) {
    return { ...init, ...(own ? { headers: own } : {}), credentials: "same-origin" };
  }
  // A plain record stays one (what most callers pass); anything else becomes Headers.
  if (own && !(own instanceof Headers) && !Array.isArray(own)) {
    const kept = Object.fromEntries(
      Object.entries(own).filter(([name]) => name.toLowerCase() !== CSRF_HEADER)
    );
    return {
      ...init,
      headers: { ...kept, [CSRF_HEADER]: csrfToken },
      credentials: "same-origin",
    };
  }
  const headers = new Headers(own);
  headers.set(CSRF_HEADER, csrfToken);
  return { ...init, headers, credentials: "same-origin" };
}

/** Whether `init` can be sent again (a stream body is consumed by the first send). */
function replayable(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (isRequest(input)) return false;
  const body = init?.body;
  return (
    body === undefined ||
    body === null ||
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    (typeof FormData !== "undefined" && body instanceof FormData) ||
    (typeof Blob !== "undefined" && body instanceof Blob) ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
}

/** The refusal code of a response, read from a copy (the caller still reads the body). */
async function refusalCode(response: Response): Promise<string | null> {
  try {
    const data = (await response.clone().json()) as { code?: unknown };
    return typeof data.code === "string" ? data.code : null;
  } catch {
    return null;
  }
}

export interface ApiFetchOptions {
  /**
   * What to do when the server says the session has ended. "note" (the default): the page
   * forgets it, so its screens show sign-in. "leave": the response is only returned — for a
   * caller that can start the session again itself and make the call once more (an app's guest
   * screen, which starts a new guest session), and that calls noteSessionEnded() when it cannot.
   */
  readonly onSessionEnded?: "note" | "leave";
}

export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: ApiFetchOptions = {}
): Promise<Response> {
  if (!isSameOrigin(input)) return fetch(input, init);
  const changing = !SAFE_METHODS.has(methodOf(input, init));
  // A state-changing call waits for the page's read of its session, if one is under way. This
  // never starts a read: the provider does, when it mounts. A call made with no token yet (no
  // provider, or a read that failed) is refused by the server with auth.csrf_failed, and
  // answered below by reading the session and making the call again.
  if (changing && currentSession().status === "loading") {
    const reading = pendingSessionLoad();
    if (reading) await reading;
  }
  const held = currentSession();
  const token = changing && held.status === "signed-in" ? held.csrfToken : null;
  const response = await fetch(input, withSession(input, init, token));
  if (response.status !== 401 && response.status !== 403) return response;
  const code = await refusalCode(response);
  if (
    response.status === 401 &&
    (code === "auth.token_invalid" || code === "auth.required")
  ) {
    if (options.onSessionEnded !== "leave") noteSessionEnded();
    return response;
  }
  if (code !== "auth.csrf_failed" || !changing || !replayable(input, init))
    return response;
  const renewed = await loadSession();
  if (renewed.status !== "signed-in" || renewed.csrfToken === token) return response;
  return fetch(input, withSession(input, init, renewed.csrfToken));
}
