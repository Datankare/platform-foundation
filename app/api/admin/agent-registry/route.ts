/**
 * app/api/admin/agent-registry/route.ts — GET the trusted-agent registry state (Sprint 3c U4).
 *
 * Read-only view for the governance panel. Returns the current agent.trusted_agents config as
 * an ordered [agentId, record] list. Mutations flow through the AI plan → confirm → execute
 * path (handlers/agents.ts), not this route. Read fail closed (review 13 P): 503 when the
 * registry cannot be read — or is not well formed (review 14 L-1), never an empty list.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import {
  isWellFormedTrustedAgents,
  readTrustedAgents,
} from "@/platform/agents/governed-agent-config";
import { logger } from "@/lib/logger";
import { apiError } from "@/platform/errors";
import { tenantRoute } from "@/platform/tenancy/route";

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_agents");
  if (denied) return denied;

  // Fail closed (review 13 P): a registry that cannot be read is answered 503, never shown empty.
  let agents: unknown;
  try {
    agents = await readTrustedAgents();
  } catch {
    return apiError("service.unavailable", { params: { service: "config" }, request });
  }
  // A stored value that is not well formed is not an empty registry (review 14 L-1): it could not be
  // read as one, so it is answered as unreadable — the panel says so, never "none".
  if (!isWellFormedTrustedAgents(agents)) {
    logger.error("The stored registry is malformed; answered as unavailable", {
      route: "app/api/admin/agent-registry",
    });
    return apiError("service.unavailable", { params: { service: "config" }, request });
  }
  return NextResponse.json({ agents: agents });
});
