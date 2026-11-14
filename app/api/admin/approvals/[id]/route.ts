/**
 * app/api/admin/approvals/[id]/route.ts — the approval decision surface (ADR-040, 040b).
 *
 * POST — approve or reject a held change in the admin's tenant: platform/admin/approval-decision.ts.
 */

import { NextRequest } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { DECISION_REFUSAL, decideApproval } from "@/platform/admin/approval-decision";
import { COMMAND_BAR_HOLDS } from "@/app/api/admin/ai/command-bar";
import { tenantRoute } from "@/platform/tenancy/route";
import { type ResponseSchema, SETTING_VALUE } from "@/platform/errors/response-schema";

const POST_RESPONSE: ResponseSchema = {
  type: "object",
  onError: DECISION_REFUSAL,
  properties: {
    applied: {
      type: "boolean",
    },
    decision: {
      type: "string",
    },
    outcome: {
      type: "string",
    },
    pendingApproval: {
      type: "object",
      properties: {
        action: {
          type: "string",
        },
        changeComment: {
          type: "string",
        },
        configKey: {
          type: "string",
        },
        createdAt: {
          type: "string",
        },
        currentValue: SETTING_VALUE,
        expiresAt: {
          type: "string",
        },
        id: {
          type: "string",
        },
        impactSummary: {
          type: "string",
        },
        proposedValue: SETTING_VALUE,
        requestedBy: {
          type: "string",
        },
        reviewComment: {
          type: "null",
        },
        reviewedAt: {
          type: "null",
        },
        reviewedBy: {
          type: "null",
        },
        scope: {
          type: "string",
        },
        status: {
          type: "string",
        },
      },
    },
    requestId: {
      type: "string",
    },
    source: {
      type: "string",
    },
    status: {
      type: "string",
    },
    withdrawn: {
      type: "boolean",
    },
  },
};

export const POST = tenantRoute(async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const verified = await requireAdmin(request, "can_access_admin");
  if (verified.error) return verified.error;
  const { id } = await context.params;
  return decideApproval(request, verified.admin, id, [COMMAND_BAR_HOLDS]);
}, POST_RESPONSE);
