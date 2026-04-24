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
 *   - Write tools (update, request_approval):
 *     config_manage_standard (admin) or config_manage_safety (super_admin)
 *   - Approval tools (approve, reject):
 *     config_manage_safety (super_admin only)
 *
 * Phase 4, Sprint 3a
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard, getAdminActorId } from "@/platform/auth/admin-guard";
import { logger, generateRequestId } from "@/lib/logger";
import { dispatchConfigTool } from "@/platform/admin/config-handlers";
import { getPermissionTier } from "@/platform/auth/platform-config";
import type { ToolExecutionContext } from "@/platform/admin/types";

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
    return "config_manage_safety";
  }
  if (WRITE_TOOLS.has(toolId)) {
    // Write permission depends on the config key's permission tier
    // This is checked after reading the key, so we start with standard
    return "config_manage_standard";
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

  try {
    const body: ExecuteRequest = await request.json();

    if (!body.toolId || typeof body.toolId !== "string") {
      return NextResponse.json({ error: "toolId is required" }, { status: 400 });
    }

    // Determine base permission required
    const basePermission = getRequiredPermission(body.toolId);
    const denied = await adminGuard(request, basePermission);
    if (denied) return denied;

    const actorId = getAdminActorId(request);

    // For write tools, check if the config key requires safety-tier access
    if (WRITE_TOOLS.has(body.toolId) && body.input?.key) {
      const tier = await getPermissionTier(body.input.key as string);
      if (tier === "safety") {
        const safetyDenied = await adminGuard(request, "config_manage_safety");
        if (safetyDenied) return safetyDenied;
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
      trajectoryId: `traj-\${Date.now().toString(36)}-\${Math.random().toString(36).slice(2, 8)}`,
      agentId: `config-manager-\${Date.now().toString(36)}`,
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
    return NextResponse.json({ error: "Tool execution failed" }, { status: 500 });
  }
}
