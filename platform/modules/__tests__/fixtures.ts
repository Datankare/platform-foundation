/**
 * platform/modules/__tests__/fixtures.ts — Fixture module parts for the module-system tests
 *
 * Plain declarations that name no real module, so the core's module tests run without any.
 */

import type { AgentConfig } from "@/platform/agents/types";
import type { ModuleProviderSlot, PlatformModuleInput } from "../types";
import type { EvalSuite } from "@/prompts/evals/types";

export const slot = (
  overrides: Partial<ModuleProviderSlot> = {}
): ModuleProviderSlot => ({
  slot: "fixtureStore",
  envVar: "FIXTURE_STORE",
  values: ["postgres", "memory"],
  defaultValue: "memory",
  singletonKeys: ["platform.fixture.store"],
  init: () => undefined,
  ...overrides,
});

export const agent = (id: string): AgentConfig => ({
  id,
  name: id,
  description: `fixture agent ${id}`,
  tools: [],
  budgetConfig: {
    maxCostPerTrajectory: 0.01,
    maxCostPerDay: 1,
    maxStepsPerTrajectory: 3,
  },
  effortTier: "low",
});

export const prompt = (name: string) => ({
  name,
  version: 1,
  tier: "fast" as const,
  maxTokens: 64,
});

export const suite = (promptName: string): EvalSuite<unknown> => ({
  prompt: promptName,
  source: `prompts/fixture/${promptName}-v1.ts`,
  parse: (raw) => raw,
  coverage: { enums: {} },
  cases: [],
});

/** A module declaring one of everything, named after `id`. */
export function fullModule(id: string): PlatformModuleInput {
  return {
    id,
    providers: [
      slot({
        slot: `${id.replace(/-/g, "")}Store`,
        envVar: `${id.toUpperCase().replace(/-/g, "_")}_STORE`,
        singletonKeys: [`platform.${id.replace(/-/g, "")}.store`],
      }),
    ],
    agents: [agent(`${id}-agent`)],
    prompts: [prompt(`${id}-prompt`)],
    evals: [suite(`${id}-prompt`)],
    features: [
      {
        id: `${id.replace(/-/g, "_")}_feature`,
        needs: "nothing at all",
        check: () => ({ available: true }),
      },
    ],
    goals: [`${id}-goal`],
    rateRules: [{ id: `${id}:rule`, maxRequests: 5, windowSeconds: 60 }],
    consentFeatures: [`${id.replace(/-/g, "_")}_use`],
    accountStatusFeatures: [`${id.replace(/-/g, "_")}_use`],
    moderationContentTypes: [{ name: `${id}-content`, severityReduction: false }],
    healthProbes: [
      {
        name: `${id}-probe`,
        create: () => ({
          name: `${id}-probe`,
          check: async () => ({
            name: `${id}-probe`,
            status: "healthy",
            checkedAt: "now",
          }),
        }),
      },
    ],
    kits: [`__tests__/contract/${id}-contract.ts`],
  };
}
