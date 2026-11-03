/**
 * platform/ai/readiness-probe.ts — readiness for the AI provider, with the deployed key and the
 * deployed models (TASK-197, audit D-2/D-3)
 *
 * LLMProviderHealthProbe (platform/observability/health.ts) was never registered, and its
 * empty-body POST answered 400 for a retired model or an exhausted balance alike — reported as
 * "healthy". This probe sends, for each model MODEL_REGISTRY routes to, the one request
 * scripts/check-model-ids.mjs sends — max_tokens 1, the entry's own `thinking` and `temperature`
 * settings — with THIS deployment's ANTHROPIC_API_KEY, so a revoked or out-of-credit production
 * key, a retired model (404) or a request shape the model now refuses (400) shows in readiness
 * here, where the weekly CI check, which uses the repository's key, cannot see it.
 *
 * Billed (a few tokens per model), so cached (CachedHealthProbe, AI_PROBE_TTL_MS — audit X-13).
 * Optional (ADR-056 D4): unhealthy makes readiness "degraded" and reaches the error reporter.
 *
 * @module platform/ai
 */

import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { CachedHealthProbe } from "@/platform/observability/health";
import {
  PAID_PROBE_CACHE,
  PaidApiProbe,
  type PaidApiCall,
} from "@/platform/observability/paid-api-probe";
import type { HealthProbe } from "@/platform/observability/types";
import { MODEL_REGISTRY, type ModelConfig } from "./types";
import { anthropicFailureReason } from "./provider";

export const AI_PROVIDER_PROBE = "ai-provider";
/** At most one probe call per model per 15 minutes per instance. */
export const AI_PROBE_TTL_MS = 15 * 60_000;

/** The minimal request for a registry entry, as the provider would send it. */
export function aiProbeRequest(config: ModelConfig): Record<string, unknown> {
  return {
    model: config.modelId,
    max_tokens: 1,
    messages: [{ role: "user", content: "ping" }],
    ...(config.thinking ? { thinking: config.thinking } : {}),
    ...(config.acceptsTemperature ? { temperature: 0 } : {}),
  };
}

/** One call per distinct model the registry routes to (the first tier that names it). */
function modelCalls(apiKey: string, baseUrl: string): PaidApiCall[] {
  const seen = new Set<string>();
  const calls: PaidApiCall[] = [];
  for (const [tier, config] of Object.entries(MODEL_REGISTRY) as [
    string,
    ModelConfig,
  ][]) {
    if (seen.has(config.modelId)) continue;
    seen.add(config.modelId);
    calls.push({
      label: `${tier}: ${config.modelId}`,
      classify: (status, body) => anthropicFailureReason(status, body),
      call: (signal) =>
        fetchWithTimeout(`${baseUrl}/v1/messages`, {
          method: "POST",
          timeoutMs: 10_000,
          maxRetries: 0,
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(aiProbeRequest(config)),
          signal,
        }),
    });
  }
  return calls;
}

/**
 * The AI provider's readiness probe, cached. Probes only when the deployment calls Anthropic
 * (AI_PROVIDER unset or "anthropic"); without a key it is unhealthy — every AI call would fail.
 */
export function createAIProviderReadinessProbe(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: { readonly baseUrl?: string; readonly ttlMs?: number } = {}
): HealthProbe {
  const probe = new PaidApiProbe({
    name: AI_PROVIDER_PROBE,
    calls: () => {
      const selected = (env.AI_PROVIDER ?? "anthropic") === "anthropic";
      if (!selected) return null;
      const key = env.ANTHROPIC_API_KEY ?? "";
      if (!key) {
        return [
          {
            label: "ANTHROPIC_API_KEY",
            call: async () => new Response(null, { status: 401 }),
          },
        ];
      }
      return modelCalls(key, options.baseUrl ?? "https://api.anthropic.com");
    },
  });
  return new CachedHealthProbe(
    probe,
    options.ttlMs ?? AI_PROBE_TTL_MS,
    Date.now,
    PAID_PROBE_CACHE
  );
}
