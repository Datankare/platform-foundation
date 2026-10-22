/**
 * app/api/admin/ai/execute/route.ts — Execute confirmed admin actions
 *
 * Dispatches to individual handlers in handlers.ts.
 * Sprint 6
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { holds, type VerifiedAdmin } from "@/platform/auth/role-governance";
import {
  ADMIN_TOOL_PERMISSIONS,
  type AdminToolId,
} from "@/app/api/admin/ai/tool-permissions";
import { logger } from "@/lib/logger";
import {
  handleCreateRole,
  handleDeleteRole,
  handleDuplicateRole,
  handleAssignPermissions,
  handleChangeUserRole,
  handleCreateEntitlementGroup,
  handleUpdatePasswordPolicy,
  handleSearch,
  handleRegisterAgent,
  handleSuspendAgent,
  handleSetAgentScope,
  handleSetAgentTtl,
  handleBlockUserFeature,
  handleUnblockUserFeature,
  handleSetApprovalPolicy,
  handleSetCapabilityMapping,
} from "@/app/api/admin/ai/handlers";
import type { Tool, AgentIdentity } from "@/platform/agents/types";
import { invokeTool } from "@/platform/agents/tool-invoker";
import { getTrajectoryStore } from "@/platform/agents/trajectory-store";
import { getProposalStore } from "@/platform/agents/proposal-store";
import { apiError, readJsonObject } from "@/platform/errors";

type ActionResult = {
  success: boolean;
  result?: string;
  error?: string;
  code?: string;
  params?: Readonly<Record<string, string>>;
};

/* eslint-disable @typescript-eslint/no-explicit-any */

type Handler = (
  input: Record<string, any>,
  admin: VerifiedAdmin
) => Promise<ActionResult>;

/** Handlers that act only on their input record the verified admin as the actor (TASK-138). */
const asActor =
  (fn: (input: Record<string, any>, actorId: string) => Promise<ActionResult>): Handler =>
  (input, admin) =>
    fn(input, admin.userId);

const toolHandlers: Record<AdminToolId, Handler> = {
  create_role: handleCreateRole,
  delete_role: handleDeleteRole,
  duplicate_role: handleDuplicateRole,
  assign_permissions: handleAssignPermissions,
  change_user_role: handleChangeUserRole,
  create_entitlement_group: handleCreateEntitlementGroup,
  update_password_policy: asActor(handleUpdatePasswordPolicy),
  search: handleSearch,
  register_agent: handleRegisterAgent,
  suspend_agent: handleSuspendAgent,
  set_agent_scope: handleSetAgentScope,
  set_agent_ttl: handleSetAgentTtl,
  block_user_feature: asActor(handleBlockUserFeature),
  unblock_user_feature: asActor(handleUnblockUserFeature),
  set_approval_policy: asActor(handleSetApprovalPolicy),
  set_capability_mapping: handleSetCapabilityMapping,
};

/** The most actions one confirmed plan may carry (audit B-19). */
const MAX_ACTIONS = 20;

export async function POST(request: NextRequest) {
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
  // trajectory, budget and gating — instead of a bespoke dispatch. Each handler is wrapped as a
  // runtime Tool; writes declare stateWrite (effectiveRisk consequential, below the hold line).
  const trajectoryStore = getTrajectoryStore();
  const actor: AgentIdentity = {
    actorType: "agent",
    actorId: "command-bar",
    agentRole: "command-bar",
    onBehalfOf: admin.userId,
  };
  const trajectory = await trajectoryStore.create(
    { kind: "agent", id: actor.actorId },
    "command-bar",
    "platform"
  );
  const trajectoryId = trajectory.trajectory.trajectoryId;
  const validTools = new Set(Object.keys(toolHandlers));

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

    const handler = toolHandlers[tool];
    const toolInput = (action.input ?? {}) as Record<string, unknown>;
    const isRead = action.tool === "search";
    const runtimeTool: Tool = {
      id: action.tool,
      name: action.tool,
      description: `admin command-bar: ${action.tool}`,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      effects: isRead ? [] : ["stateWrite"],
      declaredRisk: isRead ? "ordinary" : "consequential",
      execute: async () =>
        (await handler(toolInput, admin)) as unknown as Record<string, unknown>,
    };

    let result: ActionResult;
    try {
      const invoked = await invokeTool({
        tool: runtimeTool,
        input: toolInput,
        actor,
        sessionId: trajectoryId,
        trajectoryId,
        stepIndex: i,
        trajectoryStore,
        proposalStore: getProposalStore(),
      });
      result = invoked.output as unknown as ActionResult;
      // An action that produced no result (held for approval) is not a success (release
      // review; running an approved command-bar hold is Wave 2, with runtime holds).
      if (typeof result?.success !== "boolean") {
        result = {
          success: false,
          error: "The action was held for approval and has not run",
        };
      }
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
}
