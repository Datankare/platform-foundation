/**
 * @jest-environment node
 */
/**
 * __tests__/db/deep-json-writers.db.test.ts — every writer refuses, keeps a "not kept" marker for,
 * or drops a value over the stored-JSON bound, in the platform's own words, never the database's
 * check_violation (platform TASK-229; design 56e-3a §2.6, T7; reviews B-14, TA-a-4, CONFIRM CA3-2)
 *
 * What it refuses: a writer whose over-bound value reaches the database (23514), is lost silently, is read
 * back as if it were the value, or fails a run after its work was done
 *
 * Writers with no limit of their own now check (storedJsonViolation: depth 64, 1 MiB compact, every
 * number 0 or 1e-18 <= |n| < 1e21). What each does over it (§2.6): a job's payload, an effect's
 * request, an embedding's metadata, a group's metadata, an approval policy's rules — refused,
 * coded, nothing written; an effect's receipt (the effect happened) — stored as the marker and
 * replayed as `resultKept: false`; a classifier's output (the decision is kept) — the marker, read
 * back as `classifierOutputNotKept`; a metric — dropped, alone, the rest of its batch written; an
 * agent run's step (the workflow already ran, E2) — recorded as `outputNotRecorded`, the run goes
 * on, its budget consumed; a pipeline step's input (E2) — refused before anything performs.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

import { withOwnerTx, withTenantTx } from "@/platform/data";
import { eraseUserData } from "@/platform/auth/user-data";
import { PostgresJobStore } from "@/platform/jobs/postgres-store";
import { PostgresEffectLedger } from "@/platform/agents/postgres-effect-ledger";
import { performExternalEffect } from "@/platform/agents/external-effect";
import { PostgresModerationStore } from "@/platform/moderation/store";
import { PostgresMetricsSink } from "@/platform/observability/metrics-sink";
import { PostgresEmbeddingStore } from "@/platform/rag/postgres-embedding-store";
import { PostgresTrajectoryStore } from "@/platform/agents/postgres-trajectory-store";
import { executeAgent, type WorkflowFn } from "@/platform/agents/runtime";
import { registerAgent, resetAgentRegistry } from "@/platform/agents/registry";
import { BudgetTracker } from "@/platform/agents/budget-tracker";
import { InMemoryEffectLedger } from "@/platform/agents/effect-ledger";
import { InMemoryActivityStateStore } from "@/platform/app-framework/memory-state-store";
import {
  ActionNotRecordedError,
  executeActionPipeline,
} from "@/platform/action-pipeline";
import { invokeTool } from "@/platform/agents/tool-invoker";
import {
  EFFECT_RECEIPT_MAX_IMAGE_BYTES,
  EFFECT_RECEIPT_MAX_TEXT,
  isJsonLimitError,
  STORED_JSON_MAX_DEPTH,
} from "@/platform/errors/json-limits";
import { PostgresActivityStateStore } from "@/platform/app-framework/postgres-state-store";
import { createSession } from "@/platform/app-framework/session";
import { resetActivityStateStore, setActivityStateStore } from "@/platform/app-framework";
import type { AgentIdentity } from "@/platform/kernel";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  DB_ENABLED,
  type TestTenant,
} from "../helpers/db";

let t: TestTenant;
if (DB_ENABLED) {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });
  beforeEach(async () => {
    t = await createTestTenant();
  });
}

/** A value nested `n` deep (an array in an array …). */
function nested(n: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < n; i++) v = [v];
  return v;
}
const DEEP = nested(STORED_JSON_MAX_DEPTH + 1);
const RANGE = "request.json_number_out_of_range 1e21";

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "written";
  } catch (err) {
    if (isJsonLimitError(err)) return `${err.code} ${err.params.max}`;
    return `other: ${(err as { code?: string }).code ?? (err as Error).message}`;
  }
}

const owner = async <R>(text: string, values: unknown[] = []): Promise<R[]> =>
  withOwnerTx(
    "tenant-lifecycle",
    async (tx) => (await tx.query(text, values)).rows as R[]
  );

const chunk = (metadata: unknown) =>
  ({
    id: "c1",
    documentId: "d",
    content: "x",
    index: 0,
    startOffset: 0,
    endOffset: 1,
    metadata,
  }) as never;

dbDescribe(
  "T7: writers with no limit of their own refuse before anything is written (B-14)",
  () => {
    it.each([
      ["too deep", { x: DEEP }, `request.json_too_deep ${STORED_JSON_MAX_DEPTH}`],
      ["a number below 1e-18", { p: 1e-20 }, RANGE],
      ["a number at 1e21 or more", { wei: 1e25 }, RANGE],
    ])(
      "%s: a job's payload, an effect's request, an embedding's metadata (a group's metadata: social-store.db.test.ts)",
      async (_l, value, want) => {
        const got = await t.run(async () => ({
          job: await refusal(
            new PostgresJobStore().enqueue({
              tenantId: t.id,
              kind: "gdpr.retention-purge",
              payload: value,
            } as never)
          ),
          effect: await refusal(
            new PostgresEffectLedger().begin({
              operationId: "op-t7",
              effectKey: "k",
              effectType: "externalCall",
              request: value,
            } as never)
          ),
          embedding: await refusal(
            new PostgresEmbeddingStore().upsert(
              { level: "tenant" } as never,
              "c1",
              [0.1],
              chunk(value)
            )
          ),
        }));
        expect(got).toEqual({ job: want, effect: want, embedding: want });
      }
    );
  }
);

dbDescribe(
  "T7: an effect's receipt over the bound (the effect happened): kept as not kept (TA-a-4)",
  () => {
    it("stored as the marker; a replay answers resultKept: false — never the marker as the result", async () => {
      const ledger = new PostgresEffectLedger();
      const calls: string[] = [];
      const live = await t.run(() =>
        performExternalEffect<Record<string, unknown>>({
          operationId: "op-t7r",
          effectKey: "k",
          effectType: "externalCall",
          call: async () => {
            calls.push("fired");
            return { score: 1e-20, image: "x" };
          },
          ledger,
        })
      );
      // The live call returns its real result.
      expect(live).toMatchObject({
        status: "confirmed",
        resultKept: true,
        result: { score: 1e-20 },
      });
      const rows = await owner<{ r: unknown }>(
        "select receipt as r from effect_ledger where tenant_id = $1 and operation_id = 'op-t7r'",
        [t.id]
      );
      expect(rows).toEqual([
        { r: { _omitted: { code: "request.json_number_out_of_range" } } },
      ]);
      const replay = await t.run(() =>
        performExternalEffect<Record<string, unknown>>({
          operationId: "op-t7r",
          effectKey: "k",
          effectType: "externalCall",
          call: async () => {
            calls.push("fired again");
            return {};
          },
          ledger,
        })
      );
      expect(calls).toEqual(["fired"]);
      expect(replay).toMatchObject({
        status: "confirmed",
        resultKept: false,
        notKept: { code: "request.json_number_out_of_range" },
      });
      expect("result" in replay).toBe(false);
    });
  }
);

dbDescribe(
  "T7 (code reviews B-1, B-11): a receipt is kept up to 6 MiB as printed — a held image survives its approval",
  () => {
    const image = (bytes: number) => ({
      mediaType: "image/png",
      data: Buffer.alloc(bytes, 7).toString("base64"),
    });

    it("a 2 MB image: stored whole by the database's bound and replayed as the result, nothing fired again", async () => {
      const ledger = new PostgresEffectLedger();
      const big = image(2 * 1_048_576);
      const calls: string[] = [];
      const call = async () => {
        calls.push("generated");
        return big;
      };
      const args = {
        operationId: "op-t7img",
        effectKey: "image-generation",
        effectType: "externalCall" as const,
        call,
        ledger,
      };
      const live = await t.run(() => performExternalEffect(args));
      expect(live).toMatchObject({
        status: "confirmed",
        resultKept: true,
        replayable: true,
      });
      const rows = await owner<{ printed: number; marker: boolean }>(
        "select octet_length(receipt::text) as printed, receipt ? '_omitted' as marker from effect_ledger where tenant_id = $1 and operation_id = 'op-t7img'",
        [t.id]
      );
      expect(rows[0].marker).toBe(false);
      expect(rows[0].printed).toBeGreaterThan(2_700_000);
      const replay = await t.run(() => performExternalEffect(args));
      expect(calls).toEqual(["generated"]);
      expect(replay).toMatchObject({ status: "confirmed", resultKept: true });
      expect((replay as { result: typeof big }).result).toEqual(big);
    }, 60_000);

    it("the largest image stated (EFFECT_RECEIPT_MAX_IMAGE_BYTES) is accepted by the database; one over the limit is stored as the marker, replayable false", async () => {
      const ledger = new PostgresEffectLedger();
      const most = await t.run(() =>
        performExternalEffect({
          operationId: "op-t7most",
          effectKey: "k",
          effectType: "externalCall",
          call: async () => image(EFFECT_RECEIPT_MAX_IMAGE_BYTES),
          ledger,
        })
      );
      expect(most).toMatchObject({ resultKept: true, replayable: true });
      const over = await t.run(() =>
        performExternalEffect({
          operationId: "op-t7over",
          effectKey: "k",
          effectType: "externalCall",
          call: async () => image(EFFECT_RECEIPT_MAX_TEXT),
          ledger,
        })
      );
      expect(over).toMatchObject({ resultKept: true, replayable: false });
      const rows = await owner<{ r: unknown }>(
        "select receipt as r from effect_ledger where tenant_id = $1 and operation_id = 'op-t7over'",
        [t.id]
      );
      expect(rows).toEqual([
        {
          r: {
            _omitted: { code: "request.json_too_large", max: EFFECT_RECEIPT_MAX_TEXT },
          },
        },
      ]);
    }, 60_000);

    it("(B-11) a provider's answer in the marker's own shape is stored wrapped and replayed as itself", async () => {
      const ledger = new PostgresEffectLedger();
      const forged = { _omitted: { code: "request.json_too_large", max: 1 } };
      const args = {
        operationId: "op-t7forged",
        effectKey: "k",
        effectType: "externalCall" as const,
        call: async () => forged as Record<string, unknown>,
        ledger,
      };
      await t.run(() => performExternalEffect(args));
      const rows = await owner<{ r: unknown }>(
        "select receipt as r from effect_ledger where tenant_id = $1 and operation_id = 'op-t7forged'",
        [t.id]
      );
      expect(rows).toEqual([{ r: { _kept: forged } }]);
      const replay = await t.run(() => performExternalEffect(args));
      expect(replay).toMatchObject({
        status: "confirmed",
        resultKept: true,
        result: forged,
      });
    });
  }
);

dbDescribe(
  "T7 (code review B-12): text jsonb refuses is found by the application first",
  () => {
    it("the database refuses half a surrogate pair (22P02) and U+0000 (22P05) in jsonb — what the application's check now refuses, coded", async () => {
      const code = async (sql: string) =>
        withOwnerTx("platform-job", (tx) => tx.query(sql)).then(
          () => "ok",
          (e: { code?: string }) => e.code ?? "?"
        );
      expect(await code(`select '"\\ud83d"'::jsonb`)).toBe("22P02");
      expect(await code(`select '"a\\u0000b"'::jsonb`)).toBe("22P05");
      expect(await code(`select '"\\ud83d\\ude00"'::jsonb`)).toBe("ok");
    });

    it("metrics: an event whose name, values or tags hold such text is dropped alone; the rest of its batch is written", async () => {
      const sink = new PostgresMetricsSink();
      const at = new Date().toISOString();
      try {
        await t.run(async () => {
          sink.record({
            name: "t7b.cut \ud83d",
            timestamp: at,
            values: { n: 1 },
            tags: {},
          });
          sink.record({
            name: "t7b.nul",
            timestamp: at,
            values: { s: "a\u0000b" } as never,
            tags: {},
          });
          sink.record({
            name: "t7b.tag",
            timestamp: at,
            values: { n: 1 },
            tags: { t: "\udc00" },
          });
          sink.record({ name: "t7b.kept", timestamp: at, values: { ms: 1 }, tags: {} });
          await sink.flush();
        });
        expect(sink.droppedOverStoredBound).toBe(3);
      } finally {
        sink.destroy();
      }
      const rows = await owner<{ name: string }>(
        "select name from ai_metrics where tenant_id = $1 and name like 't7b.%' order by name",
        [t.id]
      );
      expect(rows).toEqual([{ name: "t7b.kept" }]);
    });

    it("a job's payload holding U+0000: refused with request.json_value_not_storable before anything is written", async () => {
      const got = await t.run(() =>
        refusal(
          new PostgresJobStore().enqueue({
            tenantId: t.id,
            kind: "gdpr.retention-purge",
            payload: { note: "a\u0000b" },
          } as never)
        )
      );
      expect(got).toMatch(/^request\.json_value_not_storable/);
    });
  }
);

dbDescribe(
  "T7 (code review A-2): an account's purge that meets a row stored before the bound, over it",
  () => {
    it("is refused with 23514 json_bound until the row is converted (json_bound_convert), then completes — the row is kept, its number 0, the id erased", async () => {
      const user = await t.user("a2");
      const restore = () =>
        owner(
          "select public.json_bound_convert('public.audit_log'), public.json_bound_install(array['public.audit_log'::regclass]), public.json_bound_check('public.audit_log')"
        ).then(
          () => undefined,
          () => undefined
        );
      try {
        // A row written while the bound was not in force (as every row before migration 074).
        await withOwnerTx("tenant-lifecycle", async (tx) => {
          await tx.query(
            "select public.json_bound_off(array['public.audit_log'::regclass])"
          );
          await tx.query(
            `insert into audit_log (tenant_id, action, details)
             values ($1::uuid, 'admin_action'::audit_action, jsonb_build_object('type', 't7_a2', 'p', 1e-30, 'who', $2::text))`,
            [t.id, user]
          );
          await tx.query(
            "select public.json_bound_install(array['public.audit_log'::regclass])"
          );
        });
        const purge = () =>
          t
            .run(() => withTenantTx((tx) => eraseUserData(tx, user)))
            .then(
              () => "purged",
              (e: { code?: string; constraint?: string }) => `${e.code} ${e.constraint}`
            );
        expect(await purge()).toBe("23514 json_bound");
        const lines = await owner<{ line: string }>(
          "select line from public.json_bound_convert('public.audit_log') line"
        );
        expect(lines[lines.length - 1].line).toBe(
          "json bound: 1 row(s) converted, 0 not converted; now run select public.json_bound_check();"
        );
        await owner("select public.json_bound_check('public.audit_log')");
        expect(await purge()).toBe("purged");
        const rows = await owner<{ d: unknown }>(
          "select details as d from audit_log where tenant_id = $1 and details->>'type' = 't7_a2'",
          [t.id]
        );
        expect(rows).toEqual([{ d: { type: "t7_a2", p: 0, who: "erased" } }]);
      } finally {
        await restore();
      }
      const missing = await owner<{ m: string }>(
        "select m from public.json_bound_missing() m"
      );
      expect(missing).toEqual([]);
    }, 60_000);
  }
);

dbDescribe(
  "T7 (code review B-7): a session's metadata is the caller's — tested before anything is stored",
  () => {
    it("saveMeta with a budget of 1e21: the coded refusal, never the database's 23514", async () => {
      const store = new PostgresActivityStateStore<{ n: number }>();
      const sessionId = `sess_t7_${Date.now().toString(36)}`;
      const got = await t.run(async () => {
        await store.create(sessionId, { n: 1 });
        return refusal(
          store.saveMeta(sessionId, {
            definitionId: "d",
            status: "active",
            capabilities: [],
            participants: [],
            budget: {
              maxCostPerTrajectory: 1e21,
              maxCostPerDay: 1,
              maxStepsPerTrajectory: 1,
            },
          } as never)
        );
      });
      expect(got).toBe(RANGE);
    });

    it("createSession with a budget of Number.MAX_VALUE ('no cap'): refused; no session row and no trajectory are left", async () => {
      setActivityStateStore(new PostgresActivityStateStore() as never);
      const sessionId = `sess_t7c_${Date.now().toString(36)}`;
      try {
        const got = await t.run(() =>
          refusal(
            createSession({
              definition: {
                id: "t7-def",
                capabilities: ["persistent"],
                actions: [],
                initialState: () => ({ n: 0 }),
                validateAction: () => true,
                applyAction: (s: unknown) => s,
              },
              config: {},
              participants: [{ actorType: "user", actorId: "u1" }],
              budget: {
                maxCostPerTrajectory: Number.MAX_VALUE,
                maxCostPerDay: 1,
                maxStepsPerTrajectory: 1,
              },
              sessionId,
            } as never)
          )
        );
        expect(got).toBe(RANGE);
      } finally {
        resetActivityStateStore();
      }
      const rows = await owner<{ n: number }>(
        "select (select count(*) from app_sessions where id = $1)::int + (select count(*) from agent_trajectories where scope_id = $1)::int as n",
        [sessionId]
      );
      expect(rows[0].n).toBe(0);
    });
  }
);

dbDescribe(
  "T7: a classifier's output over the bound: the decision kept, the output marked not kept",
  () => {
    it("stored as the marker; read back as classifierOutputNotKept, never as an output", async () => {
      const store = new PostgresModerationStore();
      await t.run(() =>
        store.logAudit({
          inputHash: "h-t7",
          direction: "input",
          contentType: "generation",
          contentRatingLevel: 1,
          userId: "user-1",
          triggeredBy: "none",
          classifierOutput: { probabilities: { violence: 1e-22 } } as never,
          categoriesFlagged: [],
          confidence: 1,
          severity: "low",
          actionTaken: "allow",
          reasoning: [{ key: "screens.moderation.reasons.declined" }],
          severityAdjustment: 0,
          contextFactors: [],
          attributeToUser: true,
          classifierCostUsd: 0,
          trajectoryId: "traj-1",
          agentId: "agent-1",
          pipelineLatencyMs: 0,
          requestId: "req-1",
          timestamp: "2026-10-01T00:00:00.000Z",
        } as never)
      );
      const rows = await owner<{ o: unknown; action: string }>(
        "select classifier_output as o, action_taken::text as action from content_safety_audit where tenant_id = $1 and input_hash = 'h-t7'",
        [t.id]
      );
      expect(rows).toEqual([
        {
          o: { _omitted: { code: "request.json_number_out_of_range" } },
          action: "allow",
        },
      ]);
      const [read] = await t.run(() => store.getByInputHash("h-t7"));
      expect(read.classifierOutput).toBeUndefined();
      expect(read.classifierOutputNotKept).toEqual({
        code: "request.json_number_out_of_range",
      });
    });
  }
);

dbDescribe(
  "T7: a metric over the bound is dropped alone; the rest of its batch is written",
  () => {
    it("one event with 1e-30 among two: the other is stored, the drop counted", async () => {
      const sink = new PostgresMetricsSink();
      try {
        await t.run(async () => {
          sink.record({
            name: "t7.over",
            timestamp: new Date().toISOString(),
            values: { p: 1e-30 },
            tags: {},
          });
          sink.record({
            name: "t7.kept",
            timestamp: new Date().toISOString(),
            values: { ms: 1 },
            tags: {},
          });
          await sink.flush();
        });
        expect(sink.droppedOverStoredBound).toBe(1);
      } finally {
        sink.destroy();
      }
      const rows = await owner<{ name: string }>(
        "select name from ai_metrics where tenant_id = $1 and name like 't7.%' order by name",
        [t.id]
      );
      expect(rows).toEqual([{ name: "t7.kept" }]);
    });
  }
);

dbDescribe(
  "T7 (E2, CONFIRM CA3-2): an agent run's step over the bound after its work: recorded as not kept",
  () => {
    beforeEach(() => {
      resetAgentRegistry();
      registerAgent({
        id: "t7-analyst",
        name: "t7-analyst",
        description: "test",
        tools: [],
        budgetConfig: {
          maxCostPerTrajectory: 1,
          maxCostPerDay: 10,
          maxStepsPerTrajectory: 4,
        },
        effortTier: "standard",
      } as never);
    });

    it("a workflow outcome holding 1e-20: the run completes, its step carries outputNotRecorded, its budget is consumed", async () => {
      const consumed: number[] = [];
      class CountingBudget extends BudgetTracker {
        override async consume(...args: Parameters<BudgetTracker["consume"]>) {
          consumed.push(args[3]);
          return super.consume(...args);
        }
      }
      const store = new PostgresTrajectoryStore();
      const workflow: WorkflowFn = async () => ({
        action: "analyse",
        boundary: "commitment",
        input: { question: "q" },
        output: { probability: 1e-20 },
        costUsd: 0.25,
        continueExecution: false,
      });
      const result = await t.run(() =>
        executeAgent(
          "t7-analyst",
          "test",
          "platform",
          undefined,
          workflow,
          store,
          new CountingBudget(),
          new InMemoryEffectLedger()
        )
      );
      expect(result.finalStatus).toBe("completed");
      expect(consumed).toEqual([0.25]);
      const rec = await t.run(() => store.getById(result.trajectoryId));
      expect(rec?.trajectory.steps).toHaveLength(1);
      expect(rec?.trajectory.steps[0].output).toEqual({
        outputNotRecorded: { code: "request.json_number_out_of_range" },
      });
      expect(rec?.trajectory.steps[0].input).toEqual({ question: "q" });
    });
  }
);

dbDescribe(
  "T7: a tool's output holding a number out of range (the tool already ran): recorded as not kept",
  () => {
    it("the step is stored with outputNotRecorded naming the code — its own reason storable", async () => {
      const actor: AgentIdentity = {
        actorType: "agent",
        actorId: "agent:t7",
        agentRole: "a",
      };
      const store = new PostgresTrajectoryStore();
      const res = await t.run(async () => {
        const trajectoryId = (
          await store.create({ kind: "agent", id: "t7" }, "t", "platform")
        ).trajectory.trajectoryId;
        const r = await invokeTool({
          tool: {
            id: "score",
            name: "score",
            description: "",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            effects: ["stateWrite"],
            declaredRisk: "ordinary",
            execute: async () => ({ p: 1e-20 }),
          } as never,
          input: {},
          actor,
          sessionId: "s",
          trajectoryId,
          stepIndex: 0,
          trajectoryStore: store,
        } as never);
        return { r, rec: await store.getById(trajectoryId) };
      });
      expect(res.r.output).toEqual({ p: 1e-20 });
      expect(res.rec?.trajectory.steps[0].output).toMatchObject({
        outputNotRecorded: { code: "request.json_number_out_of_range" },
      });
    });
  }
);

dbDescribe(
  "T7 (E2, CONFIRM CA3-2): a pipeline step's input over the bound: refused before anything performs",
  () => {
    it("a stepInput holding 1e25: coded refusal, nothing performed, no ActionNotRecordedError", async () => {
      const actor: AgentIdentity = {
        actorType: "agent",
        actorId: "agent:t7",
        agentRole: "a",
      };
      const store = new PostgresTrajectoryStore();
      const performed: string[] = [];
      const err = await t.run(async () => {
        const trajectoryId = (
          await store.create({ kind: "agent", id: "t7" }, "t", "platform")
        ).trajectory.trajectoryId;
        const stateStore = new InMemoryActivityStateStore<unknown>();
        await stateStore.create("s", { v: 0 });
        return executeActionPipeline({
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
          stepInput: { amountWei: 1e25 },
          perform: async () => {
            performed.push("paid");
            return {};
          },
        } as never).then(
          () => null,
          (e: unknown) => e
        );
      });
      expect(performed).toEqual([]);
      expect(err).not.toBeInstanceOf(ActionNotRecordedError);
      expect(isJsonLimitError(err)).toBe(true);
      expect((err as { code: string }).code).toBe("request.json_number_out_of_range");
    });
  }
);
