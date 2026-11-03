/**
 * app/api/admin/ai/tool-schemas/approval.ts — approval-policy panel tool schemas (Sprint 3c U1).
 */

import type { AdminTool } from "./index";

export const approvalSchemas: Record<string, AdminTool[]> = {
  "approval-policy": [
    {
      name: "set_approval_policy",
      description:
        'Replace the agent-action approval policy: an ordered list of rules; each matches actions at or below a risk level (and optionally specific effect types) and names who must approve. A restricted action is always approved by a person whatever the rules say, and every action held today is restricted — so the rules decide only for actions below that risk, in an app that holds them. default_approver, if given, must be "user". Writing a policy mints a new version (the change is audited).',
      input_schema: {
        type: "object",
        properties: {
          default_approver: {
            type: "string",
            enum: ["user"],
            description:
              "Optional. Who approves an action that matches no rule — always a person; absent, it stays as it is",
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
        // default_approver is optional (round 13, nit 7): absent, the current default stands;
        // given, it must be "user" (the enum) — the handler, the hold check and the stores refuse
        // another.
        required: ["rules"],
      },
    },
  ],
};
