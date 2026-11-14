/**
 * app/api/operator/tenants/[id]/config/route.ts — one tenant's settings, as an operator sets
 * them (operators only, ADR-053 D5, D7)
 *
 * GET              every setting with that tenant's value, the platform default, whether the
 *                  value is the tenant's own, and whether its administrators may set it
 * PUT  { key, value, changeComment? }   the tenant's own value — any key, for an operator
 * DELETE ?key=…    the tenant's own value removed (it follows the platform default again)
 *
 * Run in the target tenant (inTargetTenant) through the same governed write as the config page:
 * tier permission, validation, history, two-person approval and dual-control holds — the
 * approvals and holds that creates are that tenant's (see ../approvals).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { listEnhancedConfig } from "@/platform/auth/platform-config";
import {
  configPutResponse,
  configResetResponse,
  describedByCatalog,
} from "@/platform/admin/config-http";
import { SET_BY_OPERATOR } from "@/platform/errors/recorded-text";
import { internalError } from "@/platform/errors";
import { inTargetTenant } from "@/platform/tenancy/operator-target";
import { tenantRoute } from "@/platform/tenancy/route";
import {
  type ResponseSchema,
  SETTING_VALUE,
  SHOWN,
} from "@/platform/errors/response-schema";

type Params = { params: Promise<{ id: string }> };

const GET_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          allowedValues: {
            type: ["array", "null"],
            items: {
              type: "string",
            },
          },
          category: {
            type: "string",
          },
          defaultValue: SETTING_VALUE,
          description: SHOWN,
          key: {
            type: "string",
          },
          maxValue: {
            type: ["null", "number"],
          },
          minValue: {
            type: ["null", "number"],
          },
          overridden: {
            type: "boolean",
          },
          permissionTier: {
            type: "string",
          },
          platformValue: SETTING_VALUE,
          tenantOverridable: {
            type: "boolean",
          },
          updatedAt: {
            type: "string",
          },
          value: SETTING_VALUE,
          valueType: {
            type: "string",
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
  { params }: Params
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id } = await params;
  return inTargetTenant(id, request, async () => {
    try {
      return NextResponse.json({
        tenantId: id,
        entries: (await listEnhancedConfig()).map(describedByCatalog),
      });
    } catch (error) {
      return internalError(error, { request, context: "Tenant settings read failed" });
    }
  });
}, GET_RESPONSE);

const PUT_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    approval: {
      type: ["null", "object"],
      properties: {
        applied: {
          type: "boolean",
        },
        approval: {
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
              type: "null",
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
        changeRequest: {
          type: "object",
          properties: {
            affectedUsers: SHOWN,
            changeComment: {
              type: "string",
            },
            currentValue: SETTING_VALUE,
            impact: {
              type: "array",
              items: SHOWN,
            },
            key: {
              type: "string",
            },
            permissionTier: {
              type: "string",
            },
            proposedValue: SETTING_VALUE,
            requiresApproval: {
              type: "boolean",
            },
            reversible: {
              type: "boolean",
            },
          },
        },
        operationId: {
          type: "string",
        },
        proposalId: {
          type: "string",
        },
        requiredApprover: {
          type: "string",
        },
        requiresApproval: {
          type: "boolean",
        },
      },
    },
    held: {
      type: "boolean",
    },
    key: {
      type: "string",
    },
    pending: {
      type: "boolean",
    },
    success: {
      type: "boolean",
    },
    value: SETTING_VALUE,
  },
};

export const PUT = tenantRoute(async function PUT(
  request: NextRequest,
  { params }: Params
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id } = await params;
  return inTargetTenant(id, request, () =>
    configPutResponse(request, guard.admin, { scope: "tenant", note: SET_BY_OPERATOR })
  );
}, PUT_RESPONSE);

const DELETE_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    approval: {
      type: "object",
      properties: {
        applied: {
          type: "boolean",
        },
        approval: {
          type: "object",
          properties: {
            action: {
              type: "string",
            },
            changeComment: {
              type: "string",
            },
            changeShown: SHOWN,
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
              type: "null",
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
        changeRequest: {
          type: "object",
          properties: {
            affectedUsers: SHOWN,
            changeComment: {
              type: "string",
            },
            currentValue: SETTING_VALUE,
            impact: {
              type: "array",
              items: SHOWN,
            },
            key: {
              type: "string",
            },
            permissionTier: {
              type: "string",
            },
            proposedValue: SETTING_VALUE,
            requiresApproval: {
              type: "boolean",
            },
            reversible: {
              type: "boolean",
            },
          },
        },
        requiresApproval: {
          type: "boolean",
        },
      },
    },
    held: {
      type: "boolean",
    },
    key: {
      type: "string",
    },
    pending: {
      type: "boolean",
    },
    success: {
      type: "boolean",
    },
    unchanged: {
      type: "boolean",
    },
  },
};

export const DELETE = tenantRoute(async function DELETE(
  request: NextRequest,
  { params }: Params
) {
  const guard = await requireAdmin(request, "platform_operate");
  if (guard.error) return guard.error;
  const { id } = await params;
  return inTargetTenant(id, request, () => configResetResponse(request, guard.admin));
}, DELETE_RESPONSE);
