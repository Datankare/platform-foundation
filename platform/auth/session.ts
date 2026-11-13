/**
 * platform/auth/session.ts — the server-side sign-in session (ADR-057, TASK-214, SEC-016)
 *
 * The browser holds one thing: an opaque session id in a cookie it cannot read from script.
 *
 *   cookie    `__Host-pf_session` — HttpOnly (no script reads it), Secure, SameSite=Lax, Path=/,
 *             no Domain (the `__Host-` prefix makes the browser enforce the last three: the
 *             cookie cannot be set by a sibling subdomain or over plain HTTP). 256 random bits.
 *             Outside a production build (plain-HTTP local work) the name is `pf_session` and
 *             Secure is off, since browsers refuse a `__Host-` cookie that is not Secure.
 *   record    auth_sessions, in the request's tenant, keyed by the id's SHA-256
 *             (session-store.ts). The provider's tokens are sealed in it (session-vault.ts).
 *
 * What ends a session: sign-out; sign-out everywhere; its idle or absolute lifetime
 * (session-lifetimes.ts); a password or second-factor change; a role change; a restriction;
 * erasure; the provider refusing to renew it. An ended session is ended in the record: the id
 * replayed afterwards finds a revoked row.
 *
 * Fixation: an id the browser presents is never adopted. startSession always makes a new id and
 * ends whatever session the presented cookie named; a privilege change (a factor enrolled or
 * removed) moves the session to a new id (rotateSession).
 *
 * Cross-site request forgery — three defences, each for what the others miss (ADR-057 D4):
 *   SameSite=Lax     the browser does not send the cookie on a cross-site POST, fetch or frame.
 *                    It still sends it on a top-level cross-site GET, and "site" is wider than
 *                    origin (a sibling subdomain is same-site).
 *   origin check     a state-changing request's Origin (else Referer) must be this deployment's
 *                    own origin: closes same-site, cross-origin senders. A request with neither
 *                    header is refused — a browser always sends one with a state-changing
 *                    request.
 *   session token    a random value kept in the session record, handed to this origin's script
 *                    by GET /api/auth/session and required in the `x-csrf-token` header of every
 *                    state-changing request: a sender that cannot read this origin's responses
 *                    cannot produce it, whatever headers it forges. It changes with the id.
 *
 * Practices adopted, credited in ADR-057: RFC 10017 (BCP 212) "OAuth 2.0 for Browser-Based
 * Applications" (A. Parecki, P. De Ryck, D. Waite) — the backend-for-frontend pattern and its
 * cookie requirements; OWASP "Session Management Cheat Sheet" and "Cross-Site Request Forgery
 * Prevention Cheat Sheet".
 *
 * @module platform/auth
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { apiError } from "@/platform/errors";
import type { ErrorCode } from "@/platform/errors/registry";
import { ensureRequestTenant } from "@/platform/tenancy/request";
import { getAuthProvider } from "@/platform/auth/config";
import { initAuth } from "@/platform/auth/auth-init";
import { getCachedPermissions } from "@/platform/auth/permissions-cache";
import { isStaffPermission } from "@/platform/auth/role-governance";
import { isStateChanging, requestOriginVerdict } from "@/platform/auth/request-origin";
import {
  sessionDeadlines,
  sessionExpiry,
  sessionLifetimes,
  type SessionAudience,
  type SessionLifetimes,
} from "@/platform/auth/session-lifetimes";
import {
  getSessionStore,
  type RevocationReason,
  type SessionKind,
  type SessionRecord,
} from "@/platform/auth/session-store";
import { endRecord, revokeSubjectSessions } from "@/platform/auth/session-revocation";

export {
  endSubjectSessions,
  revokeSubjectSessions,
  type SubjectRevocation,
} from "@/platform/auth/session-revocation";
import {
  LOCAL_SESSION_COOKIE,
  SESSION_COOKIE,
  secureCookies,
  sessionCookieName,
} from "@/platform/auth/session-cookie";
import {
  SessionVaultError,
  openForProvider,
  openIdentity,
  resealFor,
  resealRenewed,
  sealTokens,
  type SessionTokens,
} from "@/platform/auth/session-vault";

export { LOCAL_SESSION_COOKIE, SESSION_COOKIE, sessionCookieName };
export const CSRF_HEADER = "x-csrf-token";

const SESSION_ID = /^[\w-]{43}$/;
/** A session's use is written at most this often (one write a minute per session, not per request). */
const TOUCH_EVERY_MS = 60_000;
/** An access token this close to its expiry is renewed before it is used. */
const RENEW_WITHIN_SECONDS = 60;

interface RequestLike {
  readonly method?: string;
  readonly headers: Headers;
  readonly cookies: { get(name: string): { value: string } | undefined };
  readonly nextUrl: {
    readonly pathname: string;
    readonly origin: string;
    readonly protocol: string;
  };
}

interface CookieWriter {
  readonly cookies: {
    set(name: string, value: string, options: Record<string, unknown>): unknown;
  };
}

/** SHA-256 (hex) of a session id: what the store keys a session by. */
export function hashSessionId(id: string): string {
  return createHash("sha256").update(`pf_session.v1\0${id}`).digest("hex");
}

const newToken = (): string => randomBytes(32).toString("base64url");

function setSessionCookie(
  response: CookieWriter,
  id: string,
  maxAgeSeconds: number
): void {
  response.cookies.set(sessionCookieName(), id, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: Math.max(0, Math.floor(maxAgeSeconds)),
  });
}

/** Remove the session cookie from the browser. */
export function clearSessionCookie(response: CookieWriter): void {
  response.cookies.set(sessionCookieName(), "", {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/** The session id the request presents, or null (absent, or not shaped like one). */
export function presentedSessionId(request: RequestLike): string | null {
  const value = request.cookies.get(sessionCookieName())?.value;
  return value && SESSION_ID.test(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Audience and lifetimes
// ---------------------------------------------------------------------------

/**
 * Whose lifetimes apply: a guest's, a staff member's (any administrative permission) or a
 * user's. Permissions that cannot be read give the staff lifetimes — the shorter ones.
 */
async function audienceOf(kind: SessionKind, subject: string): Promise<SessionAudience> {
  if (kind === "guest") return "guest";
  try {
    const effective = await getCachedPermissions(subject);
    return effective?.permissions.some(isStaffPermission) ? "staff" : "user";
  } catch {
    return "staff";
  }
}

// ---------------------------------------------------------------------------
// Starting, rotating and ending
// ---------------------------------------------------------------------------

export interface StartedSession {
  readonly idHash: string;
  readonly csrfToken: string;
}

/**
 * Start a session for a completed sign-in and set its cookie on `response`. Always a new id: a
 * session id the request presented is ended, never reused (fixation). The request's tenant must
 * already be established (the route's rate limit does it).
 */
export async function startSession(
  request: RequestLike,
  response: CookieWriter,
  input: {
    readonly kind: SessionKind;
    readonly subject: string;
    readonly method: string;
    readonly tokens: SessionTokens;
  }
): Promise<StartedSession> {
  const store = getSessionStore();
  const now = Date.now();
  const presented = presentedSessionId(request);
  if (presented) {
    const old = await store.find(hashSessionId(presented));
    if (old && old.revokedAt === undefined) await endRecord(old, "rotated");
  }
  const id = newToken();
  const idHash = hashSessionId(id);
  const csrfToken = newToken();
  await store.open({
    idHash,
    kind: input.kind,
    subject: input.subject,
    method: input.method,
    csrfToken,
    sealedTokens: sealTokens(input.tokens, idHash),
    createdAt: now,
    lastSeenAt: now,
  });
  const lifetimes = await sessionLifetimes(await audienceOf(input.kind, input.subject));
  setSessionCookie(response, id, lifetimes.absoluteSeconds);
  return { idHash, csrfToken };
}

/** End one session: its record, then its refresh token at the provider. */
export async function endSession(
  session: { readonly record: SessionRecord },
  reason: RevocationReason
): Promise<boolean> {
  return endRecord(session.record, reason);
}

/**
 * Move a live session to a new id after a privilege change (a factor enrolled or removed): the
 * old id is ended, the new one set on `response`, and the user's other sessions ended.
 */
export async function rotateSession(
  response: CookieWriter,
  session: LiveSession,
  reason: RevocationReason
): Promise<StartedSession> {
  const store = getSessionStore();
  const id = newToken();
  const idHash = hashSessionId(id);
  const csrfToken = newToken();
  const now = Date.now();
  const current = (await store.find(session.idHash)) ?? session.record;
  await store.open({
    idHash,
    kind: current.kind,
    subject: current.subject,
    method: current.method,
    csrfToken,
    sealedTokens: resealFor(current.sealedTokens, current.idHash, idHash),
    // The absolute lifetime runs from the sign-in, not from the rotation.
    createdAt: current.createdAt,
    lastSeenAt: now,
  });
  // The old id is ended in the record only: its tokens are the new session's.
  await store.revoke(current.idHash, "rotated", now);
  await revokeSubjectSessions(current.subject, reason, { except: idHash });
  const remaining = Math.max(
    0,
    (sessionDeadlines(
      { createdAt: current.createdAt, lastSeenAt: now },
      session.lifetimes
    ).absoluteAt -
      now) /
      1000
  );
  setSessionCookie(response, id, remaining);
  return { idHash, csrfToken };
}

// ---------------------------------------------------------------------------
// Cross-site request forgery
// ---------------------------------------------------------------------------

function sameToken(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Resolving a request's session
// ---------------------------------------------------------------------------

export interface LiveSession {
  readonly idHash: string;
  readonly kind: SessionKind;
  readonly subject: string;
  readonly method: string;
  readonly csrfToken: string;
  readonly audience: SessionAudience;
  readonly lifetimes: SessionLifetimes;
  /** When the session ends by each limit, ms since the epoch (`idleAt` null: no idle limit). */
  readonly idleAt: number | null;
  readonly absoluteAt: number;
  /** The token that names the session's user or guest (verified by the caller). */
  readonly identityToken: string;
  readonly record: SessionRecord;
}

export type SessionResolution =
  | { readonly session: LiveSession; readonly error?: never }
  | {
      readonly session?: never;
      readonly error: NextResponse;
      /** Why: no cookie; an ended or unknown session; forgery checks; or a failure to answer. */
      readonly reason: "none" | "ended" | "forgery" | "unavailable";
    };

export interface ResolveOptions {
  /**
   * False for a read that must not count as use (the session's own status, which the console
   * polls to warn before an idle sign-out). Default true.
   */
  readonly touch?: boolean;
}

function ended(request: RequestLike): SessionResolution {
  const error = apiError("auth.token_invalid", { request });
  clearSessionCookie(error);
  error.headers.set("Cache-Control", "no-store");
  return { error, reason: "ended" };
}

function unavailable(
  request: RequestLike,
  what: string,
  err: unknown
): SessionResolution {
  logger.error("Session could not be resolved", {
    route: request.nextUrl.pathname,
    what,
    error: err instanceof Error ? err.message : String(err),
  });
  return {
    error: apiError("service.unavailable", { params: { service: "sessions" }, request }),
    reason: "unavailable",
  };
}

const renewing = new Map<string, Promise<"renewed" | "refused" | "unavailable">>();

/**
 * Renew a session's access token from its refresh token. Calls on one instance for one session
 * share one exchange; across instances each stores its result only when the token version is
 * still the one it read (the other's renewal is then used instead).
 */
async function renew(
  record: SessionRecord
): Promise<"renewed" | "refused" | "unavailable"> {
  const key = `${record.idHash}:${record.tokenVersion}`;
  let pending = renewing.get(key);
  if (!pending) {
    pending = (async () => {
      let refreshToken: string | null;
      try {
        refreshToken = openForProvider(record.sealedTokens, record.idHash, "renewal");
      } catch {
        return "refused" as const;
      }
      if (!refreshToken) return "refused" as const;
      initAuth();
      const outcome = await getAuthProvider().renewSession(refreshToken, record.subject);
      if (outcome.kind !== "renewed") return outcome.kind;
      const sealed = resealRenewed(record.sealedTokens, record.idHash, {
        accessToken: outcome.session.accessToken,
        refreshToken:
          outcome.session.refreshToken && outcome.session.refreshToken !== refreshToken
            ? outcome.session.refreshToken
            : undefined,
        expiresAt: outcome.session.expiresAt,
      });
      // Not stored when another request renewed first: its tokens are the session's.
      await getSessionStore().replaceTokens(record.idHash, record.tokenVersion, sealed);
      return "renewed" as const;
    })().finally(() => renewing.delete(key));
    renewing.set(key, pending);
  }
  return pending;
}

/**
 * The live session a request presents, checked in this order: the cookie; the record in the
 * request's tenant; not ended; within its idle and absolute lifetimes; for a state-changing
 * request, its origin and its session token; its tokens readable and — renewed if need be —
 * unexpired. Anything else is a coded refusal.
 */
export async function resolveSession(
  request: RequestLike,
  options: ResolveOptions = {}
): Promise<SessionResolution> {
  const id = presentedSessionId(request);
  if (!id) return { error: apiError("auth.required", { request }), reason: "none" };

  const bound = await ensureRequestTenant(request);
  if (bound.error) return { error: bound.error, reason: "unavailable" };

  const idHash = hashSessionId(id);
  const store = getSessionStore();
  let record: SessionRecord | null;
  try {
    record = await store.find(idHash);
  } catch (err) {
    return unavailable(request, "read", err);
  }
  // Unknown here: never issued, another tenant's, or deleted. Ended: revoked in the record.
  if (!record || record.revokedAt !== undefined) return ended(request);

  const audience = await audienceOf(record.kind, record.subject);
  const lifetimes = await sessionLifetimes(audience);
  const now = Date.now();
  const expiry = sessionExpiry(record, lifetimes, now);
  if (expiry) {
    try {
      await endRecord(record, expiry === "idle" ? "idle_timeout" : "absolute_timeout");
    } catch (err) {
      return unavailable(request, "expire", err);
    }
    return ended(request);
  }

  if (isStateChanging(request)) {
    const origin = requestOriginVerdict(request);
    if (
      origin !== "same" ||
      !sameToken(request.headers.get(CSRF_HEADER), record.csrfToken)
    ) {
      logger.warn("State-changing request refused: forgery check failed", {
        route: request.nextUrl.pathname,
        origin,
        token: request.headers.get(CSRF_HEADER) ? "wrong" : "absent",
      });
      return { error: apiError("auth.csrf_failed", { request }), reason: "forgery" };
    }
  }

  let identity: ReturnType<typeof openIdentity>;
  try {
    identity = openIdentity(record.sealedTokens, record.idHash);
    const nowSeconds = Math.floor(now / 1000);
    if (identity.expiresAt - nowSeconds <= RENEW_WITHIN_SECONDS) {
      if (!identity.renewable) {
        if (identity.expiresAt <= nowSeconds) {
          await endRecord(record, "absolute_timeout");
          return ended(request);
        }
      } else {
        let outcome: Awaited<ReturnType<typeof renew>>;
        try {
          outcome = await renew(record);
        } catch (err) {
          logger.warn("Session renewal failed", {
            route: request.nextUrl.pathname,
            error: err instanceof Error ? err.message : String(err),
          });
          outcome = "unavailable";
        }
        if (outcome === "refused") {
          await endRecord(record, "provider_refused");
          return ended(request);
        }
        if (outcome === "unavailable") {
          // The provider cannot answer: an unexpired token is still used; an expired one is not.
          if (identity.expiresAt <= nowSeconds) {
            return {
              error: apiError("service.unavailable", {
                params: { service: "auth" },
                request,
              }),
              reason: "unavailable",
            };
          }
        } else {
          const renewed = await store.find(idHash);
          if (!renewed || renewed.revokedAt !== undefined) return ended(request);
          record = renewed;
          identity = openIdentity(record.sealedTokens, record.idHash);
        }
      }
    }
  } catch (err) {
    if (err instanceof SessionVaultError) {
      // Sealed under a key this deployment no longer holds: the session cannot be used.
      logger.error("Session tokens could not be opened", {
        route: request.nextUrl.pathname,
        reason: err.reason,
      });
      if (err.reason === "no_key") return unavailable(request, "vault", err);
      try {
        await store.revoke(record.idHash, "unreadable", Date.now());
      } catch {
        // The refusal stands whether or not the record could be ended.
      }
      return ended(request);
    }
    return unavailable(request, "tokens", err);
  }

  let lastSeenAt = record.lastSeenAt;
  if (options.touch !== false && now - record.lastSeenAt >= TOUCH_EVERY_MS) {
    try {
      // False: ended since it was read (a sign-out on another request).
      if (!(await store.touch(idHash, now))) return ended(request);
      lastSeenAt = now;
    } catch (err) {
      return unavailable(request, "touch", err);
    }
  }
  const deadlines = sessionDeadlines(
    { createdAt: record.createdAt, lastSeenAt },
    lifetimes
  );
  return {
    session: {
      idHash,
      kind: record.kind,
      subject: record.subject,
      method: record.method,
      csrfToken: record.csrfToken,
      audience,
      lifetimes,
      idleAt: deadlines.idleAt,
      absoluteAt: deadlines.absoluteAt,
      identityToken: identity.token,
      record,
    },
  };
}

/** Use the session now (the "stay signed in" action): its idle limit starts again. */
export async function keepAlive(session: LiveSession): Promise<LiveSession> {
  const now = Date.now();
  await getSessionStore().touch(session.idHash, now);
  const deadlines = sessionDeadlines(
    { createdAt: session.record.createdAt, lastSeenAt: now },
    session.lifetimes
  );
  return { ...session, idleAt: deadlines.idleAt, absoluteAt: deadlines.absoluteAt };
}

/** The access token of a user's session for enrolling an authenticator app — its one provider use. */
export function totpEnrolmentToken(session: LiveSession): string | null {
  return openForProvider(session.record.sealedTokens, session.idHash, "totp_enrolment");
}

// ── TASK-181: the refusals this module can return (read by __tests__/refusal-coverage.test.ts) ──
export const SESSION_REFUSAL_CODES = [
  "auth.required",
  "auth.token_invalid",
  "auth.csrf_failed",
  "service.unavailable",
] as const satisfies readonly ErrorCode[];
