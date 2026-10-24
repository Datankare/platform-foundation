/**
 * platform/modules/__tests__/app-modules.test.ts — Platform Foundation's own app (CONSUMER SEAM)
 *
 * The test of PF's app-modules.ts: the app lists every module PF ships (its demo uses them), in
 * an order where each follows its dependencies, and with them registered the platform presents
 * exactly what it presented before the split (ADR-054 R4): the same provider slots, the same
 * GET /api/features body, the same goals, prompts, agents, rules and vocabulary. A consumer owns
 * its app-modules.ts and this test with it (the sync excludes both).
 *
 * jest.setup registers APP_MODULES; this test reads them through the registry.
 */

import { getModules } from "@/platform/modules";

describe("PF's app modules", () => {
  const modules = getModules();
  const ids = modules.map((m) => m.id);

  it("lists every module PF ships, each after its dependencies", () => {
    expect(ids).toEqual([
      "translation",
      "audio-convert",
      "voice",
      "song-id",
      "social",
      "games",
    ]);
    modules.forEach((m, i) => {
      for (const dep of m.dependsOn) expect(ids.indexOf(dep)).toBeLessThan(i);
    });
  });

  it("composes without a collision", async () => {
    const { assertModuleContributions } =
      await import("@/platform/modules/contributions");
    expect(() => assertModuleContributions()).not.toThrow();
  });

  it("presents the provider slots it had before the split: the core's, then the modules'", async () => {
    const { getActiveProviders } = await import("@/platform/providers/registry");
    expect(Object.keys(getActiveProviders())).toEqual([
      "auth",
      "cache",
      "ai",
      "errorReporter",
      "realtime",
      "moderationStore",
      "strikeStore",
      "reviewQueueStore",
      "embeddingProvider",
      "appStateStore",
      "trajectoryStore",
      "budgetStore",
      "proposalStore",
      "effectLedger",
      "approvalPolicyStore",
      "guestUsageStore",
      "rateLimiter",
      "jobStore",
      "translation",
      "audioConverter",
      "tts",
      "stt",
      "songId",
      "socialStore",
    ]);
  });

  it("serves the GET /api/features body it served before the split", async () => {
    const { featureAvailability } = await import("@/platform/features");
    // The same keys and values as the pre-split FEATURE_REQUIREMENTS on a bare deployment.
    expect(featureAvailability({})).toEqual({
      music_identification: { available: false },
      audio_upload: { available: false },
      speech_input: { available: false },
      teams: { available: true, preview: true },
      sso_google: { available: false },
      sso_apple: { available: false },
      sso_microsoft: { available: false },
    });
  });

  it("serves the playform-dev feature set: speech input only (no song ID, no converter)", async () => {
    const { isFeatureAvailable } = await import("@/platform/features");
    const env = {
      GOOGLE_API_KEY: "g",
      AUDIO_CONVERTER: "mock",
      SONG_ID_PROVIDER: "mock",
    };
    expect(isFeatureAvailable("speech_input", env)).toBe(true);
    expect(isFeatureAvailable("audio_upload", env)).toBe(false);
    expect(isFeatureAvailable("music_identification", env)).toBe(false);
  });

  it("declares the goals AgentGoal used to fix", async () => {
    const { listAgentGoals } = await import("@/platform/agents/goals");
    expect([...listAgentGoals()].sort()).toEqual(
      [
        "identify-song",
        "translate",
        "transcribe",
        "speak",
        "translate-and-speak",
        "full-pipeline",
        "analyze",
      ].sort()
    );
  });

  it("registers the twelve agents and twelve prompts it had", async () => {
    const { listPlatformAgentConfigs } = await import("@/platform/agents/agent-configs");
    const { listPrompts } = await import("@/prompts");
    expect(listPlatformAgentConfigs()).toHaveLength(12);
    expect(listPrompts()).toHaveLength(12);
  });

  it("keeps the rate rules, consent and account-status fallbacks it had", async () => {
    const { listRateRules } = await import("@/platform/rate-limit");
    const { consentFeatureFallback } = await import("@/platform/auth/coppa-gate");
    const { restrictedFeatureFallback } =
      await import("@/platform/auth/account-status-guard");
    expect(listRateRules().map((r) => r.value.id)).toContain("song:identify");
    expect([...consentFeatureFallback()].sort()).toEqual(
      ["translate", "transcribe", "identify_song", "generate", "upload_file"].sort()
    );
    expect([...restrictedFeatureFallback()].sort()).toEqual(
      [
        "translate",
        "transcribe",
        "identify_song",
        "generate",
        "upload_file",
        "update_profile",
      ].sort()
    );
  });

  it("screens the content kinds it screened, with the same reductions", async () => {
    const { listModerationContentTypes } =
      await import("@/platform/moderation/content-types");
    expect(
      Object.fromEntries(
        listModerationContentTypes().map((t) => [t.name, t.severityReduction])
      )
    ).toEqual({
      generation: false,
      extraction: true,
      profile: false,
      "ai-output": false,
      translation: true,
      transcription: true,
      social: false,
    });
  });

  it("registers the song-identification health probe", async () => {
    const { createModuleHealthProbes } = await import("@/platform/modules/contributions");
    expect(createModuleHealthProbes().map((p) => p.name)).toEqual([
      "song-identification",
    ]);
  });
});
