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

interface AdminTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

function getToolsForPanel(panel: string): AdminTool[] {
  const shared: AdminTool[] = [
    {
      name: "search",
      description: "Search for items. Returns matching results from the database.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query or filter" },
          table: { type: "string", description: "Table to search" },
        },
        required: ["query", "table"],
      },
    },
  ];

  const panelTools: Record<string, AdminTool[]> = {
    roles: [
      {
        name: "create_role",
        description:
          "Create a new role with specified permissions. Permissions are referenced by code (e.g. can_play, can_translate).",
        input_schema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Role slug (lowercase, no spaces)",
            },
            display_name: { type: "string", description: "Human-readable name" },
            description: { type: "string", description: "Role description" },
            permissions: {
              type: "array",
              items: { type: "string" },
              description: "Permission codes to assign",
            },
          },
          required: ["name", "display_name"],
        },
      },
      {
        name: "delete_role",
        description:
          "Delete a role. Returns impact analysis (how many players affected).",
        input_schema: {
          type: "object",
          properties: {
            role_name: { type: "string", description: "Role name to delete" },
          },
          required: ["role_name"],
        },
      },
      {
        name: "duplicate_role",
        description:
          "Duplicate an existing role with a new name. Copies all permissions.",
        input_schema: {
          type: "object",
          properties: {
            source_role: { type: "string", description: "Role to copy from" },
            new_name: { type: "string", description: "New role slug" },
            new_display_name: { type: "string", description: "New display name" },
          },
          required: ["source_role", "new_name", "new_display_name"],
        },
      },
      {
        name: "assign_permissions",
        description: "Add or remove permissions from a role.",
        input_schema: {
          type: "object",
          properties: {
            role_name: { type: "string", description: "Target role" },
            add: {
              type: "array",
              items: { type: "string" },
              description: "Permission codes to add",
            },
            remove: {
              type: "array",
              items: { type: "string" },
              description: "Permission codes to remove",
            },
          },
          required: ["role_name"],
        },
      },
      {
        name: "assign_role_to_player",
        description: "Assign a role to one or more players.",
        input_schema: {
          type: "object",
          properties: {
            role_name: { type: "string", description: "Role to assign" },
            player_ids: {
              type: "array",
              items: { type: "string" },
              description: "Player IDs to assign the role to",
            },
            player_emails: {
              type: "array",
              items: { type: "string" },
              description: "Player emails to assign the role to",
            },
          },
          required: ["role_name"],
        },
      },
    ],
    players: [
      {
        name: "change_player_role",
        description: "Change a player's role.",
        input_schema: {
          type: "object",
          properties: {
            player_identifier: {
              type: "string",
              description: "Player email or ID",
            },
            new_role: { type: "string", description: "New role name" },
          },
          required: ["player_identifier", "new_role"],
        },
      },
      {
        name: "bulk_change_role",
        description: "Change role for multiple players at once.",
        input_schema: {
          type: "object",
          properties: {
            player_identifiers: {
              type: "array",
              items: { type: "string" },
              description: "Player emails or IDs",
            },
            new_role: { type: "string", description: "New role name" },
          },
          required: ["player_identifiers", "new_role"],
        },
      },
      {
        name: "delete_player",
        description:
          "Soft-delete a player (GDPR). Anonymizes PII, preserves audit trail.",
        input_schema: {
          type: "object",
          properties: {
            player_identifier: {
              type: "string",
              description: "Player email or ID",
            },
          },
          required: ["player_identifier"],
        },
      },
    ],
    entitlements: [
      {
        name: "create_entitlement_group",
        description: "Create a new entitlement group with permissions.",
        input_schema: {
          type: "object",
          properties: {
            code: { type: "string", description: "Entitlement code (slug)" },
            display_name: { type: "string", description: "Human-readable name" },
            permissions: {
              type: "array",
              items: { type: "string" },
              description: "Permission codes to include",
            },
          },
          required: ["code", "display_name"],
        },
      },
      {
        name: "grant_entitlement",
        description: "Grant an entitlement to players.",
        input_schema: {
          type: "object",
          properties: {
            entitlement_code: { type: "string", description: "Entitlement code" },
            player_identifiers: {
              type: "array",
              items: { type: "string" },
              description: "Player emails or IDs",
            },
            expires_in_days: {
              type: "number",
              description: "Optional: auto-expire after N days",
            },
          },
          required: ["entitlement_code", "player_identifiers"],
        },
      },
      {
        name: "revoke_entitlement",
        description: "Revoke an entitlement from players.",
        input_schema: {
          type: "object",
          properties: {
            entitlement_code: { type: "string", description: "Entitlement code" },
            player_identifiers: {
              type: "array",
              items: { type: "string" },
              description: "Player emails or IDs",
            },
          },
          required: ["entitlement_code", "player_identifiers"],
        },
      },
      {
        name: "delete_entitlement_group",
        description: "Delete an entitlement group.",
        input_schema: {
          type: "object",
          properties: {
            code: { type: "string", description: "Entitlement code to delete" },
          },
          required: ["code"],
        },
      },
    ],
    audit: [
      {
        name: "search_audit",
        description:
          "Search audit log with natural language filters like time ranges, actions, actors.",
        input_schema: {
          type: "object",
          properties: {
            filter: {
              type: "string",
              description:
                "Natural language filter: e.g. 'role changes in the last 7 days'",
            },
          },
          required: ["filter"],
        },
      },
    ],
    "guest-config": [
      {
        name: "update_guest_config",
        description: "Update guest lifecycle configuration.",
        input_schema: {
          type: "object",
          properties: {
            nudge_after_sessions: { type: "number" },
            grace_after_sessions: { type: "number" },
            lockout_after_sessions: { type: "number" },
            guest_token_ttl_hours: { type: "number" },
          },
        },
      },
    ],
    "password-policy": [
      {
        name: "update_password_policy",
        description: "Update the global password policy.",
        input_schema: {
          type: "object",
          properties: {
            min_length: { type: "number" },
            rotation_days: { type: "number" },
            require_uppercase: { type: "boolean" },
            require_lowercase: { type: "boolean" },
            require_number: { type: "boolean" },
            require_special: { type: "boolean" },
            password_history_count: { type: "number" },
          },
        },
      },
    ],
  };

  return [...shared, ...(panelTools[panel] || [])];
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

  if (panel === "players") {
    const { data: roles } = await supabase.from("roles").select("name, display_name");
    const { count } = await supabase
      .from("players")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null);
    return `Total active players: ${count || 0}\nRoles: ${JSON.stringify(roles || [])}`;
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
