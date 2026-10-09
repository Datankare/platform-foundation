/**
 * platform/auth/guest-allowance.ts — The governed guest translate allowance (ADR-050 D4, TASK-099)
 *
 * A guest may make `guest.translate_allowance` translate requests (governed, 1–10, default 5)
 * before signing in. Routes that serve guests call {@link enforceGuestAllowance} after cheap
 * validation and before any paid call; a user actor is never limited here.
 *
 * Usage is counted in a GuestUsageStore. The Supabase store consumes atomically in the
 * database (guest_allowance_consume, migration 037), so concurrent requests cannot overshoot.
 * The memory store is for tests and local work; production refuses it (ADR-048 D3 pattern,
 * see the provider registry).
 *
 * @module platform/auth
 */

import type { NextResponse } from "next/server";
import { getConfig } from "@/platform/auth/platform-config";
import { isGuestId } from "@/platform/auth/guest-token";
import type { Actor } from "@/platform/auth/middleware";
import { apiError, internalError } from "@/platform/errors";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { logger } from "@/lib/logger";
import { getSingleton, setSingleton } from "@/platform/kernel/singleton";

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
  private readonly counts = new Map<string, number>();

  async consume(guestId: string, limit: number): Promise<GuestConsumeResult> {
    // Synchronous read-modify-write: no await between check and set, so concurrent calls on
    // one process cannot both take the last unit.
    const current = this.counts.get(guestId) ?? 0;
    if (current >= limit) return { allowed: false, used: current };
    this.counts.set(guestId, current + 1);
    return { allowed: true, used: current + 1 };
  }

  async used(guestId: string): Promise<number> {
    return this.counts.get(guestId) ?? 0;
  }

  async reset(): Promise<void> {
    this.counts.clear();
  }
}

interface ConsumeRow {
  allowed: boolean;
  used: number;
}

export class SupabaseGuestUsageStore implements GuestUsageStore {
  private readonly url: string;
  private readonly key: string;

  constructor(url: string, serviceKey: string) {
    this.url = url.replace(/\/+$/, "");
    this.key = serviceKey;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
    };
  }

  async consume(guestId: string, limit: number): Promise<GuestConsumeResult> {
    const res = await fetchWithTimeout(
      `${this.url}/rest/v1/rpc/guest_allowance_consume`,
      {
        timeoutMs: 10_000,
        // Never retried underneath: a retried consume could count one request twice.
        maxRetries: 0,
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ p_guest_id: guestId, p_limit: limit }),
      }
    );
    if (!res.ok) {
      throw new Error(
        `guest allowance consume failed (${res.status}): ${await res.text()}`
      );
    }
    const payload = (await res.json()) as ConsumeRow[] | ConsumeRow;
    const row = Array.isArray(payload) ? payload[0] : payload;
    if (!row || typeof row.allowed !== "boolean") {
      throw new Error("guest allowance consume returned no row");
    }
    return { allowed: row.allowed, used: Number(row.used) || 0 };
  }

  async used(guestId: string): Promise<number> {
    const res = await fetchWithTimeout(
      `${this.url}/rest/v1/guest_usage?guest_id=eq.${encodeURIComponent(guestId)}&select=translations_used`,
      { timeoutMs: 10_000, maxRetries: 1, method: "GET", headers: this.headers() }
    );
    if (!res.ok) {
      throw new Error(`guest allowance read failed (${res.status}): ${await res.text()}`);
    }
    const rows = (await res.json()) as Array<{ translations_used: number }>;
    return rows[0]?.translations_used ?? 0;
  }

  async reset(): Promise<void> {
    // translations_used is NOT NULL, so this matches every row; PostgREST refuses an
    // unfiltered DELETE, a guard worth keeping.
    const res = await fetchWithTimeout(
      `${this.url}/rest/v1/guest_usage?translations_used=gte.0`,
      { timeoutMs: 10_000, maxRetries: 0, method: "DELETE", headers: this.headers() }
    );
    if (!res.ok) {
      throw new Error(
        `guest allowance reset failed (${res.status}): ${await res.text()}`
      );
    }
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
