/**
 * GDPR Module — barrel exports.
 *
 * @module platform/gdpr
 */

export type {
  PurgeAuditEntry,
  PurgeConfig,
  PurgeHandler,
  PurgeRequest,
  PurgeResult,
  PurgeStatus,
  PurgeStepResult,
} from "./types";

export { CachePurgeHandler, PurgePipeline, RateLimitPurgeHandler } from "./hard-purge";

// AI data purge (GenAI Principle P2, P5: AI data is user-deletable)
export { AIMetricsPurgeHandler, AICachePurgeHandler } from "./ai-purge-handler";
