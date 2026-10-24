/**
 * platform/agents/__tests__/agent-configs.test.ts
 *
 * Tests for platform agent registration.
 * Covers: the core's agents, the registered modules' agents joining them (ADR-054 D4),
 * idempotent registration, unique IDs, budget configs present, effort tiers set, and a module
 * agent that reuses a core id refused rather than silently skipped.
 */

import {
  AGENT_CONFIGS,
  listPlatformAgentConfigs,
  registerPlatformAgents,
} from "../agent-configs";
import { getAgent, listAgents, resetAgentRegistry } from "../registry";
import {
  definePlatformModule,
  getModules,
  registerModules,
  resetModuleRegistry,
} from "@/platform/modules";
import type { PlatformModule } from "@/platform/modules";

/** A fixture app module with agents of its own (a core test names no product module). */
const FIXTURE_AGENT_IDS = ["fixture-scout", "fixture-scribe"];
const FIXTURE = definePlatformModule({
  id: "agent-fixture",
  agents: FIXTURE_AGENT_IDS.map((id) => ({
    id,
    name: id,
    description: `fixture agent ${id}, registered with the core's`,
    tools: [],
    budgetConfig: {
      maxCostPerTrajectory: 0.01,
      maxCostPerDay: 1,
      maxStepsPerTrajectory: 3,
    },
    effortTier: "low" as const,
  })),
});

const CORE_AGENT_IDS = [
  "audio-classifier",
  "intent-resolver",
  "guardian-social",
  "sentinel",
  "config-manager",
  "command-bar",
  "conductor",
];
const SOCIAL_AGENT_IDS = ["matchmaker", "gatekeeper", "concierge", "analyst", "curator"];

describe("Agent Configs", () => {
  let appModules: readonly PlatformModule[];

  beforeAll(() => {
    appModules = getModules();
  });

  beforeEach(() => {
    resetAgentRegistry();
    resetModuleRegistry();
    registerModules([FIXTURE]);
  });

  afterEach(() => {
    resetModuleRegistry();
    registerModules(appModules);
  });

  describe("AGENT_CONFIGS (the core's agents)", () => {
    it("defines exactly the core's agents", () => {
      expect(AGENT_CONFIGS.map((c) => c.id)).toEqual(CORE_AGENT_IDS);
    });

    it("has unique IDs for every agent", () => {
      const ids = AGENT_CONFIGS.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("names no social agent — they are the social module's (ADR-054 D3)", () => {
      const ids = AGENT_CONFIGS.map((c) => c.id);
      for (const id of SOCIAL_AGENT_IDS) expect(ids).not.toContain(id);
    });

    it("keeps Guardian's agent, which screens every kind of content", () => {
      expect(AGENT_CONFIGS.map((c) => c.id)).toContain("guardian-social");
    });

    it("includes 2 input agents", () => {
      const ids = AGENT_CONFIGS.map((c) => c.id);
      expect(ids).toContain("audio-classifier");
      expect(ids).toContain("intent-resolver");
    });

    it.each(AGENT_CONFIGS.map((c) => [c.id, c]))(
      "%s has a budget, an effort tier and a description",
      (_id, config) => {
        expect(config.budgetConfig.maxCostPerDay).toBeGreaterThan(0);
        expect(config.budgetConfig.maxStepsPerTrajectory).toBeGreaterThan(0);
        expect(["low", "standard", "max"]).toContain(config.effortTier);
        expect(config.description.length).toBeGreaterThan(10);
      }
    );
  });

  describe("registerPlatformAgents", () => {
    it("registers the core's agents and the registered modules' agents", () => {
      registerPlatformAgents();
      expect([...listAgents()].sort()).toEqual(
        [...CORE_AGENT_IDS, ...FIXTURE_AGENT_IDS].sort()
      );
    });

    it("is idempotent", () => {
      registerPlatformAgents();
      registerPlatformAgents();
      expect(listAgents()).toHaveLength(CORE_AGENT_IDS.length + FIXTURE_AGENT_IDS.length);
    });

    it("makes each agent retrievable by ID", () => {
      registerPlatformAgents();
      for (const config of listPlatformAgentConfigs()) {
        expect(getAgent(config.id)?.name).toBe(config.name);
      }
    });

    it("registers only the core's agents when the app has no modules", () => {
      resetModuleRegistry();
      registerModules([]);
      registerPlatformAgents();
      expect([...listAgents()].sort()).toEqual([...CORE_AGENT_IDS].sort());
    });

    it("refuses a module agent that reuses a core agent's id", () => {
      resetModuleRegistry();
      const impostor = definePlatformModule({
        id: "impostor",
        agents: [{ ...AGENT_CONFIGS[0], description: "takes over the audio classifier" }],
      });
      registerModules([impostor]);
      expect(() => registerPlatformAgents()).toThrow(
        /module "impostor": agent "audio-classifier" is already the core's/
      );
      expect(listAgents()).toEqual([]);
    });
  });
});
