/**
 * app/api/admin/ai/tool-schemas/config.ts — config panel tool schemas.
 */

import type { AdminTool } from "./index";

export const configSchemas: Record<string, AdminTool[]> = {
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
