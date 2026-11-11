/**
 * @jest-environment node
 */
/**
 * __tests__/db/eligible-approvers.db.test.ts — who could approve a dual-controlled action, read
 * from Postgres as the permission engine resolves it (N-24, N-85, TASK-203)
 *
 * The staff reading (platform/admin/eligible-approvers.ts STAFF_SQL) counts an account in good
 * standing — not deleted; active or warned, or a restriction or suspension whose end has passed —
 * holding each permission by its role, a role it inherits or an active entitlement; and only its
 * own tenant's accounts in a tenant transaction. Then the request path: an erasure asked for in a
 * tenant whose only purge-holder is the requester is refused up front
 * (`approvals.no_eligible_approver`), nothing held and the request's record closed as refused;
 * with a safety approver beside it, it is held as before.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-test",
}));
jest.mock("@/platform/auth/middleware", () =>
  require("@/__tests__/helpers/db-admin").mockTenantMiddleware()
);
jest.mock("@/platform/auth/permissions-cache", () =>
  require("@/__tests__/helpers/test-identities").mockPermissionsCache()
);
jest.mock("@/platform/auth/account-status-guard", () =>
  require("@/__tests__/helpers/test-identities").mockAccountStatus()
);
jest.mock("@/platform/rate-limit", () =>
  require("@/__tests__/helpers/test-identities").mockRateLimit()
);

import { randomUUID } from "node:crypto";
import {
  getTrajectoryStore,
  setTrajectoryStore,
} from "@/platform/agents/trajectory-store";
import { PostgresTrajectoryStore } from "@/platform/agents/postgres-trajectory-store";
import { getProposalStore, setProposalStore } from "@/platform/agents/proposal-store";
import { PostgresProposalStore } from "@/platform/agents/postgres-proposal-store";
import { NextRequest } from "next/server";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";
import {
  asCallerIn,
  insertUser,
  newRun,
  seededRoleId,
  suiteCaller,
} from "../helpers/db-admin";
import { withOwnerTx } from "@/platform/data";
import { runWithTenant } from "@/platform/tenancy/context";
import {
  ADMIN_ACCESS,
  eligibleApprovers,
  noApproverRefusal,
  staffOfTenant,
} from "@/platform/admin/eligible-approvers";
import { POST as erasurePOST } from "@/app/api/admin/gdpr/route";

// hostile:store-down n/a: a live database cannot be made to fail here: the unreadable staff case is no-eligible-approver.test [hostile:store-down]

const RUN = newRun();
const owner = <R extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  withOwnerTx("tenant-lifecycle", (tx) => tx.query<R>(sql, values));
const PURGE = ["admin_purge_user_data", ADMIN_ACCESS];

dbDescribe("eligible approvers, read from Postgres (N-24)", () => {
  let t: TestTenant;
  let other: TestTenant;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await connectTestDatabase();
    t = await createTestTenant();
    other = await createTestTenant();
    const role = async (name: string) => seededRoleId(name);
    ids.superA = await insertUser(t, {
      roleId: await role("super_admin"),
      email: `a-${RUN}@x.org`,
    });
    ids.safety = await insertUser(t, {
      roleId: await role("safety_approver"),
      email: `s-${RUN}@x.org`,
    });
    ids.suspended = await insertUser(t, {
      roleId: await role("super_admin"),
      email: `p-${RUN}@x.org`,
    });
    await owner(
      "update users set account_status = 'suspended', suspended_until = now() + interval '1 day' where id = $1::uuid",
      [ids.suspended]
    );
    ids.lapsed = await insertUser(t, {
      roleId: await role("super_admin"),
      email: `l-${RUN}@x.org`,
    });
    await owner(
      "update users set account_status = 'restricted', restricted_until = now() - interval '1 day' where id = $1::uuid",
      [ids.lapsed]
    );
    ids.deleted = await insertUser(t, {
      roleId: await role("super_admin"),
      email: null,
      deletedAt: new Date().toISOString(),
    });
    ids.moderator = await insertUser(t, {
      roleId: await role("moderator"),
      email: `m-${RUN}@x.org`,
    });
    ids.elsewhere = await insertUser(other, {
      roleId: await role("super_admin"),
      email: `o-${RUN}@x.org`,
    });
    // An entitlement that grants the erasure's permissions to an ordinary account.
    const group = randomUUID();
    await owner(
      `insert into entitlement_groups (id, code, display_name, is_active) values ($1::uuid, $2, $2, true)`,
      [group, `eg-${RUN}`]
    );
    await owner(
      `insert into entitlement_permissions (entitlement_group_id, permission_id)
       select $1::uuid, p.id from permissions p where p.code = any($2::text[])`,
      [group, PURGE]
    );
    ids.entitled = await insertUser(t, {
      roleId: await role("free"),
      email: `e-${RUN}@x.org`,
    });
    await owner(
      `insert into user_entitlements (tenant_id, user_id, entitlement_group_id) values ($1::uuid, $2::uuid, $3::uuid)`,
      [t.id, ids.entitled, group]
    );
  });

  afterAll(async () => {
    await dropTestTenants();
    await owner(
      "delete from entitlement_permissions where entitlement_group_id in (select id from entitlement_groups where code = $1)",
      [`eg-${RUN}`]
    );
    await owner("delete from entitlement_groups where code = $1", [`eg-${RUN}`]);
    await disconnectTestDatabase();
  });

  it("[hostile:role] reads only the tenant's staff in good standing, by role, inheritance or entitlement", async () => {
    const staff = await t.run(() => staffOfTenant());
    const seen = new Set(staff.map((s) => s.userId));
    expect(seen.has(ids.superA)).toBe(true);
    expect(seen.has(ids.safety)).toBe(true);
    expect(seen.has(ids.lapsed)).toBe(true);
    expect(seen.has(ids.moderator)).toBe(true);
    expect(seen.has(ids.entitled)).toBe(true);
    expect(seen.has(ids.suspended)).toBe(false);
    expect(seen.has(ids.deleted)).toBe(false);
    expect(seen.has(ids.elsewhere)).toBe(false);
    const purgers = eligibleApprovers(staff, {
      permissions: PURGE,
      excluded: [ids.superA],
    })
      .map((s) => s.userId)
      .sort();
    expect(purgers).toEqual([ids.entitled, ids.lapsed, ids.safety].sort());
  });

  it("[hostile:self] [hostile:id-spelling] refuses when only the requester could approve, by any of its names", async () => {
    const lone = await createTestTenant();
    const admin = await insertUser(lone, {
      roleId: await seededRoleId("super_admin"),
      email: `lone-${RUN}@x.org`,
    });
    const ask = () =>
      noApproverRefusal("purge_user_data", {
        permissions: PURGE,
        excluded: [admin.toUpperCase()],
      });
    // A single-tenant deployment: its own staff only.
    const refusal = await runWithTenant({ tenantId: lone.id, mode: "single" }, ask);
    expect(refusal).toMatchObject({
      code: "approvals.no_eligible_approver",
      params: { action: "purge_user_data", permissions: PURGE },
    });
    // A shared one: another tenant's operator (platform_operate and the permissions) decides a
    // tenant's hold too, as the operators' approval routes allow — so it is not refused.
    expect(await lone.run(ask)).toBeNull();
  });
});

dbDescribe("an erasure no one else could approve is refused up front (N-24)", () => {
  let lone: TestTenant;
  let requester: ReturnType<typeof suiteCaller>;

  let previous: ReturnType<typeof getProposalStore> | undefined;
  let previousRuns: ReturnType<typeof getTrajectoryStore> | undefined;

  beforeAll(async () => {
    await connectTestDatabase();
    previous = setProposalStore(new PostgresProposalStore());
    previousRuns = getTrajectoryStore();
    setTrajectoryStore(new PostgresTrajectoryStore());
    lone = await createTestTenant();
    requester = suiteCaller("super_admin", RUN, { name: "lone-requester" });
    await insertUser(lone, {
      id: requester.userId,
      cognitoSub: requester.sub,
      roleId: await seededRoleId("super_admin"),
      email: `requester-${RUN}@x.org`,
    });
  });

  afterAll(async () => {
    if (previous) setProposalStore(previous);
    if (previousRuns) setTrajectoryStore(previousRuns);
    await dropTestTenants();
    await disconnectTestDatabase();
  });

  // A single-tenant deployment (N-114, TASK-209): its own staff alone decide. In a shared one
  // every tenant's operators count too (asOperator: the first suite shows it with an operator it
  // made), and suites running beside this one in the same database make operators of their own —
  // so "alone" held only when none ran at that moment (409 or 202, by timing).
  const ask = async (target: string) =>
    erasurePOST(
      new NextRequest("http://localhost/api/admin/gdpr", {
        method: "POST",
        headers: {
          ...asCallerIn(requester, lone, "single"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ userId: target, reason: "user-request" }),
      })
    );

  it("one super_admin alone: 409 approvals.no_eligible_approver, nothing held, the request closed as refused", async () => {
    const target = await insertUser(lone, {
      roleId: await seededRoleId("free"),
      email: `target-${RUN}@x.org`,
    });
    const res = await ask(target);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("approvals.no_eligible_approver");
    expect(body.params).toMatchObject({
      action: "purge_user_data",
      permissions: ["admin_purge_user_data", "can_access_admin"],
    });
    const holds = await owner(
      "select count(*)::int as n from proposals where tenant_id = $1::uuid and label = 'purge_user_data'",
      [lone.id]
    );
    expect(holds.rows[0].n).toBe(0);
    const records = await owner<{ outcome: string; code: string | null }>(
      `select details->>'outcome' as outcome, details->>'code' as code from audit_log
        where tenant_id = $1::uuid and target_id = $2::uuid and details->>'type' = 'gdpr_purge_requested'
        order by created_at`,
      [lone.id, target]
    );
    expect(records.rows).toEqual([
      { outcome: "attempted", code: null },
      { outcome: "refused", code: "approvals.no_eligible_approver" },
    ]);
  });

  it("with a safety approver beside it: held for them, as before (202)", async () => {
    await insertUser(lone, {
      roleId: await seededRoleId("safety_approver"),
      email: `approver-${RUN}@x.org`,
    });
    const target = await insertUser(lone, {
      roleId: await seededRoleId("free"),
      email: `target2-${RUN}@x.org`,
    });
    const res = await ask(target);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ held: true });
  });
});
