/**
 * platform/jobs/tick-auth.ts — who may make the job runner work (ADR-056 D2)
 *
 * The tick route is called by the host's scheduler, not by a user: Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`, and the CLI worker (scripts/jobs-worker.mjs) sends the
 * same. requireJobTick admits exactly that header and nothing else:
 *
 *   - CRON_SECRET unset, or shorter than 32 characters → 503 service.unavailable (in every
 *     environment: an unauthenticated tick is never accepted, so a deployment that forgets the
 *     secret runs no jobs and says so, rather than letting anyone run them);
 *   - no Authorization header → 401 auth.required;
 *   - any other value → 401 auth.token_invalid.
 *
 * The comparison is of SHA-256 digests with timingSafeEqual: equal length always, and no early
 * exit, so the time taken says nothing about how much of a guess was right.
 *
 * @module platform/jobs
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { apiError } from "@/platform/errors";
import { getCronSecret } from "@/platform/providers/environment-contract";

/** The shortest secret accepted (the environment contract's shape requires the same). */
export const MIN_SECRET_LENGTH = 32;

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Whether `header` is exactly `Bearer <secret>`. Constant time in the guess. */
export function tickHeaderMatches(header: string, secret: string): boolean {
  const m = /^Bearer (\S+)$/.exec(header);
  const presented = m ? m[1] : "";
  // Compared even when the header is malformed, so a malformed one takes as long as a wrong one.
  const same = timingSafeEqual(digest(presented), digest(secret));
  return m !== null && same;
}

/**
 * Verify the caller of an internal tick. Returns null when admitted, else the error response.
 */
export function requireJobTick(request: { headers: Headers }): NextResponse | null {
  const secret = getCronSecret();
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    logger.error(
      "Job tick refused: CRON_SECRET is not set (or is shorter than 32 characters) — no job runs until it is",
      { route: "/api/internal/jobs/tick", status: 503 }
    );
    return apiError("service.unavailable", { params: { service: "jobs" }, request });
  }
  const header = request.headers.get("authorization");
  if (!header) return apiError("auth.required", { request });
  if (!tickHeaderMatches(header, secret)) {
    logger.warn("Job tick refused: wrong credentials", {
      route: "/api/internal/jobs/tick",
      status: 401,
    });
    return apiError("auth.token_invalid", { request });
  }
  return null;
}
