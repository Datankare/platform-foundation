/**
 * app/api/agent/capabilities/route.ts — Agent capability discovery (ADR-030 D8)
 *
 * GET: enumerate the goals an agent can invoke, their steps and estimated cost, and the
 * providers that do their work. For a verified caller — a signed-in user or a guest (audit I-7:
 * it was documented as public, yet the proxy asked for a bearer and nothing verified it) — and
 * never the platform's plumbing (stores, cache, limiter: audit C-21).
 *
 * The logic is in platform/agents/capabilities.ts (buildCapabilities), kept out of the
 * route so it is unit-tested there. This file only resolves the live inputs and serialises.
 *
 * OWASP A05: the payload carries provider NAMES only (getActiveProviders returns the
 * selection map, not credentials). It runs no health probe — see the module header and
 * TASK-086 for why liveness is /api/health's job, not this endpoint's.
 */

import { NextResponse, type NextRequest } from "next/server";
import { logger, generateRequestId } from "@/lib/logger";
import { getActiveProviders } from "@/platform/providers/registry";
import { listWorkflows, buildCapabilities } from "@/platform/agents";
import { capabilitySelections } from "@/platform/agents/capabilities";
import { requireActor } from "@/platform/auth/middleware";
import { DEFAULT_RULES, enforceRateLimit } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";

export const GET = tenantRoute(async function GET(request: NextRequest) {
  // ADR-052: rate limited before any work.
  const limited = await enforceRateLimit(request, DEFAULT_RULES.API_GLOBAL);
  if (limited) return limited;
  const caller = await requireActor(request, { allowGuests: true });
  if (caller.error) return caller.error;
  const requestId = generateRequestId();

  const capabilities = buildCapabilities(
    listWorkflows(),
    capabilitySelections(getActiveProviders() as unknown as Record<string, string>)
  );

  logger.info("Agent capabilities", {
    requestId,
    route: "/api/agent/capabilities",
    goalCount: capabilities.goals.length,
  });

  return NextResponse.json({ requestId, ...capabilities });
});
