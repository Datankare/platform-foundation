/**
 * platform/ai/provider-failure.ts — the external-failure seam as the AI provider uses it
 * (TASK-197)
 *
 * The provider classifies an answer with the platform's table and records it through
 * platform/observability/external-failure.ts (a metric; an alert for a refused credential, an
 * exhausted credit balance or a retired model). Re-exported here so provider.ts has one import.
 *
 * @module platform/ai
 */

import {
  TRANSIENT_REASONS,
  type ExternalFailureReason,
} from "@/platform/errors/external-service";

export {
  classifyHttpFailure,
  externalFailure,
  type ExternalFailureReason,
} from "@/platform/observability/external-failure";

/** The reasons an AI call may be retried later (the circuit breaker counts these). */
export const TRANSIENT_REASONS_FOR_AI: ReadonlySet<ExternalFailureReason> =
  TRANSIENT_REASONS;
