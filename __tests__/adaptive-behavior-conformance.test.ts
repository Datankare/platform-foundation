/**
 * __tests__/adaptive-behavior-conformance.test.ts — ADR-036 §6 (L21).
 *
 * Runs the portable adaptive-behavior contract kit against every adaptive behavior this platform
 * registers. Playform runs the same kit against its own behaviors; this file is our invocation.
 * A coverage self-test keeps the invoked set in lockstep with the live registry, so a newly
 * registered behavior with no contract spec turns this red (Gotcha 64).
 */
jest.mock("@/platform/ai", () => ({
  ...jest.requireActual("@/platform/ai"),
  getOrchestrator: jest.fn(),
}));
jest.mock("@/platform/action-pipeline", () => ({
  ...jest.requireActual("@/platform/action-pipeline"),
  executeActionPipeline: jest.fn(),
}));

import { runAdaptiveBehaviorContract } from "./contract/adaptive-behavior-contract";
import { registerAdaptiveReference } from "@/platform/adaptive/bootstrap";
import { PACING_BEHAVIOR } from "@/platform/adaptive/behaviors/pacing";
import { listAdaptiveBehaviors } from "@/platform/adaptive";

// Register the reference behavior + its host agent so the kit's runs resolve the host. Idempotent
// (jest.setup mirrors the same boot registration); runs before any test in this file.
beforeAll(() => {
  registerAdaptiveReference();
});

const SPECS = [
  {
    name: PACING_BEHAVIOR.name,
    spec: {
      behavior: PACING_BEHAVIOR,
      sampleInput: { scopeLabel: "contract-group", signal: "steady demand" },
    },
  },
];

for (const { spec } of SPECS) {
  runAdaptiveBehaviorContract(spec);
}

describe("adaptive behavior conformance — coverage (ADR-036 L21)", () => {
  it("every registered adaptive behavior has a contract spec", () => {
    const covered = SPECS.map((s) => s.name).sort();
    expect(covered).toEqual([...listAdaptiveBehaviors()].sort());
  });
});
