/**
 * app/api/admin/ai/execute/route.ts — Execute confirmed admin actions
 *
 * Dispatches to individual handlers in handlers.ts.
 * Sprint 6
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { holds } from "@/platform/auth/role-governance";
import {
  ADMIN_TOOL_PERMISSIONS,
  type AdminToolId,
} from "@/app/api/admin/ai/tool-permissions";
import { logger } from "@/lib/logger";
import {
  COMMAND_BAR_ACTOR_ID,
  COMMAND_BAR_HANDLERS,
  runCommandBarAction,
  type ActionResult as BarResult,
} from "@/app/api/admin/ai/command-bar";
import { getTrajectoryStore } from "@/platform/agents/trajectory-store";
import { apiError, readJsonObject } from "@/platform/errors";
import { tenantRoute } from "@/platform/tenancy/route";

/** Held for a second admin's approval: `held`, with the hold's id (ActionResult, review 9 H1). */
type ActionResult = BarResult;

/** The most actions one confirmed plan may carry (audit B-19). */
const MAX_ACTIONS = 20;

export const POST = tenantRoute(async function POST(request: NextRequest) {
  const verified = await requireAdmin(request, "can_access_admin");
  if (verified.error) return verified.error;
  const { admin } = verified;

  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const body = read.body;
  const { actions } = (body && typeof body === "object" ? body : {}) as {
    actions?: unknown;
  };

  if (!actions || !Array.isArray(actions) || actions.length === 0) {
    return apiError("request.missing_fields", {
      params: { fields: ["actions"] },
      request,
    });
  }
  if (actions.length > MAX_ACTIONS) {
    return apiError("request.invalid_value", {
      params: { field: "actions", allowed: [`at most ${MAX_ACTIONS}`] },
      request,
    });
  }

  const results: ({ tool: string } & ActionResult)[] = [];

  // ADR-039 F2c: command-bar execution runs through the governed runtime (invokeTool) —
  // trajectory, budget and gating — instead of a bespoke dispatch. An action under dual control
  // (admin.dual_control_actions) is held for a second admin, and the plan stops there: the
  // actions after it may depend on it (audit X-10, C-14).
  const trajectoryStore = getTrajectoryStore();
  const trajectory = await trajectoryStore.create(
    { kind: "agent", id: COMMAND_BAR_ACTOR_ID },
    "command-bar",
    "platform"
  );
  const trajectoryId = trajectory.trajectory.trajectoryId;
  const validTools = new Set(Object.keys(COMMAND_BAR_HANDLERS));

  for (let i = 0; i < actions.length; i += 1) {
    const action = (actions[i] && typeof actions[i] === "object" ? actions[i] : {}) as {
      tool?: unknown;
      input?: unknown;
    };
    if (typeof action.tool !== "string" || !validTools.has(action.tool)) {
      // Never String() an arbitrary value: an object with a non-callable toString throws.
      const named =
        typeof action.tool === "string" ? action.tool.slice(0, 64) : "(invalid)";
      results.push({ tool: named, success: false, error: `Unknown tool: ${named}` });
      break;
    }

    // TASK-145: entering the admin area only opens the command bar. Each action requires the
    // permission its own admin page requires, checked before anything runs.
    const tool = action.tool as AdminToolId;
    const required = ADMIN_TOOL_PERMISSIONS[tool];
    if (!holds(admin, required)) {
      results.push({
        tool: action.tool,
        success: false,
        error: "auth.permission_denied",
        code: "auth.permission_denied",
        params: { permission: required },
      });
      break;
    }

    const toolInput = (
      action.input && typeof action.input === "object" && !Array.isArray(action.input)
        ? action.input
        : {}
    ) as Record<string, unknown>;

    let result: ActionResult;
    try {
      const outcome = await runCommandBarAction({
        tool,
        input: toolInput,
        admin,
        trajectoryId,
        stepIndex: i,
      });
      result =
        outcome.kind === "held"
          ? {
              success: false,
              held: true,
              proposalId: outcome.proposalId,
              error: "Held for a second administrator's approval; it has not run",
            }
          : outcome.result;
    } catch (err) {
      result = {
        success: false,
        error: err instanceof Error ? err.message : "Tool invocation failed",
      };
    }
    results.push({ tool: action.tool, ...result });
    if (!result.success) break;
  }

  // No prompt in the log: free text an admin types may carry personal data (release review).
  logger.info("Admin AI action executed", {
    actionCount: actions.length,
    results: results.map((r) => ({ tool: r.tool, success: r.success })),
    route: "api/admin/ai/execute",
  });

  return NextResponse.json({ results });
});
