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
import { withTenantTx } from "@/platform/data";
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

  runProposalStoreContract({
    makeStore: async () =>
      inTenant(new PostgresProposalStore(), await createTestTenant()),
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
