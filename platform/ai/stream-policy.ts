/**
 * platform/ai/stream-policy.ts — Server-side bounds for the streaming endpoint
 *
 * The caller never decides how much model time a request may spend. Every field the client may
 * send to /api/stream is validated here against fixed bounds; anything outside them is refused
 * with a coded error rather than clamped silently, so a client learns what it may ask for.
 *
 * GenAI Principles: P4 (structural safety), P5 (cost-aware), P11 (fail-closed)
 *
 * @module platform/ai
 */

import type { ModelTier } from "./types";

/** The account-status feature the stream route is governed under (see account-status-guard). */
export const STREAM_FEATURE = "stream";

/** Longest prompt accepted, in characters. */
export const STREAM_MAX_PROMPT_CHARACTERS = 4000;
/** Most output tokens a single request may ask for; also the default. */
export const STREAM_MAX_TOKENS = 1024;
/** Model tiers a caller may choose. */
export const STREAM_TIERS = ["fast", "standard"] as const satisfies readonly ModelTier[];

export type StreamTier = (typeof STREAM_TIERS)[number];

export interface StreamRequestInput {
  readonly prompt: string;
  readonly tier: StreamTier;
  readonly maxTokens: number;
  /**
   * 0–1. Applied only on a tier whose model accepts it (ModelConfig.acceptsTemperature): the
   * standard tier (Sonnet 5.5) answers a request carrying one with a 400, so the provider drops
   * it there and the stream runs at the model's own sampling. Accepted, never refused, so a
   * client that sends one keeps working on either tier.
   */
  readonly temperature?: number;
}

export type StreamValidation =
  | { readonly ok: true; readonly input: StreamRequestInput }
  | {
      readonly ok: false;
      readonly code:
        | "request.invalid_body"
        | "request.text_empty"
        | "request.text_too_long"
        | "request.invalid_value"
        | "request.field_not_accepted";
      readonly params?: Record<string, string | number | readonly string[]>;
    };

/** Validate a parsed request body against the stream bounds. */
export function validateStreamRequest(body: unknown): StreamValidation {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, code: "request.invalid_body" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.prompt !== "string" || b.prompt.trim().length === 0) {
    return { ok: false, code: "request.text_empty" };
  }
  if (b.prompt.length > STREAM_MAX_PROMPT_CHARACTERS) {
    return {
      ok: false,
      code: "request.text_too_long",
      params: { max: STREAM_MAX_PROMPT_CHARACTERS },
    };
  }

  // The system prompt is the platform's (prompts/assistant/stream-v1.ts), never the caller's:
  // a caller-supplied one replaced the platform's instructions (audit X-11).
  if (b.system !== undefined) {
    return { ok: false, code: "request.field_not_accepted", params: { field: "system" } };
  }

  const tier = b.tier ?? "standard";
  if (typeof tier !== "string" || !(STREAM_TIERS as readonly string[]).includes(tier)) {
    return {
      ok: false,
      code: "request.invalid_value",
      params: { field: "tier", allowed: STREAM_TIERS },
    };
  }

  const maxTokens = b.maxTokens ?? STREAM_MAX_TOKENS;
  if (
    typeof maxTokens !== "number" ||
    !Number.isInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > STREAM_MAX_TOKENS
  ) {
    return {
      ok: false,
      code: "request.invalid_value",
      params: { field: "maxTokens", allowed: [`1–${STREAM_MAX_TOKENS}`] },
    };
  }

  if (
    b.temperature !== undefined &&
    (typeof b.temperature !== "number" ||
      !Number.isFinite(b.temperature) ||
      b.temperature < 0 ||
      b.temperature > 1)
  ) {
    return {
      ok: false,
      code: "request.invalid_value",
      params: { field: "temperature", allowed: ["0–1"] },
    };
  }

  return {
    ok: true,
    input: {
      prompt: b.prompt,
      tier: tier as StreamTier,
      maxTokens,
      temperature: b.temperature as number | undefined,
    },
  };
}
