/**
 * app/api/admin/ai/execute/route.ts — Execute confirmed admin actions
 *
 * Dispatches to individual handlers in handlers.ts.
 * Sprint 6
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { logger } from "@/lib/logger";
import {
  handleCreateRole,
  handleDeleteRole,
  handleDuplicateRole,
  handleAssignPermissions,
  handleChangeUserRole,
  handleCreateEntitlementGroup,
  handleUpdateGuestConfig,
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

type ActionResult = {
  success: boolean;
  result?: string;
  error?: string;
};

/* eslint-disable @typescript-eslint/no-explicit-any */

const toolHandlers: Record<
  string,
  (input: Record<string, any>, actorId: string) => Promise<ActionResult>
> = {
  create_role: handleCreateRole,
  delete_role: handleDeleteRole,
  duplicate_role: handleDuplicateRole,
  assign_permissions: handleAssignPermissions,
  change_user_role: handleChangeUserRole,
  create_entitlement_group: handleCreateEntitlementGroup,
  update_guest_config: handleUpdateGuestConfig,
  update_password_policy: handleUpdatePasswordPolicy,
  search: (input) => handleSearch(input),
  register_agent: handleRegisterAgent,
  suspend_agent: handleSuspendAgent,
  set_agent_scope: handleSetAgentScope,
  set_agent_ttl: handleSetAgentTtl,
  block_user_feature: handleBlockUserFeature,
  unblock_user_feature: handleUnblockUserFeature,
  set_approval_policy: handleSetApprovalPolicy,
  set_capability_mapping: handleSetCapabilityMapping,
};

export async function POST(request: NextRequest) {
  const denied = await adminGuard(request, "can_access_admin");
  if (denied) return denied;

  const { actions, prompt } = await request.json();

  if (!actions || !Array.isArray(actions)) {
    return NextResponse.json({ error: "actions array required" }, { status: 400 });
  }

  const actorId = "dev-admin";
  const results: { tool: string; success: boolean; result?: string; error?: string }[] =
    [];

  for (const action of actions) {
    const validTools = new Set(Object.keys(toolHandlers));
    if (!validTools.has(action.tool)) {
      results.push({
        tool: action.tool,
        success: false,
        error: `Unknown tool: ${action.tool}`,
      });
      break;
    }

    // Validated: action.tool is a known key in toolHandlers
    const handler = toolHandlers[action.tool as keyof typeof toolHandlers];
    const result = await handler(action.input, actorId);
    results.push({ tool: action.tool, ...result });
    if (!result.success) break;
  }

  logger.info("Admin AI action executed", {
    prompt,
    actionCount: actions.length,
    results: results.map((r) => ({ tool: r.tool, success: r.success })),
    route: "api/admin/ai/execute",
  });

  return NextResponse.json({ results });
}
