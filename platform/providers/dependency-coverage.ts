/**
 * platform/providers/dependency-coverage.ts — for every core provider selection, what tells
 * readiness that the dependency it reaches works (TASK-197, audit D-2)
 *
 * Readiness answered "ready" while the AI key was revoked, the Google key restricted or the
 * rate-limit store's token rotated: nothing probed them, and nothing required that anything
 * should. This is the requirement, per selection: the health probe that checks it (by name), a
 * stated exemption, or "local" — it reaches nothing outside the process. A module declares the
 * same for its own slots (ModuleProviderSlot.coverage).
 *
 * Typed against the selection unions (CoreProviderSelections), so a new selection does not
 * compile until it is covered; __tests__/dependency-probe-coverage.test.ts checks every module
 * slot's values the same way, and that each named probe is in fact registered for that selection
 * (platform/providers/readiness-probes.ts).
 *
 * @module platform/providers
 */

import type { DependencyCoverage } from "@/platform/modules/types";
import type { CoreProviderSelections } from "./registry";

export type { DependencyCoverage } from "@/platform/modules/types";

/** The probe names readiness registers (platform/providers/readiness-probes.ts). */
export const PROBE = {
  database: "database",
  cache: "cache",
  identityPool: "identity-pool",
  realtime: "realtime",
  aiProvider: "ai-provider",
  rateLimitStore: "rate-limit-store",
} as const;

const DB = { probe: PROBE.database } as const;

/** A durable store slot: postgres and supabase are the database; memory is the process. */
const durable = {
  postgres: DB,
  supabase: DB,
  memory: "local",
} as const satisfies Record<"postgres" | "supabase" | "memory", DependencyCoverage>;

export const CORE_DEPENDENCY_COVERAGE: {
  readonly [K in keyof CoreProviderSelections]: Readonly<
    Record<CoreProviderSelections[K], DependencyCoverage>
  >;
} = {
  auth: { cognito: { probe: PROBE.identityPool }, mock: "local" },
  cache: {
    upstash: { probe: PROBE.cache },
    valkey: { probe: PROBE.cache },
    memory: "local",
  },
  ai: { anthropic: { probe: PROBE.aiProvider }, mock: "local" },
  errorReporter: {
    sentry: {
      exempt:
        "the error reporter: its failure loses reports, never a user's request, and its SDK reports its own delivery problems; probing it would page through the channel being probed",
    },
    noop: "local",
  },
  realtime: { supabase: { probe: PROBE.realtime }, mock: "local" },
  moderationStore: durable,
  strikeStore: durable,
  reviewQueueStore: durable,
  embeddingProvider: {
    openai: {
      exempt:
        "no OpenAI embedding provider is built yet: the selection installs the mock (registry initEmbeddingProvider); probe it when the real provider lands",
    },
    mock: "local",
  },
  appStateStore: durable,
  trajectoryStore: durable,
  budgetStore: durable,
  proposalStore: durable,
  effectLedger: durable,
  approvalPolicyStore: durable,
  guestUsageStore: durable,
  rateLimiter: { ...durable, upstash: { probe: PROBE.rateLimitStore } },
  jobStore: durable,
};
