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
    effects: [],
    execute: async () => ({ ok: true }),
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

    it("throws on an unregistered ID rather than skipping it", () => {
      registerTool(makeTool({ id: "a" }));

      expect(() => resolveTools(["a", "missing"])).toThrow(/not registered: missing/);
    });

    it("throws on the first missing ID when none are registered", () => {
      expect(() => resolveTools(["x", "y"])).toThrow(/not registered: x/);
    });

    it("resolves nothing and throws rather than returning a short list", () => {
      registerTool(makeTool({ id: "a" }));

      let resolvedLength = -1;
      try {
        resolvedLength = resolveTools(["a", "missing"]).length;
      } catch {
        /* justified */
        // The assertion is that no partial result escapes — resolvedLength must remain
        // untouched, which distinguishes throwing from returning a shortened array.
      }
      expect(resolvedLength).toBe(-1);
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
