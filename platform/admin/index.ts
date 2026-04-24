/**
 * platform/admin/index.ts — Config management module public API
 *
 * Exports the config management agent's types, tool handlers,
 * approval service, and impact correlation.
 *
 * Phase 4, Sprint 3a
 *
 * @module platform/admin
 */

// Types
export type {
  ConfigValueType,
  PermissionTier,
  EnhancedConfigEntry,
  ConfigValidationResult,
  ConfigChangeRequest,
  ConfigChangeSource,
  ConfigHistoryRecord,
  ConfigHistoryOptions,
  ConfigApprovalStatus,
  ConfigApprovalRecord,
  ConfigApprovalQueryOptions,
  ConfigImpactReport,
  ConfigImpactMetrics,
  ConfigSearchOptions,
  ConfigToolResult,
  ConfigAgentResult,
  ConfigToolId,
} from "./types";
export { CONFIG_TOOL_IDS } from "./types";

// Tool handlers
export {
  handleSearchConfig,
  handleGetConfig,
  handleUpdateConfig,
  handleGetHistory,
  handleCompareToDefaults,
  handleImpactReport,
  handleBulkReview,
  handleRequestApproval,
  handleApproveChange,
  handleRejectChange,
  dispatchConfigTool,
  CONFIG_TOOLS,
} from "./config-handlers";

// Approval service
export {
  isApprovalRequired,
  requestApproval,
  approveChange,
  rejectChange,
  listApprovals,
  getApproval,
  countPendingApprovals,
} from "./config-approval";

// Impact correlation
export { generateImpactReport, isModerationConfig } from "./config-impact";
