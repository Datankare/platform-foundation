/**
 * platform/features/availability.ts — Optional features declare what they need (ADR-050 D3, TASK-104)
 *
 * A feature whose settings are absent is not offered: the UI asks `GET /api/features` and hides
 * it, and its route refuses with `feature.not_configured` instead of attempting and failing with
 * "please try again". Availability is computed from the same settings the providers read.
 *
 * `preview` marks a feature that is offered but not yet real (it shows sample data); the UI
 * labels it as a preview.
 *
 * Only booleans leave the server — never a setting's value.
 *
 * @module platform/features
 */

import { getAcrCloudConfig } from "@/platform/voice/acrcloud-identify";

export type FeatureId =
  "music_identification" | "audio_upload" | "speech_input" | "teams";

export interface FeatureStatus {
  readonly available: boolean;
  /** Offered, but showing sample data — label it (e.g. Teams until TASK-108). */
  readonly preview?: boolean;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

function set(env: EnvSource, name: string): boolean {
  const v = env[name];
  return typeof v === "string" && v.trim() !== "";
}

/** An audio converter that actually converts (ffmpeg-service with its URL and key). */
function converterReady(env: EnvSource): boolean {
  return (
    env.AUDIO_CONVERTER === "ffmpeg-service" &&
    set(env, "AUDIO_CONVERTER_URL") &&
    set(env, "AUDIO_CONVERTER_KEY")
  );
}

function googleSpeechReady(env: EnvSource): boolean {
  return set(env, "GOOGLE_API_KEY") || set(env, "NEXT_PUBLIC_GOOGLE_API_KEY");
}

/** What each optional feature needs. */
export const FEATURE_REQUIREMENTS: Readonly<
  Record<
    FeatureId,
    { readonly needs: string; readonly check: (env: EnvSource) => FeatureStatus }
  >
> = {
  music_identification: {
    needs:
      "SONG_ID_PROVIDER=acrcloud with ACRCLOUD_HOST / ACRCLOUD_ACCESS_KEY / ACRCLOUD_ACCESS_SECRET, and AUDIO_CONVERTER=ffmpeg-service with AUDIO_CONVERTER_URL / AUDIO_CONVERTER_KEY",
    check: (env) => {
      const acr = getAcrCloudConfig(env);
      return {
        available:
          env.SONG_ID_PROVIDER === "acrcloud" &&
          [acr.host, acr.accessKey, acr.accessSecret].every((v) => v.trim() !== "") &&
          converterReady(env),
      };
    },
  },
  audio_upload: {
    needs:
      "a speech key (GOOGLE_API_KEY) and AUDIO_CONVERTER=ffmpeg-service with AUDIO_CONVERTER_URL / AUDIO_CONVERTER_KEY (uploaded files need converting)",
    check: (env) => ({ available: googleSpeechReady(env) && converterReady(env) }),
  },
  speech_input: {
    needs: "a speech key (GOOGLE_API_KEY)",
    check: (env) => ({ available: googleSpeechReady(env) }),
  },
  teams: {
    needs:
      "nothing — sample data until TASK-108 defines participation (offered as a preview)",
    check: () => ({ available: true, preview: true }),
  },
};

export function featureAvailability(
  env: EnvSource = process.env
): Record<FeatureId, FeatureStatus> {
  const out = {} as Record<FeatureId, FeatureStatus>;
  for (const id of Object.keys(FEATURE_REQUIREMENTS) as FeatureId[]) {
    out[id] = FEATURE_REQUIREMENTS[id].check(env);
  }
  return out;
}

export function isFeatureAvailable(id: FeatureId, env: EnvSource = process.env): boolean {
  return FEATURE_REQUIREMENTS[id].check(env).available;
}
