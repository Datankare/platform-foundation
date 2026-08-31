/**
 * app/api/admin/ai/tool-schemas/agents.ts — agents panel tool schemas.
 */

import type { AdminTool } from "./index";

export const agentsSchemas: Record<string, AdminTool[]> = {
  "agent-registry": [
    {
      name: "register_agent",
      description:
        "Register a new trusted agent. Provide the agent id, its owner, and the capability scopes it may act on. Status defaults to active.",
      input_schema: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: "Agent identifier (e.g. agent:<name>)",
          },
          owner: { type: "string", description: "Owner label (default first-party)" },
          scopes: {
            type: "array",
            items: { type: "string" },
            description: "Capability names the agent may act on",
          },
          max_token_ttl: {
            type: "number",
            description: "Per-agent token-lifetime ceiling in seconds (default 300)",
          },
        },
        required: ["agent_id"],
      },
    },
    {
      name: "suspend_agent",
      description:
        "Suspend an agent (it can no longer act on any capability), or reactivate a suspended one.",
      input_schema: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Agent to suspend or reactivate" },
          reactivate: {
            type: "boolean",
            description: "true to reactivate; omit or false to suspend",
          },
        },
        required: ["agent_id"],
      },
    },
    {
      name: "set_agent_scope",
      description:
        "Replace the set of capabilities an agent may act on. The new scope fully replaces the old.",
      input_schema: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Agent whose scope to set" },
          scopes: {
            type: "array",
            items: { type: "string" },
            description: "The complete new capability set",
          },
        },
        required: ["agent_id", "scopes"],
      },
    },
    {
      name: "set_agent_ttl",
      description:
        "Set an agent's per-agent token-lifetime ceiling (seconds). The effective token TTL is the minimum of the request, this ceiling, and the global cap.",
      input_schema: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Agent whose ceiling to set" },
          max_token_ttl: {
            type: "number",
            description: "Ceiling in seconds (positive)",
          },
        },
        required: ["agent_id", "max_token_ttl"],
      },
    },
  ],
};
