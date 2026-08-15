/**
 * app/api/agent/capabilities/route.ts — Agent capability discovery (ADR-030 D8)
 *
 * GET: enumerate the goals an agent can invoke, their steps and estimated cost, and the
 * resolved provider selections. Unauthenticated by design — this is the machine-readable
 * form of the goal vocabulary, the counterpart to a public OpenAPI document.
 *
 * The logic is in platform/agents/capabilities.ts (buildCapabilities), kept out of the
 * route so it is unit-tested there. This file only resolves the live inputs and serialises.
 *
 * OWASP A05: the payload carries provider NAMES only (getActiveProviders returns the
 * selection map, not credentials). It runs no health probe — see the module header and
 * TASK-086 for why liveness is /api/health's job, not this endpoint's.
 */

import { NextResponse } from "next/server";
import { logger, generateRequestId } from "@/lib/logger";
import { getActiveProviders } from "@/platform/providers/registry";
import { listWorkflows, buildCapabilities } from "@/platform/agents";

export async function GET() {
  const requestId = generateRequestId();

  const capabilities = buildCapabilities(
    listWorkflows(),
    getActiveProviders() as unknown as Record<string, string>
  );

  logger.info("Agent capabilities", {
    requestId,
    route: "/api/agent/capabilities",
    goalCount: capabilities.goals.length,
  });

  return NextResponse.json({ requestId, ...capabilities });
}
