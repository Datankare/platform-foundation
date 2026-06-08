/**
 * platform/moderation/review-assist.ts — AI reviewer assist (advisory)
 *
 * ADR-025: produces a NON-BINDING recommendation (uphold / overturn / modify)
 * for a human reviewer, from the automated decision's own context. The human
 * always makes the final call (P10) — this never resolves anything.
 *
 * Design:
 *   - On-demand only (the reviewer asks) — never auto-fired (P12 cost/latency).
 *   - Fail-open: any model/parse failure returns null, so the review surface
 *     simply shows no suggestion rather than blocking (P11).
 *   - Structured output (P6): the model is constrained to a small JSON object,
 *     which we validate before trusting.
 *
 * @module platform/moderation
 */

import { getOrchestrator } from "@/platform/ai";
import { logger } from "@/lib/logger";
import type { AIResponse } from "@/platform/ai";
import type { ReviewDecision, ReviewQueueItem } from "./review-types";

/** A non-binding suggestion for a human reviewer. */
export interface ReviewRecommendation {
  /** Suggested decision — advisory only */
  readonly recommendation: ReviewDecision;
  /** One or two sentences explaining the suggestion */
  readonly rationale: string;
}

const SYSTEM_PROMPT =
  "You are a content-moderation review assistant. You are given an automated " +
  "moderation decision and the reasoning behind it. Recommend whether a human " +
  "reviewer should UPHOLD, OVERTURN, or MODIFY the decision. You are advisory " +
  "only — the human makes the final decision. Respond with ONLY a JSON object, " +
  "no prose and no markdown fences: " +
  '{"recommendation":"uphold"|"overturn"|"modify","rationale":"<one or two sentences>"}.';

/** Build the decision context the model reasons over. */
function buildContext(item: ReviewQueueItem): string {
  const m = item.moderationResult;
  const c = m.classifierOutput;
  const lines: string[] = [
    `Review source: ${item.source}`,
    `Automated action: ${m.action}`,
    `Triggered by: ${m.triggeredBy}`,
    c
      ? `Classifier: categories=[${c.categories.join(", ")}], severity=${c.severity}`
      : "Classifier: not invoked",
    `Reasoning: ${m.reasoning}`,
    m.contextFactors.length > 0
      ? `Context factors: ${m.contextFactors.join("; ")}`
      : "Context factors: none",
  ];
  if (item.appealReason) lines.push(`User appeal: ${item.appealReason}`);
  if (item.explanationChain?.conclusion) {
    lines.push(`Explanation: ${item.explanationChain.conclusion}`);
  }
  return lines.join("\n");
}

/** Concatenate the text blocks of an AI response. */
function extractText(content: AIResponse["content"]): string {
  return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** Parse + validate the model's JSON. Returns null on anything unexpected. */
function parseRecommendation(text: string): ReviewRecommendation | null {
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  try {
    const obj = JSON.parse(cleaned) as {
      recommendation?: unknown;
      rationale?: unknown;
    };
    const rec = obj.recommendation;
    const valid: ReviewDecision[] = ["uphold", "overturn", "modify"];
    if (
      typeof rec === "string" &&
      (valid as string[]).includes(rec) &&
      typeof obj.rationale === "string" &&
      obj.rationale.trim().length > 0
    ) {
      return { recommendation: rec as ReviewDecision, rationale: obj.rationale };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Generate an advisory recommendation for a review item.
 * Returns null if the model is unavailable or its output cannot be trusted.
 */
export async function generateReviewRecommendation(
  item: ReviewQueueItem,
  requestId: string
): Promise<ReviewRecommendation | null> {
  try {
    const response = await getOrchestrator().complete(
      {
        tier: "standard",
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildContext(item) }],
        maxTokens: 400,
      },
      { useCase: "review-assist", requestId }
    );

    const parsed = parseRecommendation(extractText(response.content));
    if (!parsed) {
      logger.warn("Review assist: model output could not be parsed", {
        reviewItemId: item.id,
        requestId,
        route: "platform/moderation/review-assist",
      });
      return null;
    }
    return parsed;
  } catch (err) {
    logger.error("Review assist: generation failed", {
      reviewItemId: item.id,
      requestId,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/moderation/review-assist",
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gotchas (L17)
// ---------------------------------------------------------------------------
//
// 1. ADVISORY ONLY. This module never resolves a review item or changes account
//    status — it returns a suggestion a human may accept or ignore (P10).
//
// 2. Fail-open by design. Model unavailable, timeout, or malformed JSON → null.
//    The review surface must treat null as "no suggestion", never as an error
//    that blocks resolution (P11).
//
// 3. On-demand only. Callers should invoke this when a reviewer explicitly asks
//    (a button), not for every queued item — each call spends tokens (P12).
//
// 4. The prompt is inline for now. If reviewer-assist grows (few-shot examples,
//    tier tuning), graduate it into the prompts/ registry like other agents.
