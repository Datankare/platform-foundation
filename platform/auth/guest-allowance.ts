/**
 * platform/auth/guest-allowance.ts — The governed guest translate allowance (ADR-050 D4, TASK-099)
 *
 * A guest may make `guest.translate_allowance` translate requests (governed, 1–10, default 5)
 * before signing in. Routes that serve guests call {@link enforceGuestAllowance} after cheap
 * validation and before any paid call; a user actor is never limited here.
 *
 * Usage is counted in a GuestUsageStore, per tenant (ADR-053). The Postgres store consumes
 * atomically in the database (guest_allowance_consume, migration 037; it runs as the caller,
 * under row-level security, in the request's tenant), so concurrent requests cannot overshoot.
 * The memory store keeps each tenant's counts apart the same way; it is for tests and local
 * work, and production refuses it (ADR-048 D3 pattern, see the provider registry).
 *
 * A guest token is free to mint (20 an hour from one address), so an allowance per token alone
 * was 100 paid requests an hour per address, and a banned user could carry on as a stream of
 * new guests (audit A-6, X-20). Guests' paid requests are also counted per address bucket
 * (GUEST_PAID_PER_ADDRESS: 20 a day; an IPv6 client per /64), whichever token they carry; and
 * the guest route refuses a new guest token to a browser whose account is restricted.
 *
 * @module platform/auth
 */

import type { NextResponse } from "next/server";
import { getConfig } from "@/platform/auth/platform-config";
import { isGuestId } from "@/platform/auth/guest-token";
import type { Actor } from "@/platform/auth/middleware";
import { apiError, internalError } from "@/platform/errors";
import { logger } from "@/lib/logger";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";
import { withTenantTx } from "@/platform/data";
import { TenantPartitionedMap } from "@/platform/tenancy/partition";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import type { ErrorCode } from "@/platform/errors/registry";

export const GUEST_ALLOWANCE_KEY = "guest.translate_allowance";
export const GUEST_ALLOWANCE_MIN = 1;
export const GUEST_ALLOWANCE_DEFAULT = 5;
export const GUEST_ALLOWANCE_MAX = 10;

/** The governed allowance, clamped to [1, 10] whatever the config row says. */
export async function getGuestTranslateAllowance(): Promise<number> {
  let raw: unknown;
  try {
    raw = await getConfig<unknown>(GUEST_ALLOWANCE_KEY, GUEST_ALLOWANCE_DEFAULT);
  } catch (err) {
    logger.warn("Guest allowance config unreadable — using the default", {
      error: err instanceof Error ? err.message : String(err),
    });
    raw = GUEST_ALLOWANCE_DEFAULT;
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return GUEST_ALLOWANCE_DEFAULT;
  return Math.min(GUEST_ALLOWANCE_MAX, Math.max(GUEST_ALLOWANCE_MIN, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface GuestConsumeResult {
  /** True when this request was counted (the guest was under the limit). */
  allowed: boolean;
  /** Translations used after this request (or at refusal). */
  used: number;
}

export interface GuestUsageStore {
  consume(guestId: string, limit: number): Promise<GuestConsumeResult>;
  used(guestId: string): Promise<number>;
  reset(): Promise<void>;
}

export class MemoryGuestUsageStore implements GuestUsageStore {
  private readonly counts = new TenantPartitionedMap<string, number>();

  async consume(guestId: string, limit: number): Promise<GuestConsumeResult> {
    // Synchronous read-modify-write: no await between check and set, so concurrent calls on
    // one process cannot both take the last unit.
    const counts = this.counts.current();
    const current = counts.get(guestId) ?? 0;
    if (current >= limit) return { allowed: false, used: current };
    counts.set(guestId, current + 1);
    return { allowed: true, used: current + 1 };
  }

  async used(guestId: string): Promise<number> {
    return this.counts.current().get(guestId) ?? 0;
  }

  /** Forget the current tenant's counts. */
  async reset(): Promise<void> {
    this.counts.current().clear();
  }
}

interface ConsumeRow {
  allowed: boolean;
  used: number;
}

/** GuestUsageStore on Postgres through platform/data, in the request's tenant. */
export class PostgresGuestUsageStore implements GuestUsageStore {
  async consume(guestId: string, limit: number): Promise<GuestConsumeResult> {
    const { rows } = await withTenantTx((tx) =>
      tx.query<ConsumeRow>("select allowed, used from guest_allowance_consume($1, $2)", [
        guestId,
        limit,
      ])
    );
    const row = rows[0];
    if (!row || typeof row.allowed !== "boolean") {
      throw new Error("guest allowance consume returned no row");
    }
    return { allowed: row.allowed, used: Number(row.used) || 0 };
  }

  async used(guestId: string): Promise<number> {
    const { rows } = await withTenantTx((tx) =>
      tx.query<{ translations_used: number }>(
        "select translations_used from guest_usage where guest_id = $1",
        [guestId]
      )
    );
    return rows[0]?.translations_used ?? 0;
  }

  /** Forget this tenant's counts (tests and operator resets). Never another tenant's. */
  async reset(): Promise<void> {
    await withTenantTx((tx) => tx.query("delete from guest_usage"));
  }
}

const STORE_KEY = "platform.auth.guestUsageStore";

export function getGuestUsageStore(): GuestUsageStore {
  return getSingleton<GuestUsageStore>(STORE_KEY, () => new MemoryGuestUsageStore());
}

export function setGuestUsageStore(store: GuestUsageStore): void {
  setSingleton(STORE_KEY, store);
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

export type GuestAllowanceOutcome =
  | { readonly error: NextResponse; readonly remaining?: never }
  | { readonly error?: never; readonly remaining: number | null };

/**
 * Count one translate request against a guest's allowance. Returns `{ remaining }` (null for a
 * user — not limited) or `{ error }`: `guest.allowance_exhausted` at the limit, or a logged
 * `internal.error` if the store fails — fail closed: a paid call is never made uncounted.
 */
export async function enforceGuestAllowance(
  actor: Actor,
  options: { request?: { headers: Headers; nextUrl?: { pathname: string } } } = {}
): Promise<GuestAllowanceOutcome> {
  if (actor.kind !== "guest") return { remaining: null };
  if (!isGuestId(actor.id)) {
    // requireActor only yields namespaced guest ids; anything else is a platform bug.
    return { error: apiError("auth.guest_invalid", { request: options.request }) };
  }

  const limit = await getGuestTranslateAllowance();
  // Per address first, whatever token it carries: a request with no address to count is
  // refused (fail closed — a paid call is never made uncounted).
  if (!options.request) {
    return { error: apiError("guest.allowance_exhausted", { params: { limit } }) };
  }
  const perAddress = await enforceRateLimit(
    options.request,
    DEFAULT_RULES.GUEST_PAID_PER_ADDRESS
  );
  if (perAddress) {
    if (perAddress.status !== 429) return { error: perAddress };
    logger.info("Guest paid requests from this address exhausted", { limit });
    return {
      error: apiError("guest.allowance_exhausted", {
        params: { limit },
        request: options.request,
      }),
    };
  }
  try {
    const { allowed, used } = await getGuestUsageStore().consume(actor.id, limit);
    if (!allowed) {
      logger.info("Guest translate allowance exhausted", { guestId: actor.id, limit });
      return {
        error: apiError("guest.allowance_exhausted", {
          params: { limit },
          request: options.request,
        }),
      };
    }
    return { remaining: Math.max(0, limit - used) };
  } catch (err) {
    return {
      error: internalError(err, {
        request: options.request,
        context: "Guest allowance check failed",
      }),
    };
  }
}

// ── TASK-181: the refusals this guard can return ─────────────────────────────────────────────
// Read by __tests__/refusal-coverage.test.ts: each route that calls a guard named here can
// return its codes, and every screen calling that route must handle each one. The test also
// checks this module's own apiError literals are all listed.

/** What counting a guest's paid turn can refuse with. */
export const GUEST_ALLOWANCE_REFUSAL_CODES = [
  "auth.guest_invalid",
  "guest.allowance_exhausted",
  "internal.error",
] as const satisfies readonly ErrorCode[];

export const REFUSAL_GUARDS: Readonly<Record<string, readonly ErrorCode[]>> = {
  enforceGuestAllowance: GUEST_ALLOWANCE_REFUSAL_CODES,
};
