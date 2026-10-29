/**
 * app/api/admin/ai/route.ts — Admin AI orchestrator
 *
 * Receives natural language admin commands, uses Claude to
 * interpret them into structured actions, returns a plan
 * for the admin to confirm before execution.
 *
 * GenAI-native admin (ADR-003): all admin operations flow
 * through natural language → AI plan → human confirm → execute.
 *
 * Phase 2: refactored to use platform/ai orchestration layer (ADR-015).
 *
 * The planner is offered only the tools the verified admin may run, and reads a panel's data
 * only with that panel's page permission (TASK-145). The execute route checks every action again.
 *
 * Panel context is read in the tenant's transaction (ADR-053 D5): the user count is this
 * tenant's; roles, permissions and entitlement groups are the shared catalog.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/admin-guard";
import { holds, type VerifiedAdmin } from "@/platform/auth/role-governance";
import { PANEL_CONTEXT_PERMISSIONS, toolPermission } from "./tool-permissions";
import { withTenantTx, type Tx } from "@/platform/data";
import { logger, generateRequestId } from "@/lib/logger";
import { getOrchestrator } from "@/platform/ai";
import { isAIRefusalError } from "@/platform/ai/provider";
import { getPromptConfig, buildAdminSystemPrompt } from "@/prompts";
import { SHARED_TOOLS, PANEL_TOOL_SCHEMAS, type AdminTool } from "./tool-schemas";
import { listPendingApprovals } from "@/platform/admin/pending-approvals";
import { COMMAND_BAR_HOLDS } from "@/app/api/admin/ai/command-bar";
import { apiError, readJsonObject } from "@/platform/errors";
import { enforceDailyPaidQuota } from "@/platform/rate-limit";
import { tenantRoute } from "@/platform/tenancy/route";

/** The longest command an admin may send to the planner. */
const MAX_PROMPT_CHARS = 4000;

function getToolsForPanel(panel: string, admin: VerifiedAdmin): AdminTool[] {
  const panelTools = Object.prototype.hasOwnProperty.call(PANEL_TOOL_SCHEMAS, panel)
    ? PANEL_TOOL_SCHEMAS[panel]
    : [];
  return [...SHARED_TOOLS, ...panelTools].filter((tool) => {
    const permission = toolPermission(tool.name);
    return permission !== undefined && holds(admin, permission);
  });
}

/** Rows of a context read; an unreadable table reads as none, as before (context is advisory). */
async function contextRows<R extends Record<string, unknown>>(
  read: (tx: Tx) => Promise<{ rows: R[] }>
): Promise<R[]> {
  try {
    return (await withTenantTx(read)).rows;
  } catch (err) {
    logger.warn("Admin AI panel context unreadable", {
      error: err instanceof Error ? err.message : String(err),
      route: "api/admin/ai",
    });
    return [];
  }
}

async function getContextForPanel(panel: string, admin: VerifiedAdmin): Promise<string> {
  const permission = PANEL_CONTEXT_PERMISSIONS[panel];
  if (!permission || !holds(admin, permission)) return "";

  if (panel === "roles") {
    const roles = await contextRows((tx) =>
      tx.query("select name, display_name from roles order by sort_order")
    );
    const perms = await contextRows((tx) =>
      tx.query("select code, display_name, category from permissions order by category")
    );
    return `Current roles: ${JSON.stringify(roles)}\nAvailable permissions: ${JSON.stringify(perms)}`;
  }

  if (panel === "users") {
    const roles = await contextRows((tx) =>
      tx.query("select name, display_name from roles")
    );
    const [counted] = await contextRows((tx) =>
      tx.query<{ n: number }>(
        "select count(*)::int as n from users where deleted_at is null"
      )
    );
    return `Total active users: ${counted?.n || 0}\nRoles: ${JSON.stringify(roles)}`;
  }

  if (panel === "entitlements") {
    const groups = await contextRows((tx) =>
      tx.query("select code, display_name, is_active from entitlement_groups")
    );
    const perms = await contextRows((tx) =>
      tx.query("select code, display_name from permissions")
    );
    return `Current entitlement groups: ${JSON.stringify(groups)}\nAvailable permissions: ${JSON.stringify(perms)}`;
  }

  if (panel === "approvals") {
    const holds = await listPendingApprovals([COMMAND_BAR_HOLDS]);
    const summary = holds.map((h) => ({
      proposalId: h.id,
      source: h.source,
      label: h.label,
      requester: h.requester,
    }));
    return `Pending approvals — resolve the request to exactly one of these, by proposalId: ${JSON.stringify(summary)}`;
  }

  return "";
}

export const POST = tenantRoute(async function POST(request: NextRequest) {
  const verified = await requireAdmin(request, "can_access_admin");
  if (verified.error) return verified.error;
  const { admin } = verified;

  const requestId = generateRequestId();
  const read = await readJsonObject(request);
  if (!read.ok) return read.response;
  const body = read.body as { prompt?: unknown; panel?: unknown };
  const { prompt, panel } = body ?? {};

  if (typeof prompt !== "string" || !prompt || typeof panel !== "string" || !panel) {
    return apiError("request.missing_fields", {
      params: { fields: ["prompt", "panel"] },
      request,
    });
  }

  // A bounded request: the plan call is paid for per token.
  if (prompt.length > MAX_PROMPT_CHARS) {
    return apiError("request.text_too_long", {
      params: { max: MAX_PROMPT_CHARS },
      request,
    });
  }

  // The plan call is paid: it counts against the admin's daily paid-request quota (audit X-12).
  const quota = await enforceDailyPaidQuota(request, admin.userId);
  if (quota) return quota;

  const tools = getToolsForPanel(panel, admin);
  const context = await getContextForPanel(panel, admin);
  const config = getPromptConfig("admin-command-bar");

  try {
    const response = await getOrchestrator().complete(
      {
        tier: config.tier,
        system: buildAdminSystemPrompt(panel, context),
        messages: [{ role: "user", content: prompt }],
        maxTokens: config.maxTokens,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
        })),
      },
      {
        useCase: config.name,
        requestId,
      }
    );

    // Extract text responses and tool calls
    const plan: {
      message: string;
      actions: { tool: string; input: Record<string, unknown> }[];
    } = { message: "", actions: [] };

    for (const block of response.content) {
      if (block.type === "text") {
        plan.message += block.text;
      }
      if (block.type === "tool_use") {
        plan.actions.push({
          tool: block.name,
          input: block.input,
        });
      }
    }

    return NextResponse.json({ plan });
  } catch (err) {
    // The model declining the request is not an outage: retrying it is declined again.
    if (isAIRefusalError(err)) {
      logger.warn("Admin AI request declined by the model", {
        requestId,
        route: "api/admin/ai",
      });
      return apiError("ai.request_declined", { request });
    }
    logger.error("Admin AI orchestrator error", {
      error: err instanceof Error ? err.message : "Unknown",
      requestId,
      route: "api/admin/ai",
    });
    return apiError("service.unavailable", { params: { service: "ai" }, request });
  }
});
