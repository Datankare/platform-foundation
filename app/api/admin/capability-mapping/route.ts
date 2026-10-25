/**
 * app/api/admin/capability-mapping/route.ts — GET the capability→feature map (Sprint 3c U3).
 *
 * Read view for the governance panel. Mutations flow through the AI plan → confirm → execute
 * path (handlers/mapping.ts), not this route. Read fail closed (review 13 P): 503 when the map
 * cannot be read — or is not well formed (review 14 L-1), never an empty list.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import {
  isWellFormedCapabilityMap,
  readCapabilityFeatures,
} from "@/platform/agents/governed-agent-config";
import { logger } from "@/lib/logger";
import { apiError } from "@/platform/errors";
import { tenantRoute } from "@/platform/tenancy/route";

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_config");
  if (denied) return denied;

  // Fail closed (review 13 P): a map that cannot be read is answered 503, never shown as empty.
  let pairs: unknown;
  try {
    pairs = await readCapabilityFeatures();
  } catch {
    return apiError("service.unavailable", { params: { service: "config" }, request });
  }
  // A stored value that is not well formed is not an empty map (review 14 L-1): it could not be
  // read as one, so it is answered as unreadable — the panel says so, never "none".
  if (!isWellFormedCapabilityMap(pairs)) {
    logger.error("The stored map is malformed; answered as unavailable", {
      route: "app/api/admin/capability-mapping",
    });
    return apiError("service.unavailable", { params: { service: "config" }, request });
  }
  return NextResponse.json({ mappings: pairs });
});
