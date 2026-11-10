/**
 * app/api/operator/tenants/[id]/state/route.ts — suspend, resume or restore a tenant
 * (operators only, ADR-053 D7)
 *
 * POST { action: "suspend" | "resume" | "restore", reason }
 *   suspend  every request of the tenant is refused (tenant.suspended) until resumed
 *   resume   back to active
 *   restore  a deleted tenant whose data is not yet purged, back to suspended
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import {
  apiError,
  internalError,
  readJsonBody,
  type InputSchemaNode,
} from "@/platform/errors";
import { restoreTenant, resumeTenant, suspendTenant } from "@/platform/tenancy/admin";
import { operatorOf, operatorResponse } from "@/platform/tenancy/operator-http";
import { tenantRoute } from "@/platform/tenancy/route";

/** The body this route reads (TASK-203, N-31): read against its schema — any other key refused. */
const STATE_BODY_SCHEMA: InputSchemaNode = {
  type: "object",
  properties: {
    action: { type: "string" },
    reason: { type: "string" },
  },
};

const ACTIONS = { suspend: suspendTenant, resume: resumeTenant, restore: restoreTenant };

export const POST = tenantRoute(async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id } = await params;
  const read = await readJsonBody(request, STATE_BODY_SCHEMA);
  if (!read.ok) return read.response;
  const { action, reason } = read.body as Record<string, unknown>;
  if (typeof reason !== "string" || typeof action !== "string") {
    return apiError("request.missing_fields", {
      params: { fields: ["action", "reason"] },
      request,
    });
  }
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
    return apiError("request.invalid_body", { request });
  }
  try {
    const act = ACTIONS[action as keyof typeof ACTIONS];
    return operatorResponse(await act(operatorOf(guard.admin), id, reason), request);
  } catch (error) {
    return internalError(error, { request, context: "Tenant state change failed" });
  }
});
