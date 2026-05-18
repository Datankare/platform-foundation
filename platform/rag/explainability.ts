/**
 * platform/rag/explainability.ts — Explanation chain builder
 *
 * Builds human-readable explanation chains for AI decisions.
 * Records what context was retrieved, how the prompt was constructed,
 * and what the model returned.
 *
 * P10: Human oversight — inspect AI reasoning
 * P18: Durable trajectories — each step is an event
 *
 * @module platform/rag
 */

import type { ExplanationChain, ExplanationStep } from "./types";
import { generateId } from "@/platform/agents/utils";

/**
 * Builder for constructing explanation chains step by step.
 *
 * Usage:
 *   const builder = createExplanationBuilder(requestId);
 *   builder.addStep("context-retrieval", "Retrieved 3 chunks", { ... }, 42);
 *   builder.addStep("prompt-construction", "Built prompt with context", { ... }, 5);
 *   const chain = builder.build("Final answer generated");
 */
export interface ExplanationBuilder {
  /** Add a step to the chain */
  addStep(
    phase: string,
    description: string,
    data: Record<string, unknown>,
    durationMs: number
  ): void;

  /** Build the final explanation chain */
  build(conclusion: string): ExplanationChain;
}

/**
 * Create a new explanation builder.
 *
 * @param requestId - The request this explanation is for
 * @returns Builder instance
 */
export function createExplanationBuilder(requestId: string): ExplanationBuilder {
  const steps: ExplanationStep[] = [];

  return {
    addStep(
      phase: string,
      description: string,
      data: Record<string, unknown>,
      durationMs: number
    ): void {
      steps.push({ phase, description, data, durationMs });
    },

    build(conclusion: string): ExplanationChain {
      return {
        id: generateId(),
        requestId,
        steps: [...steps],
        conclusion,
        createdAt: new Date().toISOString(),
      };
    },
  };
}
