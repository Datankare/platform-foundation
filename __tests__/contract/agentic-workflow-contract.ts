/**
 * __tests__/contract/agentic-workflow-contract.ts
 * Agentic workflow conformance kit (TCK) — ADR-029 L21, ADR-031. Not a *.test.ts.
 *
 * One arm per named ADR requirement, run against SUPPLIED fixtures. That is the point: a
 * consumer wiring its own trajectory store, proposal store and effect ledger can run this
 * and learn whether its agentic workflow behaves as the ADRs require. The rest of the suite
 * answers "does ours work"; this answers "does yours".
 *
 * It duplicates coverage deliberately. Portability is what a TCK is for.
 *
 * Registered as a FABRIC entry (ADR-029 D9): tool execution is in-process, so there is no
 * provider slot to swap and the meta-test's registry bijection is unaffected.
 */

import {
  executeActionPipeline,
  proposeAction,
  proposeOnce,
  approveProposal,
  rejectProposal,
  compensateTrajectory,
  mostRestrictiveCeiling,
  PipelineRejectedError,
} from "@/platform/action-pipeline";
import { invokeTool } from "@/platform/agents/tool-invoker";
import { performExternalEffect } from "@/platform/agents/external-effect";
import { registerTool, resolveTools, resetToolRegistry } from "@/platform/agents/tools";
import type {
  ActionSpec,
  AgentIdentity,
  EffectLedger,
  ProposalStore,
  SessionEvent,
  Step,
  Tool,
  TrajectoryStore,
} from "@/platform/kernel";

export interface AgenticWorkflowFixtures {
  readonly makeTrajectoryStore: () => TrajectoryStore | Promise<TrajectoryStore>;
  readonly makeProposalStore: () => ProposalStore | Promise<ProposalStore>;
  readonly makeEffectLedger: () => EffectLedger | Promise<EffectLedger>;
}

const ACTOR: AgentIdentity = {
  actorType: "agent",
  actorId: "conformance",
  agentRole: "conformance",
};

const ORDINARY: ActionSpec = {
  type: "ordinary_action",
  effects: [],
  ephemeral: false,
  commutative: false,
};

const RESTRICTED: ActionSpec = {
  type: "restricted_action",
  effects: ["restricted"],
  ephemeral: false,
  commutative: false,
};

function echoTool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: "echo",
    name: "Echo",
    description: "Returns its input",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    outputSchema: {
      type: "object",
      properties: { echoed: { type: "string" } },
      required: ["echoed"],
    },
    effects: [],
    execute: async (input) => ({ echoed: String(input.text) }),
    ...overrides,
  };
}

function committedStep(index: number, operationId: string, action: string): Step {
  return {
    stepIndex: index,
    action,
    input: {},
    output: {},
    cost: 0,
    durationMs: 1,
    timestamp: new Date().toISOString(),
    boundary: "commitment",
    operationId,
  };
}

export function runAgenticWorkflowContract(fx: AgenticWorkflowFixtures): void {
  let trajectoryStore: TrajectoryStore;
  let proposalStore: ProposalStore;
  let effectLedger: EffectLedger;
  let trajectoryId: string;

  beforeEach(async () => {
    resetToolRegistry();
    trajectoryStore = await fx.makeTrajectoryStore();
    proposalStore = await fx.makeProposalStore();
    effectLedger = await fx.makeEffectLedger();
    const rec = await trajectoryStore.create(
      { kind: "agent", id: "conformance" },
      "conformance-run",
      "platform"
    );
    trajectoryId = rec.trajectory.trajectoryId;
  });

  function call(tool: Tool, input: Record<string, unknown>, extra = {}) {
    return invokeTool({
      tool,
      input,
      actor: ACTOR,
      sessionId: "sess_conformance",
      trajectoryId,
      stepIndex: 0,
      trajectoryStore,
      effectLedger,
      ...extra,
    });
  }

  describe("ADR-029 D1 — a registered tool is invocable, resolution fails closed", () => {
    it("a resolved tool can be executed", async () => {
      registerTool(echoTool());
      const [tool] = resolveTools(["echo"]);
      await expect(tool.execute({ text: "hi" })).resolves.toEqual({ echoed: "hi" });
    });

    it("an unknown tool id throws rather than being skipped", () => {
      // Silently returning a short list gives an agent reduced capability and no signal,
      // which produces wrong answers indefinitely instead of one loud failure.
      registerTool(echoTool());
      expect(() => resolveTools(["echo", "missing"])).toThrow(/not registered/);
    });
  });

  describe("ADR-029 D2 — a tool call is governed by the session pipeline", () => {
    it("a restricted tool is gated by the same threshold as a restricted action", async () => {
      await expect(
        call(echoTool({ effects: ["restricted"] }), { text: "hi" })
      ).rejects.toThrow(/requires approval/);
    });

    it("a gated tool call leaves no trajectory step", async () => {
      await expect(
        call(echoTool({ effects: ["restricted"] }), { text: "hi" })
      ).rejects.toThrow();
      const rec = await trajectoryStore.getById(trajectoryId);
      expect(rec?.trajectory.steps).toHaveLength(0);
    });

    it("a permitted tool call appends exactly one step (invariant 1)", async () => {
      await call(echoTool(), { text: "hi" });
      const rec = await trajectoryStore.getById(trajectoryId);
      expect(rec?.trajectory.steps).toHaveLength(1);
    });
  });

  describe("ADR-029 D3 — schemas enforced at both edges", () => {
    it("rejects input that fails its schema before anything runs", async () => {
      await expect(call(echoTool(), { wrong: 1 })).rejects.toThrow(/schema/);
      const rec = await trajectoryStore.getById(trajectoryId);
      expect(rec?.trajectory.steps).toHaveLength(0);
    });

    it("retries invalid output rather than coercing it", async () => {
      let n = 0;
      const flaky = echoTool({
        execute: async (input) => {
          n += 1;
          return n < 2 ? { wrong: true } : { echoed: String(input.text) };
        },
      });
      const res = await call(flaky, { text: "hi" });
      expect(res.attempts).toBe(2);
      expect(res.output).toEqual({ echoed: "hi" });
    });

    it("fails the step when output never validates — never a plausible wrong answer", async () => {
      await expect(
        call(echoTool({ execute: async () => ({ wrong: true }) }), { text: "hi" })
      ).rejects.toThrow(/schema/);
    });
  });

  describe("ADR-029 D4 / D9 — identity on the trajectory and the step", () => {
    it("a trajectory records its subject kind", async () => {
      const rec = await trajectoryStore.getById(trajectoryId);
      expect(rec?.subject.kind).toBe("agent");
      expect(rec?.subject.id).toBe("conformance");
    });

    it("a session subject is distinguishable from an agent subject", async () => {
      await trajectoryStore.create({ kind: "session", id: "sess_1" }, "t", "user");
      const sessions = await trajectoryStore.query({ subjectKind: "session" });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].subject.id).toBe("sess_1");
    });

    it("a step carries the justification record (ADR-031 D9)", async () => {
      const res = await call(echoTool({ declaredRisk: "consequential" }), { text: "hi" });
      const rec = await trajectoryStore.getById(trajectoryId);
      const step = rec?.trajectory.steps[0];
      expect(step?.operationId).toBe(res.operationId);
      expect(step?.actor?.actorId).toBe("conformance");
      expect(step?.effectiveRisk).toBe("consequential");
    });
  });

  describe("ADR-029 D6 — compensation appends, never rewrites", () => {
    it("keeps the original step and links the compensation to it", async () => {
      await trajectoryStore.addStep(trajectoryId, committedStep(0, "op_1", "charge"));

      const outcome = await compensateTrajectory({
        trajectoryId,
        trajectoryStore,
        actor: ACTOR,
        sessionId: "sess_conformance",
        plan: (step) =>
          step.boundary === "commitment"
            ? { spec: ORDINARY, label: "refund", perform: async () => ({ ok: true }) }
            : null,
      });

      expect(outcome.compensated).toBe(1);
      const rec = await trajectoryStore.getById(trajectoryId);
      // Both survive: the history says what happened AND what was done about it.
      expect(rec?.trajectory.steps).toHaveLength(2);
      expect(rec?.trajectory.steps[0].action).toBe("charge");
      expect(rec?.trajectory.steps[1].compensates).toBe("op_1");
    });

    it("does not compensate the same operation twice", async () => {
      await trajectoryStore.addStep(trajectoryId, committedStep(0, "op_1", "charge"));
      const args = {
        trajectoryId,
        trajectoryStore,
        actor: ACTOR,
        sessionId: "sess_conformance",
        plan: (step: Step) =>
          step.boundary === "commitment"
            ? { spec: ORDINARY, label: "refund", perform: async () => ({ ok: true }) }
            : null,
      };
      await compensateTrajectory(args);
      const second = await compensateTrajectory(args);
      expect(second.compensated).toBe(0);
    });
  });

  describe("ADR-029 D7 — a gated action is held, not refused", () => {
    function propose(emit?: (e: SessionEvent) => void) {
      return proposeAction({
        spec: RESTRICTED,
        actor: ACTOR,
        sessionId: "sess_conformance",
        trajectoryId,
        stepIndex: 0,
        label: "restricted_action",
        operationId: "op_gated",
        proposalStore,
        trajectoryStore,
        emit,
      });
    }

    it("records the proposal and pauses the trajectory", async () => {
      const p = await propose();
      expect(p.status).toBe("proposed");
      const rec = await trajectoryStore.getById(trajectoryId);
      expect(rec?.trajectory.status).toBe("paused");
    });

    it("nothing executes and no state version is produced (ADR-031 D8)", async () => {
      await propose();
      const rec = await trajectoryStore.getById(trajectoryId);
      expect(rec?.trajectory.steps[0].boundary).toBe("cognition");
      expect(rec?.trajectory.steps[0].output).not.toHaveProperty("version");
    });

    it("emits an approval request", async () => {
      const events: SessionEvent[] = [];
      await propose((e) => events.push(e));
      expect(events.map((e) => e.type)).toContain("approval-request");
    });

    it("approval returns the trajectory to running", async () => {
      const p = await propose();
      await approveProposal({
        proposalId: p.proposalId,
        decidedBy: "approver",
        proposalStore,
        trajectoryStore,
      });
      const rec = await trajectoryStore.getById(trajectoryId);
      expect(rec?.trajectory.status).toBe("running");
    });

    it("rejection is terminal and keeps the reasoning", async () => {
      const p = await propose();
      await rejectProposal({
        proposalId: p.proposalId,
        decidedBy: "approver",
        note: "not sanctioned",
        proposalStore,
        trajectoryStore,
      });
      const rec = await trajectoryStore.getById(trajectoryId);
      expect(rec?.trajectory.status).toBe("failed");
      expect(rec?.trajectory.steps.at(-1)?.output).toMatchObject({
        note: "not sanctioned",
      });
    });
  });

  describe("ADR-029 D8 — the effective ceiling is the minimum", () => {
    it("takes the lowest of the applicable limits", () => {
      expect(
        mostRestrictiveCeiling([
          { limit: 1.0, label: "agent ceiling" },
          { limit: 0.01, label: "session ceiling" },
        ])?.limit
      ).toBe(0.01);
    });

    it("a generous agent budget does not defeat a strict session one", async () => {
      await expect(
        call(
          echoTool(),
          { text: "hi" },
          {
            cost: 0.9,
            budgetCeiling: 100,
            sessionCeiling: 0.5,
          }
        )
      ).rejects.toThrow(/session ceiling/);
    });

    it("no ceiling means unbounded, not zero", () => {
      expect(mostRestrictiveCeiling([])).toBeUndefined();
    });
  });

  describe("ADR-031 D4 — a retry finds its predecessor", () => {
    it("proposing twice for one operation returns the existing proposal", async () => {
      const args = {
        spec: RESTRICTED,
        actor: ACTOR,
        sessionId: "sess_conformance",
        trajectoryId,
        stepIndex: 0,
        label: "restricted_action",
        operationId: "op_dedup",
        proposalStore,
        trajectoryStore,
      };
      const first = await proposeOnce(args);
      const retry = await proposeOnce(args);
      expect(retry.proposalId).toBe(first.proposalId);
    });

    it("a second decision on a proposal is a no-op", async () => {
      const p = await proposeAction({
        spec: RESTRICTED,
        actor: ACTOR,
        sessionId: "sess_conformance",
        trajectoryId,
        stepIndex: 0,
        label: "restricted_action",
        proposalStore,
        trajectoryStore,
      });
      await approveProposal({
        proposalId: p.proposalId,
        decidedBy: "a",
        proposalStore,
        trajectoryStore,
      });
      const second = await rejectProposal({
        proposalId: p.proposalId,
        decidedBy: "b",
        proposalStore,
        trajectoryStore,
      });
      expect(second).toBeUndefined();
    });
  });

  describe("ADR-031 D7 / ADR-029 D10 — an effect fires once, or says it cannot know", () => {
    it("writes the ledger entry before the call and resolves it after", async () => {
      const outcome = await performExternalEffect({
        operationId: "op_effect",
        effectKey: "charge",
        effectType: "externalCall",
        call: async () => ({ id: "ch_1" }),
        ledger: effectLedger,
      });
      expect(outcome.status).toBe("confirmed");
      expect((await effectLedger.get("op_effect", "charge"))?.status).toBe("confirmed");
    });

    it("does not re-fire an unresolved entry — it reports indeterminate", async () => {
      await effectLedger.begin({
        operationId: "op_effect",
        effectKey: "charge",
        effectType: "externalCall",
      });
      let called = 0;
      const outcome = await performExternalEffect({
        operationId: "op_effect",
        effectKey: "charge",
        effectType: "externalCall",
        call: async () => {
          called += 1;
          return {};
        },
        ledger: effectLedger,
      });
      // Calling again is an at-least-once violation; assuming failure is at-most-once.
      expect(called).toBe(0);
      expect(outcome.status).toBe("indeterminate");
    });

    it("an indeterminate effect stays unresolved for the workflow check", async () => {
      await effectLedger.begin({
        operationId: "op_effect",
        effectKey: "charge",
        effectType: "externalCall",
      });
      await effectLedger.resolve("op_effect", "charge", "indeterminate", {
        error: "timeout after send",
      });
      const unresolved = await effectLedger.listUnresolved();
      expect(unresolved.map((e) => e.effectKey)).toContain("charge");
    });
  });

  describe("pipeline invariants that hold for every adapter", () => {
    it("a two-phase action cannot be direct-committed", async () => {
      await expect(
        executeActionPipeline({
          spec: RESTRICTED,
          actor: ACTOR,
          sessionId: "sess_conformance",
          label: "restricted_action",
          cost: 0,
          boundary: "commitment",
          stateStore: undefined as never,
          trajectoryStore,
          trajectoryId,
          stepIndex: 0,
          expectedVersion: 0,
          computeNextState: null,
        })
      ).rejects.toBeInstanceOf(PipelineRejectedError);
    });

    it("an ephemeral action leaves no durable trace", async () => {
      const outcome = await executeActionPipeline({
        spec: { ...ORDINARY, ephemeral: true },
        actor: ACTOR,
        sessionId: "sess_conformance",
        label: "ephemeral_action",
        cost: 0,
        boundary: "cognition",
        stateStore: undefined as never,
        trajectoryStore,
        trajectoryId,
        stepIndex: 0,
        expectedVersion: 0,
        computeNextState: null,
      });
      expect("tier" in outcome && outcome.tier).toBe("ephemeral");
      const rec = await trajectoryStore.getById(trajectoryId);
      expect(rec?.trajectory.steps).toHaveLength(0);
    });
  });
}
