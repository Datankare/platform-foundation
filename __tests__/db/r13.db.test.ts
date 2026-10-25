/**
 * @jest-environment node
 */
/**
 * Review 13 on the replayed database — the reviewer's Postgres proofs, inverted, and the rest
 *
 *   L1  a superseded-hold withdrawal is scoped: a TENANT-scope reduction withdraws only that
 *       tenant's tenant-scope holds and approvals — a pending change to the PLATFORM default stands
 *       — and a platform-scope reduction only platform-scope ones.
 *   L5' lock order platform → tenant under 40 concurrent mixed writes: no deadlock (kept).
 *   M1  an approved reset is compare-and-set on the tenant's value AND on the platform default it
 *       inherits: a default changed since the request makes it stale (approvals.stale), never a
 *       value no approver saw.
 *   L3  the chain guard locks the predecessor: a concurrent update of it is serialised with its
 *       continuation's insert (two connections), and a continued segment's step count never
 *       changes (no growth, no shrink).
 *   L6  ABA: a value changed and changed back before approval — the approval applies (its base is
 *       identical; documented, ADR-040 / runbook §5).
 *   L7  250 holds on one key are withdrawn in 3 batches: 3 audit records, all withdrawn.
 *   H2  (rv12-killswitch on Postgres) the kill switch, tenant and platform scope, with the real
 *       setConfigWithHistory: it withdraws the holds of its scope; a held change requested before
 *       it, approved after, is stale and changes nothing.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

import { withOwnerTx, withTenantTx } from "@/platform/data";
import { requestApproval } from "@/platform/admin/config-approval";
import { withdrawSupersededHolds } from "@/platform/admin/hold-withdrawal";
import { suspendAllAgents } from "@/platform/admin/agent-kill-switch";
import {
  handleApproveChange,
  handleUpdateConfig,
} from "@/platform/admin/config-handlers";
import { PostgresProposalStore } from "@/platform/agents/postgres-proposal-store";
import { resetProposalStore, setProposalStore } from "@/platform/agents/proposal-store";
import {
  clearConfigCache,
  clearTenantConfig,
  setConfigWithHistory,
} from "@/platform/auth/platform-config";
import { runWithTenant } from "@/platform/tenancy/context";
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
const owner = (text: string, values: unknown[] = []) =>
  withOwnerTx("operator", async (tx) => (await tx.query(text, values)).rows);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeKey(key: string, tier = "safety", value = "1"): Promise<void> {
  await owner(
    `insert into platform_config (key, value, default_value, description, category, value_type, permission_tier, tenant_overridable)
     values ($1, $2::jsonb, $2::jsonb, 'r13', 'test', 'number', $3, true)`,
    [key, value, tier]
  );
}
async function dropKey(key: string): Promise<void> {
  await withOwnerTx("operator", async (tx) => {
    await tx.query("delete from config_pending_approvals where config_key = $1", [key]);
    await tx.query("delete from platform_config_history where config_key = $1", [key]);
    await tx.query("delete from tenant_config_overrides where key = $1", [key]);
    await tx.query("delete from platform_config where key = $1", [key]);
  });
  clearConfigCache();
}
const hold = (
  store: PostgresProposalStore,
  key: string,
  i: number,
  payload: Record<string, unknown> = {}
) =>
  t.run(() =>
    store.create({
      operationId: `op_r13_${t.id}_${key}_${i}`,
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
      payload: { key, value: i, heldPrevious: { value: 1 }, ...payload },
    })
  );

dbDescribe(
  "R13-L1 a superseded-hold withdrawal withdraws only the reduced scope's holds",
  () => {
    const KEY = () => `r13.scope.${t.id}`;
    beforeEach(() => makeKey(KEY()));
    afterEach(async () => {
      resetProposalStore();
      await dropKey(KEY());
    });

    it("a TENANT-scope reduction leaves a pending PLATFORM-scope approval and runtime hold standing", async () => {
      const operator = await t.user("op");
      const reducer = await t.user("red");
      const platformApproval = await t.run(() =>
        requestApproval({
          configKey: KEY(),
          currentValue: 1,
          proposedValue: 2,
          requestedBy: operator,
          changeComment: "operator: change the platform default",
          scope: "platform",
        })
      );
      const tenantApproval = await t.run(() =>
        requestApproval({
          configKey: KEY(),
          currentValue: 1,
          proposedValue: 3,
          requestedBy: operator,
          changeComment: "the tenant's own value",
          scope: "tenant",
        })
      );
      expect(platformApproval.success && tenantApproval.success).toBe(true);
      const proposals = new PostgresProposalStore();
      setProposalStore(proposals);
      const platformHold = await hold(proposals, KEY(), 1, { scope: "platform" });
      const tenantHold = await hold(proposals, KEY(), 2); // shared deployment: the tenant's value
      const out = await t.run(() =>
        withdrawSupersededHolds(KEY(), reducer, "a power reduction was applied", "tenant")
      );
      expect(out).toEqual({
        holds: [tenantHold.proposalId],
        approvals: [tenantApproval.record!.id],
        failed: [],
        remaining: 0,
        tenants: [],
      });
      expect(
        await sql(
          "select scope, status::text as status from config_pending_approvals where config_key = $1 order by scope",
          [KEY()]
        )
      ).toEqual([
        { scope: "platform", status: "pending" },
        { scope: "tenant", status: "rejected" },
      ]);
      expect(
        (await t.run(() => proposals.getById(platformHold.proposalId)))?.status
      ).toBe("proposed");
      // And a platform-scope reduction withdraws the platform-scope ones only.
      const again = await t.run(() =>
        withdrawSupersededHolds(KEY(), reducer, "the default was reduced", "platform")
      );
      expect(again).toEqual({
        holds: [platformHold.proposalId],
        approvals: [platformApproval.record!.id],
        failed: [],
        remaining: 0,
        tenants: [],
      });
      const records = await sql(
        `select details->>'source' as source, details->>'scope' as scope, details->'holdIds' as ids
         from audit_log where details->>'type' = 'approval_withdrawn' and details->>'key' = $1
          and details->>'outcome' is distinct from 'failed'
        order by details->>'scope', details->>'source'`,
        [KEY()]
      );
      expect(records).toEqual([
        {
          source: "config-approval",
          scope: "platform",
          ids: [platformApproval.record!.id],
        },
        { source: "runtime", scope: "platform", ids: [platformHold.proposalId] },
        { source: "config-approval", scope: "tenant", ids: [tenantApproval.record!.id] },
        { source: "runtime", scope: "tenant", ids: [tenantHold.proposalId] },
      ]);
    });
  }
);

dbDescribe("R13 lock order platform → tenant under concurrent mixed writes", () => {
  const KEY = () => `r13.locks.${t.id}`;
  afterEach(() => dropKey(KEY()));
  it("40 concurrent tenant and platform writes of one key: no deadlock, all settle", async () => {
    await makeKey(KEY(), "standard");
    const admin = await t.user("ops");
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        t.run(() =>
          setConfigWithHistory(KEY(), i + 2, admin, "r13", "admin_ui", undefined, {
            scope: i % 2 ? "tenant" : "platform",
            operator: true,
          })
        )
      )
    );
    expect(results.filter((r) => !r.success)).toEqual([]);
  }, 60_000);
});

dbDescribe("R13-M1 an approved reset is compare-and-set on what it resets TO", () => {
  const KEY = () => `r13.reset.${t.id}`;
  beforeEach(async () => {
    await makeKey(KEY());
    await owner(
      "insert into tenant_config_overrides (tenant_id, key, value) values ($1::uuid, $2, '0')",
      [t.id, KEY()]
    );
  });
  afterEach(() => dropKey(KEY()));
  const effective = async () =>
    (
      await sql(
        "select coalesce((select value from tenant_config_overrides where key = $1), (select value from platform_config where key = $1)) as v",
        [KEY()]
      )
    )[0].v;

  it("the default changed after the request: stale, the tenant keeps its value", async () => {
    // Requested: tenant 0 → inherit 1. Meanwhile the platform default moves to 99.
    await owner("update platform_config set value = '99' where key = $1", [KEY()]);
    clearConfigCache();
    const admin = await t.user("rev");
    const r = await t.run(() =>
      clearTenantConfig(KEY(), admin, "Approved reset", true, {
        expectPrevious: { value: 0 },
        expectInherited: { value: 1 },
      })
    );
    expect(r).toMatchObject({ success: false, stale: true });
    clearConfigCache();
    expect(await effective()).toBe(0);
  });

  it("through the approval: approvals.stale, the approval withdrawn, nothing changed", async () => {
    const requester = await t.user("req");
    const reviewer = await t.user("rev");
    const approval = await t.run(() =>
      requestApproval({
        configKey: KEY(),
        currentValue: 0,
        proposedValue: 1, // the default it would inherit, recorded at request time
        requestedBy: requester,
        changeComment: "back to the default",
        scope: "tenant",
        action: "reset",
      })
    );
    await owner("update platform_config set value = '99' where key = $1", [KEY()]);
    clearConfigCache();
    const shared = { tenantId: t.id, mode: "shared" as const };
    const r = await runWithTenant(shared, () =>
      handleApproveChange({
        approvalId: approval.record!.id,
        reviewerId: reviewer,
        reviewComment: "ok",
        reviewerIsOperator: true,
      })
    );
    expect(r.data).toMatchObject({ success: false, errorCode: "approvals.stale" });
    expect(
      await sql(
        "select status::text as status from config_pending_approvals where id = $1::uuid",
        [approval.record!.id]
      )
    ).toEqual([{ status: "rejected" }]);
    clearConfigCache();
    expect(await effective()).toBe(0);
  });

  it("the default unchanged: the reset applies", async () => {
    const admin = await t.user("rev");
    const r = await t.run(() =>
      clearTenantConfig(KEY(), admin, "Approved reset", true, {
        expectPrevious: { value: 0 },
        expectInherited: { value: 1 },
      })
    );
    expect(r).toMatchObject({ success: true });
    clearConfigCache();
    expect(await effective()).toBe(1);
  });
});

dbDescribe(
  "R13-L3 the chain guard serialises a continuation's insert with its predecessor's update",
  () => {
    const insertRoot = async () =>
      (
        await sql(
          `insert into agent_trajectories (tenant_id, trigger, subject_kind, subject_id, steps)
         values ($1::uuid, 't', 'agent', 'r13race', '[1]'::jsonb) returning id`,
          [t.id]
        )
      )[0].id as string;
    const continuation = (
      tx: { query: (s: string, v: unknown[]) => Promise<unknown> },
      root: string,
      offset: number
    ) =>
      tx.query(
        `insert into agent_trajectories (tenant_id, trigger, subject_kind, subject_id, steps, segment, previous_trajectory_id, step_offset)
       values ($1::uuid, 't', 'agent', 'r13race', '[]'::jsonb, 2, $2::uuid, $3::int)`,
        [t.id, root, offset]
      );
    const grow = (
      tx: { query: (s: string, v: unknown[]) => Promise<unknown> },
      root: string
    ) =>
      tx.query(
        "update agent_trajectories set steps = steps || '[2]'::jsonb where id = $1::uuid",
        [root]
      );

    it("the insert first: the predecessor's update waits for it, then is refused", async () => {
      const root = await insertRoot();
      let inserted!: () => void;
      const insertedP = new Promise<void>((r) => (inserted = r));
      let release!: () => void;
      const releaseP = new Promise<void>((r) => (release = r));
      const a = t.run(() =>
        withTenantTx(async (tx) => {
          await continuation(tx, root, 1);
          inserted();
          await releaseP;
        })
      );
      await insertedP;
      let bSettled = false;
      const b = t
        .run(() => withTenantTx((tx) => grow(tx, root)))
        .then(
          () => "grew",
          (e: Error) => e.message
        )
        .finally(() => {
          bSettled = true;
        });
      await sleep(400);
      expect(bSettled).toBe(false); // waiting on the continuation's lock
      release();
      await a;
      expect(await b).toMatch(/keeps its step count/);
      expect(
        await sql(
          "select segment, step_offset, jsonb_array_length(steps) as n from agent_trajectories where chain_root_id = $1::uuid order by segment",
          [root]
        )
      ).toEqual([
        { segment: 1, step_offset: 0, n: 1 },
        { segment: 2, step_offset: 1, n: 0 },
      ]);
    });

    it("the update first: the insert waits for it, and its stale offset is refused", async () => {
      const root = await insertRoot();
      let grown!: () => void;
      const grownP = new Promise<void>((r) => (grown = r));
      let release!: () => void;
      const releaseP = new Promise<void>((r) => (release = r));
      const b = t.run(() =>
        withTenantTx(async (tx) => {
          await grow(tx, root);
          grown();
          await releaseP;
        })
      );
      await grownP;
      let aSettled = false;
      const a = t
        .run(() => withTenantTx((tx) => continuation(tx, root, 1))) // offset read before the growth
        .then(
          () => "inserted",
          (e: Error) => e.message
        )
        .finally(() => {
          aSettled = true;
        });
      await sleep(400);
      expect(aSettled).toBe(false); // waiting on the update's row lock
      release();
      await b;
      expect(await a).toMatch(/step_offset is the steps before it/);
      // With the offset the predecessor now has, the continuation is accepted.
      await t.run(() => withTenantTx((tx) => continuation(tx, root, 2)));
    });

    it("a continued segment's steps neither grow nor shrink; a same-length rewrite is allowed", async () => {
      const root = await insertRoot();
      await t.run(() => withTenantTx((tx) => continuation(tx, root, 1)));
      await expect(
        sql("update agent_trajectories set steps = '[]'::jsonb where id = $1::uuid", [
          root,
        ])
      ).rejects.toThrow(/keeps its step count/);
      await expect(
        sql("update agent_trajectories set steps = '[1, 2]'::jsonb where id = $1::uuid", [
          root,
        ])
      ).rejects.toThrow(/keeps its step count/);
      await sql(
        "update agent_trajectories set steps = '[\"erased\"]'::jsonb where id = $1::uuid",
        [root]
      );
    });
  }
);

dbDescribe("R13-L6 ABA: a value changed and changed back before approval", () => {
  const KEY = () => `r13.aba.${t.id}`;
  beforeEach(() => makeKey(KEY(), "safety", "1"));
  afterEach(() => dropKey(KEY()));
  it("the approval applies: its base value is identical (documented, acceptable)", async () => {
    const requester = await t.user("req");
    const reviewer = await t.user("rev");
    const admin = await t.user("adm");
    const approval = await t.run(() =>
      requestApproval({
        configKey: KEY(),
        currentValue: 1,
        proposedValue: 5,
        requestedBy: requester,
        changeComment: "r13 aba",
        scope: "tenant",
      })
    );
    const target = { scope: "tenant" as const, operator: true };
    for (const v of [2, 1]) {
      expect(
        await t.run(() =>
          setConfigWithHistory(KEY(), v, admin, "aba", "admin_ui", undefined, target)
        )
      ).toMatchObject({ success: true });
    }
    clearConfigCache();
    const r = await runWithTenant({ tenantId: t.id, mode: "shared" }, () =>
      handleApproveChange({
        approvalId: approval.record!.id,
        reviewerId: reviewer,
        reviewComment: "ok",
        reviewerIsOperator: true,
      })
    );
    expect(r.data).toMatchObject({ approved: true, applied: true });
    clearConfigCache();
    expect(
      (await sql("select value from tenant_config_overrides where key = $1", [KEY()]))[0]
        .value
    ).toBe(5);
  });
});

dbDescribe("R13-L7 withdrawing many holds is bounded", () => {
  const KEY = () => `r13.many.${t.id}`;
  beforeEach(() => makeKey(KEY()));
  afterEach(async () => {
    resetProposalStore();
    await dropKey(KEY());
  });
  it("250 holds: withdrawn in 3 batches, one audit record each", async () => {
    const proposals = new PostgresProposalStore();
    setProposalStore(proposals);
    for (let i = 0; i < 250; i++) await hold(proposals, KEY(), i);
    const reducer = await t.user("red");
    const started = Date.now();
    const out = await t.run(() =>
      withdrawSupersededHolds(KEY(), reducer, "many", "tenant")
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out.holds).toHaveLength(250);
    expect(
      await sql(
        `select count(*)::int as n from proposals where payload->>'key' = $1 and status <> 'rejected'`,
        [KEY()]
      )
    ).toEqual([{ n: 0 }]);
    const records = await sql(
      `select (details->>'count')::int as n from audit_log
        where details->>'type' = 'approval_withdrawn' and details->>'key' = $1 and details->>'source' = 'runtime'
          and details->>'outcome' = 'attempted'`,
      [KEY()]
    );
    expect(records.map((r) => r.n).sort()).toEqual([100, 100, 50].sort());
  }, 60_000);
});

dbDescribe("R13 the kill switch on Postgres (rv12 H2): tenant and platform scope", () => {
  const KEY = "agent.trusted_agents";
  const REGISTRY = [
    ["agent:a", { owner: "o", scopes: ["x", "y"], status: "active", maxTokenTtl: 300 }],
    ["agent:b", { owner: "o", scopes: ["x"], status: "active", maxTokenTtl: 300 }],
  ];
  const statuses = (v: unknown) =>
    (v as [string, { status: string }][]).map(([, r]) => r.status);
  const opAdmin = async () => ({
    userId: await t.user("operator"),
    sub: "s",
    roleName: "super_admin",
    permissions: ["platform_operate", "config_manage_safety"],
  });
  afterEach(() => {
    resetProposalStore();
    clearConfigCache();
  });

  it("tenant scope: suspends the tenant's registry, withdraws its tenant-scope holds, not the platform's; an older held change is stale", async () => {
    const admin = await opAdmin();
    await owner(
      "insert into tenant_config_overrides (tenant_id, key, value) values ($1::uuid, $2, $3::jsonb)",
      [t.id, KEY, JSON.stringify(REGISTRY)]
    );
    const proposals = new PostgresProposalStore();
    setProposalStore(proposals);
    const widened = [
      REGISTRY[0],
      ["agent:b", { ...(REGISTRY[1][1] as object), scopes: ["x", "z"] }],
    ];
    const tenantHold = await hold(proposals, KEY, 1, {
      value: widened,
      heldPrevious: { value: REGISTRY },
    });
    const platformHold = await hold(proposals, KEY, 2, {
      value: widened,
      scope: "platform",
      heldPrevious: { value: REGISTRY },
    });
    const outcome = await runWithTenant({ tenantId: t.id, mode: "shared" }, () =>
      suspendAllAgents(admin, "incident r13")
    );
    expect(outcome).toEqual({
      ok: true,
      suspended: ["agent:a", "agent:b"],
      withdrawn: [tenantHold.proposalId],
    });
    const [row] = await sql("select value from tenant_config_overrides where key = $1", [
      KEY,
    ]);
    expect(statuses(row.value)).toEqual(["suspended", "suspended"]);
    expect((await t.run(() => proposals.getById(platformHold.proposalId)))?.status).toBe(
      "proposed"
    );
    // The older change, approved anyway (its withdrawal had not landed): stale, nothing applied.
    clearConfigCache();
    const r = await runWithTenant({ tenantId: t.id, mode: "shared" }, () =>
      handleUpdateConfig({
        key: KEY,
        value: widened,
        changeComment: "older scope change",
        actorId: admin.userId,
        actorIsOperator: true,
        confirmed: true,
        heldPrevious: { value: REGISTRY },
      })
    );
    expect(r.data).toMatchObject({ applied: false, stale: true });
    const [after] = await sql(
      "select value from tenant_config_overrides where key = $1",
      [KEY]
    );
    expect(statuses(after.value)).toEqual(["suspended", "suspended"]);
    // Audited attempted → succeeded, with history.
    expect(
      await sql(
        `select details->>'outcome' as outcome from audit_log
          where details->>'type' = 'agents_emergency_suspended' order by created_at`
      )
    ).toEqual([{ outcome: "attempted" }, { outcome: "succeeded" }]);
    // Run again: nothing to write, the invalidation published again (L2).
    expect(
      await runWithTenant({ tenantId: t.id, mode: "shared" }, () =>
        suspendAllAgents(admin, "again")
      )
    ).toEqual({ ok: true, suspended: [], republished: true });
  });

  it("platform scope (single-tenant deployment): suspends the platform default, withdraws platform-scope holds; restored after", async () => {
    const admin = await opAdmin();
    const [{ value: original }] = await owner(
      "select value from platform_config where key = $1",
      [KEY]
    );
    await owner("update platform_config set value = $2::jsonb where key = $1", [
      KEY,
      JSON.stringify(REGISTRY),
    ]);
    clearConfigCache();
    try {
      const proposals = new PostgresProposalStore();
      setProposalStore(proposals);
      const single = { tenantId: t.id, mode: "single" as const };
      const platformHold = await runWithTenant(single, () =>
        proposals.create({
          operationId: `op_r13_ks_${t.id}`,
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
          payload: { key: KEY, value: [], heldPrevious: { value: REGISTRY } },
        })
      );
      const outcome = await runWithTenant(single, () =>
        suspendAllAgents(admin, "incident")
      );
      expect(outcome).toEqual({
        ok: true,
        suspended: ["agent:a", "agent:b"],
        withdrawn: [platformHold.proposalId],
      });
      const [row] = await owner("select value from platform_config where key = $1", [
        KEY,
      ]);
      expect(statuses(row.value)).toEqual(["suspended", "suspended"]);
      // A compare-and-set against the registry as it was: refused.
      const stale = await runWithTenant(single, () =>
        setConfigWithHistory(
          KEY,
          REGISTRY,
          admin.userId,
          "older",
          "admin_ui",
          undefined,
          {
            scope: "platform",
            operator: true,
          },
          { expectPrevious: { value: REGISTRY } }
        )
      );
      expect(stale).toMatchObject({ success: false, stale: true });
    } finally {
      await owner("update platform_config set value = $2::jsonb where key = $1", [
        KEY,
        JSON.stringify(original),
      ]);
      await owner(
        "delete from platform_config_history where config_key = $1 and changed_by = $2::uuid",
        [KEY, admin.userId]
      );
      clearConfigCache();
    }
  });
});
