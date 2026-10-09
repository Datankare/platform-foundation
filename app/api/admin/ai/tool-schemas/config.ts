/**
 * app/api/admin/ai/tool-schemas/config.ts — config panel tool schemas.
 */

import type { AdminTool } from "./index";

export const configSchemas: Record<string, AdminTool[]> = {
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
