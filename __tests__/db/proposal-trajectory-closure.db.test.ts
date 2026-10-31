/**
 * @jest-environment node
 */
/**
 * __tests__/db/proposal-trajectory-closure.db.test.ts — no hold ends with its trajectory left open
 * (TASK-193, audit B-2)
 *
 * The proposal × trajectory matrix, on the replayed Postgres: for every path that ends a hold —
 * each decision on the approvals page, the agent-facing decisions, the expiry and recovery
 * sweeps, the withdrawal of superseded holds, erasure — and each open status its trajectory can
 * be in (running, paused, awaiting_retry, indeterminate), a hold is seeded in the state the path
 * acts on, the path runs, and the pair is read back. No pair may be a hold that is over (rejected,
 * superseded, executed) with its trajectory still open; a hold still open (approved again, or
 * undecided) may keep its trajectory waiting, but never `running` or `paused` as if nothing had
 * happened.
 *
 * Before: only a plain rejection ended the trajectory. A withdrawal, a mark-executed, an expiry,
 * a supersede, an approved run and an erasure all left it paused, running or awaiting_retry for
 * good (the playform-dev process-content workflow stuck in awaiting_retry is the audit's case).
 */

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";
import { withOwnerTx, withTenantTx } from "@/platform/data";
import {
  setTrajectoryStore,
  type TrajectoryStore,
} from "@/platform/agents/trajectory-store";
import { PostgresTrajectoryStore } from "@/platform/agents/postgres-trajectory-store";
import { setProposalStore, type ProposalStore } from "@/platform/agents/proposal-store";
import { PostgresProposalStore } from "@/platform/agents/postgres-proposal-store";
import {
  rejectHeldAction,
  resolveUndecidedHeldAction,
  withdrawHeldAction,
} from "@/platform/agents/gating";
import { decideApproval } from "@/platform/admin/approval-decision";
import type { HoldAuthority, HoldResumeResult } from "@/platform/admin/hold-authority";
import { expireStaleApprovals } from "@/platform/admin/config-approval";
import { withdrawSupersededHolds } from "@/platform/admin/hold-withdrawal";
import { eraseUserData } from "@/platform/auth/user-data";
import { alertWaitingUndecided } from "@/platform/admin/hold-expiry";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";

const mockAlerts: { name: string; count?: number }[] = [];
jest.mock("@/platform/observability/alert", () => ({
  raiseAlert: (a: { name: string; count?: number }) => mockAlerts.push(a),
}));

const OPEN = ["running", "paused", "awaiting_retry", "indeterminate"] as const;
const OVER = new Set(["rejected", "superseded", "executed"]);
const FINISHED = new Set(["completed", "failed"]);

const owner = <R extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  withOwnerTx("tenant-lifecycle", (tx) => tx.query<R>(sql, values));

let t: TestTenant;
let previousTrajectories: TrajectoryStore;
let previousProposals: ProposalStore;
let resumeAs: HoldResumeResult["kind"] = "applied";

/** A test authority: owns `dbtest` holds; its run answers what the case sets. */
const AUTHORITY: HoldAuthority = {
  name: "dbtest",
  owns: (p) => p.label === "dbtest",
  requiredPermission: async () => "admin_manage_users",
  async resume(proposal) {
    if (resumeAs === "applied") {
      // What the pipeline's run records when it takes effect: the approval used.
      await owner(
        "update proposals set status = 'executed', updated_at = now() where id = $1::uuid",
        [proposal.proposalId]
      );
      return { kind: "applied" };
    }
    if (resumeAs === "stale") {
      return { kind: "stale", error: "approvals.stale: changed" };
    }
    return { kind: "failed", error: "it could not run", approvalKept: true };
  },
};

const ADMIN: { -readonly [K in keyof VerifiedAdmin]: VerifiedAdmin[K] } = {
  userId: randomUUID(),
  sub: randomUUID(),
  roleName: "super_admin",
  permissions: ["admin_manage_users", "config_manage_safety", "config_manage_standard"],
};

interface Seeded {
  readonly proposalId: string;
  readonly trajectoryId: string;
}

/** A trajectory in `trajectory` and a hold on it in `proposal` (with its decision fields). */
async function seed(
  trajectory: string,
  proposal: string,
  opts: {
    readonly label?: string;
    readonly payload?: Record<string, unknown>;
    readonly age?: string;
    readonly trigger?: string;
    /** Continue this trajectory: the new one is its chain's next segment. */
    readonly after?: string;
  } = {}
): Promise<Seeded> {
  const age = opts.age ?? "1 hour";
  const { rows: tr } = await owner<{ id: string }>(
    opts.after
      ? `insert into agent_trajectories (tenant_id, trigger, status, subject_kind, subject_id, updated_at,
                                         previous_trajectory_id, segment, step_offset)
         select $1, $4, $2::trajectory_status, 'agent', 'dbtest-agent', now() - $3::interval,
                p.id, p.segment + 1, p.step_offset + jsonb_array_length(p.steps)
           from agent_trajectories p where p.id = $5::uuid
         returning id`
      : `insert into agent_trajectories (tenant_id, trigger, status, subject_kind, subject_id, updated_at)
         values ($1, $4, $2::trajectory_status, 'agent', 'dbtest-agent', now() - $3::interval)
         returning id`,
    [
      t.id,
      trajectory,
      age,
      opts.trigger ?? "dbtest-closure",
      ...(opts.after ? [opts.after] : []),
    ]
  );
  const { rows: pr } = await owner<{ id: string }>(
    `insert into proposals (tenant_id, operation_id, session_id, trajectory_id, label, status,
                            actor_id, actor_role, effective_risk, payload, actor_identity,
                            created_at, decided_at, decided_by, updated_at)
     values ($1, $2, 'sess-a', $3, $4, $5, 'dbtest-agent', 'agent', 'restricted', $6::jsonb,
             jsonb_build_object('actorType', 'agent', 'actorId', 'dbtest-agent',
                                'onBehalfOf', $7::text, 'sessionId', 'sess-a'),
             now() - $8::interval,
             case when $5 in ('approved', 'executing', 'indeterminate') then now() - $8::interval end,
             case when $5 in ('approved', 'executing', 'indeterminate') then 'someone' end,
             now() - $8::interval)
     returning id`,
    [
      t.id,
      `op-${randomUUID()}`,
      tr[0].id,
      opts.label ?? "dbtest",
      proposal,
      JSON.stringify(opts.payload ?? {}),
      randomUUID(),
      age,
    ]
  );
  return { proposalId: pr[0].id, trajectoryId: tr[0].id };
}

async function pairOf(s: Seeded): Promise<{ proposal: string; trajectory: string }> {
  const { rows } = await owner<{ proposal: string; trajectory: string }>(
    `select p.status as proposal, t.status::text as trajectory
       from proposals p join agent_trajectories t on t.id::text = p.trajectory_id
      where p.id = $1::uuid`,
    [s.proposalId]
  );
  return rows[0];
}

const decide = (id: string, body: Record<string, unknown>) =>
  t.run(() =>
    decideApproval(
      new NextRequest(`http://localhost/api/admin/approvals/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "runtime", ...body }),
      }),
      ADMIN,
      id,
      [AUTHORITY]
    )
  );

/** A path that ends a hold: the state it acts on, and how it is driven. */
interface Path {
  readonly name: string;
  readonly from: string;
  readonly age?: string;
  readonly label?: string;
  readonly payload?: Record<string, unknown>;
  readonly before?: () => void;
  run(s: Seeded): Promise<unknown>;
}

const PATHS: readonly Path[] = [
  {
    name: "gating: rejectHeldAction",
    from: "proposed",
    run: (s) =>
      t.run(() => rejectHeldAction({ proposalId: s.proposalId, decidedBy: "x" })),
  },
  {
    name: "gating: withdrawHeldAction",
    from: "approved",
    run: (s) =>
      t.run(() => withdrawHeldAction({ proposalId: s.proposalId, decidedBy: "x" })),
  },
  {
    name: "gating: resolveUndecidedHeldAction (executed)",
    from: "indeterminate",
    run: (s) =>
      t.run(() =>
        resolveUndecidedHeldAction({
          proposalId: s.proposalId,
          decidedBy: "x",
          resolution: "executed",
        })
      ),
  },
  {
    name: "gating: resolveUndecidedHeldAction (approved again)",
    from: "indeterminate",
    run: (s) =>
      t.run(() =>
        resolveUndecidedHeldAction({
          proposalId: s.proposalId,
          decidedBy: "x",
          resolution: "approved",
        })
      ),
  },
  {
    name: "approvals page: reject an approved hold (withdraw)",
    from: "approved",
    run: (s) => decide(s.proposalId, { decision: "reject" }),
  },
  {
    name: "approvals page: reject a proposed hold",
    from: "proposed",
    run: (s) => decide(s.proposalId, { decision: "reject" }),
  },
  {
    name: "approvals page: mark an undecided run executed",
    from: "indeterminate",
    run: (s) => decide(s.proposalId, { decision: "mark_executed" }),
  },
  {
    name: "approvals page: approve, the run applied",
    from: "proposed",
    before: () => {
      resumeAs = "applied";
    },
    run: (s) => decide(s.proposalId, { decision: "approve" }),
  },
  {
    name: "approvals page: approve, the run stale (withdrawn)",
    from: "proposed",
    before: () => {
      resumeAs = "stale";
    },
    run: (s) => decide(s.proposalId, { decision: "approve" }),
  },
  {
    name: "approvals page: approve, the run failed (approval kept)",
    from: "proposed",
    before: () => {
      resumeAs = "failed";
    },
    run: (s) => decide(s.proposalId, { decision: "approve" }),
  },
  {
    name: "approvals page: a decision on an approval past its period (withdrawn)",
    from: "approved",
    age: "30 days",
    run: (s) => decide(s.proposalId, { decision: "approve" }),
  },
  {
    name: "approvals page: a decision on a hold never decided past its period (withdrawn)",
    from: "proposed",
    age: "30 days",
    run: (s) => decide(s.proposalId, { decision: "approve" }),
  },
  {
    name: "config.expire-approvals: an unused approval past its period",
    from: "approved",
    age: "30 days",
    run: () => expireStaleApprovals({ tenantIds: [t.id] }),
  },
  {
    name: "config.expire-approvals: a hold never decided past its period",
    from: "proposed",
    age: "30 days",
    run: () => expireStaleApprovals({ tenantIds: [t.id] }),
  },
  {
    name: "config.expire-approvals: a run that never ended (recovered)",
    from: "executing",
    run: () => expireStaleApprovals({ tenantIds: [t.id] }),
  },
  {
    name: "a reduced key withdraws its holds (supersede)",
    from: "proposed",
    label: "update_config",
    payload: { key: "agent.trusted_agents", scope: "tenant", value: [] },
    run: () =>
      t.run(() =>
        withdrawSupersededHolds(
          "agent.trusted_agents",
          "system:dbtest",
          "dbtest",
          "tenant"
        )
      ),
  },
];

dbDescribe("no hold ends with its trajectory left open (TASK-193, B-2)", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    t = await createTestTenant();
    ADMIN.userId = await t.user("approver");
    previousTrajectories = setTrajectoryStore(new PostgresTrajectoryStore());
    previousProposals = setProposalStore(new PostgresProposalStore());
  });

  afterAll(async () => {
    await dropTestTenants();
    setTrajectoryStore(previousTrajectories);
    setProposalStore(previousProposals);
    await disconnectTestDatabase();
  });

  const cases = PATHS.flatMap((p) => OPEN.map((status) => [p.name, status, p] as const));

  it.each(cases)("%s, its trajectory %s", async (_name, trajectory, path) => {
    path.before?.();
    const s = await seed(trajectory, path.from, {
      label: path.label,
      payload: path.payload,
      age: path.age,
    });
    await path.run(s);
    const after = await pairOf(s);
    if (!after) return; // the hold was deleted (erasure): its trajectory is checked below
    if (OVER.has(after.proposal)) {
      expect([after.proposal, after.trajectory, FINISHED.has(after.trajectory)]).toEqual([
        after.proposal,
        after.trajectory,
        true,
      ]);
    } else {
      // Still open (approved again, undecided): it may wait, never as if nothing happened.
      expect([after.proposal, after.trajectory]).not.toEqual([after.proposal, "paused"]);
    }
  });

  const statusOf = async (id: string) =>
    (
      await owner<{ status: string }>(
        "select status::text from agent_trajectories where id = $1::uuid",
        [id]
      )
    ).rows[0].status;

  it("a recovered run whose step was recorded completes its trajectory — not a workflow's (round 1, L1)", async () => {
    const record = async (s: Seeded) => {
      const { rows } = await owner<{ operation_id: string }>(
        "select operation_id from proposals where id = $1::uuid",
        [s.proposalId]
      );
      await owner(
        `update agent_trajectories
            set steps = jsonb_build_array(jsonb_build_object('stepIndex', 0, 'action', 'dbtest',
                          'boundary', 'commitment', 'operationId', $2::text))
          where id = $1::uuid`,
        [s.trajectoryId, rows[0].operation_id]
      );
    };
    const request = await seed("running", "executing");
    const workflow = await seed("running", "executing", { trigger: "analyze" });
    await record(request);
    await record(workflow);
    await expireStaleApprovals({ tenantIds: [t.id] });
    expect(await pairOf(request)).toEqual({
      proposal: "executed",
      trajectory: "completed",
    });
    // A workflow's: its user continues it past the step (M1).
    expect(await pairOf(workflow)).toEqual({
      proposal: "executed",
      trajectory: "running",
    });
  });

  it("an expiry leaves the chain open while another segment's hold is open (round 1, L4)", async () => {
    const first = await seed("paused", "proposed", { age: "30 days" });
    // The chain continued into a second segment, with a hold of its own still open.
    const second = await seed("paused", "proposed", { after: first.trajectoryId });
    await expireStaleApprovals({ tenantIds: [t.id] });
    expect((await pairOf(first)).proposal).toBe("rejected");
    expect((await pairOf(second)).proposal).toBe("proposed");
    expect(await statusOf(first.trajectoryId)).toBe("paused");
    expect(await statusOf(second.trajectoryId)).toBe("paused");
  });

  it("an undecided run is alerted once, then reminded at most daily (round 1, L3)", async () => {
    // Earlier cases' undecided runs are reminded now, so only this run's alerts count.
    const sweep = () =>
      withOwnerTx("tenant-lifecycle", (tx) =>
        alertWaitingUndecided(tx, { tenantIds: [t.id] })
      );
    await sweep();
    const s = await seed("indeterminate", "indeterminate");
    mockAlerts.length = 0;
    expect(await sweep()).toBeGreaterThan(0);
    expect(mockAlerts.map((a) => a.name)).toEqual(["approvals.indeterminate"]);
    mockAlerts.length = 0;
    await sweep();
    await sweep();
    expect(mockAlerts).toEqual([]);
    // A day on, still undecided: one reminder.
    await owner(
      "update proposals set reminded_at = now() - interval '25 hours' where id = $1::uuid",
      [s.proposalId]
    );
    await sweep();
    expect(mockAlerts.map((a) => a.name)).toEqual(["approvals.indeterminate"]);
    // A run recovered as undecided is alerted by the recovery, not again by the reminder.
    const lost = await seed("running", "executing");
    mockAlerts.length = 0;
    await expireStaleApprovals({ tenantIds: [t.id] });
    expect((await pairOf(lost)).proposal).toBe("indeterminate");
    expect(mockAlerts.filter((a) => a.name === "approvals.indeterminate")).toHaveLength(
      1
    );
  });

  it("an erased account's held action leaves no trajectory open (the hold is deleted)", async () => {
    const user = await t.user(`erased-${randomUUID().slice(0, 8)}`);
    const s = await seed("paused", "proposed", { payload: { user_identifier: user } });
    await t.run(() => withTenantTx((tx) => eraseUserData(tx, user)));
    const { rows } = await owner<{ status: string }>(
      "select status::text from agent_trajectories where id = $1::uuid",
      [s.trajectoryId]
    );
    expect(rows[0].status).toBe("failed");
    expect(
      (await owner("select 1 from proposals where id = $1::uuid", [s.proposalId]))
        .rowCount
    ).toBe(0);
  });
});
