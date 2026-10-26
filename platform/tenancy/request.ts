/**
 * platform/tenancy/request.ts — establishing a request's tenant (ADR-053 D2, D3)
 *
 * Two entry points, both called by platform code every route already runs:
 *
 *   ensureRequestTenant(request)    — from the rate limiter, the first thing every route does
 *                                     (ADR-052): the tenant the address serves, before anyone
 *                                     is verified, so even refused requests are counted per
 *                                     tenant. A no-op when the request already has one.
 *   bindIdentityTenant(claimed, …)  — from the verifiers: the verified identity's tenant, which
 *                                     must agree with the one already established.
 *
 * Each enters the tenant for the rest of the request (enterTenant). A refusal is a coded
 * response; a directory that cannot be read is "unavailable" (503) — never a guess, never the
 * default tenant.
 *
 * @module platform/tenancy
 */

import type { NextResponse } from "next/server";
import { apiError } from "@/platform/errors";
import { logger } from "@/lib/logger";
import { enterTenant, peekTenant, type TenantContext } from "./context";
import { resolveAnonymous, resolveForIdentity, type ResolveOptions } from "./resolve";
import type { ErrorCode } from "@/platform/errors/registry";

interface RequestLike {
  readonly headers: Headers;
}

export type TenantBinding =
  | { readonly tenant: TenantContext; readonly error?: never }
  | { readonly tenant?: never; readonly error: NextResponse };

function unavailable(request: RequestLike, err: unknown): NextResponse {
  logger.error("Tenant directory could not be read", {
    route: "platform/tenancy/request",
    error: err instanceof Error ? err.message : String(err),
  });
  return apiError("service.unavailable", { params: { service: "tenants" }, request });
}

/** The request's tenant from its address, entered for the rest of the request. */
export async function ensureRequestTenant(
  request: RequestLike,
  options: ResolveOptions = {}
): Promise<TenantBinding> {
  const present = peekTenant();
  if (present) return { tenant: present };
  let resolution: Awaited<ReturnType<typeof resolveAnonymous>>;
  try {
    resolution = await resolveAnonymous(request, options);
  } catch (err) {
    return { error: unavailable(request, err) };
  }
  if (!resolution.ok) {
    logger.warn("Request refused: no tenant for its address", {
      code: resolution.code,
      reason: resolution.reason,
    });
    return { error: apiError(resolution.code, { request }) };
  }
  return { tenant: enterTenant(resolution.context) };
}

/**
 * The verified identity's tenant (`claimed`: what its token says, undefined for nothing),
 * entered for the rest of the request. Refused when it disagrees with the tenant the request
 * already has.
 */
export async function bindIdentityTenant(
  claimed: string | undefined,
  request: RequestLike,
  options: ResolveOptions = {}
): Promise<TenantBinding> {
  let resolution: Awaited<ReturnType<typeof resolveForIdentity>>;
  try {
    resolution = await resolveForIdentity(claimed, request, options);
  } catch (err) {
    return { error: unavailable(request, err) };
  }
  if (!resolution.ok) {
    logger.warn("Identity refused for its tenant", {
      code: resolution.code,
      reason: resolution.reason,
    });
    return { error: apiError(resolution.code, { request }) };
  }
  const present = peekTenant();
  if (
    present &&
    (present.tenantId !== resolution.context.tenantId ||
      present.mode !== resolution.context.mode)
  ) {
    logger.warn("Identity refused: its tenant is not the request's", {});
    return { error: apiError("tenant.mismatch", { request }) };
  }
  return { tenant: present ?? enterTenant(resolution.context) };
}

// ── TASK-181: the refusals this guard can return ─────────────────────────────────────────────
// Read by __tests__/refusal-coverage.test.ts: each route that calls a guard named here can
// return its codes, and every screen calling that route must handle each one. The test also
// checks this module's own apiError literals are all listed.

/** What establishing a request's tenant can refuse with (ensureRequestTenant, bindIdentityTenant). */
export const TENANCY_REFUSAL_CODES = [
  "tenant.mismatch",
  "tenant.missing",
  "tenant.suspended",
  "tenant.unknown_host",
  "service.unavailable",
] as const satisfies readonly ErrorCode[];

export const REFUSAL_GUARDS: Readonly<Record<string, readonly ErrorCode[]>> = {
  ensureRequestTenant: TENANCY_REFUSAL_CODES,
  bindIdentityTenant: TENANCY_REFUSAL_CODES,
};
