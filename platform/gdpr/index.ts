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
