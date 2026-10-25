/**
 * @jest-environment node
 */
/**
 * PostgresProposalStore against the replayed database: the conformance kit inside one tenant,
 * rows from before migration 046 and tampered identities (inserted as raw rows), the SQL paths
 * the kit does not reach, and the store isolated between tenants.
 */

import { randomUUID } from "node:crypto";
import { runProposalStoreContract } from "../contract/proposal-store-contract";
import { runTenantIsolationContract } from "../contract/tenant-isolation-contract";
import { proposalIsolation } from "../helpers/store-isolation-fixtures";
import { PostgresProposalStore } from "@/platform/agents/postgres-proposal-store";
import { withOwnerTx, withTenantTx } from "@/platform/data";
import {
  expireLapsedApprovedHolds,
  HOLD_EXPIRY_ACTOR,
  recoverStaleRuns,
} from "@/platform/admin/hold-expiry";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  inTenant,
  type TestTenant,
} from "../helpers/db";

const actor = { actorType: "agent" as const, actorId: "agent:a", agentRole: "a" };
const base = {
  sessionId: "s",
  trajectoryId: "t",
  label: "publish",
  actor,
  effects: ["stateWrite" as const],
  effectiveRisk: "consequential" as const,
};

dbDescribe("PostgresProposalStore", () => {
  beforeAll(connectTestDatabase);
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  let kitTenant: TestTenant;
  runProposalStoreContract({
    makeStore: async () => {
      kitTenant = await createTestTenant();
      return inTenant(new PostgresProposalStore(), kitTenant);
    },
    // The approval-expiry job's own recovery, on the owner connection, scoped to this tenant and
    // with a lease the run has passed (review 11 H-1, L-5).
    markUndecided: async (_store, proposalId) => {
      await withOwnerTx("platform-job", async (tx) => {
        await tx.query(
          "update proposals set updated_at = now() - interval '1 hour' where id = $1::uuid",
          [proposalId]
        );
        await recoverStaleRuns(tx, 60, { tenantIds: [kitTenant.id] });
      });
    },
  });

  // Review 7 M7: the config.expire-approvals job withdraws approvals never used past their
  // period. Run as the job runs it — on the owner connection — scoped to this suite's tenant, and
  // with a period (1 day) whose lapsed rows the real job (7 days) never sweeps from under it
  // (review 11 L-5).
  it("withdraws approved holds never run past the period, and nothing else", async () => {
    const tenant = await createTestTenant();
    const store = inTenant(new PostgresProposalStore(), tenant);
    const make = async (op: string, status: "approved" | "proposed", daysAgo: number) => {
      const p = await store.create({ ...base, operationId: op });
      if (status === "approved") await store.decide(p.proposalId, "approved", "alice");
      await tenant.run(() =>
        withTenantTx((tx) =>
          tx.query(
            "update proposals set decided_at = now() - make_interval(days => $2::int), created_at = now() - make_interval(days => $2::int) where id = $1::uuid",
            [p.proposalId, daysAgo]
          )
        )
      );
      return p.proposalId;
    };
    const lapsed = await make("op_lapsed", "approved", 2);
    const recent = await make("op_recent", "approved", 0);
    const open = await make("op_open", "proposed", 30);
    const n = await withOwnerTx("platform-job", (tx) =>
      expireLapsedApprovedHolds(tx, 1, { tenantIds: [tenant.id] })
    );
    expect(n).toBe(1);
    const after = await store.getById(lapsed);
    expect(after).toMatchObject({ status: "rejected", decidedBy: HOLD_EXPIRY_ACTOR });
    expect(after?.decisionNote).toMatch(
      /^Approved by alice at \d{4}-\d\d-\d\dT[\d:.]+Z, never run; withdrawn: expired: not run within 1 day of its approval$/
    );
    expect((await store.getById(recent))?.status).toBe("approved");
    expect((await store.getById(open))?.status).toBe("proposed");
    // Review 8 L5: each withdrawal is in the tenant's audit log, by the system.
    const audit = await tenant.run(() =>
      withTenantTx((tx) =>
        tx.query(
          "select actor_id, details from audit_log where details->>'type' = 'approval_withdrawn'"
        )
      )
    );
    expect(audit.rows).toEqual([
      {
        actor_id: null,
        details: expect.objectContaining({
          reason: "expired",
          holdId: lapsed,
          label: expect.any(String),
          approvedBy: "alice",
          agent: HOLD_EXPIRY_ACTOR,
        }),
      },
    ]);
  });

  describe("rows from before migration 046, and tampered identities", () => {
    // Primary keys are uuids unique across tenants, so each test inserts its own.
    let ID: string;
    const legacy = {
      actorType: "agent",
      actorId: "agent:conductor",
      agentRole: "conductor",
    };
    let tenant: TestTenant;
    let store: PostgresProposalStore;
    beforeEach(async () => {
      tenant = await createTestTenant();
      store = inTenant(new PostgresProposalStore(), tenant);
      ID = randomUUID();
    });

    async function insertRow(actorIdentity: unknown): Promise<void> {
      await tenant.run(() =>
        withTenantTx((tx) =>
          tx.query(
            `insert into proposals (id, operation_id, session_id, trajectory_id, label, status,
               actor_id, actor_role, effects, effective_risk, actor_identity)
             values ($1::uuid, 'op_x', 's', 't', 'publish', 'proposed', 'agent:conductor',
               'conductor', '["restricted"]'::jsonb, 'restricted', $2::jsonb)`,
            [ID, actorIdentity === undefined ? null : JSON.stringify(actorIdentity)]
          )
        )
      );
    }

    it.each([
      ["no actor_identity (a row from before 046)", undefined],
      [
        "an identity whose id disagrees with the column",
        { ...legacy, actorId: "agent:other", onBehalfOf: "u1" },
      ],
      [
        "an identity whose role disagrees with the column",
        { ...legacy, agentRole: "admin", onBehalfOf: "u1" },
      ],
      ["an unknown actor type", { ...legacy, actorType: "root", onBehalfOf: "u1" }],
      ["an identity that is not an object", "u1"],
      ["an identity that is a list", [legacy]],
    ])(
      "reads %s as an agent acting for nobody (fails closed)",
      async (_label, identity) => {
        await insertRow(identity);
        const p = await store.getById(ID);
        expect(p?.actor).toEqual(legacy);
      }
    );

    it("drops a malformed delegation or non-string session, keeping the rest", async () => {
      await insertRow({
        ...legacy,
        onBehalfOf: "u1",
        sessionId: 7,
        delegation: { scope: "x" },
      });
      const p = await store.getById(ID);
      expect(p?.actor).toEqual({ ...legacy, onBehalfOf: "u1" });
    });

    it("keeps a well-formed delegation and session", async () => {
      const delegation = { onBehalfOf: "u1", method: "grant", scope: ["publish"] };
      await insertRow({ ...legacy, onBehalfOf: "u1", sessionId: "s9", delegation });
      const p = await store.getById(ID);
      expect(p?.actor).toEqual({
        ...legacy,
        onBehalfOf: "u1",
        sessionId: "s9",
        delegation,
      });
    });

    it("reads non-list effects and non-object payload as empty", async () => {
      await insertRow(undefined);
      await tenant.run(() =>
        withTenantTx((tx) =>
          tx.query(
            `update proposals set effects = '{}'::jsonb, payload = '"x"'::jsonb where id = $1::uuid`,
            [ID]
          )
        )
      );
      const p = await store.getById(ID);
      expect(p?.effects).toEqual([]);
      expect(p?.payload).toEqual({});
      expect(p?.observedVersion).toBeUndefined();
    });
  });

  describe("SQL paths beyond the kit", () => {
    let store: PostgresProposalStore;
    beforeEach(async () => {
      store = inTenant(new PostgresProposalStore(), await createTestTenant());
    });

    it("round-trips observedVersion and a decision note, with ISO timestamps", async () => {
      const p = await store.create({ ...base, operationId: "op1", observedVersion: 4 });
      expect(p.observedVersion).toBe(4);
      const d = await store.decide(p.proposalId, "rejected", "bob", "too risky");
      expect(d?.decisionNote).toBe("too risky");
      expect(d?.decidedBy).toBe("bob");
      expect(new Date(d!.decidedAt!).toISOString()).toBe(d!.decidedAt);
    });

    it("refuses a second live proposal for one operation (the database's unique index)", async () => {
      await store.create({ ...base, operationId: "op2" });
      await expect(store.create({ ...base, operationId: "op2" })).rejects.toThrow(
        /idx_proposals_tenant_one_live/
      );
    });

    it("allows a new proposal once the earlier one is rejected", async () => {
      const p = await store.create({ ...base, operationId: "op3" });
      await store.decide(p.proposalId, "rejected", "bob");
      const again = await store.create({ ...base, operationId: "op3" });
      expect(again.status).toBe("proposed");
    });

    it("returns undefined, without a query error, for ids that are not uuids", async () => {
      expect(await store.getById("missing")).toBeUndefined();
      expect(await store.decide("missing", "approved", "bob")).toBeUndefined();
      expect(await store.consume("missing")).toBeUndefined();
    });

    it("filters by trajectory and limits, newest first", async () => {
      const a = await store.create({ ...base, operationId: "q1", trajectoryId: "tA" });
      const b = await store.create({ ...base, operationId: "q2", trajectoryId: "tA" });
      await store.create({ ...base, operationId: "q3", trajectoryId: "tB" });
      const rows = await store.query({ trajectoryId: "tA" });
      expect(rows.map((r) => r.proposalId)).toEqual([b.proposalId, a.proposalId]);
      expect(await store.query({ trajectoryId: "tA", limit: 1 })).toHaveLength(1);
      expect(await store.query({})).toHaveLength(3);
    });
  });

  runTenantIsolationContract({
    name: "proposals",
    makeStore: () => new PostgresProposalStore(),
    createTenant: createTestTenant,
    ...proposalIsolation(),
  });
});
