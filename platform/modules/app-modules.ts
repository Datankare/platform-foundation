/**
 * platform/modules/app-modules.ts — The modules this app runs with (CONSUMER SEAM, ADR-054 D4)
 *
 * The one list of an app's product modules. instrumentation.ts registers it at boot, before the
 * providers initialize; the test setup registers it the same way. A consumer owns this file:
 * the sync excludes it, and the consumer lists the modules it opted into (or none — the core
 * runs without any). Order is registration order: core lists are followed by each module's
 * entries in this order, and a module is listed after the modules it depends on.
 *
 * This file and the home seam (./app-home.tsx) are the composition roots: the only core files
 * allowed to import a module (eslint.config.mjs, import/no-restricted-paths).
 *
 * Platform Foundation lists every module it ships, because its demo uses them.
 *
 * @module platform/modules
 */

import type { PlatformModule } from "./types";
import { TRANSLATION_MODULE } from "@/platform/translation/module";
import { AUDIO_CONVERT_MODULE } from "@/platform/voice/audio-convert-module";
import { VOICE_MODULE } from "@/platform/voice/voice-module";
import { SONG_ID_MODULE } from "@/platform/voice/song-id-module";
import { SOCIAL_MODULE } from "@/platform/social/module";
import { GAMES_MODULE } from "@/games/module";

export const APP_MODULES: readonly PlatformModule[] = [
  TRANSLATION_MODULE,
  AUDIO_CONVERT_MODULE,
  VOICE_MODULE,
  SONG_ID_MODULE,
  SOCIAL_MODULE,
  GAMES_MODULE,
];
