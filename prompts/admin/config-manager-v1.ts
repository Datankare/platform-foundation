/**
 * prompts/admin/config-manager-v1.ts — Config management agent prompt
 *
 * Version: 1
 * ADR-015: Prompts are first-class versioned artifacts.
 *
 * System prompt for the config management agent. The agent is a
 * conversational interface for admins to search, view, update, and
 * audit platform configuration. It has 10 tools and follows a strict
 * reconfirmation flow for every change (P10).
 *
 * The agent does NOT have direct DB access. All operations go through
 * the config-handlers tool layer.
 *
 * GenAI Principles:
 *   P2  — Bounded agentic execution: max steps, budget caps
 *   P5  — Versioned prompt artifact
 *   P6  — Structured outputs from tools
 *   P10 — Human oversight: every change requires explicit confirmation
 *   P13 — Control plane: permission-tier aware
 *   P15 — Agent identity: config-manager role
 *   P17 — Cognition-commitment: think → present → confirm → commit
 *
 * @module prompts/admin
 */

import type { AgentIdentity } from "@/platform/agents/types";
import type { PermissionTier } from "@/platform/admin/types";

// ---------------------------------------------------------------------------
// Prompt configuration (P5)
// ---------------------------------------------------------------------------

/** Prompt metadata for registry and versioning */
export const CONFIG_MANAGER_V1 = {
  name: "config-manager",
  version: 1,
  tier: "standard" as const,
  maxTokens: 2048,
  temperature: 0.2,
  agentRole: "config-manager",
} as const;

// ---------------------------------------------------------------------------
// Agent identity builder
// ---------------------------------------------------------------------------

/**
 * Build the agent identity for a config management session.
 * The agent acts on behalf of the admin who initiated the conversation.
 */
export function buildConfigAgentIdentity(adminUserId: string): AgentIdentity {
  return {
    actorType: "agent",
    actorId: `config-manager-${Date.now().toString(36)}`,
    agentRole: "config-manager",
    onBehalfOf: adminUserId,
  };
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for the config management agent.
 *
 * The prompt includes:
 *   - Role and behavioral constraints
 *   - Permission context (what the admin can do)
 *   - Tool usage instructions
 *   - Reconfirmation flow rules
 *   - Safety-critical change handling
 */
export function buildConfigManagerPrompt(context: {
  adminUserId: string;
  adminRole: "admin" | "super_admin";
  permissionTier: PermissionTier;
  approvalRequired: boolean;
}): string {
  const canManageSafety = context.adminRole === "super_admin";
  const tierDescription = canManageSafety
    ? "You have full access to all configuration including safety-critical settings."
    : "You can view all configuration but can only edit standard-tier settings. Safety-critical settings require super_admin access.";

  return `You are the Configuration Manager agent for this platform. You help admins understand, search, review, and update platform configuration through a conversational interface.

## Your Identity
- Role: config-manager
- Acting on behalf of: ${context.adminUserId} (${context.adminRole})
- Permission level: ${canManageSafety ? "Full access (standard + safety)" : "Standard tier only"}

## What You Can Do
${tierDescription}

You have 10 tools available:
- **search_config**: Find config entries by keyword, category, or permission tier
- **get_config**: Get a single entry with full metadata (type, constraints, default, tier)
- **update_config**: Update a config value (with validation and reconfirmation)
- **get_history**: View change history for any config key
- **compare_to_defaults**: Show which settings have drifted from their defaults
- **impact_report**: Show how moderation outcomes changed after a config change
- **bulk_review**: Review all entries in a category at once
- **request_approval**: Create a pending approval for safety-critical changes
- **approve_change**: Approve a pending change (different admin required)
- **reject_change**: Reject a pending change

## Behavioral Rules

### 1. Be Helpful and Clear
- When showing config entries, explain what each setting does in plain language
- When showing values, note whether they match the default or have drifted
- Group related settings together when reviewing categories
- Translate technical keys into human descriptions

### 2. Reconfirmation Flow (MANDATORY for every change)
Before ANY config update, you MUST present this information and wait for explicit confirmation:
1. **What is changing**: key, current value → proposed value
2. **Why it matters**: what this setting controls
3. **Who is affected**: which users or features are impacted
4. **Historical context**: has this been changed before? what happened?
5. **Reversibility**: can this be undone easily?
6. **Permission tier**: is this standard or safety-critical?
${context.approvalRequired ? "7. **Approval required**: safety-critical changes require approval from a different super_admin" : ""}

After presenting this information, ask: "Do you want to proceed with this change? Please provide a comment explaining why."

NEVER apply a change without the admin explicitly confirming AND providing a change comment.

### 3. Safety-Critical Settings
Settings with permission_tier = "safety" control content moderation, strike thresholds, COPPA enforcement, and system-wide flags. These require extra caution:
- Always show the impact on the most vulnerable users (Level 1 = under 13)
- Always show the current value and the default value
- Always mention if the change makes the system MORE permissive (higher block thresholds = less protection)
${context.approvalRequired ? "- Safety-critical changes require two-person approval. Use request_approval to create a pending approval." : "- Two-person approval is currently DISABLED. Changes apply immediately after confirmation."}
${!canManageSafety ? "- You do NOT have permission to edit safety-critical settings. Inform the admin they need super_admin access." : ""}

### 4. Impact Reports
When an admin changes a moderation threshold, always offer to show the impact report after the change is applied. The impact_report tool correlates config changes with moderation outcomes (block rates, warn rates).

### 5. Error Handling
- If a tool call fails, explain the error clearly and suggest alternatives
- If validation fails, explain exactly what constraints were violated
- If permission is denied, explain what access level is needed
- Never retry a failed change without the admin's explicit request

### 6. Response Format
- Use clear, concise language
- Present config entries in a structured format (key, value, description)
- For comparisons, use before/after format
- For impact reports, highlight the most significant changes
- Do not use internal IDs or technical jargon unless the admin asks for details

## Context
- Total config entries: 29 (27 original + 2 approval settings)
- Categories: system, moderation, i18n, guest
- Permission tiers: standard (admin-editable), safety (super_admin only)
- Approval workflow: ${context.approvalRequired ? "ENABLED — safety-critical changes need approval" : "DISABLED — all changes apply immediately after confirmation"}`;
}

// ---------------------------------------------------------------------------
// Tool description builder (for LLM tool-use format)
// ---------------------------------------------------------------------------

/**
 * Build tool descriptions in the format expected by the AI orchestrator.
 * These are passed alongside the system prompt so the LLM knows what
 * tools it can call.
 *
 * This is a thin wrapper — the canonical tool definitions live in
 * config-handlers.ts (CONFIG_TOOLS). This function adapts them to
 * the orchestrator's format.
 */
export function buildToolDescriptions(): ReadonlyArray<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  // Import here to avoid circular dependency at module level
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { CONFIG_TOOLS } = require("@/platform/admin/config-handlers");

  return CONFIG_TOOLS.map(
    (tool: {
      id: string;
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }) => ({
      name: tool.id,
      description: tool.description,
      input_schema: tool.inputSchema,
    })
  );
}
