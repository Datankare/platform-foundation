/**
 * platform/rate-limit/daily-quota.ts — a daily cap on paid requests per actor (audit X-12)
 *
 * The per-minute AI limit (20/min) bounds bursts, not spend: one account could make ~28,800
 * paid requests a day. Every route that makes a paid provider call (model, translation, speech,
 * song identification) calls enforceDailyPaidQuota after verifying the actor and before its
 * first paid call, so each user or guest has a bounded number of paid requests per rolling 24
 * hours, counted in the shared limiter store. The cap is governed config
 * (`ai.daily_paid_requests_per_actor`, migration 044); if it cannot be read the built-in
 * default applies, never "unlimited".
 *
 * The unit is a paid REQUEST, not a provider call: one request may make several calls (a
 * translation request: the safety check, then a translation and speech per language; a stream:
 * the safety check, the model, and an output screen per window). The bound on calls is the cap
 * times the route's own per-request bound. A per-user dollar budget, weighted by each call's
 * cost, needs per-call cost records (TASK-113).
 *
 * @module platform/rate-limit
 */

import type { NextResponse } from "next/server";
import { getConfig } from "@/platform/auth/platform-config";
import { enforceRateLimit } from "./enforce";
import type { RateLimitRule } from "./types";

/** The governed setting, and the cap used when it is missing or invalid. */
export const DAILY_PAID_QUOTA_KEY = "ai.daily_paid_requests_per_actor";
export const DEFAULT_DAILY_PAID_QUOTA = 200;
const MAX_DAILY_PAID_QUOTA = 10_000;

/** The current cap: the governed value when it is a sane integer, else the default. */
export async function dailyPaidQuota(): Promise<number> {
  let value: unknown;
  try {
    value = await getConfig<unknown>(DAILY_PAID_QUOTA_KEY, DEFAULT_DAILY_PAID_QUOTA);
  } catch {
    return DEFAULT_DAILY_PAID_QUOTA;
  }
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_DAILY_PAID_QUOTA
    ? value
    : DEFAULT_DAILY_PAID_QUOTA;
}

interface RequestLike {
  readonly headers: Headers;
  readonly nextUrl?: { readonly pathname: string };
}

/**
 * Count one paid call against the actor's daily quota. Returns a 429 response when the quota is
 * spent (or 503 when the limiter's store fails — fail closed), otherwise null.
 */
export async function enforceDailyPaidQuota(
  request: RequestLike,
  actorId: string
): Promise<NextResponse | null> {
  const rule: RateLimitRule = {
    id: "ai:daily-paid",
    maxRequests: await dailyPaidQuota(),
    windowSeconds: 86_400,
  };
  return enforceRateLimit(request, rule, { actorId });
}
