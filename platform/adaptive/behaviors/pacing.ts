/**
 * platform/adaptive/behaviors/pacing.ts — the reference adaptive behavior (ADR-036 step 4).
 *
 * The canonical, registered end-to-end example an adaptive consumer copies (Playform first):
 * a real AdaptiveBehavior bound to the "adaptive-pacing" prompt (ADR-038 eval-gated), hosted by a
 * dedicated runtime agent, with a mandatory deterministic fallback (D3), a JSON-Schema contract
 * validated before use, and within-session memory fed back into the next decision (D5).
 *
 * See ./README.md for the authoring guide (interfaces, the fallback/schema/memory contract, and
 * how activation works via registerAdaptiveReference).
 *
 * @module platform/adaptive/behaviors
 */

import type { AgentConfig } from "@/platform/agents";
import type { AIRequest } from "@/platform/ai/types";
import {
  PACING_V1,
  buildPacingPrompt,
  parsePacingResponse,
  type PacingDecision,
  type PacingDecisionResult,
} from "@/prompts/adaptive/pacing-v1";
import type { AdaptiveBehavior, AdaptiveMemory } from "../types";

/** Decision input the consumer supplies each turn. Recent prior decisions come from
 *  within-session memory (D5), not from the caller — so the caller passes only the live signal. */
export interface PacingBehaviorInput {
  readonly scopeLabel: string;
  readonly signal: string;
}

/** The runtime agent that hosts the pacing decision (ADR-039). Its budget bounds a single
 *  cheap LLM call per trigger. Registered by registerAdaptiveReference (see ../bootstrap). */
export const PACING_HOST_AGENT: AgentConfig = {
  id: "adaptive-pacing-host",
  name: "Adaptive Pacing (reference host)",
  description:
    "Reference host agent for the ADR-036 adaptive-pacing behavior. Runs one governed pacing " +
    "decision per trigger; the decision is routed as a commitment-boundary effect (ADR-036 D4).",
  tools: [],
  budgetConfig: {
    maxCostPerTrajectory: 0.05,
    maxCostPerDay: 10.0,
    maxStepsPerTrajectory: 4,
  },
  effortTier: "standard",
};

const DECISION_VALUES: readonly PacingDecision[] = [
  "accelerate",
  "steady",
  "slow",
  "pause",
];

/** JSON Schema the parsed decision is validated against before use (D3). ajv-backed
 *  (platform/agents/schema), so the decision `enum` is enforced as defense in depth on top of the
 *  parser's own fail-closed default. */
const PACING_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    decision: { type: "string", enum: [...DECISION_VALUES] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string" },
  },
  required: ["decision", "confidence", "rationale"],
  additionalProperties: false,
};

/** The reference behavior. Binds the "adaptive-pacing" prompt's own builder + parser; maps
 *  within-session memory into the prompt input; falls back to the neutral "steady" no-op. */
export const PACING_BEHAVIOR: AdaptiveBehavior<
  PacingBehaviorInput,
  PacingDecisionResult
> = {
  name: PACING_V1.name,
  agentId: PACING_HOST_AGENT.id,
  build: (input: PacingBehaviorInput, memory: AdaptiveMemory): AIRequest => ({
    tier: PACING_V1.tier,
    messages: [
      {
        role: "user",
        content: buildPacingPrompt({
          scopeLabel: input.scopeLabel,
          signal: input.signal,
          recentSummaries: memory.recent.map((e) => e.summary),
        }),
      },
    ],
    maxTokens: PACING_V1.maxTokens,
    temperature: PACING_V1.temperature,
  }),
  parse: parsePacingResponse,
  schema: PACING_SCHEMA,
  fallback: (): PacingDecisionResult => ({
    decision: "steady",
    confidence: 0,
    rationale: "Deterministic fallback (ADR-036 D3): held pace steady.",
  }),
  summarize: (d: PacingDecisionResult): string =>
    `pacing=${d.decision} (confidence ${d.confidence.toFixed(2)})`,
};
