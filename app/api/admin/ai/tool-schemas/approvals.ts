/**
 * app/api/admin/ai/tool-schemas/approvals.ts — approvals panel tool schemas (ADR-040 040c).
 *
 * Approve-by-conversation: the model resolves the admin's request to a SPECIFIC pending
 * approval (from the panel context), and the decision is confirmed (mandatory) and executed
 * through the deterministic decision route — not the command-bar executor.
 */

import type { AdminTool } from "./index";

const idSchema = {
  type: "object",
  properties: {
    proposalId: {
      type: "string",
      description:
        "The id of the specific held change, taken from the pending-approvals context",
    },
    source: {
      type: "string",
      enum: ["runtime", "config-approval"],
      description: "The hold's source, from the context",
    },
    summary: {
      type: "string",
      description:
        "The change's human-readable label, so the admin can confirm the exact change",
    },
  },
  required: ["proposalId", "source"],
} as const;

export const approvalsSchemas: Record<string, AdminTool[]> = {
  approvals: [
    {
      name: "approve_hold",
      description:
        "Approve a held change, clearing it. Resolve the request to ONE specific pending approval from the context and set proposalId, source, and summary accordingly. Never guess an id that is not in the context.",
      input_schema: idSchema as unknown as Record<string, unknown>,
    },
    {
      name: "reject_hold",
      description:
        "Reject a held change. Resolve the request to ONE specific pending approval from the context and set proposalId, source, and summary accordingly. Never guess an id that is not in the context.",
      input_schema: idSchema as unknown as Record<string, unknown>,
    },
  ],
};
