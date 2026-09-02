/**
 * app/api/admin/ai/tool-schemas/approval.ts — approval-policy panel tool schemas (Sprint 3c U1).
 */

import type { AdminTool } from "./index";

export const approvalSchemas: Record<string, AdminTool[]> = {
  "approval-policy": [
    {
      name: "set_approval_policy",
      description:
        "Replace the agent-action approval policy. Set the default approver and an ordered list of rules; each rule matches actions at or below a risk level (and optionally specific effect types) and names who must approve. Writing a policy mints a new version (the change is audited).",
      input_schema: {
        type: "object",
        properties: {
          default_approver: {
            type: "string",
            enum: ["user", "agent", "system"],
            description: "Who approves an action that matches no rule",
          },
          rules: {
            type: "array",
            description: "Ordered rules; the first match wins",
            items: {
              type: "object",
              properties: {
                max_risk: {
                  type: "string",
                  enum: ["ordinary", "consequential", "restricted"],
                  description: "Rule matches actions at or below this risk level",
                },
                effects: {
                  type: "array",
                  items: { type: "string" },
                  description: "Optional effect types the rule is limited to",
                },
                required_approver: {
                  type: "string",
                  enum: ["user", "agent", "system"],
                  description: "Who must approve a matching action",
                },
              },
              required: ["max_risk", "required_approver"],
            },
          },
        },
        required: ["default_approver", "rules"],
      },
    },
  ],
};
