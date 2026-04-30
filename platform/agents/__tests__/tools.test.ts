/**
 * platform/agents/__tests__/tools.test.ts
 *
 * Tests for tool registry. Covers: register, lookup, list,
 * resolve multiple, duplicate rejection, reset.
 */

import {
  registerTool,
  getTool,
  hasTool,
  listTools,
  resolveTools,
  resetToolRegistry,
} from "../tools";
import type { Tool } from "../types";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: "test-tool",
    name: "Test Tool",
    description: "A test tool",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("Tool Registry", () => {
  beforeEach(() => {
    resetToolRegistry();
  });

  describe("registerTool", () => {
    it("registers a tool definition", () => {
      registerTool(makeTool());
      expect(hasTool("test-tool")).toBe(true);
    });

    it("throws on duplicate registration", () => {
      registerTool(makeTool());
      expect(() => registerTool(makeTool())).toThrow(/already registered/);
    });
  });

  describe("getTool", () => {
    it("returns tool when registered", () => {
      registerTool(makeTool());
      const tool = getTool("test-tool");
      expect(tool).toBeDefined();
      expect(tool!.name).toBe("Test Tool");
    });

    it("returns undefined when not registered", () => {
      expect(getTool("nonexistent")).toBeUndefined();
    });
  });

  describe("listTools", () => {
    it("returns all registered tool IDs", () => {
      registerTool(makeTool({ id: "a" }));
      registerTool(makeTool({ id: "b" }));
      expect(listTools()).toHaveLength(2);
    });
  });

  describe("resolveTools", () => {
    it("returns tools for valid IDs", () => {
      registerTool(makeTool({ id: "a", name: "Tool A" }));
      registerTool(makeTool({ id: "b", name: "Tool B" }));

      const resolved = resolveTools(["a", "b"]);
      expect(resolved).toHaveLength(2);
      expect(resolved[0].name).toBe("Tool A");
    });

    it("skips unregistered IDs", () => {
      registerTool(makeTool({ id: "a" }));

      const resolved = resolveTools(["a", "missing"]);
      expect(resolved).toHaveLength(1);
    });

    it("returns empty for all-missing IDs", () => {
      const resolved = resolveTools(["x", "y"]);
      expect(resolved).toEqual([]);
    });
  });

  describe("resetToolRegistry", () => {
    it("clears all registrations", () => {
      registerTool(makeTool({ id: "a" }));
      resetToolRegistry();
      expect(listTools()).toEqual([]);
    });
  });
});
