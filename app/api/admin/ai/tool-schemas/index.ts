/**
 * app/api/admin/ai/tool-schemas/index.ts — admin AI tool schemas.
 *
 * The AdminTool type, the SHARED_TOOLS every panel gets, and PANEL_TOOL_SCHEMAS
 * assembled from the per-domain schema files. Extracted from route.ts so
 * getToolsForPanel stays a thin lookup and adding a panel never grows a function.
 */

import { rolesSchemas } from "./roles";
import { entitlementsSchemas } from "./entitlements";
import { configSchemas } from "./config";
import { agentsSchemas } from "./agents";
import { restrictionsSchemas } from "./restrictions";
import { approvalSchemas } from "./approval";
import { mappingSchemas } from "./mapping";

export interface AdminTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const SHARED_TOOLS: AdminTool[] = [
  {
    name: "search",
    description: "Search for items. Returns matching results from the database.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query or filter" },
        table: { type: "string", description: "Table to search" },
      },
      required: ["query", "table"],
    },
  },
];

export const PANEL_TOOL_SCHEMAS: Record<string, AdminTool[]> = {
  ...rolesSchemas,
  ...entitlementsSchemas,
  ...configSchemas,
  ...agentsSchemas,
  ...restrictionsSchemas,
  ...approvalSchemas,
  ...mappingSchemas,
};
