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
 */

import { readAccessToken } from "./context";

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

export function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const token = isSameOrigin(input) ? readAccessToken() : null;
  if (!token) return fetch(input, init);
  const headers = new Headers(
    init?.headers ?? (isRequest(input) ? input.headers : undefined)
  );
  if (headers.has("authorization")) return fetch(input, init);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
