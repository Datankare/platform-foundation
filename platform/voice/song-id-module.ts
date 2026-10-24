/**
 * platform/voice/song-id-module.ts — The song-id module (ADR-020, ADR-054 D2)
 *
 * Song identification: the provider slot (SONG_ID_PROVIDER), the SONG_IDENTIFY rule, the
 * "identify-song" goal, the "identify_song" consent and account-status feature, the
 * music_identification feature and the provider's health probe. Shares platform/voice/ with
 * voice and audio-convert until Sprint 7S; its files and migration (013) are listed in
 * platform/modules/manifest.json.
 *
 * Depends on audio-convert: a clip is converted to the canonical format before it is identified,
 * so music identification is offered only with a converter that converts.
 *
 * @module platform/voice/song-id
 */

import { definePlatformModule } from "@/platform/modules/define";
import { CachedHealthProbe } from "@/platform/observability/health";
import { ACRCloudIdentifier, getAcrCloudConfig } from "./acrcloud-identify";
import {
  AUDIO_CONVERTER_NEEDS,
  isAudioConverterReady,
} from "./audio-converter-readiness";
import { SONG_IDENTIFY_RULE } from "./identify-types";
import { MockSongIdentifier } from "./mock-identify";
import { SongIdHealthProbeAdapter } from "./song-id-health";
import {
  SONGIDPROVIDER_KEY,
  getSongIdProvider,
  setSongIdProvider,
} from "./song-id-provider";

/** The probe makes a billable identify call: at most one per 15 minutes per instance (X-13). */
const SONG_ID_PROBE_TTL_MS = 15 * 60_000;

export const SONG_ID_MODULE = definePlatformModule({
  id: "song-id",
  dependsOn: ["audio-convert"],
  providers: [
    {
      slot: "songId",
      envVar: "SONG_ID_PROVIDER",
      values: ["acrcloud", "mock"],
      defaultValue: "mock",
      singletonKeys: [SONGIDPROVIDER_KEY],
      init: (selection, { env, warn }) => {
        if (selection !== "acrcloud") {
          setSongIdProvider(new MockSongIdentifier());
          return;
        }
        // TASK-042: single source of truth — do not read ACRCLOUD_* directly here.
        const { host, accessKey, accessSecret } = getAcrCloudConfig(env);
        const configured = Boolean(host && accessKey && accessSecret);
        // TASK-041: construct and STORE the provider so the health probe (and anything else)
        // uses the live instance rather than building its own.
        setSongIdProvider(
          configured ? new ACRCloudIdentifier() : new MockSongIdentifier()
        );
        if (!configured) {
          warn(
            "SONG_ID_PROVIDER=acrcloud but ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY, or ACRCLOUD_ACCESS_SECRET missing — song ID will fail"
          );
        }
      },
    },
  ],
  goals: ["identify-song"],
  rateRules: [SONG_IDENTIFY_RULE],
  consentFeatures: ["identify_song"],
  accountStatusFeatures: ["identify_song"],
  features: [
    {
      id: "music_identification",
      needs: `SONG_ID_PROVIDER=acrcloud with ACRCLOUD_HOST / ACRCLOUD_ACCESS_KEY / ACRCLOUD_ACCESS_SECRET, and ${AUDIO_CONVERTER_NEEDS}`,
      check: (env) => {
        const acr = getAcrCloudConfig(env);
        return {
          available:
            env.SONG_ID_PROVIDER === "acrcloud" &&
            [acr.host, acr.accessKey, acr.accessSecret].every((v) => v.trim() !== "") &&
            isAudioConverterReady(env),
        };
      },
    },
  ],
  // TASK-041: wraps the LIVE provider stored by the slot's init — not a freshly constructed
  // duplicate — so the probe reports on the instance actually serving traffic.
  healthProbes: [
    {
      name: "song-identification",
      create: () =>
        new CachedHealthProbe(
          new SongIdHealthProbeAdapter(getSongIdProvider()),
          SONG_ID_PROBE_TTL_MS
        ),
    },
  ],
  kits: ["__tests__/contract/song-id-provider-contract.ts"],
});
