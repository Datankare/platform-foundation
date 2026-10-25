/**
 * platform/auth/token-verification.ts — a verified access token, remembered briefly (audit
 * A-3/A-4/A-9/X-17 follow-up)
 *
 * Cognito verifies an access token by GetUser: it proves the token genuine and not revoked, and
 * carries the user's current MFA setting and tenant. That was one AWS call per request, and
 * GetUser has a per-account request-rate quota: at scale the quota runs out and every request
 * fails. Now the outcome is remembered in the selected shared cache (CACHE_PROVIDER — Upstash in
 * production, so every instance shares it):
 *
 *   key       auth:token:v1:<sha256 of the token> — never the token itself;
 *   fresh     for auth.token_cache_seconds (governed; default 30, at most 60) after GetUser
 *             answered, and never past the token's own exp: a request in that window is answered
 *             from the cache;
 *   revoked   at once, on every instance, by revokeTokenVerification(sub) — sign-out (and the
 *             global sign-out it performs), an account disabled or deleted, a role or MFA change.
 *             Each entry remembers the user's revocation stamp it was verified under, and is
 *             used only while that stamp is unchanged (the permissions cache's pattern). The
 *             stamp is read before GetUser is called and read again after it answers: an answer
 *             is saved only under the stamp it was asked under, and only when that stamp is
 *             still current — a revocation during the call voids it (and the request asks again,
 *             once, under the new stamp);
 *             An "unavailable" answer is checked the same way: the stamp is read again, and a
 *             revocation during the call voids the entry a stand-in would use (review 9 L11);
 *   one call  concurrent requests with one token and one stamp on one instance share one
 *             GetUser (single flight). A request that read a newer stamp — one that arrived after
 *             a sign-out, a role or MFA change — never joins a call started before it (review 8
 *             H-A: it did, and saved the pre-revocation answer under the new stamp, so a
 *             signed-out token was served from the cache);
 *   refused   locally first: a token that is not this app's or has expired (foreignTokenReason),
 *             or whose signature is not the pool's (platform/auth/jwt-verification.ts, review 8
 *             M5), never reaches GetUser.
 *
 * When GetUser cannot answer (throttled — the quota — or Cognito down): a privileged route
 * (requireAdmin: administration, moderation, operation; and, review 8 M5, the account's own
 * export and deletion and its MFA setup, verification and removal) fails closed with 503
 * service.unavailable (auth). An ordinary route may use the entry past its fresh window, for
 * auth.token_stale_grace_seconds more (governed; default 300, at most 900; 0 turns it off), never
 * past the token's exp and never after a revocation: the user stays signed in through a quota
 * spike on what Cognito itself verified minutes ago. Without such an entry it fails closed too.
 * Never a 401: an outage is not a signed-out user.
 *
 * Residual window (docs/ASSURANCE.md, ADR-012): a token revoked outside the platform (in the
 * Cognito console, or by Cognito's own detection) is honoured until its entry stops being fresh —
 * at most auth.token_cache_seconds — or, during a GetUser outage on an ordinary route, until the
 * grace ends. Revocations the platform makes (above) take effect at the next request. A cache
 * that cannot be read is a miss (GetUser is asked); one that cannot be written is logged.
 *
 * @module platform/auth
 */

import { createHash, randomUUID } from "node:crypto";
import { getCache } from "@/platform/cache";
import type { CacheProvider } from "@/platform/cache/types";
import { getConfigNumber } from "@/platform/auth/platform-config";
import { logger } from "@/lib/logger";
import type { TokenPayload } from "@/platform/auth/types";

/** How a route verifies a token. */
export interface VerifyOptions {
  /**
   * A privileged route (administration, moderation, operation): when the identity provider
   * cannot answer, it fails closed — no stale grace.
   */
  readonly privileged?: boolean;
}

/** The identity provider could not answer, and no remembered verification may stand in. */
export class TokenVerificationUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`token verification unavailable: ${reason}`);
    this.name = "TokenVerificationUnavailableError";
  }
}

/** What the identity provider said about a token. */
export type ProviderOutcome =
  | { readonly kind: "valid"; readonly payload: TokenPayload }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable"; readonly reason: string };

export const TOKEN_CACHE_SECONDS_KEY = "auth.token_cache_seconds";
export const TOKEN_STALE_GRACE_SECONDS_KEY = "auth.token_stale_grace_seconds";
const DEFAULT_FRESH = 30;
const MAX_FRESH = 60;
const DEFAULT_GRACE = 300;
const MAX_GRACE = 900;
/** How long a revocation stamp is kept: longer than any entry lives (fresh + grace). */
const STAMP_TTL_SECONDS = 3600;

interface Entry {
  readonly payload: TokenPayload;
  /** When GetUser answered, ms since the epoch. */
  readonly verifiedAt: number;
  /** The user's revocation stamp then ("-": none). */
  readonly stamp: string;
}

export interface TokenSettings {
  readonly freshSeconds: number;
  readonly graceSeconds: number;
}

const clamp = (v: number, fallback: number, max: number): number =>
  Number.isInteger(v) && v >= 0 ? Math.min(v, max) : fallback;

/** The governed windows, clamped (defaults when unreadable). */
export async function tokenSettings(): Promise<TokenSettings> {
  try {
    const [fresh, grace] = await Promise.all([
      getConfigNumber(TOKEN_CACHE_SECONDS_KEY, DEFAULT_FRESH),
      getConfigNumber(TOKEN_STALE_GRACE_SECONDS_KEY, DEFAULT_GRACE),
    ]);
    return {
      freshSeconds: clamp(fresh, DEFAULT_FRESH, MAX_FRESH),
      graceSeconds: clamp(grace, DEFAULT_GRACE, MAX_GRACE),
    };
  } catch {
    return { freshSeconds: DEFAULT_FRESH, graceSeconds: DEFAULT_GRACE };
  }
}

/** The cache key of a token: a hash of it, never the token. */
export function tokenKey(token: string): string {
  return `auth:token:v1:${createHash("sha256").update(token).digest("hex")}`;
}
const stampKey = (sub: string) => `auth:token-revoked:${sub}`;

export interface TokenVerifierDeps {
  readonly cache?: () => CacheProvider;
  readonly settings?: () => Promise<TokenSettings>;
  readonly now?: () => number;
}

/**
 * One instance's verifier: the shared cache, and this instance's in-flight calls. Instances
 * share what they remember through the cache, and nothing else.
 */
export class TokenVerifier {
  /**
   * In-flight GetUser calls, by token and the revocation stamp their starter read: a request
   * joins only a call asked under the stamp it read itself (review 8 H-A).
   */
  private readonly inflight = new Map<string, Promise<ProviderOutcome>>();
  private readonly cache: () => CacheProvider;
  private readonly settings: () => Promise<TokenSettings>;
  private readonly now: () => number;

  constructor(deps: TokenVerifierDeps = {}) {
    this.cache = deps.cache ?? getCache;
    this.settings = deps.settings ?? tokenSettings;
    this.now = deps.now ?? Date.now;
  }

  /**
   * The token's payload, or null when it is not valid. `claims` are the token's own (decoded,
   * not yet trusted): its expiry, and the subject its revocation stamp is read for — before the
   * provider is asked; `ask` calls the identity provider. Throws TokenVerificationUnavailableError
   * when the provider cannot answer and no remembered verification may stand in.
   */
  async verify(
    token: string,
    claims: { readonly exp: number; readonly subject: string },
    ask: () => Promise<ProviderOutcome>,
    options: VerifyOptions = {}
  ): Promise<TokenPayload | null> {
    const key = tokenKey(token);
    const { freshSeconds, graceSeconds } = await this.settings();
    const remembering = freshSeconds > 0;
    const { exp, subject } = claims;
    const now = this.now();
    if (exp * 1000 <= now) return null;

    // The stamp is read before anything else: a revocation from here on voids what follows.
    const stamp = remembering ? await this.stampOf(subject) : undefined;
    const remembered = remembering ? await this.read(key) : undefined;
    const usable =
      remembered &&
      stamp !== undefined &&
      remembered.stamp === stamp &&
      remembered.payload.sub === subject
        ? remembered
        : undefined;
    if (usable && now < usable.verifiedAt + freshSeconds * 1000) return usable.payload;

    let asked = stamp;
    let answered = await this.flight(key, asked, ask);
    if (answered.kind === "valid" && remembering && asked !== undefined) {
      // Read again: a revocation published while GetUser was answering voids the answer — it
      // may predate a sign-out, a role or an MFA change. Ask once more, under the new stamp.
      const after = await this.stampOf(subject);
      if (after !== undefined && after !== asked) {
        asked = after;
        answered = await this.flight(key, asked, ask);
      }
    }

    if (answered.kind === "valid") {
      // Saved only under the stamp it was asked under, and only while that stamp is current.
      if (
        remembering &&
        asked !== undefined &&
        answered.payload.sub === subject &&
        (await this.stampOf(subject)) === asked
      )
        await this.remember(
          key,
          answered.payload,
          asked,
          exp,
          freshSeconds + graceSeconds
        );
      return answered.payload;
    }
    if (answered.kind === "invalid") {
      if (remembered) await this.forget(key);
      return null;
    }
    // Unavailable: an ordinary route may stand on a recent verification (see the module comment)
    // — never one a revocation voided. The stamp is read again first (review 9 L11): a
    // revocation published while the call was in flight voids the entry read before it, exactly
    // as it voids a "valid" answer; a stamp that cannot be read now is no proof, so no stand-in.
    const now2 = remembering && usable ? await this.stampOf(subject) : undefined;
    const standIn =
      asked === stamp && now2 !== undefined && now2 === stamp ? usable : undefined;
    const graceEnds = standIn
      ? standIn.verifiedAt + (freshSeconds + graceSeconds) * 1000
      : 0;
    if (!options.privileged && standIn && now < graceEnds && now < exp * 1000) {
      logger.warn(
        "Token verified from a recent answer: the identity provider cannot answer",
        {
          reason: answered.reason,
          route: "platform/auth/token-verification",
        }
      );
      return standIn.payload;
    }
    throw new TokenVerificationUnavailableError(answered.reason);
  }

  /**
   * The provider's answer for `key`, asked under `stamp`: joins a call this instance already has
   * in flight for the same token and stamp, or starts one.
   */
  private flight(
    key: string,
    stamp: string | undefined,
    ask: () => Promise<ProviderOutcome>
  ): Promise<ProviderOutcome> {
    // An unreadable stamp ("") shares only with others that could not read it either.
    const id = `${key}\u0000${stamp ?? ""}`;
    let outcome = this.inflight.get(id);
    if (!outcome) {
      outcome = this.ask(ask);
      this.inflight.set(id, outcome);
      void outcome.finally(() => this.inflight.delete(id));
    }
    return outcome;
  }

  private async ask(ask: () => Promise<ProviderOutcome>): Promise<ProviderOutcome> {
    try {
      return await ask();
    } catch (err) {
      return {
        kind: "unavailable",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async read(key: string): Promise<Entry | undefined> {
    try {
      const entry = await this.cache().get<Entry>(key);
      return entry && typeof entry === "object" && entry.payload ? entry : undefined;
    } catch {
      return undefined;
    }
  }

  /** The user's revocation stamp ("-": none), or undefined when it cannot be read. */
  private async stampOf(sub: string): Promise<string | undefined> {
    try {
      return (await this.cache().get<string>(stampKey(sub))) ?? "-";
    } catch {
      return undefined;
    }
  }

  /** Remember a verification under the stamp read before the provider was asked. */
  private async remember(
    key: string,
    payload: TokenPayload,
    stamp: string,
    exp: number,
    lifeSeconds: number
  ): Promise<void> {
    const ttlSeconds = Math.min(lifeSeconds, exp - Math.floor(this.now() / 1000));
    if (ttlSeconds < 1) return;
    try {
      await this.cache().set<Entry>(
        key,
        { payload, verifiedAt: this.now(), stamp },
        { ttlSeconds }
      );
    } catch (err) {
      logger.warn("Token verification not remembered", {
        error: err instanceof Error ? err.message : String(err),
        route: "platform/auth/token-verification",
      });
    }
  }

  private async forget(key: string): Promise<void> {
    try {
      await this.cache().delete(key);
    } catch {
      /* justified: an entry not deleted still expires, and is not fresh past its window */
    }
  }
}

/**
 * Void every remembered verification of `sub`'s tokens, on every instance (sign-out, an account
 * disabled or deleted, a role or MFA change). A failure is logged; the fresh window still bounds
 * it.
 */
export async function revokeTokenVerification(
  sub: string,
  cache: CacheProvider = getCache()
): Promise<void> {
  try {
    await cache.set(stampKey(sub), randomUUID(), { ttlSeconds: STAMP_TTL_SECONDS });
  } catch (err) {
    logger.error("Token revocation not published to other instances", {
      error: err instanceof Error ? err.message : String(err),
      route: "platform/auth/token-verification",
    });
  }
}

/** Forget one token's remembered verification (its own sign-out), on every instance. */
export async function forgetTokenVerification(
  token: string,
  cache: CacheProvider = getCache()
): Promise<void> {
  try {
    await cache.delete(tokenKey(token));
  } catch {
    /* justified: the user's revocation stamp (revokeTokenVerification) voids it as well */
  }
}

/**
 * The subject an access token names (its username, else its sub), read without verifying it —
 * only to address a revocation after the provider accepted the sign-out.
 */
export function tokenSubject(token: string): string | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const name = claims.username ?? claims.sub;
    return typeof name === "string" && name ? name : undefined;
  } catch {
    return undefined;
  }
}
