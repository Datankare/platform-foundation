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
 */

import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/platform/auth/admin-guard";
import { getSupabaseServiceClient } from "@/lib/supabase/server";
import { logger, generateRequestId } from "@/lib/logger";
import { getOrchestrator } from "@/platform/ai";
import { getPromptConfig, buildAdminSystemPrompt } from "@/prompts";
import { SHARED_TOOLS, PANEL_TOOL_SCHEMAS, type AdminTool } from "./tool-schemas";

function getToolsForPanel(panel: string): AdminTool[] {
  return [...SHARED_TOOLS, ...(PANEL_TOOL_SCHEMAS[panel] || [])];
}

async function getContextForPanel(panel: string): Promise<string> {
  const supabase = getSupabaseServiceClient();

  if (panel === "roles") {
    const { data: roles } = await supabase
      .from("roles")
      .select("name, display_name")
      .order("sort_order");
    const { data: perms } = await supabase
      .from("permissions")
      .select("code, display_name, category")
      .order("category");
    return `Current roles: ${JSON.stringify(roles || [])}\nAvailable permissions: ${JSON.stringify(perms || [])}`;
  }

  if (panel === "users") {
    const { data: roles } = await supabase.from("roles").select("name, display_name");
    const { count } = await supabase
      .from("users")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null);
    return `Total active users: ${count || 0}\nRoles: ${JSON.stringify(roles || [])}`;
  }

  if (panel === "entitlements") {
    const { data: groups } = await supabase
      .from("entitlement_groups")
      .select("code, display_name, is_active");
    const { data: perms } = await supabase
      .from("permissions")
      .select("code, display_name");
    return `Current entitlement groups: ${JSON.stringify(groups || [])}\nAvailable permissions: ${JSON.stringify(perms || [])}`;
  }

  return "";
}

export async function POST(request: NextRequest) {
  const denied = await adminGuard(request, "can_access_admin");
  if (denied) return denied;

  const requestId = generateRequestId();
  const { prompt, panel } = await request.json();

  if (!prompt || !panel) {
    return NextResponse.json({ error: "prompt and panel are required" }, { status: 400 });
  }

  const tools = getToolsForPanel(panel);
  const context = await getContextForPanel(panel);
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
    logger.error("Admin AI orchestrator error", {
      error: err instanceof Error ? err.message : "Unknown",
      requestId,
      route: "api/admin/ai",
    });
    return NextResponse.json({ error: "AI service unavailable" }, { status: 500 });
  }
}
