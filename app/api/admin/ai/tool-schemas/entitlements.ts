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
  ],
};
