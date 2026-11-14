/**
 * app/api/admin/approvals/route.ts — the unified pending-approvals read surface (ADR-040, 040a).
 *
 * GET — list every live hold (runtime dual-control + config-approval two-person), each with the
 * permission required to clear it. Read-only; approve/reject is 040b (POST /[id]).
 *
 * Gated on can_access_admin: any admin may SEE the queue (transparency / manageability);
 * clearing a hold still requires the per-change permission, enforced in 040b. A hold's summary
 * (the account it acts on — an address among it) goes only to an admin holding that permission
 * (TASK-194 round 2, N2).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { logger, generateRequestId } from "@/lib/logger";
import { listPendingApprovals } from "@/platform/admin/pending-approvals";
import { COMMAND_BAR_HOLDS } from "@/app/api/admin/ai/command-bar";
import { apiError } from "@/platform/errors";
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
                type: "string",
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
    requestId: {
      type: "string",
    },
  },
};

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const verified = await requireAdmin(request, "can_access_admin");
  if (verified.error) return verified.error;

  const requestId = generateRequestId();
  try {
    // Each hold's summary only to an admin who could decide it (TASK-194 round 2, N2).
    const approvals = await listPendingApprovals([COMMAND_BAR_HOLDS], verified.admin);
    return NextResponse.json({ approvals, requestId });
  } catch (err) {
    logger.error(
      `pending-approvals list failed: ${err instanceof Error ? err.message : String(err)} (req ${requestId})`
    );
    return apiError("internal.error", { params: { requestId }, request });
  }
}, GET_RESPONSE);
