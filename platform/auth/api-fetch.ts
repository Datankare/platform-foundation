/**
 * platform/auth/api-fetch.ts — fetch for the platform's own API, as the signed-in user
 *
 * The server authenticates every API call by its `Authorization: Bearer` header
 * (platform/auth/middleware.ts); the browser keeps the session's access token (context.tsx). A
 * screen that called `fetch` directly sent no token, so every authenticated call from it was
 * refused with 401 — the admin console, the review dashboard, appeals and the main screen all
 * did. apiFetch is `fetch` with the token attached:
 *
 *   - only to this origin (a relative path, or an absolute URL on window.location.origin): the
 *     token is never sent to another site, whatever URL a caller passes;
 *   - only when the caller set no Authorization header of its own;
 *   - only a live token (an expired or corrupt session attaches nothing).
 *
 * Without a session, or on the server, it is exactly `fetch(input, init)`.
 *
 * An access token lives an hour; when the API answers 401 to a call that carried one, the
 * session is renewed once from the server's refresh cookie (refreshSession, audit A-14) and the
 * call made again with the new token. A body that is a stream cannot be sent twice, so such a
 * call is not retried.
 */

import { readAccessToken, refreshSession } from "./context";

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

function withToken(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  token: string
): RequestInit {
  const headers = new Headers(
    init?.headers ?? (isRequest(input) ? input.headers : undefined)
  );
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
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

export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const token = isSameOrigin(input) ? readAccessToken() : null;
  if (!token) return fetch(input, init);
  const own = new Headers(
    init?.headers ?? (isRequest(input) ? input.headers : undefined)
  );
  if (own.has("authorization")) return fetch(input, init);
  const response = await fetch(input, withToken(input, init, token));
  if (response.status !== 401 || !replayable(input, init)) return response;
  const renewed = await refreshSession();
  if (!renewed || renewed === token) return response;
  return fetch(input, withToken(input, init, renewed));
}
