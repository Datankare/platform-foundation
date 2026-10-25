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

// The platform's own handler: the account and every platform table holding its data (X-15).
export {
  AccountErasureHandler,
  createPlatformPurgePipeline,
  recordPurge,
} from "./account-erasure";

// AI data purge (GenAI Principle P2, P5: AI data is user-deletable)
export { AIMetricsPurgeHandler, AICachePurgeHandler } from "./ai-purge-handler";
