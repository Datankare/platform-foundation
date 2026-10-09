/**
 * platform/auth/sso.ts — Single sign-on through the identity provider's hosted sign-in (TASK-101)
 *
 * The authorization-code flow, protected the standard way:
 *   - `state` (RFC 6749 §10.12) — a random value bound to this browser, checked on return, so an
 *     attacker cannot complete a sign-in into the victim's session (login CSRF);
 *   - PKCE S256 (RFC 7636) — the verifier never leaves the server, so an intercepted code is
 *     useless without it.
 * Both live in one short-lived httpOnly cookie scoped to /api/auth/sso, set when the flow starts
 * and cleared when it ends. The redirect address is derived from the request's own origin and
 * must be registered on the identity provider's app client.
 *
 * Web Crypto only (crypto.getRandomValues, crypto.subtle, btoa/atob), like guest-token.ts, so
 * it runs on Node and Edge alike.
 *
 * @module platform/auth
 */

import type { SsoProvider } from "@/platform/auth/types";

/** The cookie that carries one sign-in attempt (provider, state, PKCE verifier). */
export const SSO_COOKIE = "pf_sso";
/** Only the SSO routes can read it. */
export const SSO_COOKIE_PATH = "/api/auth/sso";
/** An attempt must complete within ten minutes. */
export const SSO_COOKIE_MAX_AGE_SECONDS = 600;
/** Where the identity provider returns the browser (register it on the app client). */
export const SSO_CALLBACK_PATH = "/auth/callback";

export const SSO_PROVIDER_IDS: readonly SsoProvider[] = ["google", "apple", "microsoft"];

export function isSsoProvider(value: unknown): value is SsoProvider {
  return (
    typeof value === "string" && (SSO_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToText(s: string): string {
  if (!/^[\w-]*$/.test(s)) throw new Error("not base64url");
  const padded =
    s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** 256 random bits, base64url (43 characters) — a valid PKCE verifier and a strong state. */
export function randomToken(): string {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The S256 code challenge for a verifier (RFC 7636 §4.2). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return bytesToB64url(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// The attempt cookie
// ---------------------------------------------------------------------------

export interface SsoAttempt {
  readonly provider: SsoProvider;
  readonly state: string;
  readonly verifier: string;
}

const TOKEN = /^[\w-]{43,128}$/;

export function encodeSsoAttempt(attempt: SsoAttempt): string {
  return `${attempt.provider}.${attempt.state}.${attempt.verifier}`;
}

/** The attempt in a cookie value, or null when absent or malformed. */
export function decodeSsoAttempt(value: string | undefined): SsoAttempt | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [provider, state, verifier] = parts;
  if (!isSsoProvider(provider) || !TOKEN.test(state) || !TOKEN.test(verifier))
    return null;
  return { provider, state, verifier };
}

/** Constant-time comparison of the returned state with the stored one. */
export function sameState(expected: string, received: unknown): boolean {
  if (typeof received !== "string" || received.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  }
  return diff === 0;
}

/** The redirect address for this origin — the same at the start and at the exchange. */
export function ssoRedirectUri(origin: string): string {
  return `${origin}${SSO_CALLBACK_PATH}`;
}

// ---------------------------------------------------------------------------
// Identity from the ID token
// ---------------------------------------------------------------------------

export interface SsoIdentity {
  readonly email: string;
  readonly emailVerified: boolean;
}

/**
 * Email claims from an ID token. Only for display and the client session: the token came from
 * the identity provider's token endpoint over TLS in the same request, and every API call still
 * verifies the access token. Never use this to authorize anything.
 */
export function idTokenIdentity(idToken: string | undefined): SsoIdentity {
  try {
    const payload = JSON.parse(
      b64urlToText((idToken ?? "").split(".")[1] ?? "")
    ) as Record<string, unknown>;
    return {
      email: typeof payload.email === "string" ? payload.email : "",
      emailVerified: payload.email_verified === true || payload.email_verified === "true",
    };
  } catch {
    return { email: "", emailVerified: false };
  }
}
