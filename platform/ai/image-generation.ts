/**
 * platform/ai/image-generation.ts — governed image generation (ADR-045).
 *
 * Generation is a committed external effect, not a plain call: draft (idempotent) → screen
 * (ADR-046, output direction) → risk-classify → route. Low-risk auto-commits at the boundary;
 * high-risk is held for Confirm; a blocked/escalated draft is withheld. Nothing is surfaced,
 * stored, or counted as spend until it is committed, and a retry never double-spends (the draft
 * runs through performExternalEffect on the ADR-031 effect-ledger). Provenance (ADR-047) is
 * attached at commit in a follow-up step.
 *
 * @module platform/ai
 */

import { performExternalEffect } from "@/platform/agents";
import { screenModality, screenPermits } from "@/platform/moderation";
import type { ModalityScreenResult } from "@/platform/moderation";

export interface GeneratedImage {
  readonly mediaType: string;
  readonly data: string;
}

export type RequesterTrust = "system" | "trusted" | "user" | "guest";

export interface GenerationRequest {
  readonly prompt: string;
  /** Idempotency anchor — a retry with the same id never re-generates (ADR-045 D1). */
  readonly operationId: string;
  readonly requesterTrust?: RequesterTrust;
  readonly category?: string;
}

export type ImageGenerator = (request: GenerationRequest) => Promise<GeneratedImage>;

export type GenerationTier = "low" | "high";
export type GenerationStatus = "committed" | "held" | "withheld";

export interface GenerationOutcome {
  readonly status: GenerationStatus;
  /** Present for committed + held (the drafted bytes); absent when withheld. */
  readonly image?: GeneratedImage;
  readonly tier?: GenerationTier;
  readonly reason: string;
}

/** Admin-configurable risk policy: request + output-screen verdict → tier (ADR-045 D3). */
export type GenerationRiskPolicy = (
  request: GenerationRequest,
  screen: ModalityScreenResult
) => GenerationTier;

/**
 * Default policy: an untrusted requester (user/guest/unknown) or a warned image → high;
 * only a trusted/system requester with a clean image auto-commits. Conservative by default.
 */
export const defaultRiskPolicy: GenerationRiskPolicy = (request, screen) => {
  const trusted =
    request.requesterTrust === "system" || request.requesterTrust === "trusted";
  if (!trusted) return "high";
  if (screen.action === "warn") return "high";
  return "low";
};

let riskPolicy: GenerationRiskPolicy = defaultRiskPolicy;
export function setGenerationRiskPolicy(p: GenerationRiskPolicy): void {
  riskPolicy = p;
}
export function resetGenerationRiskPolicy(): void {
  riskPolicy = defaultRiskPolicy;
}

export interface GenerateOptions {
  readonly requestId: string;
}

/** Governed image generation (ADR-045). See the module header for the lifecycle contract. */
export async function generateGoverned(
  request: GenerationRequest,
  generator: ImageGenerator,
  opts: GenerateOptions
): Promise<GenerationOutcome> {
  // 1. Draft idempotently — the external effect. A retry reconciles, never double-spends.
  const effect = await performExternalEffect<GeneratedImage>({
    operationId: request.operationId,
    effectKey: "image-generation",
    effectType: "externalCall",
    call: async () => generator(request),
  });
  if (effect.status === "failed") {
    return { status: "withheld", reason: `generation failed: ${effect.error}` };
  }
  if (effect.status === "indeterminate") {
    return {
      status: "held",
      reason: "generation indeterminate — awaiting reconciliation",
    };
  }
  const draft = effect.result;

  // 2. Screen the draft before commit (ADR-046, output direction). Fail-closed.
  const verdict = await screenModality(
    { modality: "image", mediaType: draft.mediaType, data: draft.data },
    { direction: "output", requestId: opts.requestId }
  );
  if (!screenPermits(verdict)) {
    return {
      status: "withheld",
      reason: `generated image ${verdict.action}: ${verdict.reasoning}`,
    };
  }

  // 3. Risk-classify + 4. route.
  const tier = riskPolicy(request, verdict);
  if (tier === "high") {
    return {
      status: "held",
      image: draft,
      tier,
      reason: "high-risk generation held for Confirm",
    };
  }
  // 5. Low-risk auto-commits at the boundary (not bypassing it).
  return { status: "committed", image: draft, tier, reason: "committed (low risk)" };
}
