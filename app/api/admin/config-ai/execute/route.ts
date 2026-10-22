/**
 * POST /api/admin/config-ai/execute — Direct config tool execution
 *
 * Executes a specific config agent tool by ID. Used by the admin UI
 * for direct tool invocations (search, get, update, history, impact,
 * approval workflow).
 *
 * Permission routing:
 *   - Read tools (search, get, history, compare, impact, bulk_review):
 *     config_view (all admins)
 *   - Write tools (update, request_approval): the target key's tier permission —
 *     config_manage_standard, or config_manage_safety for a safety-tier or unknown key
 *   - Approval tools (approve, reject):
 *     config_manage_safety (super_admin only)
 *
 * Phase 4, Sprint 3a
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { holds } from "@/platform/auth/role-governance";
import { tierPermission } from "@/platform/admin/governed-config";
import { logger, generateRequestId } from "@/lib/logger";
import { dispatchConfigTool } from "@/platform/admin/config-handlers";
import { getPermissionTier } from "@/platform/auth/platform-config";
import type { ToolExecutionContext } from "@/platform/admin/types";
import { generateId } from "@/platform/agents/utils";
import { apiError, readJsonObject } from "@/platform/errors";
import { getApproval } from "@/platform/admin/config-approval";
import { requiredPermissionForKey } from "@/platform/admin/pending-approvals";

// ---------------------------------------------------------------------------
// Permission routing
// ---------------------------------------------------------------------------

/** Tools that only require read access */
const READ_TOOLS = new Set([
  "search_config",
  "get_config",
  "get_history",
  "compare_to_defaults",
  "impact_report",
  "bulk_review",
]);

/** Tools that require write access (standard or safety tier) */
const WRITE_TOOLS = new Set(["update_config", "request_approval"]);

/** Tools that require safety-tier access (super_admin) */
const APPROVAL_TOOLS = new Set(["approve_change", "reject_change"]);

/**
 * Determine the required permission for a tool + config key combination.
 */
function getRequiredPermission(toolId: string, _configKey?: string): string {
  if (READ_TOOLS.has(toolId)) {
    return "config_view";
  }
  if (APPROVAL_TOOLS.has(toolId)) {
    // Entry only: the approval's own key decides the permission (its tier), checked below with
    // the record in hand — as the approvals route does (release review, Sprint 7X).
    return "config_view";
  }
  if (WRITE_TOOLS.has(toolId)) {
    // Entry only: the key's own tier permission (config_manage_standard or
    // config_manage_safety) is checked once the key is known, below. A safety approver holds
    // config_manage_safety without config_manage_standard, and may edit safety-tier keys.
    return "config_view";
  }
  // Unknown tool — require highest permission
  return "config_manage_safety";
}

// ---------------------------------------------------------------------------
// Request type
// ---------------------------------------------------------------------------

interface ExecuteRequest {
  /** Tool ID to execute */
  toolId: string;
  /** Tool input parameters */
  input: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const requestId = generateRequestId();

  // Verified (and rate limited) before the body is read: every config tool needs at least
  // config_view, and nothing about the request is looked at for an unverified caller (audit I-2).
  const guard = await requireAdmin(request, "config_view");
  if (guard.error) return guard.error;
  const { admin } = guard;
  const actorId = admin.userId;

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const raw = read.body;
  if (typeof raw.toolId !== "string" || !raw.toolId) {
    return apiError("request.missing_fields", {
      params: { fields: ["toolId"] },
      request,
    });
  }
  if (
    raw.input !== undefined &&
    (typeof raw.input !== "object" || raw.input === null || Array.isArray(raw.input))
  ) {
    return apiError("request.invalid_body", { request });
  }
  const body: ExecuteRequest = {
    toolId: raw.toolId,
    input: (raw.input as Record<string, unknown> | undefined) ?? {},
  };

  // The tool's own permission, beyond config_view.
  const basePermission = getRequiredPermission(body.toolId);
  if (!holds(admin, basePermission)) {
    return apiError("auth.permission_denied", {
      params: { permission: basePermission },
      request,
    });
  }

  try {
    // A write needs the target key's tier permission. update_config names the key `key`,
    // request_approval names it `configKey`; a write naming neither is held to the safety
    // tier (fail closed — previously request_approval skipped this check).
    if (WRITE_TOOLS.has(body.toolId)) {
      const input = body.input ?? {};
      const key =
        typeof input.key === "string"
          ? input.key
          : typeof input.configKey === "string"
            ? input.configKey
            : undefined;
      const needed = key
        ? tierPermission(await getPermissionTier(key))
        : "config_manage_safety";
      if (!holds(admin, needed)) {
        return apiError("auth.permission_denied", {
          params: { permission: needed },
          request,
        });
      }
    }

    // An approval decision needs the permission of the key it concerns; a missing or unknown
    // approval is held to the safety tier (fail closed).
    if (APPROVAL_TOOLS.has(body.toolId)) {
      const approvalId = body.input.approvalId;
      const record =
        typeof approvalId === "string" ? await getApproval(approvalId) : null;
      const needed = await requiredPermissionForKey(record?.configKey);
      if (!holds(admin, needed)) {
        return apiError("auth.permission_denied", {
          params: { permission: needed },
          request,
        });
      }
    }

    // SECURITY INVARIANT (S2): Inject actorId/reviewerId from the
    // authenticated session, overwriting any values the frontend sent.
    // This prevents a compromised frontend from spoofing a different
    // reviewer to bypass the self-approval check in config-approval.ts.
    // Do NOT remove this overwrite or allow frontend-supplied actor IDs.
    const enrichedInput = { ...body.input };
    if (WRITE_TOOLS.has(body.toolId) || APPROVAL_TOOLS.has(body.toolId)) {
      enrichedInput.actorId = actorId;
      enrichedInput.reviewerId = actorId;
    }

    // P3/P15/P18: Create trajectory context for this request
    const trajectoryContext: ToolExecutionContext = {
      trajectoryId: `traj-${Date.now().toString(36)}-${generateId()}`,
      agentId: `config-manager-${Date.now().toString(36)}`,
      onBehalfOf: actorId,
      steps: [],
    };

    // Execute the tool with trajectory recording
    const result = await dispatchConfigTool(
      body.toolId,
      enrichedInput,
      trajectoryContext
    );

    logger.info("Config tool executed", {
      requestId,
      route: "/api/admin/config-ai/execute",
      toolId: body.toolId,
      actorId,
      success: result.success,
      durationMs: result.durationMs,
      trajectoryId: trajectoryContext.trajectoryId,
    });

    // A7: For mutation tools, check business outcome (data.applied) for HTTP status
    // success:true = tool ran without throwing. data.applied = business operation succeeded.
    let status = result.success ? 200 : 422;
    const data = result.data as Record<string, unknown> | null;
    if (result.success && data && data.applied === false && !data.pendingConfirmation) {
      status = 422; // Business operation failed (validation error, key not found, etc.)
    }

    return NextResponse.json(
      {
        ...result,
        trajectoryId: trajectoryContext.trajectoryId,
        agentId: trajectoryContext.agentId,
        steps: trajectoryContext.steps,
      },
      { status }
    );
  } catch (error) {
    logger.error("Config tool execution failed", {
      requestId,
      route: "/api/admin/config-ai/execute",
      error: error instanceof Error ? error.message : "Unknown",
    });
    return apiError("internal.error", { request });
  }
}
