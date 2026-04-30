/**
 * platform/agents/__tests__/agent-configs.test.ts
 *
 * Tests for platform agent registration.
 * Covers: all agents registered, idempotent, unique IDs,
 * budget configs present, effort tiers set.
 */

import { AGENT_CONFIGS, registerPlatformAgents } from "../agent-configs";
import { getAgent, listAgents, resetAgentRegistry } from "../registry";

describe("Agent Configs", () => {
  beforeEach(() => {
    resetAgentRegistry();
  });

  describe("AGENT_CONFIGS", () => {
    it("defines 8 agents total", () => {
      expect(AGENT_CONFIGS).toHaveLength(8);
    });

    it("has unique IDs for every agent", () => {
      const ids = AGENT_CONFIGS.map((c) => c.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });

    it("includes all 6 social agents", () => {
      const ids = AGENT_CONFIGS.map((c) => c.id);
      expect(ids).toContain("guardian-social");
      expect(ids).toContain("matchmaker");
      expect(ids).toContain("gatekeeper");
      expect(ids).toContain("concierge");
      expect(ids).toContain("analyst");
      expect(ids).toContain("curator");
    });

    it("includes 2 input agents", () => {
      const ids = AGENT_CONFIGS.map((c) => c.id);
      expect(ids).toContain("audio-classifier");
      expect(ids).toContain("intent-resolver");
    });

    it("every agent has a budget config", () => {
      for (const config of AGENT_CONFIGS) {
        expect(config.budgetConfig).toBeDefined();
        expect(config.budgetConfig.maxCostPerDay).toBeGreaterThan(0);
        expect(config.budgetConfig.maxStepsPerTrajectory).toBeGreaterThan(0);
      }
    });

    it("every agent has an effort tier", () => {
      for (const config of AGENT_CONFIGS) {
        expect(["low", "standard", "max"]).toContain(config.effortTier);
      }
    });

    it("every agent has a non-empty description", () => {
      for (const config of AGENT_CONFIGS) {
        expect(config.description.length).toBeGreaterThan(10);
      }
    });
  });

  describe("registerPlatformAgents", () => {
    it("registers all agents", () => {
      registerPlatformAgents();
      expect(listAgents()).toHaveLength(8);
    });

    it("is idempotent", () => {
      registerPlatformAgents();
      registerPlatformAgents();
      expect(listAgents()).toHaveLength(8);
    });

    it("makes each agent retrievable by ID", () => {
      registerPlatformAgents();

      for (const config of AGENT_CONFIGS) {
        const registered = getAgent(config.id);
        expect(registered).toBeDefined();
        expect(registered!.name).toBe(config.name);
      }
    });
  });
});
