/**
 * platform/rag/__tests__/explainability.test.ts
 *
 * Tests for the explanation chain builder.
 */

import { createExplanationBuilder } from "../explainability";
import type { ShownText } from "@/platform/errors/shown-text";

/** A step's or a conclusion's text is a catalog key (TASK-209): one per label here. */
const k = (label: string): ShownText => ({
  key: `screens.app.rag.${label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
});

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

describe("createExplanationBuilder", () => {
  it("builds an empty chain", () => {
    const builder = createExplanationBuilder("req-1");
    const chain = builder.build(k("No steps taken"));
    expect(chain.requestId).toBe("req-1");
    expect(chain.steps).toHaveLength(0);
    expect(chain.conclusion).toEqual(k("No steps taken"));
    expect(chain.id).toBeDefined();
    expect(chain.createdAt).toBeDefined();
  });

  it("accumulates steps in order", () => {
    const builder = createExplanationBuilder("req-2");
    builder.addStep("retrieval", k("Retrieved 3 chunks"), { count: 3 }, 42);
    builder.addStep("prompt", k("Built prompt"), { tokens: 500 }, 5);
    builder.addStep("inference", k("Model responded"), { model: "mock" }, 200);
    const chain = builder.build(k("Answer generated"));

    expect(chain.steps).toHaveLength(3);
    expect(chain.steps[0].phase).toBe("retrieval");
    expect(chain.steps[1].phase).toBe("prompt");
    expect(chain.steps[2].phase).toBe("inference");
    expect(chain.steps[0].durationMs).toBe(42);
  });

  it("preserves step data", () => {
    const builder = createExplanationBuilder("req-3");
    builder.addStep("test", k("description"), { key: "value", nested: { a: 1 } }, 10);
    const chain = builder.build(k("done"));

    expect(chain.steps[0].data).toEqual({ key: "value", nested: { a: 1 } });
    expect(chain.steps[0].description).toEqual(k("description"));
  });

  it("builds independent chains from same builder", () => {
    const builder = createExplanationBuilder("req-4");
    builder.addStep("step1", k("first"), {}, 1);
    const chain1 = builder.build(k("conclusion 1"));

    builder.addStep("step2", k("second"), {}, 2);
    const chain2 = builder.build(k("conclusion 2"));

    expect(chain1.steps).toHaveLength(1);
    expect(chain2.steps).toHaveLength(2);
    expect(chain1.id).not.toBe(chain2.id);
  });
});
