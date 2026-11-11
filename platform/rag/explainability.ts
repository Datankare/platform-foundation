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

import type { ShownText } from "@/platform/errors/shown-text";
import type { ExplanationChain, ExplanationStep } from "./types";
import { generateId } from "@/platform/agents/utils";

/**
 * Builder for constructing explanation chains step by step.
 *
 * Usage:
 *   const builder = createExplanationBuilder(requestId);
 *   builder.addStep("context-retrieval", retrievedText, { ... }, 42);
 *   const chain = builder.build(answeredText);
 *
 * Each description and the conclusion is a catalog key and values (an app's own, under
 * screens.app.*), never English composed in code (TASK-209): a chain is stored with a review case
 * and shown to moderators.
 */
export interface ExplanationBuilder {
  /** Add a step to the chain */
  addStep(
    phase: string,
    description: ShownText,
    data: Record<string, unknown>,
    durationMs: number
  ): void;

  /** Build the final explanation chain; its conclusion a catalog key and values (TASK-209). */
  build(conclusion: ShownText): ExplanationChain;
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
      description: ShownText,
      data: Record<string, unknown>,
      durationMs: number
    ): void {
      steps.push({ phase, description, data, durationMs });
    },

    build(conclusion: ShownText): ExplanationChain {
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
