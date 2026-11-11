/**
 * platform/ai/screen-input.ts — ADR-044 D4: screen multimodal input before dispatch.
 *
 * Bridges the AI provider content model (ADR-044) to the ADR-046 screenModality seam. Runs on
 * the blocks that survive capability degradation, so screening always sees exactly what will
 * reach the model. allow/warn proceed; block/escalate (and a screener error, which fails closed
 * to escalate) withhold the turn — a flagged input is a hard stop, never a silent omission.
 *
 * @module platform/ai
 */

import { shown, type ShownText } from "@/platform/errors/shown-text";
import type { AIRequest, AIImageBlock, AIAudioBlock } from "./types";
import { screenModality, screenPermits } from "@/platform/moderation";
import type { ModalityContent } from "@/platform/moderation";

function toModalityContent(b: AIImageBlock | AIAudioBlock): ModalityContent {
  return { modality: b.type, mediaType: b.source.mediaType, data: b.source.data };
}

export interface InputScreenOutcome {
  readonly refused: boolean;
  /** Why: a catalog key and values (TASK-209), logged; never returned to the caller. */
  readonly reason?: ShownText;
}

/** Screen every image/audio input block through the ADR-046 seam (fail-closed refusal). */
export async function screenMultimodalInput(
  request: AIRequest,
  requestId: string
): Promise<InputScreenOutcome> {
  for (const m of request.messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type !== "image" && b.type !== "audio") continue;
      const result = await screenModality(toModalityContent(b), {
        direction: "input",
        requestId,
      });
      if (!screenPermits(result)) {
        return {
          refused: true,
          reason: shown("screens.moderation.modality.input_withheld", {
            modality: b.type,
            action: result.action,
            reason: result.reasoning,
          }),
        };
      }
    }
  }
  return { refused: false };
}

import { detectSyntheticOrigin } from "./provenance";

/**
 * Detect synthetic origin on multimodal input (ADR-047 D2). For a completion there is no
 * governed-hold to raise, so this records the signal (available downstream) rather than gating —
 * detection is a signal, never a standalone gate. Returns the per-block signals for the caller
 * to log / attach.
 */
export async function detectMultimodalInput(
  request: AIRequest
): Promise<{ syntheticBlocks: number }> {
  let syntheticBlocks = 0;
  for (const m of request.messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type !== "image" && b.type !== "audio") continue;
      const signal = await detectSyntheticOrigin({
        mediaType: b.source.mediaType,
        data: b.source.data,
      });
      if (signal.synthetic) syntheticBlocks++;
    }
  }
  return { syntheticBlocks };
}
