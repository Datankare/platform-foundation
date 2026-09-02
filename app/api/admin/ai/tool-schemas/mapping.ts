/**
 * app/api/admin/ai/tool-schemas/mapping.ts — capability-mapping panel tool schema (Sprint 3c U3).
 */

import type { AdminTool } from "./index";

export const mappingSchemas: Record<string, AdminTool[]> = {
  "capability-mapping": [
    {
      name: "set_capability_mapping",
      description:
        "Set which account-status features a capability requires (the user gate checks all of them), or remove a capability's mapping. Setting replaces the capability's feature list; setting a new capability adds it.",
      input_schema: {
        type: "object",
        properties: {
          capability: {
            type: "string",
            description: "The capability name to map",
          },
          features: {
            type: "array",
            items: { type: "string" },
            description: "The required feature names (replaces the current list)",
          },
          remove: {
            type: "boolean",
            description: "true to remove this capability's mapping instead of setting it",
          },
        },
        required: ["capability"],
      },
    },
  ],
};
