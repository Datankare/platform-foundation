/**
 * platform/auth/jwt-verification.ts — an access token's signature, checked here before the
 * identity provider is asked (review 8 M5)
 *
 * Before: foreignTokenReason checked an access token's claims only, so a forged, unsigned token
 * with the right claims reached Cognito's GetUser — one call each, under a per-account quota. A
 * flood of forged tokens drained the quota, GetUser failed for everyone (an outage), and ordinary
 * routes fell back to the stale grace. Now every token is verified locally first, against the
 * pool's published signing keys (its JWKS), and only a token the pool really signed costs a
 * GetUser call:
 *
 *   algorithm   RS256 only (Cognito's): "none", HS256 with the public key as its secret, or any
 *               other algorithm is refused before a key is looked at;
 *   key         chosen by the token's `kid` from the pool's JWKS. The keys are fetched from
 *               https://cognito-idp.<region>.amazonaws.com/<pool>/.well-known/jwks.json, kept
 *               for an hour, and fetched by one request at a time (single flight). An unknown
 *               kid refreshes the keys once — at most one refresh per 30 s whatever arrives (a
 *               rotation is seen; a flood of made-up kids cannot turn into a flood of fetches) —
 *               and is refused if the refreshed keys do not hold it. When that refresh was
 *               suppressed (another unknown kid spent the 30 s), the answer is "unavailable",
 *               not "invalid": a genuinely rotated key is never a 401 (review 9 L9);
 *   claims      iss (the pool), exp and nbf (jose), token_use "access", client_id this app's.
 *
 * When the keys cannot be fetched and none were fetched in the last day, verification is
 * unavailable, never a 401: the token verifier then treats it as the identity provider not
 * answering — a fresh remembered verification of that very token is honoured, an ordinary route
 * may use the stale grace, a privileged one fails closed with 503 (review 9 M4). Keys fetched
 * before stand in for a failed refresh for up to a day: Cognito rotates its keys rarely and
 * announces new ones in the JWKS before using them. A cold instance (no keys yet) retries with a
 * short backoff — 250 ms, doubling, at most the 30 s cooldown; two attempts within one call,
 * shared by concurrent callers — rather than refusing every token for 30 s after one failure. A
 * request waits at most 1 s in all (COLD_WAIT_CAP_MS) — what is left of the backoff and any fetch
 * it joins or starts (review 10 M4, review 11 L-6) — and joins a fetch already in flight rather
 * than sleeping.
 *
 * @module platform/auth
 */

import {
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { getSingleton } from "@/platform/kernel/singleton";

/**
 * The longest one request waits for the signing keys, in all — the backoff and every fetch it
 * joins or starts (review 10 M4, review 11 L-6). The backoff between attempts still doubles up to
 * the cooldown; a request that would have to wait longer is answered with the keys it has or
 * "unavailable", instead of being held.
 */
export const COLD_WAIT_CAP_MS = 1000;

/** The one algorithm a Cognito access token is signed with. */
export const ACCESS_TOKEN_ALGORITHM = "RS256";

/** The keys could not be fetched, and no recent ones can stand in. */
export class JwksUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`signing keys unavailable: ${reason}`);
    this.name = "JwksUnavailableError";
  }
}

export interface KeyStoreOptions {
  /** Keys older than this are fetched again before use (default 1 h). */
  readonly maxAgeMs?: number;
  /** At most one refresh in this period, whatever triggers it (default 30 s). */
  readonly cooldownMs?: number;
  /** How long keys fetched before stand in for a failed refresh (default 24 h). */
  readonly staleMs?: number;
  /** While no keys are held: the first retry's delay, doubling per failure (default 250 ms). */
  readonly coldBackoffMs?: number;
  /** While no keys are held: fetch attempts within one call (default 2). */
  readonly coldAttempts?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * The keys are fixed (tests, or a deployment that pins its pool's keys): no refresh can show
   * a new one, so an unknown kid is refused at once (never "unavailable").
   */
  readonly pinned?: boolean;
}

/** One pool's signing keys: fetched, kept, refreshed on a rotation, one fetch at a time. */
export class JwksKeyStore {
  private keys: JSONWebKeySet | undefined;
  private fetchedAt = 0;
  private lastAttempt = Number.NEGATIVE_INFINITY;
  /** Consecutive failed fetches while no keys are held (the cold-start backoff, review 9 M4). */
  private coldFailures = 0;
  private pending: Promise<void> | undefined;
  private readonly maxAgeMs: number;
  private readonly cooldownMs: number;
  private readonly staleMs: number;
  private readonly coldBackoffMs: number;
  private readonly coldAttempts: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pinned: boolean;

  constructor(
    private readonly fetchKeys: () => Promise<JSONWebKeySet>,
    options: KeyStoreOptions = {}
  ) {
    this.maxAgeMs = options.maxAgeMs ?? 60 * 60 * 1000;
    this.cooldownMs = options.cooldownMs ?? 30 * 1000;
    this.staleMs = options.staleMs ?? 24 * 60 * 60 * 1000;
    this.coldBackoffMs = options.coldBackoffMs ?? 250;
    this.coldAttempts = options.coldAttempts ?? 2;
    this.now = options.now ?? Date.now;
    this.pinned = options.pinned ?? false;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Whether any keys are held (fetched at some point, however long ago). */
  private get cold(): boolean {
    return this.keys === undefined;
  }

  /**
   * How long after the last attempt the next may be made. With keys held: the cooldown (30 s).
   * With none (a cold instance, review 9 M4): a short backoff — 250 ms, doubling per failure,
   * never longer than the cooldown — so one transient failure does not refuse every token for
   * the whole cooldown.
   */
  private retryAfterMs(): number {
    if (!this.cold) return this.cooldownMs;
    return Math.min(
      this.cooldownMs,
      this.coldBackoffMs * 2 ** Math.max(0, this.coldFailures - 1)
    );
  }

  /**
   * Wait for `work`, at most `budgetMs` (review 11 L-6): true when it settled in time. The work
   * itself goes on (a fetch is never abandoned half-way; a later request finds its keys).
   */
  private async within(work: Promise<void>, budgetMs: number): Promise<boolean> {
    if (budgetMs <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), budgetMs);
    });
    try {
      return await Promise.race([work.then(() => true as const), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The keys to verify with; fetched first when there are none or they are old.
   *
   * One request waits at most COLD_WAIT_CAP_MS in all for fetches (review 11 L-6: a cold request
   * joined two 5 s fetches — about 10 s — on top of the backoff's 1 s cap). Past it, the keys held
   * (if any, within the stale period) are used, else the answer is "unavailable"; the fetch in
   * flight completes for the requests after.
   */
  async current(): Promise<JSONWebKeySet> {
    if (!this.keys || this.now() - this.fetchedAt >= this.maxAgeMs) {
      const deadline = this.now() + COLD_WAIT_CAP_MS;
      const left = () => deadline - this.now();
      let inTime = await this.within(this.refresh(), left());
      // Cold: a bounded retry inside this call (single flight — concurrent callers share it), so
      // a blip on the first fetch does not fail the request that met it. The wait is only what
      // is left of the backoff since the last attempt, within this request's budget: a request
      // never sleeps through the whole doubled backoff (review 10 M4 — up to 30 s per request on
      // a cold instance during an outage). A fetch already in flight is joined, not waited out.
      for (let i = 1; inTime && this.cold && i < this.coldAttempts && left() > 0; i++) {
        if (!this.pending) {
          const backoff = this.lastAttempt + this.retryAfterMs() - this.now();
          const wait = Math.min(left(), Math.max(0, backoff));
          if (wait > 0) await this.sleep(wait);
          if (left() <= 0) break;
        }
        inTime = await this.within(this.refresh(), left());
      }
    }
    if (!this.keys || this.now() - this.fetchedAt >= this.staleMs) {
      throw new JwksUnavailableError("the pool's signing keys could not be fetched");
    }
    return this.keys;
  }

  /**
   * A token named a key the store does not hold: refresh once, unless a refresh was tried within
   * the cooldown. True when the keys were refreshed (or a refresh was already under way); false
   * when the refresh was suppressed — the key may be a genuine rotation not yet seen, so the
   * caller answers "unavailable", never "invalid" (review 9 L9).
   */
  async refreshForUnknownKey(): Promise<boolean> {
    // Pinned keys are final: the kid is unknown, and no refresh could change that.
    if (this.pinned && this.keys) return true;
    // A join or a refresh is waited for at most COLD_WAIT_CAP_MS (review 11 L-6); past it, the
    // answer is "unavailable" (false), never a wait as long as the fetch's own timeout.
    if (this.pending) return this.within(this.pending, COLD_WAIT_CAP_MS);
    if (this.now() - this.lastAttempt < this.retryAfterMs()) return false;
    return this.within(this.refresh(), COLD_WAIT_CAP_MS);
  }

  /** One fetch at a time; a failure keeps what was fetched before. */
  private refresh(): Promise<void> {
    if (this.pending) return this.pending;
    // Bounded: one attempt per cooldown (or per cold backoff) — a failing JWKS endpoint is not
    // asked once per request.
    if (this.now() - this.lastAttempt < this.retryAfterMs()) return Promise.resolve();
    this.lastAttempt = this.now();
    this.pending = (async () => {
      try {
        const keys = await this.fetchKeys();
        if (!keys || !Array.isArray(keys.keys)) throw new Error("not a JWKS");
        this.keys = { keys: keys.keys };
        this.fetchedAt = this.now();
        this.coldFailures = 0;
      } catch {
        /* justified: what was fetched before stands in (current() bounds how long) */
        if (this.cold) this.coldFailures += 1;
      } finally {
        this.pending = undefined;
      }
    })();
    return this.pending;
  }
}

/** The JWKS address of a Cognito user pool. */
export function jwksUrl(region: string, userPoolId: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`;
}

/** The pool's key store, one per process (shared by every provider instance, ADR-032). */
export function poolKeyStore(region: string, userPoolId: string): JwksKeyStore {
  const stores = getSingleton<Map<string, JwksKeyStore>>(
    "platform.auth.jwks-stores",
    () => new Map()
  );
  const url = jwksUrl(region, userPoolId);
  let store = stores.get(url);
  if (!store) {
    store = new JwksKeyStore(async () => {
      const response = await fetchWithTimeout(url, { timeoutMs: 5000, maxRetries: 0 });
      if (!response.ok) throw new Error(`JWKS answered ${response.status}`);
      return (await response.json()) as JSONWebKeySet;
    });
    stores.set(url, store);
  }
  return store;
}

/** A store over a fixed key set (tests, or a deployment that pins its pool's keys). */
export function staticKeyStore(keys: JSONWebKeySet): JwksKeyStore {
  return new JwksKeyStore(async () => keys, { pinned: true });
}

export interface AccessTokenExpectations {
  /** https://cognito-idp.<region>.amazonaws.com/<pool> */
  readonly issuer: string;
  readonly clientId: string;
  readonly keys: JwksKeyStore;
  readonly nowSeconds?: number;
}

export type AccessTokenCheck =
  | { readonly ok: true; readonly claims: JWTPayload & Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether `token` is an access token the pool signed for this app client, judged locally.
 * Throws JwksUnavailableError when the pool's keys cannot be had.
 */
export async function verifyAccessTokenSignature(
  token: string,
  expect: AccessTokenExpectations
): Promise<AccessTokenCheck> {
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return { ok: false, reason: "undecodable" };
  }
  if (header.alg !== ACCESS_TOKEN_ALGORITHM)
    return { ok: false, reason: `algorithm ${String(header.alg)} is not accepted` };
  if (typeof header.kid !== "string" || !header.kid)
    return { ok: false, reason: "no key id" };

  let keys = await expect.keys.current();
  if (!keys.keys.some((k) => k.kid === header.kid)) {
    // A rotation, or a made-up kid: refreshed at most once per cooldown. Refused only when the
    // refreshed keys do not hold it. When the refresh was suppressed (another token's unknown
    // kid spent the cooldown), the key may be a genuine rotation: unavailable — 503, or the
    // stale grace on an ordinary route — never a 401 (review 9 L9).
    if (!(await expect.keys.refreshForUnknownKey())) {
      throw new JwksUnavailableError(
        "the token's signing key is not yet known and the keys were refreshed moments ago"
      );
    }
    keys = await expect.keys.current();
    if (!keys.keys.some((k) => k.kid === header.kid))
      return { ok: false, reason: "unknown signing key" };
  }

  let claims: JWTPayload & Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, createLocalJWKSet(keys), {
      algorithms: [ACCESS_TOKEN_ALGORITHM],
      issuer: expect.issuer,
      requiredClaims: ["exp"],
      ...(expect.nowSeconds !== undefined
        ? { currentDate: new Date(expect.nowSeconds * 1000) }
        : {}),
    });
    claims = verified.payload as JWTPayload & Record<string, unknown>;
  } catch (err) {
    const code = (err as { code?: string }).code;
    return { ok: false, reason: code ?? "signature" };
  }
  if (claims.token_use !== "access") return { ok: false, reason: "not an access token" };
  if (claims.client_id !== expect.clientId)
    return { ok: false, reason: "issued to another app client" };
  return { ok: true, claims };
}
