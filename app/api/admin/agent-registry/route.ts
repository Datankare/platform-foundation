/**
 * app/api/admin/agent-registry/route.ts — GET the trusted-agent registry state (Sprint 3c U4).
 *
 * Read-only view for the governance panel. Returns the current agent.trusted_agents config as
 * an ordered [agentId, record] list. Mutations flow through the AI plan → confirm → execute
 * path (handlers/agents.ts), not this route.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { getConfig } from "@/platform/auth/platform-config";

export async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_agents");
  if (denied) return denied;

  const agents = await getConfig<[string, unknown][]>("agent.trusted_agents", []);
  return NextResponse.json({ agents: Array.isArray(agents) ? agents : [] });
}
