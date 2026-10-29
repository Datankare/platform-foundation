/**
 * app/api/admin/ai/tool-schemas/index.ts — admin AI tool schemas.
 *
 * The AdminTool type, the SHARED_TOOLS every panel gets, and PANEL_TOOL_SCHEMAS
 * assembled from the per-domain schema files. Extracted from route.ts so
 * getToolsForPanel stays a thin lookup and adding a panel never grows a function.
 */

import { rolesSchemas } from "./roles";
import { entitlementsSchemas } from "./entitlements";
import { configSchemas } from "./config";
import { agentsSchemas } from "./agents";
import { restrictionsSchemas } from "./restrictions";
import { approvalSchemas } from "./approval";
import { mappingSchemas } from "./mapping";
import { approvalsSchemas } from "./approvals";
import { SEARCHABLE_TABLES } from "../tool-permissions";
import { AUDIT_ACTIONS } from "@/platform/auth/audit";
import { SEARCH_MAX_DAYS, SEARCH_USER_STATUSES } from "../handlers/search";

export interface AdminTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * search (TASK-189): one table, read with typed filters — never free text the server would have
 * to interpret. Each filter applies to the tables named in its description (SEARCH_FILTERS in
 * handlers/search.ts); a filter the table does not take is refused, as is a bad value. No
 * filter: the 20 newest rows. Periods are in days back from now (the planner has no clock).
 */
export const SHARED_TOOLS: AdminTool[] = [
  {
    name: "search",
    description:
      "Read up to 20 rows (newest first) of one admin table, narrowed by optional filters. " +
      "Use only the filters listed for the table; pass no filter to list the newest rows. " +
      "Periods are whole days back from now (this week = 7). The result shows only the " +
      "columns the table's admin page shows.",
    input_schema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          enum: Object.keys(SEARCHABLE_TABLES),
          description: "Table to read",
        },
        text: {
          type: "string",
          description:
            "Substring, case-insensitive. users: email or display name; roles: name or " +
            "display name; permissions: code, display name or category; role_permissions: " +
            "role name or permission code; entitlement_groups: code or display name; " +
            "audit_log: action names containing it; platform_config: key or description",
        },
        role: {
          type: "string",
          description: "users only: the role's name, e.g. moderator",
        },
        status: {
          type: "string",
          enum: [...SEARCH_USER_STATUSES],
          description: "users only: the account's standing",
        },
        signed_in_within_days: {
          type: "integer",
          minimum: 1,
          maximum: SEARCH_MAX_DAYS,
          description: "users only: signed in within this many days",
        },
        created_within_days: {
          type: "integer",
          minimum: 1,
          maximum: SEARCH_MAX_DAYS,
          description: "users only: created within this many days",
        },
        action: {
          type: "string",
          enum: [...AUDIT_ACTIONS],
          description: "audit_log only: one action",
        },
        actor_id: {
          type: "string",
          description: "audit_log only: the acting account's id",
        },
        target_id: {
          type: "string",
          description: "audit_log only: the affected account's id",
        },
        within_days: {
          type: "integer",
          minimum: 1,
          maximum: SEARCH_MAX_DAYS,
          description: "audit_log only: recorded within this many days",
        },
        category: { type: "string", description: "platform_config only: one category" },
      },
      required: ["table"],
      additionalProperties: false,
    },
  },
];

export const PANEL_TOOL_SCHEMAS: Record<string, AdminTool[]> = {
  ...rolesSchemas,
  ...entitlementsSchemas,
  ...configSchemas,
  ...agentsSchemas,
  ...restrictionsSchemas,
  ...approvalSchemas,
  ...mappingSchemas,
  ...approvalsSchemas,
};
