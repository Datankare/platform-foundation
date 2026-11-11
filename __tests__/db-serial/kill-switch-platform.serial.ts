/**
 * @jest-environment node
 */
/**
 * The kill switch's platform scope on Postgres (rv12 H2; moved from r13.db.test.ts by TASK-204,
 * N-19) — the serial pass.
 *
 * A single-tenant deployment's kill switch acts on the platform default of the seeded
 * `agent.trusted_agents`: the key is fixed in agent-kill-switch.ts and power-reduction.ts, so no
 * random key can stand in, and the parallel DB suites must never see it changed. This suite is not
 * a `*.test.ts` (jest's testMatch leaves it out of every parallel pass); `npm run test:db-serial`
 * runs it alone (--runInBand), after the parallel passes, in CI's Layer 1 and in
 * scripts/test-db.sh. The value is restored in a finally.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

import { withOwnerTx } from "@/platform/data";
import { suspendAllAgents } from "@/platform/admin/agent-kill-switch";
import { PostgresProposalStore } from "@/platform/agents/postgres-proposal-store";
import { resetProposalStore, setProposalStore } from "@/platform/agents/proposal-store";
import { clearConfigCache, setConfigWithHistory } from "@/platform/auth/platform-config";
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
const owner = (text: string, values: unknown[] = []) =>
  withOwnerTx("operator", async (tx) => (await tx.query(text, values)).rows);

dbDescribe("the kill switch on Postgres (rv12 H2): platform scope, alone", () => {
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
