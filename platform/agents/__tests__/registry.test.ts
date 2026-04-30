/**
 * platform/agents/__tests__/registry.test.ts
 *
 * Tests for agent registry. Covers: register, lookup, list,
 * duplicate rejection, unregister, reset.
 */

import {
  registerAgent,
  getAgent,
  hasAgent,
  listAgents,
  unregisterAgent,
  resetAgentRegistry,
} from "../registry";
import { DEFAULT_BUDGET_CONFIG } from "../types";
import type { AgentConfig } from "../types";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test-agent",
    name: "Test Agent",
    description: "A test agent",
    tools: [],
    budgetConfig: DEFAULT_BUDGET_CONFIG,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("Agent Registry", () => {
  beforeEach(() => {
    resetAgentRegistry();
  });

  describe("registerAgent", () => {
    it("registers an agent config", () => {
      registerAgent(makeConfig());
      expect(hasAgent("test-agent")).toBe(true);
    });

    it("throws on duplicate registration", () => {
      registerAgent(makeConfig());
      expect(() => registerAgent(makeConfig())).toThrow(/already registered/);
    });
  });

  describe("getAgent", () => {
    it("returns config when registered", () => {
      registerAgent(makeConfig());
      const config = getAgent("test-agent");

      expect(config).toBeDefined();
      expect(config!.name).toBe("Test Agent");
    });

    it("returns undefined when not registered", () => {
      expect(getAgent("nonexistent")).toBeUndefined();
    });
  });

  describe("hasAgent", () => {
    it("returns true for registered agent", () => {
      registerAgent(makeConfig());
      expect(hasAgent("test-agent")).toBe(true);
    });

    it("returns false for unregistered agent", () => {
      expect(hasAgent("nonexistent")).toBe(false);
    });
  });

  describe("listAgents", () => {
    it("returns all registered agent IDs", () => {
      registerAgent(makeConfig({ id: "a" }));
      registerAgent(makeConfig({ id: "b" }));
      registerAgent(makeConfig({ id: "c" }));

      const ids = listAgents();
      expect(ids).toHaveLength(3);
      expect(ids).toContain("a");
      expect(ids).toContain("b");
      expect(ids).toContain("c");
    });

    it("returns empty array when none registered", () => {
      expect(listAgents()).toEqual([]);
    });
  });

  describe("unregisterAgent", () => {
    it("removes a registered agent", () => {
      registerAgent(makeConfig());
      expect(unregisterAgent("test-agent")).toBe(true);
      expect(hasAgent("test-agent")).toBe(false);
    });

    it("returns false for non-existent agent", () => {
      expect(unregisterAgent("nonexistent")).toBe(false);
    });
  });

  describe("resetAgentRegistry", () => {
    it("clears all registrations", () => {
      registerAgent(makeConfig({ id: "a" }));
      registerAgent(makeConfig({ id: "b" }));
      resetAgentRegistry();

      expect(listAgents()).toEqual([]);
    });
  });
});
