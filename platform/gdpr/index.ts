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

export { PurgePipeline } from "./hard-purge";

// The platform's own handler: the account and every platform table holding its data (X-15).
export {
  AccountErasureHandler,
  createPlatformPurgePipeline,
  recordPurge,
} from "./account-erasure";

// N-29: the placeholder handlers (cache, rate limit, AI metrics, AI cache) were exported and
// registered nowhere — and the AI-cache one would have cleared the whole shared cache. The erasure
// register (platform/auth/user-data.ts) erases ai_metrics; rate-limit entries expire with their
// window; the AI cache keeps no user's data (a user-scoped answer is keyed by its scope and expires
// with its TTL).
