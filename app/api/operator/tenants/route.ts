/**
 * app/api/operator/tenants/route.ts — the tenants (operators only, ADR-053 D7)
 *
 * GET   every tenant: state, addresses, users, any deletion awaiting approval
 * POST  provision one: { slug, name, domains?: string[] }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { internalError, readJsonBody, type InputSchemaNode } from "@/platform/errors";
import { listTenantOverviews, provisionTenant } from "@/platform/tenancy/admin";
import { operatorOf, operatorResponse } from "@/platform/tenancy/operator-http";
import { tenantRoute } from "@/platform/tenancy/route";
import { apiError } from "@/platform/errors";

/** The body this route reads (TASK-203, N-31): read against its schema — any other key refused. */
const TENANT_BODY_SCHEMA: InputSchemaNode = {
  type: "object",
  properties: {
    slug: { type: "string" },
    name: { type: "string" },
    domains: { type: "array", items: { type: "string" } },
  },
};

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  try {
    return NextResponse.json({ tenants: await listTenantOverviews() });
  } catch (error) {
    return internalError(error, { request, context: "Tenant list failed" });
  }
});

export const POST = tenantRoute(async function POST(request: NextRequest) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const read = await readJsonBody(request, TENANT_BODY_SCHEMA);
  if (!read.ok) return read.response;
  const { slug, name, domains } = read.body as Record<string, unknown>;
  if (typeof slug !== "string" || typeof name !== "string") {
    return apiError("request.missing_fields", {
      params: { fields: ["slug", "name"] },
      request,
    });
  }
  if (
    domains !== undefined &&
    (!Array.isArray(domains) ||
      domains.length > 20 ||
      !domains.every((d) => typeof d === "string"))
  ) {
    return apiError("request.invalid_body", { request });
  }
  try {
    const result = await provisionTenant(operatorOf(guard.admin), {
      slug,
      name,
      domains: (domains as string[] | undefined) ?? [],
    });
    return operatorResponse(result, request, 201);
  } catch (error) {
    return internalError(error, { request, context: "Tenant provisioning failed" });
  }
});
