/**
 * platform/agents/__tests__/tool-contract.test.ts
 *
 * ADR-029 D1 — a registered tool is invocable and declares its effects.
 */

import { registerTool, resolveTools, resetToolRegistry } from "../tools";
import type { Tool } from "../types";

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: "echo",
    name: "Echo",
    description: "Returns its input",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    effects: [],
    execute: async (input) => ({ echoed: input }),
    ...overrides,
  };
}

describe("Tool executable contract (ADR-029 D1)", () => {
  beforeEach(() => {
    resetToolRegistry();
  });

  it("a resolved tool is invocable", async () => {
    registerTool(makeTool());

    const [tool] = resolveTools(["echo"]);

    await expect(tool.execute({ a: 1 })).resolves.toEqual({ echoed: { a: 1 } });
  });

  it("carries effects and an optional declaredRisk", () => {
    const tool = makeTool({
      effects: ["externalCall"],
      declaredRisk: "consequential",
    });

    expect(tool.effects).toEqual(["externalCall"]);
    expect(tool.declaredRisk).toBe("consequential");
  });

  it("declaredRisk is absent by default", () => {
    expect(makeTool().declaredRisk).toBeUndefined();
  });

  it("execute accepts an optional ActionContext", async () => {
    const tool = makeTool({
      execute: async (input, context) => ({
        operationId: context?.operationId ?? "none",
        ...input,
      }),
    });

    await expect(tool.execute({ x: 1 })).resolves.toEqual({
      operationId: "none",
      x: 1,
    });
  });
});
