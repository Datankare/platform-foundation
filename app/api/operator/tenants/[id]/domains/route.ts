/**
 * app/api/operator/tenants/[id]/domains/route.ts — a tenant's addresses (operators only,
 * ADR-053 D2/D7)
 *
 * POST    { host }   map the host to the tenant (a host serves one tenant)
 * DELETE  ?host=…    unmap it
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import {
  apiError,
  internalError,
  readJsonBody,
  type InputSchemaNode,
} from "@/platform/errors";
import { addTenantDomain, removeTenantDomain } from "@/platform/tenancy/admin";
import { operatorOf, operatorResponse } from "@/platform/tenancy/operator-http";
import { tenantRoute } from "@/platform/tenancy/route";
import type { ResponseSchema } from "@/platform/errors/response-schema";

/** The body this route reads (TASK-203, N-31): read against its schema — any other key refused. */
const DOMAIN_BODY_SCHEMA: InputSchemaNode = {
  type: "object",
  properties: {
    host: { type: "string" },
  },
};

type Ctx = { params: Promise<{ id: string }> };

const POST_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    result: {
      type: "object",
      properties: {
        createdAt: {
          type: "string",
        },
        host: {
          type: "string",
        },
        tenantId: {
          type: "string",
        },
      },
    },
  },
};

export const POST = tenantRoute(async function POST(
  request: NextRequest,
  { params }: Ctx
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id } = await params;
  const read = await readJsonBody(request, DOMAIN_BODY_SCHEMA);
  if (!read.ok) return read.response;
  const { host } = read.body as Record<string, unknown>;
  if (typeof host !== "string") {
    return apiError("request.missing_fields", { params: { fields: ["host"] }, request });
  }
  try {
    return operatorResponse(
      await addTenantDomain(operatorOf(guard.admin), id, host),
      request,
      201
    );
  } catch (error) {
    return internalError(error, { request, context: "Adding a tenant address failed" });
  }
}, POST_RESPONSE);

const DELETE_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    result: {
      type: "boolean",
    },
  },
};

export const DELETE = tenantRoute(async function DELETE(
  request: NextRequest,
  { params }: Ctx
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id } = await params;
  const host = request.nextUrl.searchParams.get("host");
  if (!host)
    return apiError("request.missing_fields", { params: { fields: ["host"] }, request });
  try {
    return operatorResponse(
      await removeTenantDomain(operatorOf(guard.admin), id, host),
      request
    );
  } catch (error) {
    return internalError(error, { request, context: "Removing a tenant address failed" });
  }
}, DELETE_RESPONSE);
