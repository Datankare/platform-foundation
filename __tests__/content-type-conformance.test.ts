/**
 * __tests__/content-type-conformance.test.ts — ADR-037 §7 (L21).
 *
 * Runs the portable content-type contract kit against every content type this platform registers.
 * Playform runs the same kit against its own content types; this file is our invocation. A coverage
 * self-test keeps the invoked set in lockstep with the live registry, so a newly registered content
 * type with no contract spec turns this red (Gotcha 64).
 *
 * Content types are registered here in beforeAll rather than via jest.setup: importing the content
 * generation graph at setup time would pre-bind it and defeat the per-test orchestrator / screening
 * mocks this kit relies on (ADR-037 step-4 finding).
 */
jest.mock("@/platform/ai", () => ({
  ...jest.requireActual("@/platform/ai"),
  getOrchestrator: jest.fn(),
}));
jest.mock("@/platform/moderation/middleware", () => ({
  ...jest.requireActual("@/platform/moderation/middleware"),
  screenContent: jest.fn(),
}));
jest.mock("@/platform/action-pipeline", () => ({
  ...jest.requireActual("@/platform/action-pipeline"),
  executeActionPipeline: jest.fn(),
}));

import { runContentTypeContract } from "./contract/content-type-contract";
import { registerPlatformAgents } from "@/platform/agents/agent-configs";
import {
  registerSocialContentTypes,
  CURATOR_CONTENT_TYPE,
} from "@/platform/social/content/curator-content";
import { listContentTypes } from "@/platform/content/registry";

// Register the reference content type + its host agent so the kit's runs resolve the host.
// Idempotent; runs before any test in this file.
beforeAll(() => {
  registerPlatformAgents();
  registerSocialContentTypes();
});

const SPECS = [
  {
    name: CURATOR_CONTENT_TYPE.name,
    spec: {
      contentType: CURATOR_CONTENT_TYPE,
      sampleInput: {
        groupName: "contract-group",
        userId: "contract-user",
        recentActivity: ["a member posted a route"],
      },
      sampleValidRaw: JSON.stringify([
        { title: "Welcome", summary: "A new member joined the group", priority: "high" },
      ]),
    },
  },
];

for (const { spec } of SPECS) {
  runContentTypeContract(spec);
}

describe("content type conformance — coverage (ADR-037 L21)", () => {
  it("every registered content type has a contract spec", () => {
    const covered = SPECS.map((s) => s.name).sort();
    expect(covered).toEqual([...listContentTypes()].sort());
  });
});
