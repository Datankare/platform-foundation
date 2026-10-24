/**
 * platform/modules/__tests__/no-modules.test.ts — The core runs with no product module (ADR-054 §4)
 *
 * An app whose module list is empty boots and works: the providers initialize with the core's
 * slots only, and every extensible list — agents, prompts, evals, features, goals, rate rules,
 * consent and account-status fallbacks, moderation content kinds, content types, health probes,
 * the environment contract's durable selectors, the singletons a reset clears — is exactly the
 * core's. A consumer that uses no module inherits and runs only this.
 */

import { registerModules, resetModuleRegistry, getModules } from "@/platform/modules";
import type { PlatformModule } from "@/platform/modules";

const CORE_SLOTS = [
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
];

let appModules: readonly PlatformModule[];

beforeAll(() => {
  appModules = getModules();
});

beforeEach(() => {
  jest.resetModules();
  resetModuleRegistry();
  registerModules([]);
});

afterAll(() => {
  resetModuleRegistry();
  registerModules(appModules);
});

describe("an app with no modules", () => {
  it("boots: the providers initialize with exactly the core's slots", async () => {
    const {
      initProviders,
      resetProviders,
      getActiveProviders,
      providerSingletonKeys,
      CORE_PROVIDER_SINGLETON_KEYS,
    } = await import("@/platform/providers/registry");
    resetProviders();
    const selections = initProviders();
    expect(Object.keys(selections)).toEqual(CORE_SLOTS);
    expect(Object.keys(getActiveProviders())).toEqual(CORE_SLOTS);
    expect(providerSingletonKeys()).toEqual(CORE_PROVIDER_SINGLETON_KEYS);
    resetProviders();
  });

  it("registers the core's agents only, and they run on the runtime", async () => {
    const { registerPlatformAgents, AGENT_CONFIGS } =
      await import("@/platform/agents/agent-configs");
    const { listAgents, resetAgentRegistry, getAgent } =
      await import("@/platform/agents/registry");
    resetAgentRegistry();
    registerPlatformAgents();
    expect([...listAgents()].sort()).toEqual(AGENT_CONFIGS.map((a) => a.id).sort());
    expect(getAgent("guardian-social")).toBeDefined(); // Guardian screens every kind of content
    expect(getAgent("matchmaker")).toBeUndefined();
  });

  it("has the core's prompts and eval suites only", async () => {
    const { listPrompts, getPromptConfig } = await import("@/prompts");
    const { listEvalSuites, CORE_EVAL_SUITES } = await import("@/prompts/evals");
    expect(listPrompts()).toEqual([
      "safety-classify",
      "admin-command-bar",
      "config-manager",
      "classify-audio",
      "resolve-intent",
      "adaptive-pacing",
      "stream-assistant",
    ]);
    expect(getPromptConfig("safety-classify").name).toBe("safety-classify");
    expect(listEvalSuites()).toEqual(CORE_EVAL_SUITES);
  });

  it("offers the core's features only", async () => {
    const { featureAvailability, isFeatureAvailable } =
      await import("@/platform/features");
    expect(Object.keys(featureAvailability({}))).toEqual([
      "sso_google",
      "sso_apple",
      "sso_microsoft",
    ]);
    expect(isFeatureAvailable("music_identification", {})).toBe(false);
  });

  it("has the core's goals and rate rules only — and every core route's rule", async () => {
    const { listAgentGoals } = await import("@/platform/agents/goals");
    const { listRateRules, DEFAULT_RULES, getRateRule } =
      await import("@/platform/rate-limit");
    expect(listAgentGoals()).toEqual(["analyze"]);
    expect(listRateRules().map((r) => r.value)).toEqual(Object.values(DEFAULT_RULES));
    expect(getRateRule("api:global")).toBe(DEFAULT_RULES.API_GLOBAL);
  });

  it("enforces a core rate rule", async () => {
    const { enforceRateLimit, DEFAULT_RULES } = await import("@/platform/rate-limit");
    const request = new Request("http://localhost/api/features", {
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(await enforceRateLimit(request, DEFAULT_RULES.API_GLOBAL)).toBeNull();
  });

  it("falls back to the core's consent, account-status and content vocabulary", async () => {
    const { consentFeatureFallback, CORE_CONSENT_FEATURES } =
      await import("@/platform/auth/coppa-gate");
    const { restrictedFeatureFallback, CORE_RESTRICTED_FEATURES } =
      await import("@/platform/auth/account-status-guard");
    const { listModerationContentTypes, CORE_MODERATION_CONTENT_TYPES } =
      await import("@/platform/moderation/content-types");
    expect(consentFeatureFallback()).toEqual(CORE_CONSENT_FEATURES);
    expect(restrictedFeatureFallback()).toEqual(CORE_RESTRICTED_FEATURES);
    expect(listModerationContentTypes()).toEqual(CORE_MODERATION_CONTENT_TYPES);
  });

  it("registers no content type and builds no module health probe", async () => {
    const { resetContentTypes, listContentTypes } =
      await import("@/platform/content/registry");
    const {
      registerModuleContentTypes,
      createModuleHealthProbes,
      assertModuleContributions,
    } = await import("@/platform/modules/contributions");
    resetContentTypes();
    expect(() => assertModuleContributions()).not.toThrow();
    registerModuleContentTypes();
    expect(listContentTypes()).toEqual([]);
    expect(createModuleHealthProbes()).toEqual([]);
  });

  it("checks the core's durable selectors only", async () => {
    const { databaseSelectors, DATABASE_SELECTORS } =
      await import("@/platform/providers/environment-contract");
    expect(databaseSelectors()).toEqual(DATABASE_SELECTORS);
  });

  it("screens content: an undeclared kind is screened as generation", async () => {
    const { evaluateContext } = await import("@/platform/moderation/context");
    const evaluation = await evaluateContext({ contentType: "translation" });
    expect(evaluation).toMatchObject({ severityReduction: 0, attributeToUser: true });
    expect(evaluation.factors).toContain("unknown-content-type: treated as generation");
  });
});
