/**
 * platform/voice/audio-convert-module.ts — The audio-convert module (ADR-054 D2)
 *
 * Audio format conversion — the ffmpeg service, passthrough and mock converters — and the
 * converter slot (AUDIO_CONVERTER). Shares platform/voice/ with voice and song-id until Sprint
 * 7S; its files are listed in platform/modules/manifest.json.
 *
 * @module platform/voice/audio-convert
 */

import { definePlatformModule } from "@/platform/modules/define";

export const AUDIO_CONVERT_MODULE = definePlatformModule({
  id: "audio-convert",
  providers: [
    {
      slot: "audioConverter",
      envVar: "AUDIO_CONVERTER",
      values: ["ffmpeg-service", "passthrough", "mock"],
      defaultValue: "mock",
      singletonKeys: [],
      // The converter is constructed where it is used; boot only reports missing settings.
      init: (selection, { env, warn }) => {
        if (
          selection === "ffmpeg-service" &&
          (!(env.AUDIO_CONVERTER_URL ?? "") || !(env.AUDIO_CONVERTER_KEY ?? ""))
        ) {
          warn(
            "AUDIO_CONVERTER=ffmpeg-service but AUDIO_CONVERTER_URL or AUDIO_CONVERTER_KEY missing — conversion will fail"
          );
        }
      },
    },
  ],
  kits: ["__tests__/contract/audio-converter-contract.ts"],
});
