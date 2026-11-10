/**
 * app/api/operator/tenants/[id]/route.ts — rename a tenant (operators only, ADR-053 D7)
 *
 * PATCH { name }
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import {
  apiError,
  internalError,
  readJsonBody,
  type InputSchemaNode,
} from "@/platform/errors";
import { renameTenant } from "@/platform/tenancy/admin";
import { operatorOf, operatorResponse } from "@/platform/tenancy/operator-http";
import { tenantRoute } from "@/platform/tenancy/route";

/** The body this route reads (TASK-203, N-31): read against its schema — any other key refused. */
const RENAME_BODY_SCHEMA: InputSchemaNode = {
  type: "object",
  properties: {
    name: { type: "string" },
  },
};

export const PATCH = tenantRoute(async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id } = await params;
  const read = await readJsonBody(request, RENAME_BODY_SCHEMA);
  if (!read.ok) return read.response;
  const { name } = read.body as Record<string, unknown>;
  if (typeof name !== "string") {
    return apiError("request.missing_fields", { params: { fields: ["name"] }, request });
  }
  try {
    return operatorResponse(
      await renameTenant(operatorOf(guard.admin), id, name),
      request
    );
  } catch (error) {
    return internalError(error, { request, context: "Tenant rename failed" });
  }
});
