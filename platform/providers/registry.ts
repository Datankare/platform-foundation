/**
 * platform/providers/registry.ts — Central provider registry
 *
 * Single entry point for initializing all platform providers.
 * Reads provider selection from environment variables.
 * Falls back to mock/memory/noop when env vars are absent.
 *
 * Synchronous — safe to call without await.
 *
 * GenAI Principles:
 *   P1  — All AI through orchestration (provider registered here)
 *   P6  — Resilient: every slot has a working fallback
 *   P7  — Provider-aware: realtime abstraction (Sprint 5)
 *   P9  — Observable: provider selections logged at startup
 *   P10 — No late discovery: all provider slots defined here
 *
 * Environment variables (all optional — omit for mock/fallback):
 *   AUTH_PROVIDER      = "cognito" | "mock"      (default: "mock")
 *   CACHE_PROVIDER     = "upstash" | "memory"    (default: "memory")
 *   AI_PROVIDER        = "anthropic" | "mock"    (default: "mock")
 *   ERROR_REPORTER     = "sentry" | "noop"       (default: "noop")
 *   REALTIME_PROVIDER  = "supabase" | "mock"     (default: "mock")
 *   TRANSLATION_PROVIDER = "google" | "mock"     (default: "mock")
 *   TTS_PROVIDER          = "google" | "mock"     (default: "mock")
 *   STT_PROVIDER          = "google" | "mock"     (default: "mock")
 *   SONG_ID_PROVIDER      = "acrcloud" | "mock"   (default: "mock")
 *   AUDIO_CONVERTER       = "ffmpeg-service" | "passthrough" | "mock" (default: "mock")
 *   MODERATION_STORE      = "supabase" | "memory" (default: "memory")
   SOCIAL_STORE           = "supabase" | "memory" (default: "memory")
 *
 * @module platform/providers
 */

import { registerAuthProvider, hasAuthProvider } from "@/platform/auth/config";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import { createCognitoAuthProvider } from "@/platform/auth/cognito-provider";
import { resetCache } from "@/platform/cache";
import { SupabaseModerationStore, setModerationStore } from "@/platform/moderation/store";
import {
  setSocialStore,
  InMemorySocialStore,
  SupabaseSocialStore,
} from "@/platform/social";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthProviderType = "cognito" | "mock";
export type CacheProviderType = "upstash" | "memory";
export type AIProviderType = "anthropic" | "mock";
export type ErrorReporterType = "sentry" | "noop";
export type RealtimeProviderType = "supabase" | "mock";
export type TranslationProviderType = "google" | "mock";
export type TTSProviderType = "google" | "mock";
export type STTProviderType = "google" | "mock";
export type SongIdProviderType = "acrcloud" | "mock";
export type AudioConverterType = "ffmpeg-service" | "passthrough" | "mock";
export type ModerationStoreType = "supabase" | "memory";
export type SocialStoreType = "supabase" | "memory";

export interface ProviderSelections {
  auth: AuthProviderType;
  cache: CacheProviderType;
  ai: AIProviderType;
  errorReporter: ErrorReporterType;
  realtime: RealtimeProviderType;
  translation: TranslationProviderType;
  tts: TTSProviderType;
  stt: STTProviderType;
  songId: SongIdProviderType;
  audioConverter: AudioConverterType;
  moderationStore: ModerationStoreType;
  socialStore: SocialStoreType;
}

// ---------------------------------------------------------------------------
// Read selections from env
// ---------------------------------------------------------------------------

function getProviderSelections(): ProviderSelections {
  return {
    auth:
      ((process.env.AUTH_PROVIDER ??
        process.env.NEXT_PUBLIC_AUTH_PROVIDER) as AuthProviderType) ?? "mock",
    cache: (process.env.CACHE_PROVIDER as CacheProviderType) ?? "memory",
    ai: (process.env.AI_PROVIDER as AIProviderType) ?? "mock",
    errorReporter: (process.env.ERROR_REPORTER as ErrorReporterType) ?? "noop",
    realtime: (process.env.REALTIME_PROVIDER as RealtimeProviderType) ?? "mock",
    translation: (process.env.TRANSLATION_PROVIDER as TranslationProviderType) ?? "mock",
    tts: (process.env.TTS_PROVIDER as TTSProviderType) ?? "mock",
    stt: (process.env.STT_PROVIDER as STTProviderType) ?? "mock",
    songId: (process.env.SONG_ID_PROVIDER as SongIdProviderType) ?? "mock",
    audioConverter: (process.env.AUDIO_CONVERTER as AudioConverterType) ?? "mock",
    moderationStore: (process.env.MODERATION_STORE as ModerationStoreType) ?? "memory",
    socialStore: (process.env.SOCIAL_STORE as SocialStoreType) ?? "memory",
  };
}

// ---------------------------------------------------------------------------
// Individual provider init (synchronous)
// ---------------------------------------------------------------------------

function initAuthProvider(type: AuthProviderType): void {
  if (hasAuthProvider()) return;

  if (type === "cognito") {
    const region = process.env.COGNITO_REGION ?? process.env.AWS_REGION ?? "us-east-1";
    const userPoolId =
      process.env.COGNITO_USER_POOL_ID ??
      process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID ??
      "";
    const clientId =
      process.env.COGNITO_CLIENT_ID ?? process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "";

    if (!userPoolId || !clientId) {
      logger.warn(
        "AUTH_PROVIDER=cognito but COGNITO_USER_POOL_ID or COGNITO_CLIENT_ID missing — falling back to mock"
      );
      registerAuthProvider(createMockAuthProvider({}));
      return;
    }

    registerAuthProvider(createCognitoAuthProvider({ region, userPoolId, clientId }));
    return;
  }

  registerAuthProvider(createMockAuthProvider({}));
}

function initCacheProvider(type: CacheProviderType): void {
  if (type === "upstash") {
    const url = process.env.UPSTASH_REDIS_REST_URL ?? "";
    const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? "";

    if (!url || !token) {
      logger.warn(
        "CACHE_PROVIDER=upstash but UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN missing — falling back to memory"
      );
      return;
    }

    resetCache();
    return;
  }
}

function initAIProvider(type: AIProviderType): void {
  if (type === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    if (!apiKey) {
      logger.warn(
        "AI_PROVIDER=anthropic but ANTHROPIC_API_KEY missing — AI calls will fail"
      );
    }
    return;
  }
}

function initErrorReporter(type: ErrorReporterType): void {
  if (type === "sentry") {
    const dsn = process.env.SENTRY_DSN ?? "";
    if (!dsn) {
      logger.warn("ERROR_REPORTER=sentry but SENTRY_DSN missing — falling back to noop");
    }
    return;
  }
}

function initRealtimeProvider(type: RealtimeProviderType): void {
  if (type === "supabase") {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
    if (!url) {
      logger.warn(
        "REALTIME_PROVIDER=supabase but SUPABASE_URL missing — falling back to mock"
      );
    }
    return;
  }
}

function initTTSProvider(type: TTSProviderType): void {
  if (type === "google") {
    const apiKey =
      process.env.GOOGLE_API_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_API_KEY ?? "";
    if (!apiKey) {
      logger.warn("TTS_PROVIDER=google but GOOGLE_API_KEY missing — TTS will fail");
    }
    return;
  }
}

function initSTTProvider(type: STTProviderType): void {
  if (type === "google") {
    const apiKey =
      process.env.GOOGLE_API_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_API_KEY ?? "";
    if (!apiKey) {
      logger.warn("STT_PROVIDER=google but GOOGLE_API_KEY missing — STT will fail");
    }
    return;
  }
}

function initTranslationProvider(type: TranslationProviderType): void {
  if (type === "google") {
    const apiKey =
      process.env.GOOGLE_API_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_API_KEY ?? "";
    if (!apiKey) {
      logger.warn(
        "TRANSLATION_PROVIDER=google but GOOGLE_API_KEY missing — translations will fail"
      );
    }
    return;
  }
}

function initSongIdProvider(type: SongIdProviderType): void {
  if (type === "acrcloud") {
    const host = process.env.ACRCLOUD_HOST ?? "";
    const key = process.env.ACRCLOUD_ACCESS_KEY ?? "";
    const secret = process.env.ACRCLOUD_ACCESS_SECRET ?? "";

    if (!host || !key || !secret) {
      logger.warn(
        "SONG_ID_PROVIDER=acrcloud but ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY, or ACRCLOUD_ACCESS_SECRET missing — song ID will fail"
      );
    }
    return;
  }
}

function initAudioConverter(type: AudioConverterType): void {
  if (type === "ffmpeg-service") {
    const url = process.env.AUDIO_CONVERTER_URL ?? "";
    const key = process.env.AUDIO_CONVERTER_KEY ?? "";

    if (!url || !key) {
      logger.warn(
        "AUDIO_CONVERTER=ffmpeg-service but AUDIO_CONVERTER_URL or AUDIO_CONVERTER_KEY missing — conversion will fail"
      );
    }
    return;
  }

  if (type === "passthrough") {
    return;
  }
}

function initModerationStore(type: ModerationStoreType): void {
  if (type === "supabase") {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

    if (!url || !key) {
      logger.warn(
        "MODERATION_STORE=supabase but SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — falling back to memory"
      );
      return;
    }

    setModerationStore(new SupabaseModerationStore(url, key));
    return;
  }
}

function initSocialStore(type: SocialStoreType): void {
  if (type === "supabase") {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

    if (!url || !key) {
      logger.warn(
        "SOCIAL_STORE=supabase but SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — falling back to memory"
      );
      setSocialStore(new InMemorySocialStore());
      return;
    }

    setSocialStore(new SupabaseSocialStore(url, key));
    return;
  }

  setSocialStore(new InMemorySocialStore());
}

// ---------------------------------------------------------------------------
// Central init
// ---------------------------------------------------------------------------

let initialized = false;

/**
 * Initialize all platform providers from environment.
 * Safe to call multiple times — skips if already initialized.
 */
export function initProviders(): ProviderSelections {
  if (initialized) return getProviderSelections();

  const selections = getProviderSelections();

  initAuthProvider(selections.auth);
  initCacheProvider(selections.cache);
  initAIProvider(selections.ai);
  initErrorReporter(selections.errorReporter);
  initRealtimeProvider(selections.realtime);
  initTranslationProvider(selections.translation);
  initTTSProvider(selections.tts);
  initSTTProvider(selections.stt);
  initSongIdProvider(selections.songId);
  initAudioConverter(selections.audioConverter);
  initModerationStore(selections.moderationStore);
  initSocialStore(selections.socialStore);

  initialized = true;

  logger.info("Platform providers initialized", {
    auth: selections.auth,
    cache: selections.cache,
    ai: selections.ai,
    errorReporter: selections.errorReporter,
    realtime: selections.realtime,
    translation: selections.translation,
    tts: selections.tts,
    stt: selections.stt,
    songId: selections.songId,
    audioConverter: selections.audioConverter,
    moderationStore: selections.moderationStore,
    socialStore: selections.socialStore,
  });

  return selections;
}

/**
 * Get current provider selections (for health/diagnostics).
 */
export function getActiveProviders(): ProviderSelections {
  return getProviderSelections();
}

/**
 * Reset (testing only).
 */
export function resetProviders(): void {
  initialized = false;
}
