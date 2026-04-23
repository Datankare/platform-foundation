/**
 * platform/admin/config-handlers.ts — Config agent tool implementations
 *
 * Each function implements one tool that the config management agent can
 * invoke. Tools are stateless — they read/write via platform-config and
 * the approval/impact services. The agent orchestrates tool calls; these
 * functions just do the work.
 *
 * Tool roster (10):
 *   search_config      — find config entries by keyword, category, tier
 *   get_config         — get a single config entry with full metadata
 *   update_config      — validated update with reconfirmation data
 *   get_history        — change history for a key or all keys
 *   compare_to_defaults — show current vs default values
 *   impact_report      — moderation outcome changes after a config change
 *   bulk_review        — review all entries in a category or tier
 *   request_approval   — create a pending approval for safety-critical changes
 *   approve_change     — approve a pending change (different super_admin)
 *   reject_change      — reject a pending change
 *
 * GenAI Principles:
 *   P2  — Agentic execution: tools are bounded, single-purpose operations
 *   P3  — Total observability: every tool call timed and returned as ConfigToolResult
 *   P5  — Versioned artifacts: tool definitions exported for agent registration
 *   P6  — Structured outputs: all results typed via ConfigToolResult
 *   P10 — Human oversight: update_config returns reconfirmation data, not auto-applies
 *   P13 — Control plane: permission tier checks on every mutation
 *
 * @module platform/admin
 */

import {
  getEnhancedConfig,
  listEnhancedConfig,
  validateConfigValue,
  setConfigWithHistory,
  getConfigHistory,
} from "@/platform/auth/platform-config";
import {
  isApprovalRequired,
  requestApproval as createApprovalRequest,
  approveChange as approveApprovalChange,
  rejectChange as rejectApprovalChange,
} from "./config-approval";
import { generateImpactReport, isModerationConfig } from "./config-impact";
import type {
  ConfigToolResult,
  ConfigChangeRequest,
  ConfigSearchOptions,
  ConfigHistoryOptions,
  PermissionTier,
  EnhancedConfigEntry,
} from "./types";
import type { Tool } from "@/platform/agents/types";

// ---------------------------------------------------------------------------
// Tool execution wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a tool handler in timing and error handling.
 * Every tool call produces a ConfigToolResult regardless of outcome.
 */
async function executeToolCall<T>(
  toolId: string,
  fn: () => Promise<T>
): Promise<ConfigToolResult> {
  const start = Date.now();
  try {
    const data = await fn();
    return {
      toolId,
      success: true,
      data,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      toolId,
      success: false,
      data: null,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: search_config
// ---------------------------------------------------------------------------

export interface SearchConfigInput {
  readonly query?: string;
  readonly category?: string;
  readonly permissionTier?: PermissionTier;
}

/**
 * Search config entries by keyword, category, or permission tier.
 * Returns matching entries with full metadata.
 */
export async function handleSearchConfig(
  input: SearchConfigInput
): Promise<ConfigToolResult> {
  return executeToolCall("search_config", async () => {
    const options: ConfigSearchOptions = {
      query: input.query,
      category: input.category,
      permissionTier: input.permissionTier,
    };
    const entries = await listEnhancedConfig(options);
    return {
      entries,
      count: entries.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Tool: get_config
// ---------------------------------------------------------------------------

export interface GetConfigInput {
  readonly key: string;
}

/**
 * Get a single config entry with full metadata.
 */
export async function handleGetConfig(input: GetConfigInput): Promise<ConfigToolResult> {
  return executeToolCall("get_config", async () => {
    const entry = await getEnhancedConfig(input.key);
    if (!entry) {
      return { found: false, key: input.key };
    }
    return { found: true, entry };
  });
}

// ---------------------------------------------------------------------------
// Tool: update_config
// ---------------------------------------------------------------------------

export interface UpdateConfigInput {
  readonly key: string;
  readonly value: unknown;
  readonly changeComment: string;
  readonly actorId: string;
}

/**
 * Update a config entry with full validation.
 *
 * This tool does NOT auto-apply the change. It returns a
 * ConfigChangeRequest with all reconfirmation data. The agent
 * presents this to the admin for confirmation. Only after
 * explicit confirmation does the agent call applyConfigChange().
 *
 * For safety-tier keys with two-person approval enabled, this
 * creates a pending approval instead of applying.
 */
export async function handleUpdateConfig(
  input: UpdateConfigInput
): Promise<ConfigToolResult> {
  return executeToolCall("update_config", async () => {
    // 1. Load entry metadata
    const entry = await getEnhancedConfig(input.key);
    if (!entry) {
      return {
        applied: false,
        error: `Config key "${input.key}" not found.`,
      };
    }

    // 2. Validate proposed value
    const validation = validateConfigValue(entry, input.value);
    if (!validation.valid) {
      return {
        applied: false,
        validationErrors: validation.errors,
      };
    }

    // 3. Check if two-person approval is needed
    const needsApproval =
      entry.permissionTier === "safety" && (await isApprovalRequired());

    // 4. Build the reconfirmation data
    const changeRequest: ConfigChangeRequest = {
      key: input.key,
      currentValue: entry.value,
      proposedValue: input.value,
      impact: buildImpactDescription(entry, input.value),
      affectedUsers: buildAffectedUsersDescription(entry),
      reversible: true,
      permissionTier: entry.permissionTier,
      requiresApproval: needsApproval,
      changeComment: input.changeComment,
    };

    if (needsApproval) {
      // Create pending approval — don't apply
      const approvalResult = await createApprovalRequest({
        configKey: input.key,
        currentValue: entry.value,
        proposedValue: input.value,
        requestedBy: input.actorId,
        changeComment: input.changeComment,
        impactSummary: changeRequest.impact,
      });

      return {
        applied: false,
        requiresApproval: true,
        approval: approvalResult.record,
        approvalError: approvalResult.error,
        changeRequest,
      };
    }

    // 5. Apply the change directly
    const result = await setConfigWithHistory(
      input.key,
      input.value,
      input.actorId,
      input.changeComment,
      "config_agent"
    );

    return {
      applied: result.success,
      error: result.error,
      validationErrors: result.validationErrors,
      changeRequest,
    };
  });
}

/** Generate a human-readable impact description */
function buildImpactDescription(
  entry: EnhancedConfigEntry,
  proposedValue: unknown
): string {
  const parts: string[] = [];

  parts.push(
    `Changing "${entry.key}" from ${JSON.stringify(entry.value)} to ${JSON.stringify(proposedValue)}.`
  );

  if (entry.permissionTier === "safety") {
    parts.push(
      "This is a safety-critical setting. Changes affect content moderation behavior."
    );
  }

  if (entry.key.includes("block_severity") || entry.key.includes("warn_severity")) {
    parts.push(
      "Moderation threshold changes affect how content is screened in real-time."
    );
  }

  if (entry.key.includes("strike")) {
    parts.push("Strike threshold changes affect account consequence escalation.");
  }

  if (entry.key === "maintenance_mode") {
    parts.push("Enabling maintenance mode makes the platform read-only for all users.");
  }

  if (entry.key === "signups_enabled") {
    parts.push("Disabling signups prevents new account creation.");
  }

  return parts.join(" ");
}

/** Generate a human-readable description of affected users */
function buildAffectedUsersDescription(entry: EnhancedConfigEntry): string {
  if (entry.key.includes("level1")) {
    return "Users under 13 (COPPA-protected, strictest content rating)";
  }
  if (entry.key.includes("level2")) {
    return "Teen users (13–17, moderate content rating)";
  }
  if (entry.key.includes("level3")) {
    return "Adult users (18+, standard content rating)";
  }
  if (entry.key.includes("strike")) {
    return "All users — affects account consequence escalation";
  }
  if (entry.key === "rate_limit_rpm") {
    return "All users — affects API request throttling";
  }
  if (entry.key === "maintenance_mode" || entry.key === "signups_enabled") {
    return "All users — platform-wide setting";
  }
  if (entry.category === "moderation") {
    return "All users — affects content safety pipeline";
  }
  return "Varies by setting";
}

// ---------------------------------------------------------------------------
// Tool: get_history
// ---------------------------------------------------------------------------

export interface GetHistoryInput {
  readonly configKey?: string;
  readonly limit?: number;
  readonly since?: string;
  readonly before?: string;
}

/**
 * Get change history for a config key or all keys.
 */
export async function handleGetHistory(
  input: GetHistoryInput
): Promise<ConfigToolResult> {
  return executeToolCall("get_history", async () => {
    const options: ConfigHistoryOptions = {
      configKey: input.configKey,
      limit: input.limit ?? 20,
      since: input.since,
      before: input.before,
    };
    const records = await getConfigHistory(options);
    return {
      records,
      count: records.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Tool: compare_to_defaults
// ---------------------------------------------------------------------------

export interface CompareToDefaultsInput {
  readonly category?: string;
  readonly onlyDrifted?: boolean;
}

/**
 * Compare current config values to their defaults.
 * Optionally filtered to only show values that have drifted.
 */
export async function handleCompareToDefaults(
  input: CompareToDefaultsInput
): Promise<ConfigToolResult> {
  return executeToolCall("compare_to_defaults", async () => {
    const entries = await listEnhancedConfig({
      category: input.category,
    });

    const comparisons = entries.map((entry) => ({
      key: entry.key,
      currentValue: entry.value,
      defaultValue: entry.defaultValue,
      isDrifted: JSON.stringify(entry.value) !== JSON.stringify(entry.defaultValue),
      category: entry.category,
      permissionTier: entry.permissionTier,
    }));

    const filtered = input.onlyDrifted
      ? comparisons.filter((c) => c.isDrifted)
      : comparisons;

    return {
      comparisons: filtered,
      totalCount: comparisons.length,
      driftedCount: comparisons.filter((c) => c.isDrifted).length,
    };
  });
}

// ---------------------------------------------------------------------------
// Tool: impact_report
// ---------------------------------------------------------------------------

export interface ImpactReportInput {
  readonly configKey: string;
  readonly limit?: number;
}

/**
 * Generate impact reports for recent changes to a config key.
 * Only meaningful for moderation-category config keys.
 */
export async function handleImpactReport(
  input: ImpactReportInput
): Promise<ConfigToolResult> {
  return executeToolCall("impact_report", async () => {
    if (!isModerationConfig(input.configKey)) {
      return {
        reports: [],
        message: `Impact reports are only available for moderation config keys. "${input.configKey}" is not a moderation key.`,
      };
    }

    const history = await getConfigHistory({
      configKey: input.configKey,
      limit: input.limit ?? 5,
    });

    if (history.length === 0) {
      return {
        reports: [],
        message: `No change history found for "${input.configKey}".`,
      };
    }

    // Generate impact reports for each change
    // Each change's "after" window ends at the next change (or now)
    const reports = [];
    for (let i = 0; i < history.length; i++) {
      const nextChangeAt = i > 0 ? history[i - 1].createdAt : undefined;
      const report = await generateImpactReport(history[i], nextChangeAt);
      reports.push(report);
    }

    return { reports };
  });
}

// ---------------------------------------------------------------------------
// Tool: bulk_review
// ---------------------------------------------------------------------------

export interface BulkReviewInput {
  readonly category?: string;
  readonly permissionTier?: PermissionTier;
}

/**
 * Review all config entries in a category or permission tier.
 * Groups entries by category and shows current values, defaults,
 * and drift status.
 */
export async function handleBulkReview(
  input: BulkReviewInput
): Promise<ConfigToolResult> {
  return executeToolCall("bulk_review", async () => {
    const entries = await listEnhancedConfig({
      category: input.category,
      permissionTier: input.permissionTier,
    });

    // Group by category
    const grouped: Record<string, EnhancedConfigEntry[]> = {};
    for (const entry of entries) {
      const cat = entry.category;
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(entry);
    }

    return {
      entries,
      totalCount: entries.length,
      categories: Object.keys(grouped),
      byCategory: grouped,
    };
  });
}

// ---------------------------------------------------------------------------
// Tool: request_approval
// ---------------------------------------------------------------------------

export interface RequestApprovalInput {
  readonly configKey: string;
  readonly proposedValue: unknown;
  readonly changeComment: string;
  readonly actorId: string;
}

/**
 * Create a pending approval for a safety-critical config change.
 */
export async function handleRequestApproval(
  input: RequestApprovalInput
): Promise<ConfigToolResult> {
  return executeToolCall("request_approval", async () => {
    // Load current value
    const entry = await getEnhancedConfig(input.configKey);
    if (!entry) {
      return { success: false, error: `Config key "${input.configKey}" not found.` };
    }

    // Validate before creating approval
    const validation = validateConfigValue(entry, input.proposedValue);
    if (!validation.valid) {
      return {
        success: false,
        validationErrors: validation.errors,
      };
    }

    const result = await createApprovalRequest({
      configKey: input.configKey,
      currentValue: entry.value,
      proposedValue: input.proposedValue,
      requestedBy: input.actorId,
      changeComment: input.changeComment,
      impactSummary: buildImpactDescription(entry, input.proposedValue),
    });

    return result;
  });
}

// ---------------------------------------------------------------------------
// Tool: approve_change
// ---------------------------------------------------------------------------

export interface ApproveChangeInput {
  readonly approvalId: string;
  readonly reviewerId: string;
  readonly reviewComment: string;
}

/**
 * Approve a pending config change. Applies the change if approval succeeds.
 */
export async function handleApproveChange(
  input: ApproveChangeInput
): Promise<ConfigToolResult> {
  return executeToolCall("approve_change", async () => {
    const result = await approveApprovalChange(
      input.approvalId,
      input.reviewerId,
      input.reviewComment
    );

    if (!result.success) {
      return result;
    }

    // Gotcha #4 from config-approval: approval doesn't apply the change.
    // Apply it now that approval is granted.
    const record = result.record!;
    const applyResult = await setConfigWithHistory(
      record.configKey,
      record.proposedValue,
      input.reviewerId,
      `Approved: ${record.changeComment}`,
      "config_agent"
    );

    return {
      approved: true,
      applied: applyResult.success,
      applyError: applyResult.error,
      approval: record,
    };
  });
}

// ---------------------------------------------------------------------------
// Tool: reject_change
// ---------------------------------------------------------------------------

export interface RejectChangeInput {
  readonly approvalId: string;
  readonly reviewerId: string;
  readonly reviewComment: string;
}

/**
 * Reject a pending config change.
 */
export async function handleRejectChange(
  input: RejectChangeInput
): Promise<ConfigToolResult> {
  return executeToolCall("reject_change", async () => {
    const result = await rejectApprovalChange(
      input.approvalId,
      input.reviewerId,
      input.reviewComment
    );
    return result;
  });
}

// ---------------------------------------------------------------------------
// Tool definitions (P5) — for agent registration
// ---------------------------------------------------------------------------

/**
 * Typed tool definitions for the config management agent.
 * These are passed to the agent runtime so it knows what tools
 * are available and their input/output schemas.
 */
export const CONFIG_TOOLS: readonly Tool[] = [
  {
    id: "search_config",
    name: "Search Configuration",
    description:
      "Search config entries by keyword, category, or permission tier. Returns matching entries with full metadata including value type, constraints, and permission tier.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search term — matches key or description",
        },
        category: {
          type: "string",
          description: "Filter by category (e.g., moderation, system, i18n)",
        },
        permissionTier: {
          type: "string",
          enum: ["standard", "safety"],
          description: "Filter by permission tier",
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        entries: { type: "array" },
        count: { type: "number" },
      },
    },
  },
  {
    id: "get_config",
    name: "Get Configuration Entry",
    description:
      "Get a single config entry by key with full metadata: current value, default value, value type, constraints, permission tier, and description.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The config key to retrieve" },
      },
      required: ["key"],
    },
    outputSchema: {
      type: "object",
      properties: {
        found: { type: "boolean" },
        entry: { type: "object" },
      },
    },
  },
  {
    id: "update_config",
    name: "Update Configuration",
    description:
      "Update a config entry. Validates the value against type constraints. For safety-critical keys with two-person approval enabled, creates a pending approval. Returns reconfirmation data showing impact and affected users.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Config key to update" },
        value: { description: "New value (must match the entry's value_type)" },
        changeComment: {
          type: "string",
          description: "Mandatory comment explaining why the change is being made",
        },
        actorId: { type: "string", description: "ID of the admin making the change" },
      },
      required: ["key", "value", "changeComment", "actorId"],
    },
    outputSchema: {
      type: "object",
      properties: {
        applied: { type: "boolean" },
        changeRequest: { type: "object" },
        requiresApproval: { type: "boolean" },
      },
    },
  },
  {
    id: "get_history",
    name: "Get Change History",
    description:
      "Get the change history for a specific config key or all keys. Shows who changed what, when, and why.",
    inputSchema: {
      type: "object",
      properties: {
        configKey: {
          type: "string",
          description: "Specific key to get history for (omit for all)",
        },
        limit: { type: "number", description: "Max records to return (default 20)" },
        since: {
          type: "string",
          description: "ISO timestamp — only changes after this time",
        },
        before: {
          type: "string",
          description: "ISO timestamp — only changes before this time",
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        records: { type: "array" },
        count: { type: "number" },
      },
    },
  },
  {
    id: "compare_to_defaults",
    name: "Compare to Defaults",
    description:
      "Compare current config values to their seed defaults. Identifies settings that have drifted from defaults. Useful for auditing and troubleshooting.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Filter by category" },
        onlyDrifted: {
          type: "boolean",
          description: "Only show values that differ from defaults",
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        comparisons: { type: "array" },
        totalCount: { type: "number" },
        driftedCount: { type: "number" },
      },
    },
  },
  {
    id: "impact_report",
    name: "Impact Report",
    description:
      "Show how moderation outcomes changed after a config change. Compares block/warn rates before and after. Only works for moderation-category config keys.",
    inputSchema: {
      type: "object",
      properties: {
        configKey: { type: "string", description: "Moderation config key to analyze" },
        limit: {
          type: "number",
          description: "Number of recent changes to analyze (default 5)",
        },
      },
      required: ["configKey"],
    },
    outputSchema: {
      type: "object",
      properties: {
        reports: { type: "array" },
        message: { type: "string" },
      },
    },
  },
  {
    id: "bulk_review",
    name: "Bulk Review",
    description:
      "Review all config entries in a category or permission tier. Groups entries by category for organized review.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Filter by category" },
        permissionTier: {
          type: "string",
          enum: ["standard", "safety"],
          description: "Filter by permission tier",
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        entries: { type: "array" },
        totalCount: { type: "number" },
        categories: { type: "array" },
      },
    },
  },
  {
    id: "request_approval",
    name: "Request Approval",
    description:
      "Create a pending approval for a safety-critical config change. Another super_admin must approve before the change takes effect.",
    inputSchema: {
      type: "object",
      properties: {
        configKey: { type: "string", description: "Config key to change" },
        proposedValue: { description: "Proposed new value" },
        changeComment: { type: "string", description: "Why this change is needed" },
        actorId: { type: "string", description: "ID of the requesting admin" },
      },
      required: ["configKey", "proposedValue", "changeComment", "actorId"],
    },
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        record: { type: "object" },
      },
    },
  },
  {
    id: "approve_change",
    name: "Approve Change",
    description:
      "Approve a pending config change. The reviewer must be a different super_admin than the requester. On approval, the change is applied immediately.",
    inputSchema: {
      type: "object",
      properties: {
        approvalId: { type: "string", description: "ID of the pending approval" },
        reviewerId: { type: "string", description: "ID of the reviewing admin" },
        reviewComment: { type: "string", description: "Review comment" },
      },
      required: ["approvalId", "reviewerId", "reviewComment"],
    },
    outputSchema: {
      type: "object",
      properties: {
        approved: { type: "boolean" },
        applied: { type: "boolean" },
      },
    },
  },
  {
    id: "reject_change",
    name: "Reject Change",
    description:
      "Reject a pending config change. The requester can also reject their own request (to cancel it).",
    inputSchema: {
      type: "object",
      properties: {
        approvalId: { type: "string", description: "ID of the pending approval" },
        reviewerId: { type: "string", description: "ID of the reviewing admin" },
        reviewComment: { type: "string", description: "Reason for rejection" },
      },
      required: ["approvalId", "reviewerId", "reviewComment"],
    },
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        record: { type: "object" },
      },
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Tool dispatcher — maps tool ID to handler
// ---------------------------------------------------------------------------

/**
 * Dispatch a tool call by ID.
 * Used by the config agent to route tool invocations to the correct handler.
 *
 * Note: Input is cast via `as unknown as` because the agent runtime
 * passes Record<string, unknown>. Type safety is enforced at two levels:
 *   1. Tool schemas (CONFIG_TOOLS[].inputSchema) — validated by the LLM
 *   2. Each handler validates its own inputs (e.g., validateConfigValue)
 * See Gotcha #3 in this file for context.
 */
export async function dispatchConfigTool(
  toolId: string,
  input: Record<string, unknown>
): Promise<ConfigToolResult> {
  switch (toolId) {
    case "search_config":
      return handleSearchConfig(input as unknown as SearchConfigInput);
    case "get_config":
      return handleGetConfig(input as unknown as GetConfigInput);
    case "update_config":
      return handleUpdateConfig(input as unknown as UpdateConfigInput);
    case "get_history":
      return handleGetHistory(input as unknown as GetHistoryInput);
    case "compare_to_defaults":
      return handleCompareToDefaults(input as unknown as CompareToDefaultsInput);
    case "impact_report":
      return handleImpactReport(input as unknown as ImpactReportInput);
    case "bulk_review":
      return handleBulkReview(input as unknown as BulkReviewInput);
    case "request_approval":
      return handleRequestApproval(input as unknown as RequestApprovalInput);
    case "approve_change":
      return handleApproveChange(input as unknown as ApproveChangeInput);
    case "reject_change":
      return handleRejectChange(input as unknown as RejectChangeInput);
    default:
      return {
        toolId,
        success: false,
        data: null,
        error: `Unknown tool: ${toolId}`,
        durationMs: 0,
      };
  }
}

// ---------------------------------------------------------------------------
// Gotchas (L17)
// ---------------------------------------------------------------------------
//
// 1. handleUpdateConfig does NOT auto-apply for safety-tier keys when
//    two-person approval is enabled. It creates a pending approval.
//    The admin must confirm separately. handleApproveChange applies the
//    change after a different admin approves.
//
// 2. handleApproveChange applies the config change using the REVIEWER's
//    actorId (not the requester's). The history record shows who approved,
//    not who requested. Both IDs are in the approval record.
//
// 3. dispatchConfigTool uses `as unknown as` for input casting. This is
//    intentional — the agent runtime passes Record<string, unknown>,
//    and each handler validates its own inputs. Type safety is at the
//    tool schema level (P6), not the TypeScript level here.
//
// 4. CONFIG_TOOLS is `as const` — immutable array. When the agent runtime
//    registers tools (Sprint 4a), it reads from this array. Do not mutate.
//
// 5. The `Tool` import from agents/types uses JSON Schema for inputSchema
//    and outputSchema. These are descriptive (for the LLM), not enforced
//    at runtime. Runtime validation happens in each handler via
//    validateConfigValue().
