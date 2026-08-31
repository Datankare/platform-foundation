/**
 * app/api/admin/ai/tool-schemas/restrictions.ts — restrictions panel tool schemas.
 */

import type { AdminTool } from "./index";

export const restrictionsSchemas: Record<string, AdminTool[]> = {
  "per-account": [
    {
      name: "block_user_feature",
      description:
        "Block a specific feature for a specific user, independent of their account status. The user keeps every other feature and their standing.",
      input_schema: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "User UUID to block" },
          feature: { type: "string", description: "Feature identifier to block" },
          reason: { type: "string", description: "Why the block is applied (audit)" },
        },
        required: ["user_id", "feature"],
      },
    },
    {
      name: "unblock_user_feature",
      description: "Lift a per-account feature block for a user.",
      input_schema: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "User UUID" },
          feature: { type: "string", description: "Feature identifier to unblock" },
        },
        required: ["user_id", "feature"],
      },
    },
  ],
};
