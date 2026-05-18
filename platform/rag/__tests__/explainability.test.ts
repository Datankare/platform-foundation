/**
 * platform/rag/__tests__/explainability.test.ts
 *
 * Tests for the explanation chain builder.
 */

import { createExplanationBuilder } from "../explainability";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

describe("createExplanationBuilder", () => {
  it("builds an empty chain", () => {
    const builder = createExplanationBuilder("req-1");
    const chain = builder.build("No steps taken");
    expect(chain.requestId).toBe("req-1");
    expect(chain.steps).toHaveLength(0);
    expect(chain.conclusion).toBe("No steps taken");
    expect(chain.id).toBeDefined();
    expect(chain.createdAt).toBeDefined();
  });

  it("accumulates steps in order", () => {
    const builder = createExplanationBuilder("req-2");
    builder.addStep("retrieval", "Retrieved 3 chunks", { count: 3 }, 42);
    builder.addStep("prompt", "Built prompt", { tokens: 500 }, 5);
    builder.addStep("inference", "Model responded", { model: "mock" }, 200);
    const chain = builder.build("Answer generated");

    expect(chain.steps).toHaveLength(3);
    expect(chain.steps[0].phase).toBe("retrieval");
    expect(chain.steps[1].phase).toBe("prompt");
    expect(chain.steps[2].phase).toBe("inference");
    expect(chain.steps[0].durationMs).toBe(42);
  });

  it("preserves step data", () => {
    const builder = createExplanationBuilder("req-3");
    builder.addStep("test", "description", { key: "value", nested: { a: 1 } }, 10);
    const chain = builder.build("done");

    expect(chain.steps[0].data).toEqual({ key: "value", nested: { a: 1 } });
    expect(chain.steps[0].description).toBe("description");
  });

  it("builds independent chains from same builder", () => {
    const builder = createExplanationBuilder("req-4");
    builder.addStep("step1", "first", {}, 1);
    const chain1 = builder.build("conclusion 1");

    builder.addStep("step2", "second", {}, 2);
    const chain2 = builder.build("conclusion 2");

    expect(chain1.steps).toHaveLength(1);
    expect(chain2.steps).toHaveLength(2);
    expect(chain1.id).not.toBe(chain2.id);
  });
});
