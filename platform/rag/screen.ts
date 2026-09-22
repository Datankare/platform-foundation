/**
 * platform/rag/screen.ts — the input-screening seam for the RAG data path (ADR-043).
 *
 * ADR-043 makes input screening structural (D1): every user-supplied text that reaches
 * the index or the model is screened first, at both enforcement points — ingestion (D3,
 * data-poisoning) and query (D3, prompt-injection). This module is the provider-agnostic
 * seam (D2/D6): the reference screener is the Guardian-backed
 * screenContent(..., { direction: "input" }), but any InputScreen can be injected.
 *
 * @module platform/rag
 */

import type { ModerationAction } from "@/platform/moderation/types";
import { screenContent } from "@/platform/moderation/middleware";

/** The subset of a screening decision the RAG paths act on (provider-agnostic, ADR-043 D6). */
export interface ScreenDecision {
  readonly action: ModerationAction;
  readonly reasoning?: string;
}

/** Screens one user-supplied input text. The seam both enforcement points call (ADR-043 D2). */
export type InputScreen = (
  text: string,
  ctx: { requestId: string }
) => Promise<ScreenDecision>;

/** The reference screener: the Guardian-backed screenContent on the input direction. */
export const defaultInputScreen: InputScreen = (text, { requestId }) =>
  screenContent(text, { direction: "input", requestId });

/**
 * Whether a decision permits the text to proceed. `allow` and `warn` proceed; `block` and
 * `escalate` withhold (ADR-043 D4 — both fail-closed, routed to governance by the screener).
 */
export function screenPermits(decision: ScreenDecision): boolean {
  return decision.action === "allow" || decision.action === "warn";
}

/**
 * Run a screen, fail-closed: any thrown error becomes an `escalate` decision (ADR-043 D4),
 * so a screener failure withholds rather than letting unscreened text through.
 */
export async function runInputScreen(
  screen: InputScreen,
  text: string,
  requestId: string
): Promise<ScreenDecision> {
  try {
    return await screen(text, { requestId });
  } catch (error) {
    const reasoning = error instanceof Error ? error.message : "screen error";
    return { action: "escalate", reasoning: `fail-closed: ${reasoning}` };
  }
}
