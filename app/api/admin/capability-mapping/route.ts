/**
 * app/api/admin/capability-mapping/route.ts — GET the capability→feature map (Sprint 3c U3).
 *
 * Read view for the governance panel. Mutations flow through the AI plan → confirm → execute
 * path (handlers/mapping.ts), not this route.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { getConfig } from "@/platform/auth/platform-config";

export async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_config");
  if (denied) return denied;

  const pairs = await getConfig<[string, string[]][]>("agent.capability_features", []);
  return NextResponse.json({ mappings: Array.isArray(pairs) ? pairs : [] });
}
