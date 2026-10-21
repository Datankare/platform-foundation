/**
 * platform/rate-limit/enforce.ts — one call to rate-limit a route (ADR-052)
 *
 * Every API route calls enforceRateLimit (or adminGuard, which does) before any work; a CI test
 * (__tests__/api-route-rate-limit.test.ts) fails any route that does not, unless it is listed as
 * exempt with a reason.
 *
 *   - Over the limit: 429 `rate.limited` with Retry-After and X-RateLimit-* headers.
 *   - The limiter's store fails: 503 `service.unavailable` — fail closed. Protection against
 *     abuse must not disappear silently when its store does (ADR-052 D4).
 *
 * The caller is identified by its verified actor id when the route has one (after
 * verification), otherwise by its network address.
 *
 * @module platform/rate-limit
 */

import type { NextResponse } from "next/server";
import { apiError } from "@/platform/errors";
import { logger } from "@/lib/logger";
import { getRateLimiter } from "./factory";
import { getClientIp } from "./client-ip";
import type { RateLimitRule } from "./types";

/** Who a limit is counted against. Omit (or pass {}) to count by network address. */
export interface RateLimitSubject {
  /** A verified actor id (user or guest). Never a value taken from the request body. */
  readonly actorId?: string;
}

interface RequestLike {
  readonly headers: Headers;
  readonly nextUrl?: { readonly pathname: string };
}

export async function enforceRateLimit(
  request: RequestLike,
  rule: RateLimitRule,
  subject: RateLimitSubject = {}
): Promise<NextResponse | null> {
  const identifier = subject.actorId
    ? `actor:${subject.actorId}`
    : `ip:${getClientIp(request)}`;
  const route = request.nextUrl?.pathname;

  let result;
  try {
    result = await getRateLimiter().check(identifier, rule);
  } catch (err) {
    logger.error("Rate limiter unavailable — refusing the request (fail closed)", {
      rule: rule.id,
      route,
      error: err instanceof Error ? err.message : String(err),
    });
    return apiError("service.unavailable", {
      params: { service: "rate_limit" },
      request,
    });
  }

  if (result.allowed) return null;

  logger.warn("Rate limit exceeded", { rule: rule.id, identifier, route });
  return apiError("rate.limited", {
    params: { retryAfterSeconds: result.retryAfterSeconds },
    request,
    headers: {
      "X-RateLimit-Limit": String(result.limit),
      "X-RateLimit-Remaining": String(result.remaining),
      "X-RateLimit-Reset": String(result.resetAt),
    },
  });
}
