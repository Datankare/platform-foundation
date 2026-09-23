/**
 * platform/ai/multimodal.ts — shared multimodal substrate (ADR-044 D6).
 *
 * The write-once helpers over the content model + provider capability descriptor that the
 * rest of Sprint 6 consumes (ADR-045 generation, ADR-046 screening, ADR-047 provenance).
 * Modality-aware routing lives here: given a request and a provider's declared capability,
 * decide what proceeds and what degrades to text (ADR-044 D3, fail-closed).
 *
 * @module platform/ai
 */

import type {
  AIRequest,
  AIMessage,
  AIContentBlock,
  Modality,
  ProviderCapabilities,
} from "./types";

/** The modality of a single content block. */
export function blockModality(block: AIContentBlock): Modality {
  if (block.type === "image") return "image";
  if (block.type === "audio") return "audio";
  return "text"; // text, tool_use, tool_result are all text-plane
}

/** Every input modality present in a request's messages. */
export function requestModalities(request: AIRequest): Set<Modality> {
  const out = new Set<Modality>();
  for (const m of request.messages) {
    if (typeof m.content === "string") {
      out.add("text");
      continue;
    }
    for (const b of m.content) out.add(blockModality(b));
  }
  return out;
}

/** Whether a capability descriptor accepts a modality as input. */
export function supportsInput(caps: ProviderCapabilities, m: Modality): boolean {
  return caps.inputs.includes(m);
}

/**
 * Degrade a request to what the provider's capability descriptor accepts as input
 * (ADR-044 D3). Content blocks in unsupported modalities are dropped; the reason is
 * returned so the caller can record it. Text is never dropped. Fail-closed by omission:
 * an unsupported modality never reaches the provider.
 */
export function degradeToSupported(
  request: AIRequest,
  caps: ProviderCapabilities
): { request: AIRequest; dropped: Modality[] } {
  const dropped = new Set<Modality>();
  const messages: AIMessage[] = request.messages.map((m) => {
    if (typeof m.content === "string") return m;
    const kept: AIContentBlock[] = [];
    for (const b of m.content) {
      const mod = blockModality(b);
      if (mod === "text" || supportsInput(caps, mod)) kept.push(b);
      else dropped.add(mod);
    }
    return { ...m, content: kept };
  });
  return { request: { ...request, messages }, dropped: [...dropped] };
}
