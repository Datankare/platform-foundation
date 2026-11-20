/**
 * @jest-environment node
 */
/**
 * __tests__/json-bound-writers.test.ts — a write the stores would refuse is refused BEFORE the work,
 * and what work has produced is recorded as kept or not kept, never lost with the run (platform
 * TASK-229; code reviews A-9, A-11, B-2, B-3, B-7, B-10, B-12, B-13, B-14, B-18, B-26)
 *
 * What it refuses: an action, tool, session or run that does its work and then fails because a
 * value could not be stored — or a stand-in store that accepts what the real store refuses
 *
 * No database: the in-memory stores make the same checks as the Postgres ones (B-26), so each
 * case below is the real path with the real refusal.
 *   - action pipeline (B-2): the step as a whole is tested before perform; what perform returns
 *     is recorded as `outputNotRecorded` when the store could not keep it; a compensation whose
 *     step cannot be stored is reported and the walk goes on.
 *   - tool invoker (B-3): a tool with declared external effects is not run with an input the
 *     effect ledger would refuse as a request.
 *   - sessions (B-7): the metadata (participants, budget) is tested before anything is stored.
 *   - agent runs (A-11, B-10, B-18): recordableStep's input, output, whole-step, cost and action
 *     branches; executeAgent and resumeAgent both record through it.
 *   - review queue (B-13): a moderation result keeps its own fields whatever else is over.
 *   - metrics (B-12), the retention job (B-14), the json-bound probe without a database (A-9).
 */
jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));
// No database for this file, whatever the run configures: every store here is the in-memory one,
// and the probe's answer without a database is one of the cases (A-9).
jest.mock("@/platform/data", () => ({
  ...jest.requireActual("@/platform/data"),
  hasDatabase: () => false,
}));

import { InMemoryTrajectoryStore } from "@/platform/agents/trajectory-store";
import { InMemoryEffectLedger } from "@/platform/agents/effect-ledger";
import { InMemoryActivityStateStore } from "@/platform/app-framework/memory-state-store";
import {
  ActionNotRecordedError,
  compensateTrajectory,
  executeActionPipeline,
} from "@/platform/action-pipeline";
import { invokeTool } from "@/platform/agents/tool-invoker";
import {
  executeAgent,
  recordableStep,
  RECORDED_ACTION_MAX,
  resumeAgent,
  type WorkflowFn,
} from "@/platform/agents/runtime";
import { registerAgent, resetAgentRegistry } from "@/platform/agents/registry";
import { BudgetTracker } from "@/platform/agents/budget-tracker";
import {
  isJsonLimitError,
  STORED_JSON_MAX_BYTES,
  storedJsonViolation,
} from "@/platform/errors/json-limits";
import { storableModerationResult } from "@/platform/moderation/store";
import { createJsonBoundProbe } from "@/platform/auth/erasure-schema";
import { buildReadinessProbes } from "@/platform/providers/readiness-probes";
import { ERASURE_REFUSED_FAILURE } from "@/platform/jobs/duties";
import type { AgentIdentity, Step } from "@/platform/kernel";

const actor: AgentIdentity = { actorType: "agent", actorId: "agent:w1", agentRole: "a" };

async function trajectory(store: InMemoryTrajectoryStore): Promise<string> {
  return (await store.create({ kind: "agent", id: "w1" }, "t", "platform")).trajectory
    .trajectoryId;
}

/** The pipeline request of a paying action, with what the test overrides. */
async function pay(over: Record<string, unknown>) {
  const store = new InMemoryTrajectoryStore();
  const trajectoryId = await trajectory(store);
  const stateStore = new InMemoryActivityStateStore<unknown>();
  await stateStore.create("s", { v: 0 });
  const outcome = await executeActionPipeline({
    spec: {
      type: "pay",
      effects: ["externalCall"],
      ephemeral: false,
      commutative: false,
    },
    actor,
    sessionId: "s",
    label: "pay",
    cost: 0,
    boundary: "commitment",
    stateStore,
    trajectoryStore: store,
    trajectoryId,
    stepIndex: 0,
    expectedVersion: 1,
    ...over,
  } as never).then(
    (ok) => ({ ok, err: null as unknown }),
    (err: unknown) => ({ ok: null, err })
  );
  return { ...outcome, steps: (await store.getById(trajectoryId))!.trajectory.steps };
}

describe("code review B-26: the in-memory stores refuse what the Postgres stores refuse", () => {
  it("[guard] a step over the limits is refused by the in-memory trajectory store, coded", async () => {
    const store = new InMemoryTrajectoryStore();
    const id = await trajectory(store);
    const step = (output: Record<string, unknown>): Step => ({
      stepIndex: 0,
      action: "a",
      boundary: "cognition",
      input: {},
      output,
      cost: 0,
      durationMs: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const err = await store.addStep(id, step({ p: 1e-30 })).then(
      () => null,
      (e: unknown) => e
    );
    expect(isJsonLimitError(err)).toBe(true);
    expect((await store.getById(id))!.trajectory.steps).toHaveLength(0);
    await store.addStep(id, step({ p: 0.5 }));
    expect((await store.getById(id))!.trajectory.steps).toHaveLength(1);
  });

  it("[guard] the in-memory ledger refuses a request over the limits and stores the marker for a receipt it cannot keep", async () => {
    const ledger = new InMemoryEffectLedger();
    const refused = await ledger
      .begin({
        operationId: "op",
        effectKey: "k",
        effectType: "externalCall",
        request: { amount: 1e-30 },
      })
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(isJsonLimitError(refused)).toBe(true);
    expect(await ledger.get("op", "k")).toBeUndefined();
    await ledger.begin({ operationId: "op", effectKey: "k", effectType: "externalCall" });
    const resolved = await ledger.resolve("op", "k", "confirmed", {
      receipt: { p: 1e-30 },
    });
    expect(resolved?.receipt).toEqual({
      _omitted: { code: "request.json_number_out_of_range" },
    });
  });
});

describe("code review B-2: the action pipeline refuses before the work, and records what the work returned", () => {
  it("[guard] a cost the store would refuse (5e-19): coded refusal, nothing performed", async () => {
    const performed: string[] = [];
    const r = await pay({
      cost: 5e-19,
      perform: async () => {
        performed.push("paid");
        return {};
      },
    });
    expect(performed).toEqual([]);
    expect(isJsonLimitError(r.err)).toBe(true);
    expect(r.err).not.toBeInstanceOf(ActionNotRecordedError);
    expect(r.steps).toHaveLength(0);
  });

  it("[guard] input and output each within the limits, together over 1 MiB: refused before anything performs", async () => {
    const performed: string[] = [];
    const half = "x".repeat(Math.floor(STORED_JSON_MAX_BYTES * 0.6));
    expect(storedJsonViolation({ half })).toBeNull();
    const r = await pay({
      stepInput: { half },
      stepOutput: { half },
      perform: async () => {
        performed.push("paid");
        return {};
      },
    });
    expect(performed).toEqual([]);
    expect(isJsonLimitError(r.err)).toBe(true);
    expect((r.err as { code: string }).code).toBe("request.json_too_large");
  });

  it("[guard] what perform returns holds 1e-30: the action stands, its step is stored with outputNotRecorded — never ActionNotRecordedError", async () => {
    const performed: string[] = [];
    const r = await pay({
      perform: async () => {
        performed.push("paid");
        return { probability: 1e-30 };
      },
    });
    expect(performed).toEqual(["paid"]);
    expect(r.err).toBeNull();
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].output).toEqual({
      outputNotRecorded: { code: "request.json_number_out_of_range" },
    });
  });

  it("[guard] what perform returns is within the limits alone but over them with the step's input: recorded as not kept", async () => {
    const half = "x".repeat(Math.floor(STORED_JSON_MAX_BYTES * 0.6));
    const r = await pay({
      stepInput: { half },
      perform: async () => ({ half }),
    });
    expect(r.err).toBeNull();
    expect(r.steps[0].output).toEqual({
      outputNotRecorded: { code: "request.json_too_large", max: STORED_JSON_MAX_BYTES },
    });
    expect(r.steps[0].input).toMatchObject({ half });
  });

  it("a result within the limits is recorded as it is", async () => {
    const r = await pay({ perform: async () => ({ receiptId: "r1" }) });
    expect(r.steps[0].output).toEqual({ receiptId: "r1" });
  });

  it("[guard] compensation: a result the store would refuse is recorded as not kept, so the step is stored and the next walk does not run it again", async () => {
    const store = new InMemoryTrajectoryStore();
    const trajectoryId = await trajectory(store);
    for (const i of [0, 1])
      await store.addStep(trajectoryId, {
        stepIndex: i,
        action: `charge-${i}`,
        boundary: "commitment",
        input: {},
        output: {},
        cost: 0,
        durationMs: 0,
        timestamp: "2026-01-01T00:00:00.000Z",
        operationId: `op_${i}`,
      });
    const ran: string[] = [];
    const walk = () =>
      compensateTrajectory({
        trajectoryId,
        trajectoryStore: store,
        actor,
        sessionId: "s",
        plan: (step: Step) => ({
          spec: {
            type: "refund",
            effects: ["externalCall"],
            ephemeral: false,
            commutative: false,
          },
          label: `refund-${step.action}`,
          perform: async () => {
            ran.push(step.action);
            return { fee: 1e-30 };
          },
        }),
      } as never);
    const first = await walk();
    expect(first).toMatchObject({ compensated: 2, failures: [] });
    expect(ran).toEqual(["charge-1", "charge-0"]);
    const steps = (await store.getById(trajectoryId))!.trajectory.steps;
    expect(steps.slice(2).map((s) => s.output)).toEqual([
      {
        outputNotRecorded: { code: "request.json_number_out_of_range" },
        compensated: true,
      },
      {
        outputNotRecorded: { code: "request.json_number_out_of_range" },
        compensated: true,
      },
    ]);
    const second = await walk();
    expect(second.compensated).toBe(0);
    expect(ran).toHaveLength(2);
  });

  it("[guard] compensation: a step that cannot be stored (the trajectory is full) is reported and the walk goes on to the remaining steps", async () => {
    class FailsOnce extends InMemoryTrajectoryStore {
      failNext = 0;
      override async addStep(...args: Parameters<InMemoryTrajectoryStore["addStep"]>) {
        if (args[1].compensates && this.failNext-- > 0)
          throw new Error("store unreachable");
        return super.addStep(...args);
      }
    }
    const store = new FailsOnce();
    const trajectoryId = await trajectory(store);
    for (const i of [0, 1])
      await store.addStep(trajectoryId, {
        stepIndex: i,
        action: `charge-${i}`,
        boundary: "commitment",
        input: {},
        output: {},
        cost: 0,
        durationMs: 0,
        timestamp: "2026-01-01T00:00:00.000Z",
        operationId: `op_${i}`,
      });
    store.failNext = 1;
    const ran: string[] = [];
    const out = await compensateTrajectory({
      trajectoryId,
      trajectoryStore: store,
      actor,
      sessionId: "s",
      plan: (step: Step) => ({
        spec: {
          type: "refund",
          effects: ["externalCall"],
          ephemeral: false,
          commutative: false,
        },
        label: `refund-${step.action}`,
        perform: async () => {
          ran.push(step.action);
          return {};
        },
      }),
    } as never);
    // Both compensations ran; the first one's step was not stored and is reported.
    expect(ran).toEqual(["charge-1", "charge-0"]);
    expect(out.compensated).toBe(1);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0].operationId).toBe("op_1");
  });
});

describe("code review B-3: a tool with external effects is not run with an input its ledger would refuse", () => {
  const tool = (ran: string[]) =>
    ({
      id: "pay",
      name: "pay",
      description: "",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      effects: ["externalCall"],
      declaredRisk: "ordinary",
      execute: async () => {
        ran.push("tool ran");
        return { ok: true };
      },
      externalEffects: [
        {
          key: "charge",
          type: "externalCall",
          call: async () => {
            ran.push("effect fired");
            return { id: 1 };
          },
        },
      ],
    }) as never;

  it("[guard] a schema-valid input holding 1e-30: coded refusal; the tool is not called and no effect fires", async () => {
    const store = new InMemoryTrajectoryStore();
    const ran: string[] = [];
    const err = await invokeTool({
      tool: tool(ran),
      input: { amount: 1e-30 },
      actor,
      sessionId: "s",
      trajectoryId: await trajectory(store),
      stepIndex: 0,
      trajectoryStore: store,
      effectLedger: new InMemoryEffectLedger(),
    } as never).then(
      () => null,
      (e: unknown) => e
    );
    expect(ran).toEqual([]);
    expect(isJsonLimitError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("request.json_number_out_of_range");
    expect(err).not.toBeInstanceOf(ActionNotRecordedError);
  });

  it("an input within the limits runs the tool and fires its effect once", async () => {
    const store = new InMemoryTrajectoryStore();
    const ran: string[] = [];
    await invokeTool({
      tool: tool(ran),
      input: { amount: 0.5 },
      actor,
      sessionId: "s",
      trajectoryId: await trajectory(store),
      stepIndex: 0,
      trajectoryStore: store,
      effectLedger: new InMemoryEffectLedger(),
    } as never);
    expect(ran).toEqual(["tool ran", "effect fired"]);
  });
});

describe("code reviews A-11, B-10, B-18: every branch of what a run's step is recorded as", () => {
  const step = (over: Partial<Step>): Step => ({
    stepIndex: 3,
    action: "analyse",
    boundary: "cognition",
    input: { q: "q" },
    output: { a: "a" },
    cost: 0.25,
    durationMs: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    ...over,
  });

  it("a step within the limits is recorded as it is", () => {
    const s = step({});
    expect(recordableStep(s, "tid")).toEqual(s);
  });

  it("[guard] an input over the range: inputNotRecorded, the output kept", () => {
    const r = recordableStep(step({ input: { wei: 1e25 } }), "tid");
    expect(r.input).toEqual({
      inputNotRecorded: { code: "request.json_number_out_of_range" },
    });
    expect(r.output).toEqual({ a: "a" });
    expect(storedJsonViolation(r)).toBeNull();
  });

  it("[guard] an output over the range: outputNotRecorded, the input kept", () => {
    const r = recordableStep(step({ output: { p: 1e-20 } }), "tid");
    expect(r.output).toEqual({
      outputNotRecorded: { code: "request.json_number_out_of_range" },
    });
    expect(r.input).toEqual({ q: "q" });
  });

  it("[guard] input and output each within, the step over 1 MiB as a whole: both recorded as not kept", () => {
    const half = "x".repeat(Math.floor(STORED_JSON_MAX_BYTES * 0.6));
    const r = recordableStep(step({ input: { half }, output: { half } }), "tid");
    expect(r.input).toEqual({
      inputNotRecorded: { code: "request.json_too_large", max: STORED_JSON_MAX_BYTES },
    });
    expect(r.output).toEqual({
      outputNotRecorded: { code: "request.json_too_large", max: STORED_JSON_MAX_BYTES },
    });
    expect(storedJsonViolation(r)).toBeNull();
  });

  it("[guard] (B-10) a cost of 5e-19 — arithmetic residue: recorded as 0 with costNotRecorded; input and output kept; storable", () => {
    const r = recordableStep(step({ cost: 5e-19 }), "tid");
    expect(r.cost).toBe(0);
    expect(r.output).toEqual({
      outputNotRecorded: { code: "request.json_number_out_of_range" },
      costNotRecorded: { code: "request.json_number_out_of_range" },
    });
    expect(storedJsonViolation(r)).toBeNull();
  });

  it("[guard] (B-10) an action text of 2 MiB: cut to RECORDED_ACTION_MAX characters; storable", () => {
    const r = recordableStep(
      step({ action: "y".repeat(2 * STORED_JSON_MAX_BYTES) }),
      "tid"
    );
    expect(r.action).toHaveLength(RECORDED_ACTION_MAX);
    expect(storedJsonViolation(r)).toBeNull();
  });

  it("[guard] (B-12) an action holding text jsonb refuses: replaced by a fixed word; storable", () => {
    const r = recordableStep(step({ action: "cut \ud83d" }), "tid");
    expect(r.action).toBe("(an action whose name cannot be recorded)");
    expect(storedJsonViolation(r)).toBeNull();
  });

  describe("both sites that record a run's step go through it", () => {
    beforeEach(() => {
      resetAgentRegistry();
      registerAgent({
        id: "w1-analyst",
        name: "w1-analyst",
        description: "test",
        tools: [],
        budgetConfig: {
          maxCostPerTrajectory: 1,
          maxCostPerDay: 10,
          maxStepsPerTrajectory: 6,
        },
        effortTier: "standard",
      } as never);
    });
    afterEach(() => resetAgentRegistry());

    const outcome: WorkflowFn = async () => ({
      action: "analyse",
      boundary: "commitment",
      input: { question: "q" },
      output: { probability: 1e-20 },
      costUsd: 0.25,
      continueExecution: false,
    });

    it("[guard] executeAgent: a workflow outcome holding 1e-20 — the run completes, the step carries outputNotRecorded", async () => {
      const store = new InMemoryTrajectoryStore();
      const result = await executeAgent(
        "w1-analyst",
        "test",
        "platform",
        undefined,
        outcome,
        store,
        new BudgetTracker(),
        new InMemoryEffectLedger()
      );
      expect(result.finalStatus).toBe("completed");
      const steps = (await store.getById(result.trajectoryId))!.trajectory.steps;
      expect(steps[0].output).toEqual({
        outputNotRecorded: { code: "request.json_number_out_of_range" },
      });
    });

    it("[guard] resumeAgent: the same outcome on a resumed run — it completes, its budget is consumed, the step carries outputNotRecorded", async () => {
      const consumed: number[] = [];
      class CountingBudget extends BudgetTracker {
        override async consume(...args: Parameters<BudgetTracker["consume"]>) {
          consumed.push(args[3]);
          return super.consume(...args);
        }
      }
      const store = new InMemoryTrajectoryStore();
      const rec = await store.create(
        { kind: "agent", id: "w1-analyst" },
        "t",
        "platform"
      );
      const trajectoryId = rec.trajectory.trajectoryId;
      await store.updateStatus(trajectoryId, "paused");
      const result = await resumeAgent({
        trajectoryId,
        workflow: outcome,
        trajectoryStore: store,
        budgetTracker: new CountingBudget(),
        effectLedger: new InMemoryEffectLedger(),
      });
      expect(result.finalStatus).toBe("completed");
      expect(consumed).toEqual([0.25]);
      const steps = (await store.getById(trajectoryId))!.trajectory.steps;
      expect(steps).toHaveLength(1);
      expect(steps[0].output).toEqual({
        outputNotRecorded: { code: "request.json_number_out_of_range" },
      });
      expect(steps[0].input).toEqual({ question: "q" });
    });
  });
});

describe("code review B-13: a moderation result always keeps the decision's own fields", () => {
  const result = (over: Record<string, unknown>) => ({
    action: "escalate",
    triggeredBy: "classifier",
    direction: "input",
    contentType: "text",
    contentRatingLevel: 1,
    blocklistMatches: ["a"],
    reasoning: [{ key: "screens.moderation.reason.x" }],
    severityAdjustment: 0,
    contextFactors: [],
    attributeToUser: true,
    pipelineLatencyMs: 12,
    classifierCostUsd: 0.001,
    trajectoryId: "traj-1",
    agentId: "guardian",
    ...over,
  });
  const col = "review_queue.moderation_result";

  it("a result within the limits is stored as it is", () => {
    const r = result({});
    expect(storableModerationResult(r, col)).toBe(r);
  });

  it("[guard] a blocklistMatches list of 2 MiB (the classifier output already removed): the list is not kept, by name; action and trajectory stay", () => {
    const r = storableModerationResult(
      result({
        classifierOutput: { p: 1e-30 },
        blocklistMatches: ["z".repeat(2 * STORED_JSON_MAX_BYTES)],
      }),
      col
    ) as Record<string, unknown>;
    expect(r.action).toBe("escalate");
    expect(r.trajectoryId).toBe("traj-1");
    expect(r.classifierOutput).toBeUndefined();
    expect(r.classifierOutputNotKept).toEqual({
      code: "request.json_number_out_of_range",
    });
    expect(r.blocklistMatches).toEqual([]);
    expect(r.fieldsNotKept).toEqual({
      blocklistMatches: { code: "request.json_too_large", max: STORED_JSON_MAX_BYTES },
    });
    expect(storedJsonViolation(r)).toBeNull();
  });

  it("[guard] a cost of 6.5e-19 (arithmetic residue): recorded as 0 and named; the decision is whole", () => {
    const r = storableModerationResult(
      result({ classifierCostUsd: 0.00832 + 0.001586 - 0.00832 - 0.001586 }),
      col
    ) as Record<string, unknown>;
    expect(r.classifierCostUsd).toBe(0);
    expect(r.fieldsNotKept).toEqual({
      classifierCostUsd: { code: "request.json_number_out_of_range" },
    });
    expect(r.action).toBe("escalate");
    expect(r.blocklistMatches).toEqual(["a"]);
  });

  it("[guard] three lists that are each within the limits and together over them: lists are dropped by name until the result fits", () => {
    const part = ["q".repeat(Math.floor(STORED_JSON_MAX_BYTES * 0.4))];
    const r = storableModerationResult(
      result({ blocklistMatches: part, reasoning: part, contextFactors: part }),
      col
    ) as Record<string, unknown>;
    expect(storedJsonViolation(r)).toBeNull();
    expect(Object.keys(r.fieldsNotKept as object)).toEqual(["contextFactors"]);
    expect(r.contextFactors).toEqual([]);
    expect(r.reasoning).toBe(part);
    expect(r.trajectoryId).toBe("traj-1");
  });

  it("a result whose own fields cannot be stored refuses the enqueue, coded — never the bare marker", () => {
    expect(() =>
      storableModerationResult(
        result({ agentId: "g".repeat(2 * STORED_JSON_MAX_BYTES) }),
        col
      )
    ).toThrow(expect.objectContaining({ code: "request.json_too_large" }));
  });
});

describe("code review A-9: the json-bound probe without a database", () => {
  it("[guard] is registered all the same (the health watch's default checks name it) and answers healthy, saying nothing is stored", async () => {
    const { required, degradedOnly } = buildReadinessProbes({
      AI_PROVIDER: "mock",
      AUTH_PROVIDER: "mock",
    } as never);
    expect(required.map((p) => p.name)).not.toContain("database");
    const probe = degradedOnly.find((p) => p.name === "json-bound");
    expect(probe).toBeDefined();
    expect(await probe!.check()).toMatchObject({
      name: "json-bound",
      status: "healthy",
      detail: "no database: nothing is stored",
    });
    expect(await createJsonBoundProbe().check()).toMatchObject({ status: "healthy" });
  });
});

describe("code review B-14: a retention run whose erasures were refused fails, in operators' words", () => {
  it("the failure's text says no account was tried, and where to look", () => {
    expect(ERASURE_REFUSED_FAILURE).toContain("no account was tried");
    expect(ERASURE_REFUSED_FAILURE).toContain("json-bound");
    expect(ERASURE_REFUSED_FAILURE).toContain(
      'docs/runbooks/jobs.md, "Erasures refused"'
    );
    expect(ERASURE_REFUSED_FAILURE.length).toBeLessThan(1000);
  });
});
