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
 *   });
 *   if (result.action === "block") { ... }
 */

// Types
export type {
  SafetyCategory,
  SafetySeverity,
  ClassifierOutput,
  ScreeningDirection,
  ModerationAction,
  ModerationResult,
  ModerationAuditRecord,
  BlocklistPattern,
} from "./types";

// Middleware (primary API)
export { screenContent } from "./middleware";
export type { ScreeningOptions } from "./middleware";

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
