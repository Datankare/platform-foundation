/**
 * platform/agents/capabilities.ts — Agent capability discovery (ADR-030 D8)
 *
 * The data behind GET /api/agent/capabilities: the goals this platform implements, each
 * with its endpoint, steps and estimated cost, plus the resolved provider selections. A
 * new agent self-configures against this rather than against prose (D8).
 *
 * The logic lives here rather than in the route so it is unit-testable and coverage-
 * measured (the route file is a thin wrapper, and app/api is measured but a NextResponse
 * is awkward to assert against). buildCapabilities takes its inputs rather than reaching
 * for singletons, so a test supplies a known registry and selection map.
 *
 * DELIBERATELY STATIC (see TASK-086). This reports the CONFIGURED provider per slot, not
 * whether it is reachable — it runs no health probe. Liveness belongs to /api/health,
 * which is built to run live network checks; folding a 5s-per-probe live check into an
 * unauthenticated discovery GET would be a DoS lever and would couple discovery to
 * dependency liveness. An agent learns reachability at call time through the trajectory
 * and nextActions (P11), where the answer is current rather than stale-at-discovery.
 *
 * @module platform/agents
 */

import type { AgentGoal } from "@/platform/kernel";
import type { WorkflowDefinition } from "./workflow-loop";

/** One step of a goal, as reported to a discovering agent. */
export interface CapabilityStep {
  readonly intent: string;
  readonly estimatedCostUSD: number;
}

/** One goal an agent can invoke. */
export interface GoalCapability {
  readonly goal: AgentGoal;
  readonly description: string;
  readonly endpoint: string;
  readonly steps: readonly CapabilityStep[];
  /** Sum of the steps' declared estimates. Pre-execution; see TASK-085. */
  readonly estimatedCostUSD: number;
  /**
   * The opaque capability name this goal requires (ADR-030 D9), or null when it requires
   * none. A discovering agent reads this to know which capability to hold before invoking.
   */
  readonly requiredCapability: string | null;
}

/**
 * The capabilities document.
 *
 * `providerSelections` carries slot -> chosen-impl NAMES only ("mock", "google",
 * "acrcloud"), never credentials or URLs, and only for the providers that do goals' work
 * (capabilitySelections) — the route serves verified callers, user or guest.
 *
 * `notReported` names the D8 fields this surface does not yet carry, so a discovering
 * agent knows they are absent-by-design rather than absent-by-omission, and so the gap
 * is visible in the payload and not only in TASK-086.
 */
export interface Capabilities {
  readonly goals: readonly GoalCapability[];
  readonly providerSelections: Readonly<Record<string, string>>;
  readonly notReported: readonly string[];
}

/**
 * Which selections a caller may see: the providers that do a goal's work (the model, embeddings,
 * the modules' providers — song identification, speech, translation). Never the platform's own
 * plumbing — the stores, cache, rate limiter, auth provider, error reporter, effect ledger and
 * realtime transport — which told any caller how the deployment is built (audit C-21, I-7).
 */
const PLUMBING =
  /(?:Store|store)$|^(?:auth|cache|errorReporter|effectLedger|rateLimiter|realtime)$/;

export function capabilitySelections(
  all: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(all).filter(([slot]) => !PLUMBING.test(slot)));
}

/** D8 fields deferred to TASK-086. Named in the payload, not silently dropped. */
const NOT_REPORTED: readonly string[] = [
  "latencyMsRange",
  "languages",
  "limits",
  "providerLiveness",
];

/**
 * Build the capabilities document from an explicit registry and selection map.
 *
 * Pure: no singletons, no I/O. The route supplies the live registry and
 * getActiveProviders(); a test supplies fixtures.
 */
export function buildCapabilities(
  definitions: readonly WorkflowDefinition[],
  providerSelections: Readonly<Record<string, string>>
): Capabilities {
  const goals = definitions.map((def) => ({
    goal: def.goal,
    description: def.description,
    endpoint: def.endpoint,
    steps: def.steps.map((s) => ({
      intent: s.intent,
      estimatedCostUSD: s.estimatedCostUSD,
    })),
    estimatedCostUSD: def.steps.reduce((sum, s) => sum + s.estimatedCostUSD, 0),
    requiredCapability: def.requiredCapability ?? null,
  }));

  return {
    goals,
    providerSelections,
    notReported: NOT_REPORTED,
  };
}
