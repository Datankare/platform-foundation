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
import type { ResponseSchema } from "@/platform/errors/response-schema";

/** The body this route reads (TASK-203, N-31): read against its schema — any other key refused. */
const TENANT_BODY_SCHEMA: InputSchemaNode = {
  type: "object",
  properties: {
    slug: { type: "string" },
    name: { type: "string" },
    domains: { type: "array", items: { type: "string" } },
  },
};

const GET_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    tenants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          createdAt: {
            type: "string",
          },
          domains: {
            type: "array",
            items: {
              type: "string",
            },
          },
          id: {
            type: "string",
          },
          name: {
            type: "string",
          },
          pendingDeletion: {
            type: "object",
            properties: {
              requestId: {
                type: "string",
              },
              requestedBy: {
                type: "string",
              },
            },
          },
          purgeAfter: {
            type: "string",
          },
          purgedAt: {
            type: "string",
          },
          slug: {
            type: "string",
          },
          status: {
            type: "string",
          },
          statusChangedAt: {
            type: "string",
          },
          statusChangedBy: {
            type: "string",
          },
          statusReason: {
            type: "string",
          },
          updatedAt: {
            type: "string",
          },
          userCount: {
            type: "number",
          },
        },
      },
    },
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
}, GET_RESPONSE);

const POST_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    result: {
      type: "object",
      properties: {
        createdAt: {
          type: "string",
        },
        domains: {
          type: "array",
          items: {
            type: "string",
          },
        },
        id: {
          type: "string",
        },
        name: {
          type: "string",
        },
        slug: {
          type: "string",
        },
        status: {
          type: "string",
        },
        updatedAt: {
          type: "string",
        },
      },
    },
  },
};

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
}, POST_RESPONSE);
