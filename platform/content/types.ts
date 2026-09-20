/**
 * platform/content/types.ts — ADR-037 dynamic content generation framework types.
 *
 * The platform owns the generation loop; the consumer supplies the app-specific logic (ADR-028 D1):
 * build (the LLM request), parse (the typed content), schema (JSON Schema the content is validated
 * against, P6), a MANDATORY static-template fallback (ADR-037 D3, fail-closed per P11), and
 * toScreenText (the text the framework screens through the Guardian before the content can surface,
 * ADR-037 D4 / P4). Unlike the adaptive framework (ADR-036), content is generated fresh from the
 * current input — there is no within-session memory (ADR-037 D7).
 */
import type { AIRequest } from "@/platform/ai/types";

/**
 * A registered content type. `TInput` is the consumer's generation input; `TContent` its typed,
 * schema-conforming output. Everything the framework does with generated content (running it on the
 * ADR-039 runtime, screening it, surfacing it) is the platform's; everything app-specific here is
 * the consumer's.
 */
export interface ContentType<TInput, TContent> {
  /** Registered prompt name (ADR-015 / ADR-038) — the content type is eval-gated by that name. */
  readonly name: string;
  /** Registered agent that hosts generation on the ADR-039 runtime (D2). */
  readonly agentId: string;
  /** Build the LLM request from the input. No memory — content is generated fresh (D7). */
  readonly build: (input: TInput) => AIRequest;
  /** Parse the model's raw text into the typed content (the prompt's own parser). */
  readonly parse: (raw: string) => TContent;
  /** JSON Schema the parsed content is validated against before it surfaces (D6 / P6). */
  readonly schema: Record<string, unknown>;
  /** Deterministic static template — MANDATORY (D3 / P11). Fires on orchestrator error, open
   *  circuit breaker, parse failure, schema-invalid output, or a Guardian block. */
  readonly renderFallback: (input: TInput) => TContent;
  /** The text handed to the Guardian for screening before the content can surface (D4 / P4). */
  readonly toScreenText: (content: TContent) => string;
}

/** Type-erased content type for heterogeneous registry storage. */
export type AnyContentType = ContentType<never, unknown>;
