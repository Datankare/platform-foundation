/**
 * platform/adaptive/types.ts — ADR-036 adaptive behavior framework types.
 *
 * The platform owns the adaptive loop; the consumer supplies the app-specific logic (ADR-028 D1):
 * build (the LLM request), parse (the typed decision), schema (JSON Schema the decision is
 * validated against), and a MANDATORY deterministic fallback (ADR-036 D3). Within-session memory
 * is a bounded, session-scoped slice (D5) the loop reads and appends; it dies with the session.
 */
import type { AIRequest } from "@/platform/ai/types";

/** One prior adaptive decision this session (compact; consumer-summarized). */
export interface AdaptiveMemoryEntry {
  readonly at: number;
  readonly behavior: string;
  readonly summary: string;
}

/** Read-only within-session memory handed to a behavior. Backed by the session
 *  ActivityStateStore (D5); most recent entry last; bounded by the loop. */
export interface AdaptiveMemory {
  readonly recent: readonly AdaptiveMemoryEntry[];
}

/**
 * A registered adaptive behavior. `TInput` is the consumer's decision input; `TDecision` its
 * typed output. Everything effectful the framework does with a decision (routing, memory) is the
 * platform's; everything app-specific here is the consumer's.
 */
export interface AdaptiveBehavior<TInput, TDecision> {
  /** Registered prompt name (ADR-038) — the behavior is eval-gated by that name. */
  readonly name: string;
  /** Registered agent that hosts the decision on the ADR-039 runtime (D2). */
  readonly agentId: string;
  /** Build the LLM request from input + within-session memory. */
  readonly build: (input: TInput, memory: AdaptiveMemory) => AIRequest;
  /** Parse the model's raw text into the typed decision (the prompt's own parser). */
  readonly parse: (raw: string) => TDecision;
  /** JSON Schema the parsed decision is validated against before use (D3). */
  readonly schema: Record<string, unknown>;
  /** Deterministic fallback — MANDATORY (D3). Fires on orchestrator error, open circuit
   *  breaker, parse failure, or schema-invalid output. */
  readonly fallback: (input: TInput, memory: AdaptiveMemory) => TDecision;
  /** Compact summary of a decision, appended to within-session memory (D5). */
  readonly summarize: (decision: TDecision) => string;
}

/** Type-erased behavior for heterogeneous registry storage. */
export type AnyAdaptiveBehavior = AdaptiveBehavior<never, unknown>;
