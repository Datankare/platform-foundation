/**
 * app/api/admin/ai/tool-permissions.ts — The permission each command-bar action requires (TASK-145)
 *
 * The AI command bar is a second path to the same changes the admin pages make, so each action
 * requires the same permission as its page. Entering the admin area (`can_access_admin`) only
 * lets an admin use the command bar; it never authorises an action by itself.
 * `__tests__/admin-authorization-matrix.test.ts` fails when an action has no entry here, or its
 * entry differs from the permission its admin route requires.
 *
 * @module app/api/admin/ai
 */

export const ADMIN_TOOL_PERMISSIONS = {
  create_role: "admin_manage_roles",
  delete_role: "admin_manage_roles",
  duplicate_role: "admin_manage_roles",
  assign_permissions: "admin_manage_roles",
  change_user_role: "admin_manage_users",
  create_entitlement_group: "admin_manage_entitlements",
  // PATCH /api/admin/entitlements as a governed action, so the page can hold it (review 7 M6).
  set_entitlement_group_active: "admin_manage_entitlements",
  update_password_policy: "admin_manage_config",
  register_agent: "admin_manage_agents",
  suspend_agent: "admin_manage_agents",
  set_agent_scope: "admin_manage_agents",
  set_agent_ttl: "admin_manage_agents",
  block_user_feature: "admin_manage_account_restrictions",
  unblock_user_feature: "admin_manage_account_restrictions",
  set_approval_policy: "admin_manage_approval_policy",
  set_capability_mapping: "admin_manage_config",
  // search reads one of these tables; each table requires its own page's permission.
  search: "can_access_admin",
} as const satisfies Record<string, string>;

export type AdminToolId = keyof typeof ADMIN_TOOL_PERMISSIONS;

/** The tables `search` may read, each with the permission its admin page requires. */
export const SEARCHABLE_TABLES = {
  users: "admin_manage_users",
  roles: "admin_manage_roles",
  permissions: "admin_manage_roles",
  role_permissions: "admin_manage_roles",
  entitlement_groups: "admin_manage_entitlements",
  audit_log: "admin_view_audit",
  platform_config: "config_view",
} as const satisfies Record<string, string>;

/**
 * Plan-only tools: the command bar proposes them, and the admin page sends the confirmed decision
 * to its own route (approve_hold / reject_hold → POST /api/admin/approvals/[id], which checks the
 * decider's authority and independence itself).
 */
export const CLIENT_ROUTED_TOOLS = {
  approve_hold: "can_access_admin",
  reject_hold: "can_access_admin",
} as const satisfies Record<string, string>;

/** The permission a panel's page requires; the planner reads that panel's data only with it. */
export const PANEL_CONTEXT_PERMISSIONS: Readonly<Record<string, string>> = {
  roles: "admin_manage_roles",
  users: "admin_manage_users",
  entitlements: "admin_manage_entitlements",
  approvals: "can_access_admin",
};

/** The permission any command-bar tool name requires, or undefined for an unknown tool. */
export function toolPermission(tool: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(ADMIN_TOOL_PERMISSIONS, tool)) {
    return ADMIN_TOOL_PERMISSIONS[tool as AdminToolId];
  }
  if (Object.prototype.hasOwnProperty.call(CLIENT_ROUTED_TOOLS, tool)) {
    return CLIENT_ROUTED_TOOLS[tool as keyof typeof CLIENT_ROUTED_TOOLS];
  }
  return undefined;
}
