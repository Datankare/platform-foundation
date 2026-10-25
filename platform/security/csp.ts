/**
 * platform/security/csp.ts — The Content Security Policy, with a fresh nonce per response
 * (audit G-10, H-7, X-17)
 *
 * The policy allowed 'unsafe-inline' and 'unsafe-eval' scripts: any injected script ran, and with
 * the session's access token in script-readable storage, an injection was a stolen session.
 * Scripts now run only when they carry the response's nonce (or are loaded by one that does —
 * 'strict-dynamic'); the proxy (proxy.ts) makes a nonce for every page and API response and
 * passes it to Next.js, which puts it on its own scripts. 'unsafe-eval' remains in development
 * only, where React's tooling needs it.
 *
 * Also: no plugins (object-src 'none'), no <base> retargeting (base-uri 'self'), forms post only
 * here (form-action 'self'), no framing (frame-ancestors 'none'), and the browser connects to
 * this origin only — it talks to the auth provider through the platform's routes, never
 * directly. Styles keep 'unsafe-inline' (next/font and the framework inline them; a style
 * cannot run script).
 *
 * Edge-safe: Web Crypto only (the proxy runs before the app).
 *
 * @module platform/security
 */

export const NONCE_HEADER = "x-nonce";
export const CSP_HEADER = "Content-Security-Policy";

/** A fresh, unguessable nonce: 16 random bytes, base64. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** The policy for one response, scripts limited to `nonce`. */
export function contentSecurityPolicy(
  nonce: string,
  options: { development?: boolean } = {}
): string {
  const script = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(options.development ? ["'unsafe-eval'"] : []),
  ];
  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
