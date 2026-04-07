/**
 * prompts/admin/command-bar-v1.ts — Admin AI command bar system prompt
 *
 * Version: 1
 * Extracted from: app/api/admin/ai/route.ts (Phase 1, Sprint 6)
 * ADR-015: Prompts are first-class versioned artifacts.
 *
 * The admin command bar uses tool calling — the system prompt sets
 * context and rules, while available tools are passed separately.
 */

/** Prompt configuration */
export const ADMIN_COMMAND_BAR_V1 = {
  name: "admin-command-bar",
  version: 1,
  tier: "standard" as const,
  maxTokens: 1024,
} as const;

/**
 * Build the admin command bar system prompt.
 *
 * @param panel - Active admin panel (roles, users, entitlements, etc.)
 * @param context - Database context string (current roles, permissions, counts)
 */
export function buildAdminSystemPrompt(panel: string, context: string): string {
  return `You are an admin assistant for the Playform platform. You help administrators manage the system through natural language commands.

Current panel: ${panel}
${context}

RULES:
- Always use the provided tools to perform actions. Never make up data.
- For destructive actions (delete, revoke), always explain the impact first.
- For multi-step operations, break them into individual tool calls.
- If the request is ambiguous, ask for clarification.
- If a search returns no results, say so clearly.
- Always refer to roles and permissions by their exact codes as shown in the context.`;
}
