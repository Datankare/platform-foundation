/**
 * platform/auth/session-vault.ts — the one place a session's provider tokens are kept and used
 * (ADR-057 D2, TASK-214, SEC-016)
 *
 * After sign-in the server keeps the identity provider's tokens; the browser gets none. Every
 * token a session holds is sealed here before it is stored, and opened here — for one named use —
 * when the server needs it. No other module encrypts, decrypts, stores or parses a session's
 * tokens (__tests__/session-token-confinement.test.ts), so what the server keeps and what it does
 * with it can be changed in this file alone.
 *
 * What is kept, per session:
 *   a user's   access token (with its expiry) and refresh token, as the provider issued them;
 *   a guest's  platform-signed guest token.
 *
 * What a token may be opened for (TokenUse) — each use is one line in the callers:
 *   "identity"        the access token, verified locally (signature, audience, expiry) to name the
 *                     session's user. It is not sent to the identity provider.
 *   "renewal"         the refresh token, exchanged with the provider for a new access token when
 *                     the old one has expired.
 *   "revocation"      the refresh token, revoked at the provider when the session ends.
 *   "totp_enrolment"  the access token, sent to the provider to enrol an authenticator app — the
 *                     one operation the provider offers no administrative call for
 *                     (docs/SECURITY_DEBT.md SEC-018).
 *
 * Sealing: AES-256-GCM. The key is derived (HKDF-SHA256, a label of its own) from
 * SESSION_ENCRYPTION_KEY; the sealed text names the key by a short id, so after a rotation —
 * the old value moved to SESSION_ENCRYPTION_KEY_PREVIOUS — sessions sealed under the old key are
 * still opened, and each is sealed again under the current key when it is next renewed. The
 * session's own id hash is authenticated with the ciphertext: a sealed value copied onto another
 * session's row does not open. Outside production an unset key is a random one per process.
 *
 * @module platform/auth
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  getPreviousSessionEncryptionKey,
  getSessionEncryptionKey,
  isProductionContext,
} from "@/platform/providers/environment-contract";

/** What a session's tokens may be opened for. */
export type TokenUse = "identity" | "renewal" | "revocation" | "totp_enrolment";

/** A user's tokens as the provider issued them. */
export interface UserTokens {
  readonly accessToken: string;
  /** Absent when the provider issued none: the session then ends with its access token. */
  readonly refreshToken?: string;
  /** When the access token expires, seconds since the epoch. */
  readonly expiresAt: number;
}

/** What a session holds, before sealing. */
export type SessionTokens =
  | ({ readonly kind: "user" } & UserTokens)
  | { readonly kind: "guest"; readonly token: string; readonly expiresAt: number };

/** The sealed form, as stored. Opaque outside this module. */
export type SealedTokens = string & { readonly __sealed: unique symbol };

/** The session's tokens cannot be sealed or opened: no key (production), or not this key's. */
export class SessionVaultError extends Error {
  constructor(readonly reason: "no_key" | "unreadable") {
    super(`session vault: ${reason}`);
    this.name = "SessionVaultError";
  }
}

const VERSION = "v1";
/** AES-GCM's full authentication tag, in bytes; stated to the cipher so no shorter tag is accepted. */
const TAG_BYTES = 16;
const KEY_LABEL = "pf_session_tokens.v1";
const EPHEMERAL_KEY = Symbol.for("datankare.platform.sessionVault.ephemeralKey.v1");
const SEALED = /^v1\.([0-9a-f]{8})\.([\w-]{16})\.([\w-]{24,12000})$/;

interface VaultKey {
  /** Names the key in a sealed value without revealing it. */
  readonly label: string;
  readonly key: Buffer;
}

function derive(secret: string): VaultKey {
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), KEY_LABEL, 32));
  // The id names the key without revealing it: a hash of the derived key under its own label.
  const id = createHash("sha256")
    .update("pf_session_key_id.v1\0")
    .update(key)
    .digest("hex");
  return { label: id.slice(0, 8), key };
}

/** The keys a sealed value may be opened with, the sealing one first. */
function vaultKeys(): VaultKey[] {
  const current = getSessionEncryptionKey();
  if (current) {
    const previous = getPreviousSessionEncryptionKey();
    return previous && previous !== current
      ? [derive(current), derive(previous)]
      : [derive(current)];
  }
  if (isProductionContext()) return [];
  const g = globalThis as unknown as Record<symbol, string | undefined>;
  if (!g[EPHEMERAL_KEY]) g[EPHEMERAL_KEY] = randomBytes(32).toString("base64url");
  return [derive(g[EPHEMERAL_KEY] as string)];
}

/** Whether a session's tokens can be sealed here (a key is configured, or this is not production). */
export function vaultReady(): boolean {
  return vaultKeys().length > 0;
}

/** Seal `tokens` for the session whose id hash is `idHash`. */
export function sealTokens(tokens: SessionTokens, idHash: string): SealedTokens {
  const [key] = vaultKeys();
  if (!key) throw new SessionVaultError("no_key");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.key, nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(`${VERSION}\0${idHash}`, "utf8"));
  const body = Buffer.concat([
    cipher.update(JSON.stringify(tokens), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${VERSION}.${key.label}.${nonce.toString("base64url")}.${body.toString("base64url")}` as SealedTokens;
}

function isTokens(value: unknown): value is SessionTokens {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.expiresAt !== "number" || !Number.isFinite(v.expiresAt)) return false;
  if (v.kind === "guest") return typeof v.token === "string" && v.token.length > 0;
  return (
    v.kind === "user" &&
    typeof v.accessToken === "string" &&
    v.accessToken.length > 0 &&
    (v.refreshToken === undefined || typeof v.refreshToken === "string")
  );
}

function open(sealed: string, idHash: string): SessionTokens {
  const m = SEALED.exec(sealed);
  if (!m) throw new SessionVaultError("unreadable");
  const keys = vaultKeys();
  if (keys.length === 0) throw new SessionVaultError("no_key");
  const key = keys.find((k) => k.label === m[1]);
  if (!key) throw new SessionVaultError("unreadable");
  const body = Buffer.from(m[3], "base64url");
  if (body.length < TAG_BYTES + 1) throw new SessionVaultError("unreadable");
  try {
    // The tag's length is stated, so a shorter tag is refused, never verified (NIST SP 800-38D).
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key.key,
      Buffer.from(m[2], "base64url"),
      {
        authTagLength: TAG_BYTES,
      }
    );
    decipher.setAAD(Buffer.from(`${VERSION}\0${idHash}`, "utf8"));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    const text = Buffer.concat([
      decipher.update(body.subarray(0, body.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
    const parsed: unknown = JSON.parse(text);
    if (!isTokens(parsed)) throw new SessionVaultError("unreadable");
    return parsed;
  } catch {
    throw new SessionVaultError("unreadable");
  }
}

/** What opening for a use hands back: only what that use needs. */
export interface OpenedIdentity {
  readonly kind: "user" | "guest";
  /** The user's access token, or the guest's token. */
  readonly token: string;
  readonly expiresAt: number;
  /** Whether an expired access token can be renewed (a refresh token is held). */
  readonly renewable: boolean;
}

/** The token that names the session's user or guest, for local verification. */
export function openIdentity(sealed: SealedTokens, idHash: string): OpenedIdentity {
  const t = open(sealed, idHash);
  return t.kind === "guest"
    ? { kind: "guest", token: t.token, expiresAt: t.expiresAt, renewable: false }
    : {
        kind: "user",
        token: t.accessToken,
        expiresAt: t.expiresAt,
        renewable: Boolean(t.refreshToken),
      };
}

/**
 * A user session's token for one provider call: the refresh token to renew or revoke it, the
 * access token to enrol an authenticator. Null when the session holds none for that use (a
 * guest's, or a user's without a refresh token).
 */
export function openForProvider(
  sealed: SealedTokens,
  idHash: string,
  use: Exclude<TokenUse, "identity">
): string | null {
  const t = open(sealed, idHash);
  if (t.kind !== "user") return null;
  if (use === "totp_enrolment") return t.accessToken;
  return t.refreshToken ?? null;
}

/**
 * The sealed tokens after a renewal: the new access token and its expiry, the refresh token the
 * provider returned or — when it returned none — the one already held.
 */
export function resealRenewed(
  sealed: SealedTokens,
  idHash: string,
  renewed: UserTokens
): SealedTokens {
  const t = open(sealed, idHash);
  if (t.kind !== "user") throw new SessionVaultError("unreadable");
  return sealTokens(
    {
      kind: "user",
      accessToken: renewed.accessToken,
      refreshToken: renewed.refreshToken ?? t.refreshToken,
      expiresAt: renewed.expiresAt,
    },
    idHash
  );
}

/** The same tokens sealed for another session id (rotation), under the current key. */
export function resealFor(
  sealed: SealedTokens,
  idHash: string,
  nextIdHash: string
): SealedTokens {
  return sealTokens(open(sealed, idHash), nextIdHash);
}

/** Whether `sealed` was sealed under the current key (false: a rotation has not reached it yet). */
export function sealedUnderCurrentKey(sealed: string): boolean {
  const m = SEALED.exec(sealed);
  const [key] = vaultKeys();
  return Boolean(m && key && m[1] === key.label);
}
