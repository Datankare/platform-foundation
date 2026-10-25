/**
 * @jest-environment node
 */
/**
 * Review 12 on the replayed database — the reviewer's Postgres proofs, inverted, and the rest
 *
 *   M1  every append goes to the chain's tail (locked; resolved from any segment): a later small
 *       step never lands in an earlier segment; step_offset is every step before; concurrent
 *       appends across a rollover lose and misplace nothing.
 *   M2  a chain is capped (agent.trajectory_max_segments, coded); the tail is read alone, and a
 *       query can leave the steps out.
 *   L1  audited() inside a transaction that rolls back after a successful act: "rolled_back" is
 *       written after the rollback, sharing the attempt's id and naming the run it belongs to.
 *   L5  a tenant's compare-and-set against the platform default it inherits is serialised with a
 *       concurrent platform-default write (platform lock first, then the tenant's).
 *   L6  hostile chain rows are refused by the database; a cyclic chain written past the guard
 *       cannot hang the recovery.
 *   H2  an approved reset applies only onto the value it was requested against (stale otherwise).
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

import { PostgresTrajectoryStore } from "@/platform/agents/postgres-trajectory-store";
import {
  chainSteps,
  readTrajectoryChain,
  type TrajectoryRecord,
} from "@/platform/agents/trajectory-store";
import { withOwnerTx, withTenantTx } from "@/platform/data";
import { audited } from "@/platform/auth/audit";
import { withAuditCorrelation } from "@/platform/kernel/audit-correlation";
import { recoverStaleRuns } from "@/platform/admin/hold-expiry";
import { approveAndApply, requestApproval } from "@/platform/admin/config-approval";
import { withdrawSupersededHolds } from "@/platform/admin/hold-withdrawal";
import { PostgresProposalStore } from "@/platform/agents/postgres-proposal-store";
import { resetProposalStore, setProposalStore } from "@/platform/agents/proposal-store";
import {
  clearConfigCache,
  clearTenantConfig,
  setConfigWithHistory,
} from "@/platform/auth/platform-config";
import { TRAJECTORY_MAX_STEPS } from "@/platform/errors/json-limits";
import type { Step } from "@/platform/kernel";
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
const sql = (text: string, values: unknown[] = []) =>
  t.run(() => withTenantTx(async (tx) => (await tx.query(text, values)).rows));

const step = (i: number, size: number): Step => ({
  stepIndex: i,
  action: `s${i}`,
  input: { p: "x".repeat(size) },
  output: {},
  cost: 0,
  durationMs: 0,
  timestamp: new Date(0).toISOString(),
  boundary: "commitment",
});

/** Fill trajectory `id` with `n` small steps in one statement (as rv11's fullTrajectory). */
async function fill(id: string, n: number): Promise<void> {
  await sql(
    `update agent_trajectories
        set steps = (select jsonb_agg(jsonb_build_object('stepIndex', i - 1, 'action', 's' || (i - 1)))
                       from generate_series(1, $2::int) i)
      where id = $1::uuid`,
    [id, n]
  );
}

dbDescribe("R12-2 (M1) on Postgres: every append goes to the chain's tail", () => {
  it("a small step after a rollover lands in the tail, after the step before it", async () => {
    const store = new PostgresTrajectoryStore();
    const tr = await t.run(() => store.create({ kind: "agent", id: "a1" }, "t", "user"));
    const id = tr.trajectory.trajectoryId;
    for (let i = 0; i < 16; i++)
      await t.run(() => store.addStep(id, step(i, 1_040_000), { rollover: true }));
    const big = await t.run(() =>
      store.addStep(id, step(16, 1_040_000), { rollover: true })
    );
    expect(big!.trajectory.segment).toBe(2);
    expect(big!.trajectory.stepOffset).toBe(16);
    const small = await t.run(() => store.addStep(id, step(17, 10), { rollover: true }));
    expect(small!.trajectory.trajectoryId).toBe(big!.trajectory.trajectoryId);
    const chain = await t.run(() => readTrajectoryChain(store, id));
    expect(chainSteps(chain).map((s) => s.action)).toEqual(
      Array.from({ length: 18 }, (_, i) => `s${i}`)
    );
    expect(chain[0].trajectory.steps.length).toBe(16);
    expect(chain[1].trajectory.stepOffset).toBe(16);
  }, 120_000);

  it("concurrent appends across a rollover, through either segment's id: none lost, none misplaced", async () => {
    const store = new PostgresTrajectoryStore();
    const tr = await t.run(() => store.create({ kind: "agent", id: "a1" }, "t", "user"));
    const first = tr.trajectory.trajectoryId;
    await fill(first, TRAJECTORY_MAX_STEPS - 10);
    // 10 fit; the 11th rolls over; later ones go through the first segment's id or the second's.
    const seen: string[] = [first];
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        t
          .run(() =>
            store.addStep(seen[i % seen.length], step(TRAJECTORY_MAX_STEPS + i, 1), {
              rollover: true,
            })
          )
          .then((r) => {
            if (!seen.includes(r!.trajectory.trajectoryId))
              seen.push(r!.trajectory.trajectoryId);
            return r;
          })
      )
    );
    expect(results.every(Boolean)).toBe(true);
    const chain = await t.run(() => readTrajectoryChain(store, first));
    expect(chain.map((r) => r.trajectory.segment ?? 1)).toEqual([1, 2]);
    expect(chain[0].trajectory.steps).toHaveLength(TRAJECTORY_MAX_STEPS);
    expect(chain[1].trajectory.stepOffset).toBe(TRAJECTORY_MAX_STEPS);
    expect(chain[1].trajectory.steps).toHaveLength(20);
    expect(new Set(chainSteps(chain).map((s) => s.action)).size).toBe(
      TRAJECTORY_MAX_STEPS + 20
    );
  }, 120_000);
});

dbDescribe("R12-M2 on Postgres: a bounded chain, read a segment at a time", () => {
  it("the tail is read alone; a query can leave the steps out", async () => {
    const store = new PostgresTrajectoryStore();
    const tr = await t.run(() =>
      store.create({ kind: "session", id: `s_${t.id}` }, "t", "user")
    );
    const first = tr.trajectory.trajectoryId;
    await fill(first, TRAJECTORY_MAX_STEPS);
    const tail = await t.run(() =>
      store.addStep(first, step(9999, 5), { rollover: true })
    );
    const read: TrajectoryRecord | undefined = await t.run(() => store.chainTail(first));
    expect(read!.trajectory.trajectoryId).toBe(tail!.trajectory.trajectoryId);
    expect(read!.trajectory.steps).toHaveLength(1);
    expect(
      (await t.run(() => store.chainSegment(tail!.trajectory.trajectoryId, 1)))!
        .trajectory.trajectoryId
    ).toBe(first);
    expect(await t.run(() => store.chainSegment(first, 3))).toBeUndefined();
    const found = await t.run(() =>
      store.query({ subjectKind: "session", subjectId: `s_${t.id}`, withoutSteps: true })
    );
    expect(found.map((r) => r.trajectory.segment ?? 1)).toEqual([2, 1]);
    expect(found.every((r) => r.trajectory.steps.length === 0)).toBe(true);
  });

  it("past agent.trajectory_max_segments the step is refused, coded, nothing written", async () => {
    await withOwnerTx("operator", (tx) =>
      tx.query(
        "insert into tenant_config_overrides (tenant_id, key, value) values ($1::uuid, 'agent.trajectory_max_segments', '1')",
        [t.id]
      )
    );
    clearConfigCache();
    const store = new PostgresTrajectoryStore();
    const tr = await t.run(() => store.create({ kind: "agent", id: "cap" }, "t", "user"));
    const id = tr.trajectory.trajectoryId;
    await fill(id, TRAJECTORY_MAX_STEPS);
    await expect(
      t.run(() => store.addStep(id, step(1, 1), { rollover: true }))
    ).rejects.toMatchObject({
      code: "request.trajectory_chain_full",
      params: { max: 1 },
    });
    await expect(
      t.run(() => store.assertRoomForStep(id, { rollover: true }))
    ).rejects.toMatchObject({ code: "request.trajectory_chain_full" });
    expect(
      await sql(
        "select count(*)::int as n from agent_trajectories where chain_root_id = $1::uuid",
        [id]
      )
    ).toEqual([{ n: 1 }]);
    clearConfigCache();
  });
});

dbDescribe(
  "R12-5 (L1) audited() inside a transaction that rolls back after a successful act",
  () => {
    it("writes 'rolled_back' after the rollback — never 'attempted' alone — naming its run", async () => {
      const marker = `rv12-${t.id}`;
      await expect(
        t.run(() =>
          withTenantTx(async (tx) => {
            await withAuditCorrelation({ holdId: "hold-1", operationId: "op-1" }, () =>
              audited(
                { action: "admin_action", agent: "rv12", details: { type: marker } },
                async () => {
                  await tx.query("select 1");
                  return { success: true };
                }
              )
            );
            throw new Error("completion failed: the atomic run rolls back");
          })
        )
      ).rejects.toThrow(/rolls back/);
      const rows = await sql(
        `select details->>'outcome' as outcome, details->>'attemptId' as attempt,
              details->>'holdId' as hold, details->>'operationId' as op
         from audit_log where details->>'type' = $1 order by created_at, id`,
        [marker]
      );
      expect(rows.map((r) => r.outcome).sort()).toEqual(["attempted", "rolled_back"]);
      expect(new Set(rows.map((r) => r.attempt)).size).toBe(1);
      expect(rows.every((r) => r.attempt && r.hold === "hold-1" && r.op === "op-1")).toBe(
        true
      );
    });

    it("a transaction that commits leaves no 'rolled_back'", async () => {
      const marker = `rv12c-${t.id}`;
      await t.run(() =>
        withTenantTx(() =>
          audited(
            { action: "admin_action", agent: "rv12", details: { type: marker } },
            async () => ({
              success: true,
            })
          )
        )
      );
      const rows = await sql(
        "select details->>'outcome' as outcome from audit_log where details->>'type' = $1",
        [marker]
      );
      expect(rows).toEqual([{ outcome: "attempted" }]);
    });
  }
);

dbDescribe(
  "R12-L5 a tenant's compare-and-set is serialised with a platform-default write",
  () => {
    const KEY = () => `rv12.l5.${t.id}`;
    afterEach(async () => {
      await withOwnerTx("operator", async (tx) => {
        await tx.query("delete from platform_config_history where config_key = $1", [
          KEY(),
        ]);
        await tx.query("delete from tenant_config_overrides where key = $1", [KEY()]);
        await tx.query("delete from platform_config where key = $1", [KEY()]);
      });
      clearConfigCache();
    });

    it("a concurrent default change between its check and its write makes it stale", async () => {
      await withOwnerTx("operator", (tx) =>
        tx.query(
          `insert into platform_config
           (key, value, default_value, description, category, value_type, permission_tier, tenant_overridable)
         values ($1, '1', '1', 'rv12 race key', 'test', 'number', 'standard', true)`,
          [KEY()]
        )
      );
      const admin = await t.user("ops");
      // A platform-default write in flight: it holds the key's platform lock and has changed the
      // default, not yet committed.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const lockTaken = new Promise<void>((r) => (locked = r));
      const platformWrite = withOwnerTx("operator", async (tx) => {
        await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `platform_config:platform:${KEY()}`,
        ]);
        await tx.query("update platform_config set value = '2' where key = $1", [KEY()]);
        locked();
        await held;
      });
      await lockTaken;
      // The tenant's write, compare-and-set against the inherited default it read (1).
      let settled = false;
      const tenantWrite = t
        .run(() =>
          setConfigWithHistory(
            KEY(),
            7,
            admin,
            "rv12",
            "admin_ui",
            undefined,
            { scope: "tenant", operator: true },
            { expectPrevious: { value: 1 } }
          )
        )
        .finally(() => (settled = true));
      await new Promise((r) => setTimeout(r, 300));
      // It waits for the platform write (the platform lock is taken first, review 12 L5)…
      expect(settled).toBe(false);
      release();
      await platformWrite;
      // …and then finds the default it compared against changed: nothing written.
      expect(await tenantWrite).toMatchObject({ success: false, stale: true });
      expect(
        await withOwnerTx("operator", (tx) =>
          tx.query(
            "select count(*)::int as n from tenant_config_overrides where key = $1",
            [KEY()]
          )
        ).then((r) => r.rows)
      ).toEqual([{ n: 0 }]);
    });

    it("H2: an approved reset applies only onto the value it was requested against", async () => {
      await withOwnerTx("operator", async (tx) => {
        await tx.query(
          `insert into platform_config
           (key, value, default_value, description, category, value_type, permission_tier, tenant_overridable)
         values ($1, '1', '1', 'rv12 reset key', 'test', 'number', 'standard', true)`,
          [KEY()]
        );
        await tx.query(
          "insert into tenant_config_overrides (tenant_id, key, value) values ($1::uuid, $2, '5')",
          [t.id, KEY()]
        );
      });
      clearConfigCache();
      const admin = await t.user("ops");
      const clear = (expected: unknown) =>
        t.run(() =>
          clearTenantConfig(KEY(), admin, "rv12", true, {
            expectPrevious: { value: expected },
          })
        );
      expect(await clear(4)).toMatchObject({ success: false, stale: true });
      expect(await clear(5)).toMatchObject({ success: true });
      clearConfigCache();
      // Gone now: a reset requested against it is stale too.
      expect(await clear(5)).toMatchObject({ success: false, stale: true });
    });
  }
);

dbDescribe(
  "R12-L6 a hostile chain is refused; a cyclic one cannot hang the recovery",
  () => {
    const insert = (values: unknown[]) =>
      sql(
        `insert into agent_trajectories
         (id, subject_kind, subject_id, trigger, scope_type, status, steps, total_cost, version, segment, previous_trajectory_id, step_offset)
       values (gen_random_uuid(), 'agent', 'h', 't', 'platform', 'running', '[]', '{}', 1, $1::int, $2::uuid, $3::int)`,
        values
      );

    it("refuses a skipped segment, a wrong offset, another tenant's predecessor, a change of chain", async () => {
      const store = new PostgresTrajectoryStore();
      const root = (
        await t.run(() => store.create({ kind: "agent", id: "h" }, "t", "user"))
      ).trajectory.trajectoryId;
      await expect(insert([3, root, 0])).rejects.toThrow(/segment \+ 1/);
      await expect(insert([2, root, 9])).rejects.toThrow(/step_offset/);
      const other = await createTestTenant();
      const theirs = (
        await other.run(() => store.create({ kind: "agent", id: "h" }, "t", "user"))
      ).trajectory.trajectoryId;
      await expect(insert([2, theirs, 0])).rejects.toThrow(/predecessor must exist/);
      await insert([2, root, 0]);
      await expect(
        sql(
          "update agent_trajectories set previous_trajectory_id = null, segment = 1 where segment = 2"
        )
      ).rejects.toThrow(/never changes/);
      await expect(
        sql("update agent_trajectories set steps = '[1]'::jsonb where id = $1::uuid", [
          root,
        ])
      ).rejects.toThrow(/last segment/);
    });

    it("a cyclic chain written past the guard: the recovery's walk ends", async () => {
      const a = "aaaaaaaa-0000-4000-8000-" + t.id.slice(-12);
      const b = "bbbbbbbb-0000-4000-8000-" + t.id.slice(-12);
      await withOwnerTx("operator", async (tx) => {
        // The guard is the trigger; a superuser's replica mode skips it, as a hand-made row could.
        await tx.query("set local session_replication_role = replica");
        await tx.query(
          `insert into agent_trajectories
           (id, tenant_id, subject_kind, subject_id, trigger, scope_type, status, steps, total_cost, version, segment, previous_trajectory_id, step_offset, chain_root_id)
         values ($1::uuid, $3::uuid, 'agent', 'cyc', 't', 'platform', 'running', '[]', '{}', 1, 2, $2::uuid, 0, $1::uuid),
                ($2::uuid, $3::uuid, 'agent', 'cyc', 't', 'platform', 'running', '[]', '{}', 1, 3, $1::uuid, 0, $1::uuid)`,
          [a, b, t.id]
        );
        await tx.query(
          `insert into proposals (tenant_id, operation_id, session_id, trajectory_id, label, actor_id, actor_role, effective_risk, payload, status, updated_at)
         values ($1::uuid, 'op_cyc', 's', $2, 'held', 'agent:a1', 'agent', 'restricted', '{}', 'executing', now() - interval '1 hour')`,
          [t.id, a]
        );
      });
      const n = await withOwnerTx("platform-job", (tx) =>
        recoverStaleRuns(tx, 60, { tenantIds: [t.id] })
      );
      expect(n).toBe(1);
    }, 30_000);
  }
);

dbDescribe(
  "R12-H2 on Postgres: superseded and stale holds are withdrawn, audited",
  () => {
    const KEY = () => `rv12.h2.${t.id}`;
    beforeEach(async () => {
      await withOwnerTx("operator", (tx) =>
        tx.query(
          `insert into platform_config
           (key, value, default_value, description, category, value_type, permission_tier, tenant_overridable)
         values ($1, '1', '1', 'rv12 hold key', 'test', 'number', 'safety', true)`,
          [KEY()]
        )
      );
    });
    afterEach(async () => {
      resetProposalStore();
      await withOwnerTx("operator", async (tx) => {
        await tx.query("delete from config_pending_approvals where config_key = $1", [
          KEY(),
        ]);
        await tx.query("delete from platform_config_history where config_key = $1", [
          KEY(),
        ]);
        await tx.query("delete from platform_config where key = $1", [KEY()]);
      });
    });

    it("a reduction withdraws the key's pending approval and runtime hold, each audited", async () => {
      const requester = await t.user("req");
      const reducer = await t.user("red");
      const approval = await t.run(() =>
        requestApproval({
          configKey: KEY(),
          currentValue: 1,
          proposedValue: 2,
          requestedBy: requester,
          changeComment: "rv12",
          scope: "tenant",
        })
      );
      expect(approval.success).toBe(true);
      const proposals = new PostgresProposalStore();
      setProposalStore(proposals);
      const held = await t.run(() =>
        proposals.create({
          operationId: `op_${t.id}`,
          sessionId: "s",
          trajectoryId: "t",
          label: "update_config",
          actor: {
            actorType: "agent",
            actorId: "config-manager",
            agentRole: "config-manager",
          },
          effects: ["stateWrite"],
          effectiveRisk: "restricted",
          payload: { key: KEY(), value: 3, heldPrevious: { value: 1 } },
        })
      );
      const out = await t.run(() =>
        withdrawSupersededHolds(KEY(), reducer, "rv12 reduction", "tenant")
      );
      expect(out).toEqual({
        holds: [held.proposalId],
        approvals: [approval.record!.id],
        failed: [],
        remaining: 0,
        tenants: [],
      });
      expect((await t.run(() => proposals.getById(held.proposalId)))?.status).toBe(
        "rejected"
      );
      expect(
        await sql(
          "select status::text as status, reviewed_by from config_pending_approvals where id = $1::uuid",
          [approval.record!.id]
        )
      ).toEqual([{ status: "rejected", reviewed_by: reducer }]);
      const audit = await sql(
        `select details->>'source' as source, details->>'outcome' as outcome
         from audit_log where details->>'type' = 'approval_withdrawn' and details->>'key' = $1
        order by details->>'source', details->>'outcome'`,
        [KEY()]
      );
      expect(audit).toEqual([
        { source: "config-approval", outcome: null },
        { source: "runtime", outcome: "attempted" },
      ]);
    });

    it("a stale approved change is withdrawn, never reopened: approvals.stale", async () => {
      const requester = await t.user("req");
      const reviewer = await t.user("rev");
      const approval = await t.run(() =>
        requestApproval({
          configKey: KEY(),
          currentValue: 1,
          proposedValue: 2,
          requestedBy: requester,
          changeComment: "rv12",
          scope: "tenant",
        })
      );
      const out = await t.run(() =>
        approveAndApply(approval.record!.id, reviewer, "ok", async () => ({
          success: false,
          stale: true,
          error: "changed",
        }))
      );
      expect(out).toMatchObject({ success: false, errorCode: "approvals.stale" });
      expect(
        await sql(
          "select status::text as status, review_comment from config_pending_approvals where id = $1::uuid",
          [approval.record!.id]
        )
      ).toEqual([{ status: "rejected", review_comment: expect.stringMatching(/stale/) }]);
    });
  }
);
