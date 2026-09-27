/**
 * platform/auth/guest-token.ts — Signed guest tokens (ADR-050 D4, TASK-098)
 *
 * Guest identity is owned by the platform, not by the auth provider: every provider mints and
 * verifies guest tokens through this module, and the platform's guest check (A3) calls
 * verifyGuestToken() here directly — so a provider with its own weaker guest format can never
 * widen what the platform accepts.
 *
 * Format:  guest.<payload>.<signature>
 *   payload   = base64url(JSON { v: 1, sub, typ: "guest", iat, exp })   (seconds)
 *   signature = base64url(HMAC-SHA256(GUEST_TOKEN_SECRET, "guest.<payload>"))
 *
 * Guest ids are namespaced (`guest_` + 128 random bits) so they can never equal a user id.
 *
 * Secret: GUEST_TOKEN_SECRET, declared in the environment contract (required in production
 * with a real auth provider). Outside production, when it is unset, a random per-process secret
 * is used — tokens then do not survive a restart, which is fine for tests and local work.
 *
 * Web Crypto only (crypto.subtle, btoa/atob) — no node:crypto, no Buffer — so the module runs
 * in Node and Edge alike. subtle.verify compares the MAC in constant time.
 *
 * @module platform/auth
 */

import {
  getGuestTokenSecret,
  isProductionContext,
} from "@/platform/providers/environment-contract";

export const GUEST_TOKEN_PREFIX = "guest.";
export const GUEST_ID_PREFIX = "guest_";
/** Default lifetime: 72 hours, matching the guest session cookie. */
export const DEFAULT_GUEST_TTL_SECONDS = 72 * 3600;
/** Upper bound on any guest token lifetime, whatever the caller asks for. */
export const MAX_GUEST_TTL_SECONDS = 30 * 24 * 3600;
/** Tolerated clock skew for `iat` in the future. */
const CLOCK_SKEW_SECONDS = 60;

const GUEST_ID_SHAPE = /^guest_[a-z0-9]{32}$/;

export interface MintedGuestToken {
  guestId: string;
  token: string;
  expiresAt: number;
}

export type GuestTokenVerification =
  { valid: true; guestId: string; expiresAt: number } | { valid: false };

interface GuestPayload {
  v: 1;
  sub: string;
  typ: "guest";
  iat: number;
  exp: number;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[\w-]*$/.test(s)) throw new Error("not base64url");
  const padded =
    s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------
// Secret
// ---------------------------------------------------------------------------

const EPHEMERAL_KEY = Symbol.for("datankare.platform.guestToken.ephemeralSecret.v1");

function secret(): string {
  const configured = getGuestTokenSecret();
  if (configured) return configured;
  // The environment contract refuses to boot production without it; this is the belt to
  // that brace — never sign or verify with a made-up secret in production.
  if (isProductionContext()) {
    throw new Error(
      "GUEST_TOKEN_SECRET is not set — refusing to sign or verify guest tokens"
    );
  }
  const g = globalThis as unknown as Record<symbol, string | undefined>;
  if (!g[EPHEMERAL_KEY]) {
    g[EPHEMERAL_KEY] = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  }
  return g[EPHEMERAL_KEY] as string;
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Mint / verify
// ---------------------------------------------------------------------------

/** A new namespaced guest id: `guest_` + 128 random bits as 32 hex chars. */
export function newGuestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return (
    GUEST_ID_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

/** True for an id minted by newGuestId() — never a user id. */
export function isGuestId(id: string): boolean {
  return GUEST_ID_SHAPE.test(id);
}

/** Mint a signed guest token. `ttlSeconds` is clamped to [60, MAX_GUEST_TTL_SECONDS]. */
export async function mintGuestToken(
  ttlSeconds: number = DEFAULT_GUEST_TTL_SECONDS
): Promise<MintedGuestToken> {
  const ttl = Math.min(
    Math.max(Number.isFinite(ttlSeconds) ? Math.floor(ttlSeconds) : 0, 60),
    MAX_GUEST_TTL_SECONDS
  );
  const iat = nowSeconds();
  const payload: GuestPayload = {
    v: 1,
    sub: newGuestId(),
    typ: "guest",
    iat,
    exp: iat + ttl,
  };
  const body = GUEST_TOKEN_PREFIX + bytesToB64url(enc.encode(JSON.stringify(payload)));
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(body))
  );
  return {
    guestId: payload.sub,
    token: `${body}.${bytesToB64url(mac)}`,
    expiresAt: payload.exp,
  };
}

/**
 * Verify a guest token: signature (constant time), shape, namespace, lifetime. Any failure is
 * `{ valid: false }` — the reason is not disclosed to the caller.
 */
export async function verifyGuestToken(token: unknown): Promise<GuestTokenVerification> {
  try {
    if (typeof token !== "string" || !token.startsWith(GUEST_TOKEN_PREFIX)) {
      return { valid: false };
    }
    const parts = token.split(".");
    if (parts.length !== 3) return { valid: false };
    const [, payloadPart, sigPart] = parts;
    const body = `${GUEST_TOKEN_PREFIX}${payloadPart}`;

    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(),
      b64urlToBytes(sigPart),
      enc.encode(body)
    );
    if (!ok) return { valid: false };

    const p = JSON.parse(dec.decode(b64urlToBytes(payloadPart))) as Partial<GuestPayload>;
    const now = nowSeconds();
    if (
      p.v !== 1 ||
      p.typ !== "guest" ||
      typeof p.sub !== "string" ||
      !isGuestId(p.sub) ||
      typeof p.iat !== "number" ||
      typeof p.exp !== "number" ||
      p.iat > now + CLOCK_SKEW_SECONDS ||
      p.exp <= now ||
      p.exp - p.iat > MAX_GUEST_TTL_SECONDS
    ) {
      return { valid: false };
    }
    return { valid: true, guestId: p.sub, expiresAt: p.exp };
  } catch {
    return { valid: false };
  }
}
