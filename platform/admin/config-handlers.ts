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
 *   reset_config       — the tenant's own value removed (back to the platform default), governed
 *                        like an update: tier, two-person approval, dual control
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
 *   P3  — Total observability: every tool call timed; trajectory recorded at dispatch level
 *   P5  — Versioned artifacts: tool definitions exported for agent registration
 *   P6  — Structured outputs: all results typed via ConfigToolResult
 *   P10 — Human oversight: update_config requires confirmed:true to apply (preview by default)
 *   P13 — Control plane: permission tier checks on every mutation
 *   P15 — Agent identity: agentId threaded through trajectory context
 *   P17 — Cognition-commitment: read tools = cognition, write tools = commitment
 *   P18 — Durable trajectories: steps recorded per tool call via ToolExecutionContext
 *
 * @module platform/admin
 */

import {
  getEnhancedConfig,
  listEnhancedConfig,
  validateConfigValue,
  setConfigWithHistory,
  clearTenantConfig,
  getConfigHistory,
  getConfigOrThrow,
} from "@/platform/auth/platform-config";
import {
  approvedChangeTarget,
  isSharedDeployment,
  resolveConfigTarget,
} from "./config-scope";
import {
  getApproval,
  isApprovalRequired,
  requestApproval as createApprovalRequest,
  approveAndApply,
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
  ConfigScope,
  ToolExecutionContext,
} from "./types";
import { TOOL_BOUNDARIES } from "./types";
import type { Tool, StepBoundary, AgentIdentity } from "@/platform/agents/types";
import { invokeTool } from "@/platform/agents/tool-invoker";
import { getTrajectoryStore } from "@/platform/agents/trajectory-store";
import {
  finishTrajectory,
  type TrajectoryOutcome,
} from "@/platform/agents/trajectory-closure";
import { getProposalStore } from "@/platform/agents/proposal-store";
import { proposeOnce, PipelineRejectedError } from "@/platform/action-pipeline";
import { approvalPolicy } from "@/platform/agents/gating";
import { getApprovalPolicyStore } from "@/platform/agents/approval-policy-store";
import { logger } from "@/lib/logger";
import { raiseAlert } from "@/platform/observability/alert";
import {
  canonical,
  isPowerReducibleKey,
  powerReduction,
  type PowerDiff,
} from "@/platform/admin/power-reduction";
import {
  isHeldPrevious,
  staleChangeMessage,
  STALE_CHANGE_PREFIX,
  type HeldPrevious,
} from "@/platform/admin/stale-change";
import { audited, AuditWriteError } from "@/platform/auth/audit";
import { withdrawSupersededHolds } from "@/platform/admin/hold-withdrawal";

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
  /**
   * ADR-053 D5: whether the actor is an operator — set by the route from the verified admin,
   * never taken from the caller (the routes overwrite it, as they do actorId).
   */
  readonly actorIsOperator?: boolean;
  /** What the change is to; absent means the deployment's default (config-scope.ts). */
  readonly scope?: ConfigScope;
  /**
   * P10: Must be true to apply the change. When false or absent,
   * returns a preview (changeRequest) without applying. The agent
   * presents the preview, admin confirms, agent calls again with
   * confirmed: true.
   */
  readonly confirmed?: boolean;
  /**
   * Set by dispatchConfigTool only — never taken from a caller — when the change provably only
   * removes power (review 11 M-2, power-reduction.ts): the value it replaces. The change is then
   * applied by the one admin, without two-person approval, only if it is still a reduction of
   * this value and the stored value is still this one (compare-and-set); otherwise not at all.
   */
  readonly expectPrevious?: { readonly value: unknown };
  /**
   * Set by dispatchConfigTool only — never taken from a caller — on a held change (review 12 H2):
   * the value the change replaces, at request time. When the held change is approved it is
   * applied only if the key still holds this value (compare-and-set); otherwise nothing is
   * changed, the result is stale, and the hold is withdrawn.
   */
  readonly heldPrevious?: HeldPrevious;
}

/** The stale result of a held change whose replaced value changed (review 12 H2). */
function staleResult(key: string) {
  return { applied: false, stale: true, error: staleChangeMessage(key) };
}

/**
 * Update a config entry with full validation.
 *
 * This tool does NOT auto-apply the change. It returns a
 * ConfigChangeRequest with all reconfirmation data. The agent
 * presents this to the admin for confirmation. Only after
 * explicit confirmation does the agent call update_config with confirmed: true.
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

    // 3. Where the change goes (ADR-053 D5): refused before anything is held or applied
    const decision = resolveConfigTarget(
      input.actorIsOperator === true,
      entry,
      input.scope
    );
    if (!decision.ok) {
      return { applied: false, error: decision.reason };
    }

    // 3a. An approved held change (review 12 H2): only onto the value it was requested against.
    const replaced =
      decision.target.scope === "platform" ? entry.platformValue : entry.value;
    if (
      input.heldPrevious !== undefined &&
      canonical(replaced) !== canonical(input.heldPrevious.value)
    ) {
      return staleResult(input.key);
    }

    // 3b. A change that only removes power (review 11 M-2): proved again, here, against the
    // value it replaces — which the write then compares and sets.
    let reduction: PowerDiff | undefined;
    if (input.expectPrevious !== undefined) {
      reduction = powerReduction(input.key, input.expectPrevious.value, input.value);
      if (!reduction.reduces) {
        return { applied: false, error: `Not applied: ${reduction.reason}` };
      }
    }

    // 4. Check if two-person approval is needed (never for a proven reduction)
    const needsApproval =
      !reduction?.reduces &&
      entry.permissionTier === "safety" &&
      (await isApprovalRequired());

    // 5. Build the reconfirmation data (A8: pure function, independently testable)
    const changeRequest = buildChangeRequest(
      entry,
      input.value,
      input.changeComment,
      needsApproval
    );

    // P10: If not explicitly confirmed, return preview only
    if (!input.confirmed) {
      return {
        applied: false,
        pendingConfirmation: true,
        changeRequest,
      };
    }

    if (needsApproval) {
      // Create pending approval — don't apply
      const approvalResult = await createApprovalRequest({
        configKey: input.key,
        currentValue: input.heldPrevious ? input.heldPrevious.value : replaced,
        proposedValue: input.value,
        requestedBy: input.actorId,
        changeComment: input.changeComment,
        impactSummary: changeRequest.impact,
        scope: decision.target.scope,
      });

      return {
        applied: false,
        requiresApproval: true,
        approval: approvalResult.record,
        approvalError: approvalResult.error,
        changeRequest,
      };
    }

    // 6. Apply the change directly (A5: pass loaded entry to skip re-load). Compare-and-set
    // against the value a reduction was proved of (review 11 M-2), or a held change was requested
    // against (review 12 H2).
    const expectPrevious = reduction?.reduces
      ? input.expectPrevious
      : input.heldPrevious
        ? { value: input.heldPrevious.value }
        : undefined;
    const write = () =>
      setConfigWithHistory(
        input.key,
        input.value,
        input.actorId,
        input.changeComment,
        "config_agent",
        entry,
        decision.target,
        ...(expectPrevious ? [{ expectPrevious }] : [])
      );
    let result: Awaited<ReturnType<typeof setConfigWithHistory>>;
    if (reduction?.reduces) {
      // Recorded before it takes effect, fail closed (review 12 L4): no record, no reduction.
      try {
        result = await audited(
          powerReductionEntry(input.key, input.actorId, reduction.changes),
          write
        );
      } catch (err) {
        if (err instanceof AuditWriteError) {
          return {
            applied: false,
            error: "The audit log is unavailable, so the value was not changed.",
          };
        }
        throw err;
      }
      if (result.success) {
        await announcePowerReduction(
          input.key,
          input.actorId,
          reduction.changes,
          decision.target.scope
        );
      }
    } else {
      result = await write();
    }
    if (result.stale && input.heldPrevious) return staleResult(input.key);

    return {
      applied: result.success,
      error: result.error,
      validationErrors: result.validationErrors,
      changeRequest,
    };
  });
}

// ---------------------------------------------------------------------------
// Tool: reset_config
// ---------------------------------------------------------------------------

export interface ResetConfigInput {
  readonly key: string;
  readonly changeComment: string;
  readonly actorId: string;
  /** Set by the route from the verified admin, never taken from the caller. */
  readonly actorIsOperator?: boolean;
  /** P10: must be true to apply; otherwise a preview. */
  readonly confirmed?: boolean;
  /** As for update_config: set by dispatchConfigTool on a held reset (review 12 H2). */
  readonly heldPrevious?: HeldPrevious;
}

/**
 * Remove the current tenant's own value for a key, so it follows the platform default again
 * (ADR-053 D5). Governed as a change to the default value would be: the same scope rules, and
 * for a safety-tier key with two-person approval a pending approval (action "reset") rather
 * than the change. A single-tenant deployment has no tenant values; nothing changes.
 */
export async function handleResetConfig(
  input: ResetConfigInput
): Promise<ConfigToolResult> {
  return executeToolCall("reset_config", async () => {
    const entry = await getEnhancedConfig(input.key);
    if (!entry) return { applied: false, error: `Config key "${input.key}" not found.` };
    // An approved held reset (review 12 H2): only of the value it was requested against.
    const held = input.heldPrevious;
    // And only onto the platform default it was requested to inherit (review 13 M1): a held reset
    // that did not record it cannot be proved current (fail closed).
    if (
      held !== undefined &&
      (entry.overridden !== (held.overridden === true) ||
        (entry.overridden && canonical(entry.value) !== canonical(held.value)) ||
        !("inherited" in held) ||
        canonical(entry.platformValue) !== canonical(held.inherited))
    ) {
      return staleResult(input.key);
    }
    if (!isSharedDeployment() || !entry.overridden) {
      return { applied: true, unchanged: true };
    }
    const operator = input.actorIsOperator === true;
    const decision = resolveConfigTarget(operator, entry, "tenant");
    if (!decision.ok) return { applied: false, error: decision.reason };

    const needsApproval =
      entry.permissionTier === "safety" && (await isApprovalRequired());
    const changeRequest = buildChangeRequest(
      entry,
      entry.platformValue,
      input.changeComment,
      needsApproval
    );
    if (!input.confirmed) {
      return { applied: false, pendingConfirmation: true, changeRequest };
    }
    if (needsApproval) {
      const approvalResult = await createApprovalRequest({
        configKey: input.key,
        currentValue: held ? held.value : entry.value,
        // What the tenant would inherit, recorded now (review 13 M1): the approval resets only
        // while the platform default is still this value.
        proposedValue: held ? held.inherited : entry.platformValue,
        requestedBy: input.actorId,
        changeComment: input.changeComment,
        impactSummary: changeRequest.impact,
        scope: "tenant",
        action: "reset",
      });
      return {
        applied: false,
        requiresApproval: true,
        approval: approvalResult.record,
        approvalError: approvalResult.error,
        changeRequest,
      };
    }
    const result = await clearTenantConfig(
      input.key,
      input.actorId,
      input.changeComment,
      operator,
      held
        ? {
            expectPrevious: { value: held.value },
            expectInherited: { value: held.inherited },
          }
        : {}
    );
    if (result.stale) return staleResult(input.key);
    return { applied: result.success, error: result.error, changeRequest };
  });
}

/**
 * Build a ConfigChangeRequest from an entry and proposed value.
 * Pure function — no side effects, independently testable.
 * Extracted per A8/B8 sustainability review.
 */
export function buildChangeRequest(
  entry: EnhancedConfigEntry,
  proposedValue: unknown,
  changeComment: string,
  requiresApproval: boolean
): ConfigChangeRequest {
  return {
    key: entry.key,
    currentValue: entry.value,
    proposedValue,
    impact: buildImpactDescription(entry, proposedValue),
    affectedUsers: buildAffectedUsersDescription(entry),
    reversible: true,
    permissionTier: entry.permissionTier,
    requiresApproval,
    changeComment,
  };
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

    // A11: Generate impact reports in parallel (each does 2 DB queries)
    const reportPromises = history.map((change, i) => {
      const nextChangeAt = i > 0 ? history[i - 1].createdAt : undefined;
      return generateImpactReport(change, nextChangeAt);
    });
    const reports = await Promise.all(reportPromises);

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
  /** Set by the route from the verified admin (ADR-053 D5). */
  readonly actorIsOperator?: boolean;
  readonly scope?: ConfigScope;
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

    const decision = resolveConfigTarget(
      input.actorIsOperator === true,
      entry,
      input.scope
    );
    if (!decision.ok) return { success: false, error: decision.reason };

    const result = await createApprovalRequest({
      configKey: input.configKey,
      currentValue:
        decision.target.scope === "platform" ? entry.platformValue : entry.value,
      proposedValue: input.proposedValue,
      requestedBy: input.actorId,
      changeComment: input.changeComment,
      impactSummary: buildImpactDescription(entry, input.proposedValue),
      scope: decision.target.scope,
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
  /** Set by the route from the verified admin (ADR-053 D5). */
  readonly reviewerIsOperator?: boolean;
}

/**
 * Approve a pending config change. Applies the change if approval succeeds.
 */
export async function handleApproveChange(
  input: ApproveChangeInput
): Promise<ConfigToolResult> {
  return executeToolCall("approve_change", async () => {
    // Approved and applied as one outcome; a change that cannot be applied is reopened
    // (release review, Sprint 7X — it was left approved, unapplied, and reported as success).
    // A change to a shared deployment's platform default is an operator's to approve; refused
    // before the approval is recorded (ADR-053 D5).
    const pending = await getApproval(input.approvalId);
    if (pending) {
      const decision = approvedChangeTarget(
        input.reviewerIsOperator === true,
        pending.scope
      );
      if (!decision.ok) return { success: false, error: decision.reason };
    }
    const result = await approveAndApply(
      input.approvalId,
      input.reviewerId,
      input.reviewComment,
      (record) => {
        const decision = approvedChangeTarget(
          input.reviewerIsOperator === true,
          record.scope
        );
        if (!decision.ok)
          return Promise.resolve({ success: false, error: decision.reason });
        // Only onto the value it was requested against (review 12 H2).
        const expectPrevious = { value: record.currentValue };
        if (record.action === "reset") {
          // And onto the platform default it inherits as requested (review 13 M1).
          return clearTenantConfig(
            record.configKey,
            input.reviewerId,
            `Approved: ${record.changeComment}`,
            decision.target.operator,
            { expectPrevious, expectInherited: { value: record.proposedValue } }
          );
        }
        return setConfigWithHistory(
          record.configKey,
          record.proposedValue,
          input.reviewerId,
          `Approved: ${record.changeComment}`,
          "config_agent",
          undefined,
          decision.target,
          { expectPrevious }
        );
      }
    );
    if (!result.success) return result;
    return { approved: true, applied: true, approval: result.record };
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
    effects: [],
    execute: async (input: Record<string, unknown>) =>
      (await handleSearchConfig(
        input as unknown as SearchConfigInput
      )) as unknown as Record<string, unknown>,
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
    effects: [],
    execute: async (input: Record<string, unknown>) =>
      (await handleGetConfig(input as unknown as GetConfigInput)) as unknown as Record<
        string,
        unknown
      >,
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
      required: ["key", "value", "changeComment"],
    },
    outputSchema: {
      type: "object",
      properties: {
        applied: { type: "boolean" },
        changeRequest: { type: "object" },
        requiresApproval: { type: "boolean" },
      },
    },
    effects: ["stateWrite"],
    declaredRisk: "consequential",
    execute: async (input: Record<string, unknown>) =>
      (await handleUpdateConfig(
        input as unknown as UpdateConfigInput
      )) as unknown as Record<string, unknown>,
  },
  {
    id: "reset_config",
    name: "Reset Configuration to the Default",
    description:
      "Remove the current tenant's own value for a config key, so it follows the platform default again. Governed like an update: for safety-critical keys with two-person approval enabled, creates a pending approval.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Config key to reset" },
        changeComment: {
          type: "string",
          description: "Mandatory comment explaining why the value is reset",
        },
        actorId: { type: "string", description: "ID of the admin making the change" },
      },
      required: ["key", "changeComment"],
    },
    outputSchema: {
      type: "object",
      properties: {
        applied: { type: "boolean" },
        unchanged: { type: "boolean" },
        changeRequest: { type: "object" },
        requiresApproval: { type: "boolean" },
      },
    },
    effects: ["stateWrite"],
    declaredRisk: "consequential",
    execute: async (input: Record<string, unknown>) =>
      (await handleResetConfig(
        input as unknown as ResetConfigInput
      )) as unknown as Record<string, unknown>,
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
    effects: [],
    execute: async (input: Record<string, unknown>) =>
      (await handleGetHistory(input as unknown as GetHistoryInput)) as unknown as Record<
        string,
        unknown
      >,
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
    effects: [],
    execute: async (input: Record<string, unknown>) =>
      (await handleCompareToDefaults(
        input as unknown as CompareToDefaultsInput
      )) as unknown as Record<string, unknown>,
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
    effects: [],
    execute: async (input: Record<string, unknown>) =>
      (await handleImpactReport(
        input as unknown as ImpactReportInput
      )) as unknown as Record<string, unknown>,
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
    effects: [],
    execute: async (input: Record<string, unknown>) =>
      (await handleBulkReview(input as unknown as BulkReviewInput)) as unknown as Record<
        string,
        unknown
      >,
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
      required: ["configKey", "proposedValue", "changeComment"],
    },
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        record: { type: "object" },
      },
    },
    effects: ["stateWrite"],
    declaredRisk: "consequential",
    execute: async (input: Record<string, unknown>) =>
      (await handleRequestApproval(
        input as unknown as RequestApprovalInput
      )) as unknown as Record<string, unknown>,
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
      required: ["approvalId", "reviewComment"],
    },
    outputSchema: {
      type: "object",
      properties: {
        approved: { type: "boolean" },
        applied: { type: "boolean" },
      },
    },
    effects: ["stateWrite"],
    declaredRisk: "consequential",
    execute: async (input: Record<string, unknown>) =>
      (await handleApproveChange(
        input as unknown as ApproveChangeInput
      )) as unknown as Record<string, unknown>,
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
      required: ["approvalId", "reviewComment"],
    },
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        record: { type: "object" },
      },
    },
    effects: ["stateWrite"],
    declaredRisk: "consequential",
    execute: async (input: Record<string, unknown>) =>
      (await handleRejectChange(
        input as unknown as RejectChangeInput
      )) as unknown as Record<string, unknown>,
  },
] as const;

// ---------------------------------------------------------------------------
// Tool dispatcher — maps tool ID to handler
// ---------------------------------------------------------------------------

/** Required fields per tool (B5: validate before dispatch, not accidentally) */
const REQUIRED_FIELDS: Record<string, readonly string[]> = {
  get_config: ["key"],
  update_config: ["key", "value", "changeComment"],
  reset_config: ["key", "changeComment"],
  impact_report: ["configKey"],
  request_approval: ["configKey", "proposedValue", "changeComment"],
  approve_change: ["approvalId", "reviewComment"],
  reject_change: ["approvalId", "reviewComment"],
};

/**
 * Dispatch a tool call by ID with trajectory recording.
 *
 * Architecture:
 *   - B5: Validates required fields before dispatching (intentional, not accidental)
 *   - P17: Classifies each tool as cognition (read) or commitment (write)
 *   - P18: Records a step in the trajectory context after execution
 *   - Input casting: Record<string, unknown> → typed input. Type safety is at
 *     tool schema level (P6) + handler validation (validateConfigValue).
 *     See Gotcha #3.
 */
/**
 * Settings whose changes are always dual-controlled, whatever config.dual_control_keys says: the
 * settings that govern holding itself — which keys are held, two-person approval, which
 * administrative actions are held (review 10: admin.dual_control_actions is held by its own rule,
 * not only by being listed, so emptying the key list cannot be the step that frees it).
 */
export const ALWAYS_DUAL_CONTROLLED: readonly string[] = [
  "config.dual_control_keys",
  "config.require_two_person_approval",
  "admin.dual_control_actions",
];

/** Whether a change to `key` needs a runtime hold and an independent approver (ADR-039 F2b-2). */
export async function isDualControlledKey(key: string): Promise<boolean> {
  if (ALWAYS_DUAL_CONTROLLED.includes(key)) return true;
  try {
    const keys = await getConfigOrThrow<unknown>("config.dual_control_keys");
    return !Array.isArray(keys) || keys.includes(key);
  } catch {
    logger.warn(
      "config.dual_control_keys unreadable — holding the change (fail closed)",
      {
        route: "platform/admin/config-handlers",
        key,
      }
    );
    return true;
  }
}

/** Roster lookup — CONFIG_TOOLS is the single source of truth for what is dispatchable. */
const CONFIG_TOOL_BY_ID: ReadonlyMap<string, Tool> = new Map(
  CONFIG_TOOLS.map((tool) => [tool.id, tool])
);

/** The config tools a runtime (dual-control) hold can stand for. */
const RESUMABLE_TOOLS: ReadonlySet<string> = new Set(["update_config", "reset_config"]);

/** Whether a config tool's result says the change did not take effect (review 10 H2). */
export function configResultFailure(output: Record<string, unknown>): string | undefined {
  const r = output as unknown as ConfigToolResult;
  const data = (r?.data ?? {}) as {
    applied?: boolean;
    requiresApproval?: boolean;
    approvalError?: string;
    error?: string;
    validationErrors?: string[];
    stale?: boolean;
  };
  // A stale held change (review 12 H2): marked, so the decision withdraws the hold.
  if (data.stale) {
    const text = data.error ?? r?.error ?? "the value changed";
    return text.startsWith(STALE_CHANGE_PREFIX) ? text : `${STALE_CHANGE_PREFIX}${text}`;
  }
  if (r?.success && data.applied) return undefined;
  if (r?.success && data.requiresApproval && !data.approvalError) return undefined;
  return (
    r?.error ??
    data.error ??
    data.approvalError ??
    (data.validationErrors?.length ? data.validationErrors.join("; ") : undefined) ??
    "the change was not applied"
  );
}

/**
 * Apply a config change whose dual-control hold has just been approved (ADR-040): the held
 * tool runs again on its approved proposal — exactly the approved payload, the same operation,
 * as the proposer — and the pipeline claims the approval for the run, so it releases one change
 * once. A run that fails before the change takes effect keeps the approval (review 10 H2): the
 * pipeline's ApprovedRunFailedError is thrown, as is PipelineRejectedError when another run holds
 * the approval or it was used. Null for a hold that is not a config change (its own caller
 * resumes it).
 */
export async function runApprovedConfigChange(
  proposalId: string
): Promise<ConfigToolResult | null> {
  const proposalStore = getProposalStore();
  const proposal = await proposalStore.getById(proposalId);
  if (!proposal || !RESUMABLE_TOOLS.has(proposal.label)) return null;
  const tool = CONFIG_TOOL_BY_ID.get(proposal.label);
  if (!tool) return null;
  // Every held config change records the value it replaces (review 12 H2); one that does not
  // cannot be proved current, so it is not applied (fail closed): the requester asks again.
  if (!isHeldPrevious(proposal.payload["heldPrevious"])) {
    const key =
      typeof proposal.payload["key"] === "string"
        ? proposal.payload["key"]
        : "the setting";
    return {
      toolId: proposal.label,
      success: false,
      data: { ...staleResult(key), error: staleChangeMessage(key) },
      error: staleChangeMessage(key),
      durationMs: 0,
    };
  }
  const stepIndex = Number(/_(\d+)$/.exec(proposal.operationId)?.[1] ?? 0);
  const invoked = await invokeTool({
    // The held form of the tool (dual control raised its risk), so the approval is what
    // lets it through — never a lower-risk copy that would skip the gate.
    tool: { ...tool, declaredRisk: "restricted", reportsFailure: configResultFailure },
    input: proposal.payload,
    actor: proposal.actor,
    sessionId: proposal.sessionId,
    trajectoryId: proposal.trajectoryId,
    stepIndex,
    trajectoryStore: getTrajectoryStore(),
    proposalStore,
    approvedProposalId: proposal.proposalId,
    operationId: proposal.operationId,
  });
  return invoked.output as unknown as ConfigToolResult;
}

/** runApprovedConfigChange, with any error as a failed result (the error's own message). */
export async function resumeApprovedConfigChange(
  proposalId: string
): Promise<ConfigToolResult | null> {
  const start = Date.now();
  try {
    return await runApprovedConfigChange(proposalId);
  } catch (err) {
    return {
      toolId: "update_config",
      success: false,
      data: null,
      error:
        err instanceof PipelineRejectedError && err.reason === "approval-used"
          ? "This approved change is being applied or has already been applied."
          : err instanceof Error
            ? err.message
            : String(err),
      durationMs: Date.now() - start,
    };
  }
}

/**
 * The stored value a change would replace — at the scope it would be written to (an update), or
 * the tenant's own value and whether it has one (a reset) — or undefined when the entry or scope
 * cannot be resolved (the change then fails on its own when run).
 */
async function valueBefore(
  toolId: string,
  key: string,
  input: Record<string, unknown>
): Promise<HeldPrevious | undefined> {
  const entry = await getEnhancedConfig(key);
  if (!entry) return undefined;
  if (toolId === "reset_config") {
    return {
      value: entry.overridden ? entry.value : null,
      overridden: entry.overridden,
      inherited: entry.platformValue,
    };
  }
  const scope =
    input.scope === "platform" || input.scope === "tenant" ? input.scope : undefined;
  const target = resolveConfigTarget(input.actorIsOperator === true, entry, scope);
  if (!target.ok) return undefined;
  return {
    value: target.target.scope === "platform" ? entry.platformValue : entry.value,
  };
}

/** The audit record of a power reduction applied by one admin (review 11 M-2, review 12 L4). */
function powerReductionEntry(key: string, actorId: string, changes: readonly string[]) {
  return {
    action: "admin_action" as const,
    ...(UUID_RE.test(actorId) ? { actorId } : { agent: actorId }),
    details: { type: "power_reduction_applied", key, changes: changes.slice(0, 100) },
  };
}

/**
 * A power reduction applied by one admin (review 11 M-2), after its record (review 12 L4):
 * alerted, so the second admin it did not wait for hears of it; and every pending hold on the key
 * withdrawn (review 12 H2) — each was requested against a value that no longer stands.
 */
async function announcePowerReduction(
  key: string,
  actorId: string,
  changes: readonly string[],
  scope: ConfigScope
): Promise<void> {
  raiseAlert({
    name: "config.power_reduced",
    message: `${key} reduced without a second admin: ${changes.join("; ")}`.slice(0, 500),
    tags: { key },
  });
  // Only the holds of the scope that was reduced (review 13 L1).
  await withdrawSupersededHolds(
    key,
    actorId,
    "a power reduction was applied to the key",
    scope
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function dispatchConfigTool(
  toolId: string,
  input: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ConfigToolResult> {
  // B5: Validate required fields before dispatching
  const requiredFields = REQUIRED_FIELDS[toolId];
  if (requiredFields) {
    const missing = requiredFields.filter(
      (f) => input[f] === undefined || input[f] === null
    );
    if (missing.length > 0) {
      return {
        toolId,
        success: false,
        data: null,
        error: `Missing required fields: ${missing.join(", ")}`,
        durationMs: 0,
      };
    }
  }

  // ADR-029 D1: the roster is the dispatcher. A tool is invocable because it carries its
  // handler, not because a switch elsewhere happens to name it — the switch and the roster
  // could previously disagree, and nothing would have said so.
  const found = CONFIG_TOOL_BY_ID.get(toolId);
  if (!found) {
    return {
      toolId,
      success: false,
      data: null,
      error: `Unknown tool: ${toolId}`,
      durationMs: 0,
    };
  }
  const tool: Tool = found;

  // ADR-039 F2b: run through the governed runtime (invokeTool) — risk floor, budget ceiling,
  // effect ledger and trajectory recording — rather than a hand-rolled step. A config write's
  // effectiveRisk (stateWrite floor = ordinary, declaredRisk = consequential) stays below the
  // gating threshold (restricted), so nothing holds here; dual-control (F2b-2) raises risk on
  // named keys to cross it. config-approval remains the domain two-person gate.
  const trajectoryStore = getTrajectoryStore();
  // The human the config agent acts for is recorded on every hold, so the decision route can
  // refuse that person approving their own change (ADR-040; audit X-10 — holds named only the
  // agent, and the requester check compared unrelated ids).
  const principal =
    context?.onBehalfOf ??
    (typeof input.actorId === "string" ? input.actorId : undefined);
  const actor: AgentIdentity = {
    actorType: "agent",
    actorId: context?.agentId ?? "config-manager",
    agentRole: "config-manager",
    ...(principal ? { onBehalfOf: principal } : {}),
  };
  const existingTrajectoryId = context?.trajectoryId;
  if (existingTrajectoryId && (await trajectoryStore.getById(existingTrajectoryId))) {
    return dispatchInTrajectory(existingTrajectoryId);
  }
  // A trajectory opened here is this call's, and is ended with it (TASK-193: every config write
  // left one `running` for good — the config assistant's too, whose `traj-…` context id is never a
  // stored trajectory). A held write's is the hold's to end (paused: finishTrajectory leaves it).
  const created = await trajectoryStore.create(
    { kind: "agent", id: actor.actorId },
    `config:${toolId}`,
    "platform"
  );
  const ownTrajectoryId = created.trajectory.trajectoryId;
  let ended: TrajectoryOutcome = "failed";
  try {
    const result = await dispatchInTrajectory(ownTrajectoryId);
    ended = result.success ? "completed" : "failed";
    return result;
  } finally {
    await finishTrajectory(trajectoryStore, ownTrajectoryId, ended);
  }

  async function dispatchInTrajectory(trajectoryId: string): Promise<ConfigToolResult> {
    // ADR-039 F2b-2 dual-control: a config write to a key in config.dual_control_keys is
    // catastrophic-if-wrong, so raise its risk to `restricted` — crossing the gating threshold
    // forces a runtime hold cleared by an independent human (approval policy default = "user"),
    // on top of config-approval's domain two-person gate. Non-listed keys stay below the line.
    //
    // Fail closed (audit X-7): when the key list cannot be read, every config write is held; and
    // the settings that govern dual control itself are always held, so emptying the list cannot
    // be the step that turns it off.
    const targetKey = typeof input.key === "string" ? input.key : undefined;
    let isDualControl =
      (toolId === "update_config" || toolId === "reset_config") &&
      (targetKey === undefined || (await isDualControlledKey(targetKey)));

    // Review 11 M-2: a change that provably only removes power (an agent suspended, a scope or a
    // token lifetime narrowed, a required feature added to a capability) is not held — the kill
    // switch must not wait for a second admin. Proved against the value it replaces; the handler
    // proves it again and the write compares and sets. A caller never supplies the value replaced,
    // neither this one nor a held change's (review 12 H2).
    const {
      expectPrevious: _ignored,
      heldPrevious: _ignoredHeld,
      ...callerInput
    } = input;
    void _ignored;
    void _ignoredHeld;
    input = callerInput;
    if (
      isDualControl &&
      toolId === "update_config" &&
      targetKey &&
      isPowerReducibleKey(targetKey)
    ) {
      const before = await valueBefore(toolId, targetKey, input);
      if (
        before !== undefined &&
        powerReduction(targetKey, before.value, input.value).reduces
      ) {
        isDualControl = false;
        input = { ...input, expectPrevious: { value: before.value } };
      }
    }
    // Review 12 H2: a held change records the value it replaces, so its approval applies it only
    // onto that value (compare-and-set) — never over a kill switch or any change made since.
    if (isDualControl && targetKey && RESUMABLE_TOOLS.has(toolId)) {
      const before = await valueBefore(toolId, targetKey, input);
      if (before !== undefined) input = { ...input, heldPrevious: before };
    }

    const effectiveTool: Tool = isDualControl
      ? { ...tool, declaredRisk: "restricted" }
      : tool;

    let result: ConfigToolResult;
    try {
      const invoked = await invokeTool({
        tool: effectiveTool,
        input,
        actor,
        sessionId: trajectoryId,
        trajectoryId,
        stepIndex: context?.steps.length ?? 0,
        trajectoryStore,
        proposalStore: getProposalStore(),
      });
      result = invoked.output as unknown as ConfigToolResult;
    } catch (err) {
      // A dual-control write holds rather than fails: mint the proposal (idempotent) and surface
      // who must approve. This is not an error — the change is pending an independent human, not
      // broken. Clearing the hold (re-invoke with the approved proposal) is the ADR-040 surface.
      if (err instanceof PipelineRejectedError && err.reason === "requires-approval") {
        const stepIndex = context?.steps.length ?? 0;
        const proposal = await proposeOnce({
          spec: {
            type: effectiveTool.id,
            effects: effectiveTool.effects,
            declaredRisk: effectiveTool.declaredRisk,
            ephemeral: false,
            commutative: false,
          },
          actor,
          sessionId: trajectoryId,
          operationId: `op_${trajectoryId}_${stepIndex}`,
          label: effectiveTool.id,
          payload: input,
          trajectoryId,
          stepIndex,
          proposalStore: getProposalStore(),
          trajectoryStore,
        });
        const policy = await getApprovalPolicyStore().load();
        const approver = approvalPolicy(
          proposal.effectiveRisk,
          effectiveTool.effects,
          policy
        );
        return {
          toolId,
          success: false,
          held: true,
          data: {
            pendingApproval: true,
            proposalId: proposal.proposalId,
            operationId: proposal.operationId,
            requiredApprover: approver.actorType,
          },
          approval: {
            proposalId: proposal.proposalId,
            operationId: proposal.operationId,
            requiredApprover: approver.actorType,
          },
          durationMs: 0,
        };
      }
      logger.error("Config tool invocation failed in the runtime pipeline", {
        route: "platform/admin/config-handlers",
        toolId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        toolId,
        success: false,
        data: null,
        error: err instanceof Error ? err.message : "Tool invocation failed",
        durationMs: 0,
      };
    }

    // Project the governed step into the response view. The runtime trajectory is the source
    // of truth; context.steps is this request's response projection, keeping the per-tool
    // boundary for the UI.
    if (context && result) {
      // Fail closed. An unclassified tool gets the STRICTER boundary, not the lower one:
      // recording a state-changing tool as cognition would place it below the governance a
      // commitment receives. Not a throw — this is a recording concern, and refusing to run a
      // working tool because its boundary is unlisted is a worse failure than recording it
      // conservatively (TASK-064).
      const classified = TOOL_BOUNDARIES[toolId];
      if (!classified) {
        logger.warn("Tool has no boundary classification — recording as commitment", {
          route: "platform/admin/config-handlers",
          toolId,
        });
      }
      const boundary: StepBoundary = classified ?? "commitment";
      context.steps.push({
        stepIndex: context.steps.length,
        action: toolId,
        boundary,
        input: { toolId },
        output: { success: result.success },
        cost: 0,
        durationMs: result.durationMs,
        timestamp: new Date().toISOString(),
      });
    }

    return result;
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
//    intentional — the agent runtime passes Record<string, unknown>.
//    Type safety is enforced at three levels: (a) REQUIRED_FIELDS check
//    in dispatcher catches missing fields (B5), (b) tool schemas define
//    the contract (P6), (c) handlers validate values (validateConfigValue).
//
// 4. CONFIG_TOOLS is `as const` — immutable array. When the agent runtime
//    registers tools (Sprint 4a), it reads from this array. Do not mutate.
//
// 5. handleApproveChange: if the approval succeeds but setConfigWithHistory
//    fails, the approval record shows "approved" but the config value is
//    unchanged. This is intentional — the approval decision and the config
//    mutation are separate facts. The response includes both `approved: true`
//    and `applied: false` with `applyError`. Recovery: fix the underlying
//    issue (e.g., DB connectivity) and re-execute the apply manually.
//    Nothing detects "approved but not applied" states automatically: the
//    response says so (applied: false, applyError) and the reviewer acts.
//
// 6. The `Tool` import from agents/types uses JSON Schema for inputSchema
//    and outputSchema. These are descriptive (for the LLM), not enforced
//    at runtime. Runtime validation happens in each handler via
//    validateConfigValue().
