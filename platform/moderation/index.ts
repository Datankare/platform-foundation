/**
 * platform/moderation/index.ts — Public API for content safety
 *
 * ADR-016: Multi-layer defense architecture.
 * ADR-017: Input AND output screening.
 *
 * Usage:
 *   import { screenContent } from "@/platform/moderation";
 *
 *   const result = await screenContent(text, {
 *     direction: "input",
 *     requestId: "abc123",
 *     context: {
 *       contentType: "translation",
 *       contentRatingLevel: 2,
 *       userId: "user-456",
 *     },
 *   });
 *   if (result.action === "block") { ... }
 */

// Types
export type {
  SafetyCategory,
  SafetySeverity,
  ClassifierOutput,
  ContentRatingLevel,
  ContentType,
  ScreeningDirection,
  ScreeningContext,
  UserModerationHistory,
  ModerationAction,
  ModerationResult,
  ModerationAuditRecord,
  BlocklistPattern,
  ContentRatingThresholds,
  AuditQueryOptions,
  ModerationStore,
} from "./types";

// Middleware (primary API)
export { screenContent } from "./middleware";
export type { ScreeningOptions } from "./middleware";

// Guardian agent
export { Guardian, getGuardian, setGuardian, resetGuardian } from "./guardian";

// Context evaluation
export { evaluateContext, reduceSeverity } from "./context";
export type { ContextEvaluation } from "./context";

// Config
export {
  loadContentRatingThresholds,
  loadSeverityReduction,
  loadStrikeThresholds,
  loadBlocklistOnlySurfaces,
} from "./config";

// Blocklist (for direct use and testing)
export {
  scanBlocklist,
  getDefaultPatterns,
  validatePattern,
  compilePatterns,
} from "./blocklist";
export type { BlocklistMatch, BlocklistResult, PatternValidation } from "./blocklist";

// Classifier (for direct use and testing)
export { classify } from "./classifier";

// Audit (for direct use and testing)
export { logModerationAudit, buildAuditRecord, hashInput } from "./audit";

// Store (provider registration)
export {
  getModerationStore,
  setModerationStore,
  resetModerationStore,
  InMemoryModerationStore,
  SupabaseModerationStore,
} from "./store";
