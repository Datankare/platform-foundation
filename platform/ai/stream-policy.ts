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
/** Longest caller-supplied system prompt accepted, in characters. */
export const STREAM_MAX_SYSTEM_CHARACTERS = 2000;
/** Most output tokens a single request may ask for; also the default. */
export const STREAM_MAX_TOKENS = 1024;
/** Model tiers a caller may choose. */
export const STREAM_TIERS = ["fast", "standard"] as const satisfies readonly ModelTier[];

export type StreamTier = (typeof STREAM_TIERS)[number];

export interface StreamRequestInput {
  readonly prompt: string;
  readonly system?: string;
  readonly tier: StreamTier;
  readonly maxTokens: number;
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
        | "request.invalid_value";
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

  if (b.system !== undefined) {
    if (typeof b.system !== "string") {
      return {
        ok: false,
        code: "request.invalid_value",
        params: { field: "system", allowed: ["text"] },
      };
    }
    if (b.system.length > STREAM_MAX_SYSTEM_CHARACTERS) {
      return {
        ok: false,
        code: "request.text_too_long",
        params: { max: STREAM_MAX_SYSTEM_CHARACTERS },
      };
    }
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
      system: b.system as string | undefined,
      tier: tier as StreamTier,
      maxTokens,
      temperature: b.temperature as number | undefined,
    },
  };
}
