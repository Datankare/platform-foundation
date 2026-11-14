/**
 * app/api/admin/approval-policy/route.ts — GET the current approval policy (Sprint 3c U1).
 *
 * Read view for the governance panel. Mutations flow through the AI plan → confirm → execute
 * path (handlers/approval.ts), not this route.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { getApprovalPolicyStore } from "@/platform/agents";
import { tenantRoute } from "@/platform/tenancy/route";
import type { ResponseSchema } from "@/platform/errors/response-schema";

const GET_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    policy: {
      type: "object",
      properties: {
        default: {
          type: "string",
        },
        rules: {
          type: "array",
          items: {
            type: "object",
            properties: {
              effects: {
                type: "array",
                items: {
                  type: "string",
                },
              },
              maxRisk: {
                type: "string",
              },
              requiredApprover: {
                type: "string",
              },
            },
          },
        },
        version: {
          type: "number",
        },
      },
    },
  },
};

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const denied = await adminGuard(request, "admin_manage_approval_policy");
  if (denied) return denied;

  const policy = await getApprovalPolicyStore().load();
  return NextResponse.json({ policy });
}, GET_RESPONSE);
