/**
 * app/api/operator/tenants/[id]/approvals/route.ts — one tenant's held changes (operators only,
 * ADR-040, ADR-053 D7)
 *
 * GET — every live hold of that tenant (runtime dual-control and two-person config approvals),
 * each with the permission required to clear it: the changes an operator's per-tenant settings
 * (../config) are waiting on. Decided with POST ./[approvalId].
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { listPendingApprovals } from "@/platform/admin/pending-approvals";
import { COMMAND_BAR_HOLDS } from "@/app/api/admin/ai/command-bar";
import { internalError } from "@/platform/errors";
import { inTargetTenant } from "@/platform/tenancy/operator-target";
import { tenantRoute } from "@/platform/tenancy/route";
import {
  type ResponseSchema,
  SETTING_VALUE,
  SHOWN,
} from "@/platform/errors/response-schema";

const GET_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    approvals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          change: {
            type: "object",
            properties: {
              action: {
                type: "string",
              },
              after: SETTING_VALUE,
              before: SETTING_VALUE,
              key: {
                type: "string",
              },
              scope: {
                type: "string",
              },
            },
          },
          comment: {
            type: "string",
          },
          commentShown: SHOWN,
          configKey: {
            type: "string",
          },
          createdAt: {
            type: "string",
          },
          effectiveRisk: {
            type: "string",
          },
          effects: {
            type: "array",
            items: {
              type: "string",
            },
          },
          id: {
            type: "string",
          },
          label: {
            type: "string",
          },
          noEligibleDecider: {
            type: "boolean",
          },
          reason: SHOWN,
          requestedBy: {
            type: "object",
            properties: {
              email: {
                type: ["null", "string"],
              },
              kind: {
                type: "string",
              },
              role: {
                type: "string",
              },
            },
          },
          requester: {
            type: "string",
          },
          requiredPermission: {
            type: "string",
          },
          source: {
            type: "string",
          },
          state: {
            type: "string",
          },
          summary: {
            type: "object",
            properties: {
              active: {
                type: "boolean",
              },
              approvalPolicy: {
                type: "object",
                properties: {
                  defaultApprover: {
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
                },
              },
              dryRun: {
                type: "boolean",
              },
              feature: {
                type: "string",
              },
              fromRole: {
                type: "string",
              },
              group: {
                type: "string",
              },
              permissionsGranted: {
                type: "array",
                items: {
                  type: "string",
                },
              },
              permissionsRemoved: {
                type: "array",
                items: {
                  type: "string",
                },
              },
              reason: {
                type: "string",
              },
              role: {
                type: "string",
              },
              roleChangedSince: {
                type: "object",
                properties: {
                  now: {
                    type: ["null", "string"],
                  },
                },
              },
              target: {
                type: "object",
                properties: {
                  email: {
                    type: "string",
                  },
                  id: {
                    type: "string",
                  },
                  notFound: {
                    type: "boolean",
                  },
                },
              },
              toRole: {
                type: "string",
              },
            },
          },
          undecided: {
            type: "boolean",
          },
        },
      },
    },
    tenantId: {
      type: "string",
    },
  },
};

export const GET = tenantRoute(async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id } = await params;
  return inTargetTenant(id, request, async () => {
    try {
      return NextResponse.json({
        tenantId: id,
        // Summaries only where the operator could decide the hold (round 2, N2).
        approvals: await listPendingApprovals([COMMAND_BAR_HOLDS], guard.admin),
      });
    } catch (error) {
      return internalError(error, { request, context: "Tenant approvals read failed" });
    }
  });
}, GET_RESPONSE);
