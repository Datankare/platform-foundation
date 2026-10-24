/**
 * __tests__/contract/manifest.ts — Provider conformance manifest of the core (ADR-027)
 *
 * Single source of truth mapping each core abstraction to its conformance
 * kit. Registry entries are keyed by their ProviderSelections slot name (see
 * platform/providers/registry.ts); fabric entries (observability) are keyed by
 * interface name.
 *
 * A product module's kits are its own (ADR-054 D4): each module's kit manifest
 * (__tests__/contract/modules/<id>.ts, listed as `kitManifest` in
 * platform/modules/manifest.json) maps that module's slots to its kits, and this
 * core manifest imports none of them. The conformance-coverage meta-test composes
 * the core manifest with the registered modules' and walks the live provider
 * registry — so a new provider slot, core or module, cannot land without a kit.
 * Importing each runner by value means a removed kit is a compile error, not a
 * silent gap.
 */

import { runAuthProviderContract } from "./auth-provider-contract";
import { runCacheProviderContract } from "./cache-provider-contract";
import { runAIProviderContract } from "./ai-provider-contract";
import { runErrorReporterContract } from "./error-reporter-contract";
import { runRealtimeProviderContract } from "./realtime-provider-contract";
import { runModerationStoreContract } from "./moderation-store-contract";
import { runStrikeStoreContract } from "./strike-store-contract";
import { runReviewQueueStoreContract } from "./review-queue-store-contract";
import { runGuestUsageStoreContract } from "./guest-usage-store-contract";
import { runRateLimiterContract } from "./rate-limiter-contract";
import { runEmbeddingProviderContract } from "./embedding-provider-contract";
import { runTraceProviderContract } from "./trace-provider-contract";
import { runMetricsSinkContract } from "./metrics-sink-contract";
import { runHealthProbeContract } from "./health-probe-contract";
import { runAppStateStoreContract } from "./app-state-store-contract";
import { runTrajectoryStoreContract } from "./trajectory-store-contract";
import { runBudgetStoreContract } from "./budget-store-contract";
import { runProposalStoreContract } from "./proposal-store-contract";
import { runEffectLedgerContract } from "./effect-ledger-contract";
import { runToolInvocationContract } from "./tool-invocation-contract";
import { runAgenticWorkflowContract } from "./agentic-workflow-contract";
import { runAgentResponseContract } from "./agent-response-contract";
import { runApprovalPolicyStoreContract } from "./approval-policy-contract";
import { runJobStoreContract } from "./job-store-contract";

export type ContractKind = "registry" | "fabric";

export interface ConformanceEntry {
  /** "registry" = a ProviderSelections slot (meta-test enforced); "fabric" = observability abstraction. */
  readonly kind: ContractKind;
  /**
   * The kit runner function. Type-erased to unknown because each kit has its
   * own fixtures signature; the meta-test only asserts presence + callability.
   * The value import above is the compile-time guarantee that it exists.
   */
  readonly kit: unknown;
}

/**
 * Keyed by ProviderSelections slot name for registry entries. If you add a
 * provider slot to platform/providers/registry.ts, add its kit here or the
 * conformance-coverage meta-test fails.
 */
export const CONFORMANCE_MANIFEST: Readonly<Record<string, ConformanceEntry>> = {
  // ── Registry slots (ProviderSelections keys) ──
  auth: { kind: "registry", kit: runAuthProviderContract },
  cache: { kind: "registry", kit: runCacheProviderContract },
  ai: { kind: "registry", kit: runAIProviderContract },
  errorReporter: { kind: "registry", kit: runErrorReporterContract },
  realtime: { kind: "registry", kit: runRealtimeProviderContract },
  moderationStore: { kind: "registry", kit: runModerationStoreContract },
  strikeStore: { kind: "registry", kit: runStrikeStoreContract },
  reviewQueueStore: { kind: "registry", kit: runReviewQueueStoreContract },
  embeddingProvider: { kind: "registry", kit: runEmbeddingProviderContract },
  appStateStore: { kind: "registry", kit: runAppStateStoreContract },
  trajectoryStore: { kind: "registry", kit: runTrajectoryStoreContract },
  budgetStore: { kind: "registry", kit: runBudgetStoreContract },
  proposalStore: { kind: "registry", kit: runProposalStoreContract },
  effectLedger: { kind: "registry", kit: runEffectLedgerContract },
  guestUsageStore: { kind: "registry", kit: runGuestUsageStoreContract },
  // ADR-052: the shared rate limiter. Registry — RATE_LIMIT_STORE selects the store.
  rateLimiter: { kind: "registry", kit: runRateLimiterContract },
  // ADR-056 D2: the job queue. Registry — JOB_STORE selects the store.
  jobStore: { kind: "registry", kit: runJobStoreContract },

  // ── Observability fabric (not registry slots; folded in by ADR-027) ──
  // ADR-029 D9: tool execution is in-process — nothing to swap, so no registry slot.
  toolInvocation: { kind: "fabric", kit: runToolInvocationContract },
  // ADR-029 L21: the agentic workflow kit. Fabric for the same reason — the
  // workflow is in-process, so there is no slot to swap.
  agenticWorkflow: { kind: "fabric", kit: runAgenticWorkflowContract },
  // ADR-030 L21: the AUX response envelope kit. Fabric for the same reason — the
  // envelope is assembled in process, so there is no slot to swap.
  agentResponse: { kind: "fabric", kit: runAgentResponseContract },
  traceProvider: { kind: "fabric", kit: runTraceProviderContract },
  metricsSink: { kind: "fabric", kit: runMetricsSinkContract },
  // Sprint 3c A2/A3: the approval-policy store kit. Registry — A3 makes it a
  // ProviderSelections slot, so the conformance-coverage bijection requires this kit.
  approvalPolicyStore: { kind: "registry", kit: runApprovalPolicyStoreContract },
  healthProbe: { kind: "fabric", kit: runHealthProbeContract },
};
