/**
 * app/api/admin/ai/tool-schemas/entitlements.ts — entitlements panel tool schemas.
 */

import type { AdminTool } from "./index";

export const entitlementsSchemas: Record<string, AdminTool[]> = {
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
      description: "Grant an entitlement to users.",
      input_schema: {
        type: "object",
        properties: {
          entitlement_code: { type: "string", description: "Entitlement code" },
          user_identifiers: {
            type: "array",
            items: { type: "string" },
            description: "User emails or IDs",
          },
          expires_in_days: {
            type: "number",
            description: "Optional: auto-expire after N days",
          },
        },
        required: ["entitlement_code", "user_identifiers"],
      },
    },
    {
      name: "revoke_entitlement",
      description: "Revoke an entitlement from users.",
      input_schema: {
        type: "object",
        properties: {
          entitlement_code: { type: "string", description: "Entitlement code" },
          user_identifiers: {
            type: "array",
            items: { type: "string" },
            description: "User emails or IDs",
          },
        },
        required: ["entitlement_code", "user_identifiers"],
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
};
