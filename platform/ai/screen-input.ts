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

import type { AIRequest, AIImageBlock, AIAudioBlock } from "./types";
import { screenModality, screenPermits } from "@/platform/moderation";
import type { ModalityContent } from "@/platform/moderation";

function toModalityContent(b: AIImageBlock | AIAudioBlock): ModalityContent {
  return { modality: b.type, mediaType: b.source.mediaType, data: b.source.data };
}

export interface InputScreenOutcome {
  readonly refused: boolean;
  readonly reason?: string;
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
          reason: `${b.type} input ${result.action}: ${result.reasoning}`,
        };
      }
    }
  }
  return { refused: false };
}
