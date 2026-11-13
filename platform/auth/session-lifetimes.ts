/**
 * platform/auth/session-lifetimes.ts — how long a sign-in session lasts (ADR-057 D5, TASK-214)
 *
 * Two limits, both governed (safety tier, migration 070) and both clamped here to safe bounds
 * whatever a row says:
 *
 *   idle       the session ends when no request has used it for this long;
 *   absolute   the session ends this long after sign-in, however it is used.
 *
 *                 idle (default)        absolute (default)
 *   user          7 days                30 days
 *   staff         30 minutes            12 hours     (anyone holding an administrative permission)
 *   guest         none                  24 hours
 *
 * Bounds: idle 15 minutes to 30 days; absolute 1 hour to 90 days. A setting that cannot be read
 * falls back to the default — never to "no limit". The idle and absolute limits follow OWASP's
 * "Session Management Cheat Sheet" (Session Expiration: idle timeout, absolute timeout; shorter
 * for high-value applications), credited in ADR-057.
 *
 * @module platform/auth
 */

import { getConfigNumber } from "@/platform/auth/platform-config";

export type SessionAudience = "user" | "staff" | "guest";

export const IDLE_MIN_SECONDS = 15 * 60;
export const IDLE_MAX_SECONDS = 30 * 24 * 3600;
export const ABSOLUTE_MIN_SECONDS = 3600;
export const ABSOLUTE_MAX_SECONDS = 90 * 24 * 3600;

export const SESSION_LIFETIME_KEYS = {
  userIdle: "auth.session.user_idle_seconds",
  userAbsolute: "auth.session.user_absolute_seconds",
  staffIdle: "auth.session.staff_idle_seconds",
  staffAbsolute: "auth.session.staff_absolute_seconds",
  guestAbsolute: "auth.session.guest_absolute_seconds",
} as const;

export const SESSION_LIFETIME_DEFAULTS = {
  userIdle: 7 * 24 * 3600,
  userAbsolute: 30 * 24 * 3600,
  staffIdle: 30 * 60,
  staffAbsolute: 12 * 3600,
  guestAbsolute: 24 * 3600,
} as const;

/** How long before an idle sign-out a staff member is warned (the console's notice). */
export const STAFF_IDLE_WARNING_SECONDS = 120;

export interface SessionLifetimes {
  /** Seconds without a request before the session ends; null: no idle limit (a guest). */
  readonly idleSeconds: number | null;
  /** Seconds from sign-in before the session ends. */
  readonly absoluteSeconds: number;
}

const clamp = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.min(max, Math.max(min, Math.floor(v)))
    : fallback;

async function read(key: string, fallback: number): Promise<unknown> {
  try {
    return await getConfigNumber(key, fallback);
  } catch {
    return fallback;
  }
}

/** The governed lifetimes for an audience, clamped. */
export async function sessionLifetimes(
  audience: SessionAudience
): Promise<SessionLifetimes> {
  const K = SESSION_LIFETIME_KEYS;
  const D = SESSION_LIFETIME_DEFAULTS;
  if (audience === "guest") {
    return {
      idleSeconds: null,
      absoluteSeconds: clamp(
        await read(K.guestAbsolute, D.guestAbsolute),
        D.guestAbsolute,
        ABSOLUTE_MIN_SECONDS,
        ABSOLUTE_MAX_SECONDS
      ),
    };
  }
  const staff = audience === "staff";
  const [idle, absolute] = await Promise.all([
    read(staff ? K.staffIdle : K.userIdle, staff ? D.staffIdle : D.userIdle),
    read(
      staff ? K.staffAbsolute : K.userAbsolute,
      staff ? D.staffAbsolute : D.userAbsolute
    ),
  ]);
  return {
    idleSeconds: clamp(
      idle,
      staff ? D.staffIdle : D.userIdle,
      IDLE_MIN_SECONDS,
      IDLE_MAX_SECONDS
    ),
    absoluteSeconds: clamp(
      absolute,
      staff ? D.staffAbsolute : D.userAbsolute,
      ABSOLUTE_MIN_SECONDS,
      ABSOLUTE_MAX_SECONDS
    ),
  };
}

export interface SessionClock {
  /** When the session was created and last used, ms since the epoch. */
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

/** When a session ends by each limit (ms since the epoch); `idleAt` null without an idle limit. */
export function sessionDeadlines(
  clock: SessionClock,
  lifetimes: SessionLifetimes
): { readonly idleAt: number | null; readonly absoluteAt: number } {
  return {
    idleAt:
      lifetimes.idleSeconds === null
        ? null
        : clock.lastSeenAt + lifetimes.idleSeconds * 1000,
    absoluteAt: clock.createdAt + lifetimes.absoluteSeconds * 1000,
  };
}

/** Why a session has ended at `now`, or null while it is live. */
export function sessionExpiry(
  clock: SessionClock,
  lifetimes: SessionLifetimes,
  now: number
): "idle" | "absolute" | null {
  const { idleAt, absoluteAt } = sessionDeadlines(clock, lifetimes);
  if (now >= absoluteAt) return "absolute";
  if (idleAt !== null && now >= idleAt) return "idle";
  return null;
}
