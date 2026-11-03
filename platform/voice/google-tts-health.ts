/**
 * platform/voice/google-tts-health.ts — readiness for Google text-to-speech, and that every
 * voice the platform names still exists (TASK-197, audit D-2/D-3)
 *
 * Lists the voices Google offers (voices.list: no synthesis, no charge) with the deployment's
 * GOOGLE_API_KEY, whenever one is set, and checks every voice in VOICE_CONFIGS
 * (platform/voice/voices.ts) is among them: a voice Google withdraws (`en-US-Neural2-F` is named
 * in code, nothing else checked it) is reported before a user's request fails. A refused key is
 * unhealthy, as for any paid API (PaidApiProbe). Cached; optional (ADR-056 D4).
 *
 * Speech-to-text has no equivalent: its v1 API offers no list of models and no free call, so
 * `latest_long` is not checked here; it shares the key this probe checks.
 *
 * @module platform/voice
 */

import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { CachedHealthProbe } from "@/platform/observability/health";
import { PAID_PROBE_CACHE, PaidApiProbe } from "@/platform/observability/paid-api-probe";
import type { HealthProbe } from "@/platform/observability/types";
import { getGoogleApiKeySetting } from "@/shared/config/apiKeys";
import { VOICE_CONFIGS } from "./voices";

export const GOOGLE_TTS_PROBE = "google-tts";
export const GOOGLE_TTS_PROBE_TTL_MS = 15 * 60_000;

const VOICES_URL = "https://texttospeech.googleapis.com/v1/voices";

/** The configured voices a voices.list answer does not offer. */
export function missingVoices(
  body: unknown,
  wanted: readonly string[] = VOICE_CONFIGS.map((v) => v.voiceName)
): string[] {
  const offered = new Set(
    Array.isArray((body as { voices?: unknown })?.voices)
      ? (body as { voices: { name?: unknown }[] }).voices
          .map((v) => v?.name)
          .filter((n): n is string => typeof n === "string")
      : []
  );
  return wanted.filter((name) => !offered.has(name));
}

export function createGoogleTtsProbe(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: { readonly ttlMs?: number } = {}
): HealthProbe {
  return new CachedHealthProbe(
    new PaidApiProbe({
      name: GOOGLE_TTS_PROBE,
      calls: () => {
        const key = getGoogleApiKeySetting(env).trim();
        if (!key) return null;
        return [
          {
            label: "text-to-speech voices",
            call: (signal) =>
              fetchWithTimeout(VOICES_URL, {
                timeoutMs: 10_000,
                maxRetries: 0,
                headers: { "X-Goog-Api-Key": key },
                signal,
              }),
            verify: async (res) => {
              const missing = missingVoices(await res.json().catch(() => null));
              return missing.length
                ? `voices no longer offered: ${missing.join(", ")}`
                : null;
            },
          },
        ];
      },
    }),
    options.ttlMs ?? GOOGLE_TTS_PROBE_TTL_MS,
    Date.now,
    PAID_PROBE_CACHE
  );
}
