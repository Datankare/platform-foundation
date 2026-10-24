/**
 * __tests__/modules/translation.module.test.ts — The translation module's contributions (ADR-054)
 *
 * The module runs in an app that registers only it (it depends on nothing): its provider slot is
 * selected and checked like a core slot, and its goal, consent and account-status feature and
 * moderation content type join the core's lists — and leave them when the module is not
 * registered.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "test-req",
}));

import { TRANSLATION_MODULE } from "@/platform/translation/module";
import { runWithModules, restoreAppModules } from "../helpers/modules";

const KEYS = [
  "TRANSLATION_PROVIDER",
  "GOOGLE_API_KEY",
  "NEXT_PUBLIC_GOOGLE_API_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.resetModules();
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  runWithModules([TRANSLATION_MODULE]);
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterAll(() => restoreAppModules());

async function boot() {
  const registry = await import("@/platform/providers/registry");
  registry.resetProviders();
  const selections = registry.initProviders();
  const { logger } = jest.requireMock("@/lib/logger");
  return { selections, warn: logger.warn as jest.Mock };
}

describe("translation module — definition", () => {
  it("declares its slot like a core slot", () => {
    expect(TRANSLATION_MODULE.id).toBe("translation");
    expect(TRANSLATION_MODULE.dependsOn).toEqual([]);
    const [slot] = TRANSLATION_MODULE.providers;
    expect(slot).toMatchObject({
      slot: "translation",
      envVar: "TRANSLATION_PROVIDER",
      values: ["google", "mock"],
      defaultValue: "mock",
      singletonKeys: [],
    });
    expect(slot.durable).toBeUndefined();
  });

  it("is frozen", () => {
    expect(Object.isFrozen(TRANSLATION_MODULE)).toBe(true);
    expect(Object.isFrozen(TRANSLATION_MODULE.goals)).toBe(true);
  });
});

describe("translation module — provider slot", () => {
  it("defaults to mock", async () => {
    const { selections, warn } = await boot();
    expect(selections.translation).toBe("mock");
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("TRANSLATION_PROVIDER")
    );
  });

  it("warns when google is selected without a key", async () => {
    process.env.TRANSLATION_PROVIDER = "google";
    const { selections, warn } = await boot();
    expect(selections.translation).toBe("google");
    expect(warn).toHaveBeenCalledWith(
      "TRANSLATION_PROVIDER=google but GOOGLE_API_KEY missing — translations will fail"
    );
  });

  it.each(["GOOGLE_API_KEY", "NEXT_PUBLIC_GOOGLE_API_KEY"])(
    "does not warn when google has %s",
    async (key) => {
      process.env.TRANSLATION_PROVIDER = "google";
      process.env[key] = "k";
      const { warn } = await boot();
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("TRANSLATION_PROVIDER")
      );
    }
  );

  it("logs a selection outside its values and passes it on", async () => {
    process.env.TRANSLATION_PROVIDER = "deepl";
    const { selections, warn } = await boot();
    expect(selections.translation).toBe("deepl");
    expect(warn).toHaveBeenCalledWith(
      'TRANSLATION_PROVIDER="deepl" is not one of google, mock — passed to the slot as given',
      { route: "platform/providers/registry" }
    );
  });

  it("is absent from the selections when the module is not registered", async () => {
    runWithModules([]);
    const { selections } = await boot();
    expect(selections.translation).toBeUndefined();
  });
});

describe("translation module — vocabulary", () => {
  it("adds the translate goal, and registerWorkflow accepts it only with the module", async () => {
    const { listAgentGoals } = await import("@/platform/agents/goals");
    expect(listAgentGoals()).toEqual(["analyze", "translate"]);
    const { registerWorkflow, resetWorkflowRegistry } =
      await import("@/platform/agents/workflow-loop");
    const definition = {
      goal: "translate",
      description: "translate a text",
      endpoint: "/api/agent/translate",
      steps: [
        {
          tool: {
            id: "t",
            name: "t",
            description: "t",
            inputSchema: {},
            compensable: true,
          },
          intent: "propose",
          estimatedCostUSD: 0,
          input: () => ({}),
        },
      ],
    } as unknown as Parameters<typeof registerWorkflow>[0];
    resetWorkflowRegistry();
    expect(() => registerWorkflow(definition)).not.toThrow();
    resetWorkflowRegistry();
    runWithModules([]);
    expect(() => registerWorkflow(definition)).toThrow(
      /workflow goal translate is not declared by the core or a registered module \(declared: analyze\)/
    );
  });

  it("adds translate to the consent and account-status fallbacks", async () => {
    const { consentFeatureFallback } = await import("@/platform/auth/coppa-gate");
    const { restrictedFeatureFallback } =
      await import("@/platform/auth/account-status-guard");
    expect(consentFeatureFallback()).toEqual(["generate", "upload_file", "translate"]);
    expect(restrictedFeatureFallback()).toEqual([
      "generate",
      "upload_file",
      "update_profile",
      "translate",
    ]);
    runWithModules([]);
    expect(consentFeatureFallback()).not.toContain("translate");
  });

  it("adds the translation content kind, with a governed severity reduction", async () => {
    const { isModerationContentType, allowsSeverityReduction } =
      await import("@/platform/moderation/content-types");
    expect(isModerationContentType("translation")).toBe(true);
    expect(allowsSeverityReduction("translation")).toBe(true);
    runWithModules([]);
    // Without the module the kind is unknown — screened as generation, never reduced.
    expect(isModerationContentType("translation")).toBe(false);
    expect(allowsSeverityReduction("translation")).toBe(false);
  });
});
