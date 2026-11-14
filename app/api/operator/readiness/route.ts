/**
 * app/api/operator/readiness/route.ts — is the deployment set up to keep tenants apart?
 * (operators only, ADR-053). Read-only.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { internalError } from "@/platform/errors";
import { checkTenancyReadiness } from "@/platform/tenancy/readiness";
import { tenantRoute } from "@/platform/tenancy/route";
import { commandBarDualControlledActions } from "@/app/api/admin/ai/command-bar";
import { type ResponseSchema, SHOWN } from "@/platform/errors/response-schema";

const GET_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    checks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          detail: SHOWN,
          name: {
            type: "string",
          },
          state: {
            type: "string",
          },
        },
      },
    },
    mode: {
      type: "string",
    },
    ready: {
      type: "boolean",
    },
    tenantId: {
      type: "string",
    },
  },
};

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  try {
    // The command bar's held actions are weighed with the platform's (N-24).
    return NextResponse.json(
      await checkTenancyReadiness({ heldActions: commandBarDualControlledActions })
    );
  } catch (error) {
    return internalError(error, { request, context: "Tenancy readiness check failed" });
  }
}, GET_RESPONSE);
