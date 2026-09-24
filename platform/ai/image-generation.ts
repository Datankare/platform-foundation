/**
 * platform/ai/image-generation.ts — governed image generation (ADR-045).
 *
 * Generation is a committed external effect, not a plain call: draft (idempotent) → screen
 * (ADR-046, output) → risk-classify → route. Low-risk auto-commits at the boundary carrying a
 * provenance credential (ADR-047); high-risk is held for Confirm (and, given an approval
 * context, enqueued as a proposal for the ADR-040 admin queue); a blocked/escalated draft is
 * withheld. A synthetic-origin signal on a reference image (ADR-047 detection) raises the tier.
 * Nothing surfaces until committed, and a retry never double-spends.
 *
 * @module platform/ai
 */

import { performExternalEffect, getProposalStore } from "@/platform/agents";
import type { AgentIdentity } from "@/platform/kernel/types";
import { screenModality, screenPermits } from "@/platform/moderation";
import type { ModalityScreenResult } from "@/platform/moderation";
import {
  emitProvenance,
  detectSyntheticOrigin,
  type ImageBytes,
  type ProvenanceCredential,
} from "./provenance";

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
  /** Inbound reference images (image-to-image); screened for synthetic origin (ADR-047 D2). */
  readonly referenceImages?: readonly ImageBytes[];
}

export type ImageGenerator = (request: GenerationRequest) => Promise<GeneratedImage>;

export type GenerationTier = "low" | "high";
export type GenerationStatus = "committed" | "held" | "withheld";

export interface GenerationOutcome {
  readonly status: GenerationStatus;
  readonly image?: GeneratedImage;
  readonly tier?: GenerationTier;
  /** Provenance credential attached at commit (ADR-047 D1). */
  readonly provenance?: ProvenanceCredential;
  /** Proposal id when a held generation was enqueued for admin Confirm (ADR-040). */
  readonly proposalId?: string;
  readonly reason: string;
}

/** Signals available to the risk policy beyond the request + output screen. */
export interface RiskSignals {
  /** A reference image was flagged synthetic by ADR-047 detection. */
  readonly syntheticInput: boolean;
}

/** Admin-configurable risk policy: request + output-screen verdict + signals → tier (ADR-045 D3). */
export type GenerationRiskPolicy = (
  request: GenerationRequest,
  screen: ModalityScreenResult,
  signals: RiskSignals
) => GenerationTier;

/**
 * Default policy: an untrusted requester, a warned image, or a synthetic-flagged reference
 * image → high; only a trusted/system requester with a clean image and clean input auto-commits.
 */
export const defaultRiskPolicy: GenerationRiskPolicy = (request, screen, signals) => {
  const trusted =
    request.requesterTrust === "system" || request.requesterTrust === "trusted";
  if (!trusted) return "high";
  if (screen.action === "warn") return "high";
  if (signals.syntheticInput) return "high";
  return "low";
};

let riskPolicy: GenerationRiskPolicy = defaultRiskPolicy;
export function setGenerationRiskPolicy(p: GenerationRiskPolicy): void {
  riskPolicy = p;
}
export function resetGenerationRiskPolicy(): void {
  riskPolicy = defaultRiskPolicy;
}

/** Agent context required to enqueue a held generation as a proposal (ADR-040). */
export interface ApprovalContext {
  readonly actor: AgentIdentity;
  readonly sessionId: string;
  readonly trajectoryId: string;
}

export interface GenerateOptions {
  readonly requestId: string;
  /** Generation model, recorded in the provenance credential. */
  readonly model?: string;
  /** When present, a held generation is enqueued as a proposal for the admin queue. */
  readonly approvalContext?: ApprovalContext;
}

/** Detect synthetic origin across a request's reference images (ADR-047 D2). */
async function anySyntheticReference(request: GenerationRequest): Promise<boolean> {
  for (const ref of request.referenceImages ?? []) {
    if ((await detectSyntheticOrigin(ref)).synthetic) return true;
  }
  return false;
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

  // 3. Risk-classify — a synthetic reference image raises the tier (ADR-047 detection → tiering).
  const syntheticInput = await anySyntheticReference(request);
  const tier = riskPolicy(request, verdict, { syntheticInput });

  // 4. Route.
  if (tier === "high") {
    const proposalId = opts.approvalContext
      ? await enqueueHeldGeneration(request, opts.approvalContext)
      : undefined;
    return {
      status: "held",
      image: draft,
      tier,
      proposalId,
      reason: syntheticInput
        ? "high-risk generation held for Confirm (synthetic reference input)"
        : "high-risk generation held for Confirm",
    };
  }

  // 5. Low-risk auto-commits at the boundary, carrying a provenance credential (ADR-047 D1).
  const provenance = emitProvenance(draft, { model: opts.model ?? "image-generation" });
  return {
    status: "committed",
    image: draft,
    tier,
    provenance,
    reason: "committed (low risk)",
  };
}

/** Enqueue a held generation as a proposal so it surfaces in the ADR-040 admin queue. */
async function enqueueHeldGeneration(
  request: GenerationRequest,
  ctx: ApprovalContext
): Promise<string> {
  const record = await getProposalStore().create({
    operationId: request.operationId,
    sessionId: ctx.sessionId,
    trajectoryId: ctx.trajectoryId,
    label: "image-generation",
    actor: ctx.actor,
    effects: ["externalCall"],
    effectiveRisk: "consequential",
    payload: { prompt: request.prompt, category: request.category },
  });
  return record.proposalId;
}
