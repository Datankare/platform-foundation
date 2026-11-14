/**
 * GET /api/admin/config — List platform config entries (config_view)
 * PUT /api/admin/config — Change one config value through the governed path
 *
 * PUT goes through writeGovernedConfig (platform/admin/config-http.ts → governed-config.ts): the
 * admin must hold
 * the key's tier permission, the value is validated and recorded in config history, and
 * two-person approval and dual-control holds apply — the same as the config assistant
 * (audit X-7).
 * DELETE /api/admin/config?key=… — the current tenant goes back to the platform default
 *
 * Config keys are created and removed only by migrations; DELETE removes a tenant's own value
 * for a key, never the key — governed exactly as PUT (resetGovernedConfig).
 *
 * Sprint 7b, Task 7b.2 (original) · Sprint 3a, Phase 4 (enhanced) · Sprint 7X (governed)
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard, requireAdmin } from "@/platform/auth/admin-guard";
import { listConfig, listEnhancedConfig } from "@/platform/auth/platform-config";
import {
  configPutResponse,
  configResetResponse,
  describedByCatalog,
} from "@/platform/admin/config-http";
import { logger, generateRequestId } from "@/lib/logger";
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
    enhanced: {
      type: "boolean",
    },
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
  },
};

export const GET = tenantRoute(async function GET(request: NextRequest) {
  const requestId = generateRequestId();
  // Sprint 3a: downgraded from admin_manage_config to config_view
  const denied = await adminGuard(request, "config_view");
  if (denied) return denied;

  try {
    const category = request.nextUrl.searchParams.get("category") || undefined;
    const enhanced = request.nextUrl.searchParams.get("enhanced") === "true";

    if (enhanced) {
      // Sprint 3a: return enhanced entries with full metadata
      const entries = await listEnhancedConfig({ category });
      return NextResponse.json({
        entries: entries.map(describedByCatalog),
        enhanced: true,
      });
    }

    // Original behavior: simple entries
    const entries = await listConfig(category);
    return NextResponse.json({ entries: entries.map(describedByCatalog) });
  } catch (error) {
    logger.error("Config list failed", {
      requestId,
      route: "/api/admin/config",
      error: error instanceof Error ? error.message : "Unknown",
    });
    return apiError("internal.error", { request });
  }
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

export const PUT = tenantRoute(async function PUT(request: NextRequest) {
  // Entry check only; the key's own tier permission is checked by writeGovernedConfig.
  const guard = await requireAdmin(request, "config_view");
  if (guard.error) return guard.error;
  return configPutResponse(request, guard.admin);
}, PUT_RESPONSE);

/**
 * DELETE ?key=… — the current tenant uses the platform default for `key` again (a shared
 * deployment's tenant administrators, for keys a tenant may set; operators, for any key).
 * Governed like PUT (resetGovernedConfig): tier permission, scope, two-person approval and
 * dual-control holds; recorded like a change (no record, no change).
 */
const DELETE_RESPONSE: ResponseSchema = {
  type: "object",
  properties: {
    approval: {
      type: "object",
      properties: {
        applied: {
          type: "boolean",
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

export const DELETE = tenantRoute(async function DELETE(request: NextRequest) {
  const guard = await requireAdmin(request, "config_view");
  if (guard.error) return guard.error;
  return configResetResponse(request, guard.admin);
}, DELETE_RESPONSE);
