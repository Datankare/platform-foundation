/**
 * platform/translation/google-health.ts — readiness for the Google key, through Translation
 * (TASK-197, audit D-2)
 *
 * A Google key restricted, revoked or with billing off answered every translation with a 403
 * that ended as a 500 — and readiness never asked. This probe lists Translation's languages
 * (no characters translated: no charge) with the deployment's GOOGLE_API_KEY, whenever one is
 * set — the app may call Google directly (Playform's lib/translate.ts) as well as through the
 * TRANSLATION_PROVIDER slot. Cached; optional (ADR-056 D4).
 *
 * @module platform/translation
 */

import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { CachedHealthProbe } from "@/platform/observability/health";
import { PAID_PROBE_CACHE, PaidApiProbe } from "@/platform/observability/paid-api-probe";
import type { HealthProbe } from "@/platform/observability/types";
import { getGoogleApiKeySetting } from "@/shared/config/apiKeys";

export const GOOGLE_TRANSLATE_PROBE = "google-translate";
export const GOOGLE_PROBE_TTL_MS = 15 * 60_000;

const LANGUAGES_URL =
  "https://translation.googleapis.com/language/translate/v2/languages?target=en";

export function createGoogleTranslateProbe(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: { readonly ttlMs?: number } = {}
): HealthProbe {
  return new CachedHealthProbe(
    new PaidApiProbe({
      name: GOOGLE_TRANSLATE_PROBE,
      calls: () => {
        const key = getGoogleApiKeySetting(env).trim();
        if (!key) return null;
        return [
          {
            label: "translation languages",
            call: (signal) =>
              fetchWithTimeout(LANGUAGES_URL, {
                timeoutMs: 10_000,
                maxRetries: 0,
                headers: { "X-Goog-Api-Key": key },
                signal,
              }),
          },
        ];
      },
    }),
    options.ttlMs ?? GOOGLE_PROBE_TTL_MS,
    Date.now,
    PAID_PROBE_CACHE
  );
}
