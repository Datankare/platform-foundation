/**
 * __tests__/agentic-workflow-conformance.test.ts
 *
 * Runs the agentic workflow kit against the in-memory wiring.
 *
 * A consumer — Playform, or any other application on this platform — runs the same kit
 * against its own stores and ledger to learn whether its agentic workflow behaves as
 * ADR-029 and ADR-031 require. That portability is what the kit is for; this file is just
 * our own invocation of it.
 */

import { runAgenticWorkflowContract } from "./contract/agentic-workflow-contract";
import { InMemoryTrajectoryStore } from "@/platform/agents/trajectory-store";
import { InMemoryProposalStore } from "@/platform/agents/proposal-store";
import { InMemoryEffectLedger } from "@/platform/agents/effect-ledger";

describe("agentic workflow — conformance (in-memory wiring)", () => {
  runAgenticWorkflowContract({
    makeTrajectoryStore: () => new InMemoryTrajectoryStore(),
    makeProposalStore: () => new InMemoryProposalStore(),
    makeEffectLedger: () => new InMemoryEffectLedger(),
  });
});
