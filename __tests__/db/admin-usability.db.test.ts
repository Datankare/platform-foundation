/**
 * @jest-environment node
 */
/**
 * __tests__/db/admin-usability.db.test.ts — what the admin console's routes now name, on Postgres
 * (TASK-202: N-61, N-63, S3-E19)
 *
 * Each route runs for real against the replayed database, through the real admin guard (only
 * token verification, the permission and standing lookups and the rate limiter are test callers):
 *
 *   - GET /api/admin/approvals: each hold's requester by address and role, never an id; a config
 *     change's key, value now and after, and the requester's comment — to a viewer who could
 *     decide it, and to no one else; tenant isolation unchanged;
 *   - GET /api/admin/audit and GET /api/admin/per-account: each actor and target by address;
 *     an account of another tenant is never named;
 *   - GET /api/operator/erasures: the open erasures across tenants, their steps (poolUnverified,
 *     an open attestation request and who asked), the operators, operators only.
 *
 * hostile:self n/a: these routes only read; no decision on one's own change is added or changed
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
import { NextRequest } from "next/server";
import * as data from "@/platform/data";
import { withOwnerTx } from "@/platform/data";
import { GET as approvalsGET } from "@/app/api/admin/approvals/route";
import { GET as auditGET } from "@/app/api/admin/audit/route";
import { GET as perAccountGET } from "@/app/api/admin/per-account/route";
import { GET as erasuresGET } from "@/app/api/operator/erasures/route";
import * as names from "@/platform/admin/account-names";
import { namedAccounts } from "@/platform/admin/account-names";
import type { PendingApproval } from "@/platform/admin/pending-approvals";
import type { ErasureOverview } from "@/platform/gdpr/erasure-status";
import {
  DB_ENABLED,
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
import type { TestIdentity } from "../helpers/test-identities";

const RUN = newRun();
let a: TestTenant;
let b: TestTenant;
let superAdmin: TestIdentity; // requester, a@…
let approver: TestIdentity; // a second super admin
let tenantAdmin: TestIdentity; // admin: config_manage_standard, not safety
let otherTenantUser: string;
let erasedUser: string;

const email = (label: string) => `${label}-${RUN}@usability.test`;

function req(path: string, caller: TestIdentity | "anonymous", tenant: TestTenant = a) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { "content-type": "application/json", ...asCallerIn(caller, tenant) },
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** A config approval of `tenant`, as the config writer files one. */
async function fileApproval(
  tenant: TestTenant,
  by: string,
  key: string,
  current: unknown,
  proposed: unknown,
  comment: string
): Promise<string> {
  const id = randomUUID();
  await withOwnerTx("tenant-lifecycle", (tx) =>
    tx.query(
      `insert into config_pending_approvals
         (id, config_key, current_value, proposed_value, requested_by, change_comment,
          status, expires_at, created_at, tenant_id, scope, action)
       values ($1::uuid, $2, $3::jsonb, $4::jsonb, $5::uuid, $6, 'pending',
               now() + interval '7 days', now(), $7::uuid, 'tenant', 'set')`,
      [id, key, JSON.stringify(current), JSON.stringify(proposed), by, comment, tenant.id]
    )
  );
  return id;
}

if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    a = await createTestTenant();
    b = await createTestTenant();
    const superRole = await seededRoleId("super_admin");
    const adminRole = await seededRoleId("admin");
    const freeRole = await seededRoleId("free");
    superAdmin = suiteCaller("super_admin", RUN, { name: "requester" });
    approver = suiteCaller("super_admin", RUN, { name: "approver" });
    tenantAdmin = suiteCaller("admin", RUN, { name: "tenant-admin" });
    await insertUser(a, {
      id: superAdmin.userId,
      roleId: superRole,
      email: email("requester"),
    });
    await insertUser(a, {
      id: approver.userId,
      roleId: superRole,
      email: email("approver"),
    });
    await insertUser(a, {
      id: tenantAdmin.userId,
      roleId: adminRole,
      email: email("admin"),
    });
    otherTenantUser = await insertUser(b, { roleId: freeRole, email: email("other") });
    erasedUser = await insertUser(a, {
      roleId: freeRole,
      email: null,
      deletedAt: new Date().toISOString(),
    });
  });
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });
}

dbDescribe("account names (TASK-202, N-63)", () => {
  it("names an account by address and role, an erased one as erased, never another tenant's", async () => {
    const named = await a.run(() =>
      namedAccounts([superAdmin.userId, erasedUser, otherTenantUser, "not-an-id", null])
    );
    expect(named.get(superAdmin.userId)).toMatchObject({
      email: email("requester"),
      erased: false,
    });
    expect(named.get(superAdmin.userId)?.role).toBeTruthy();
    expect(named.get(erasedUser)).toMatchObject({ email: null, erased: true });
    // Row-level security: another tenant's account is never found, so never named.
    expect(named.has(otherTenantUser)).toBe(false);
    expect(named.has("not-an-id")).toBe(false);
  });

  it("[hostile:id-spelling] an id in upper case, or the identity subject, names the same account", async () => {
    const sub = `sub-${superAdmin.userId}`;
    const named = await a.run(() =>
      namedAccounts([superAdmin.userId.toUpperCase(), sub])
    );
    expect(named.get(superAdmin.userId.toUpperCase())?.email).toBe(email("requester"));
    expect(named.get(sub)?.email).toBe(email("requester"));
  });

  it("[hostile:store-down] an unreadable store names no one, and does not throw", async () => {
    const spy = jest
      .spyOn(data, "withTenantTx")
      .mockRejectedValueOnce(new Error("connection refused"));
    try {
      const named = await a.run(() => namedAccounts([superAdmin.userId]));
      expect(named.size).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

dbDescribe("GET /api/admin/approvals: what, who, when, why (TASK-202, N-61)", () => {
  let approvalId: string;
  beforeAll(async () => {
    approvalId = await fileApproval(
      a,
      superAdmin.userId,
      "moderation.strike_ban_threshold",
      5,
      7,
      `Raise the ban threshold ${RUN}`
    );
    // Another tenant's approval: never listed in A.
    await fileApproval(b, otherTenantUser, "moderation.strike_ban_threshold", 5, 9, "b");
  });

  it("a decider sees the key, the value now and after, the requester's address and role, and the comment", async () => {
    const res = await approvalsGET(req("/api/admin/approvals", approver));
    expect(res.status).toBe(200);
    const { approvals } = await json<{ approvals: PendingApproval[] }>(res);
    const row = approvals.find((x) => x.id === approvalId);
    expect(row).toMatchObject({
      source: "config-approval",
      state: "held",
      change: {
        key: "moderation.strike_ban_threshold",
        action: "set",
        before: 5,
        after: 7,
        scope: "tenant",
      },
      comment: `Raise the ban threshold ${RUN}`,
      requestedBy: { kind: "account", email: email("requester") },
    });
    expect((row?.requestedBy as { role?: string }).role).toBeTruthy();
    // Tenant isolation unchanged: B's approval is not listed in A.
    expect(
      approvals.filter((x) => x.label === "moderation.strike_ban_threshold")
    ).toHaveLength(approvals.filter((x) => x.id === approvalId).length);
  });

  it("[hostile:role] a viewer who could not decide it sees who asked, but not the values or the comment", async () => {
    // admin holds can_access_admin but not config_manage_safety (the key is safety-tier).
    const res = await approvalsGET(req("/api/admin/approvals", tenantAdmin));
    expect(res.status).toBe(200);
    const { approvals } = await json<{ approvals: PendingApproval[] }>(res);
    const row = approvals.find((x) => x.id === approvalId);
    expect(row).toBeDefined();
    expect(row?.change).toBeUndefined();
    expect(row?.comment).toBeUndefined();
    expect(row?.requestedBy).toMatchObject({
      kind: "account",
      email: email("requester"),
    });
  });

  it("[hostile:role] anonymous is refused before anything is read", async () => {
    const res = await approvalsGET(req("/api/admin/approvals", "anonymous"));
    expect(res.status).toBe(401);
  });

  it("[hostile:store-down] the requester's name unreadable: listed as unknown, never as an id", async () => {
    // namedAccounts answers an empty map when its read fails (asserted above); the listing then
    // names no one — and never falls back to the id.
    const spy = jest.spyOn(names, "namedAccounts").mockResolvedValueOnce(new Map());
    try {
      const res = await approvalsGET(req("/api/admin/approvals", approver));
      expect(res.status).toBe(200);
      const { approvals } = await json<{ approvals: PendingApproval[] }>(res);
      const row = approvals.find((x) => x.id === approvalId);
      expect(row?.requestedBy).toEqual({ kind: "unknown" });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

dbDescribe(
  "GET /api/admin/audit and /api/admin/per-account name people (TASK-202, N-63)",
  () => {
    beforeAll(async () => {
      await withOwnerTx("tenant-lifecycle", async (tx) => {
        await tx.query(
          `insert into audit_log (action, actor_id, target_id, details, tenant_id)
         values ('admin_action', $1::uuid, $2::uuid, $3::jsonb, $4::uuid),
                ('admin_action', $1::uuid, $5::uuid, $3::jsonb, $4::uuid)`,
          [
            superAdmin.userId,
            erasedUser,
            JSON.stringify({ type: `usability-${RUN}` }),
            a.id,
            otherTenantUser,
          ]
        );
        await tx.query(
          `insert into user_feature_restrictions (user_id, feature, reason, created_by, tenant_id)
         values ($1::uuid, 'translate', 'spam', $2, $3::uuid)`,
          [approver.userId, superAdmin.userId, a.id]
        );
      });
    });

    it("each audit row's actor by address; an erased target as erased; another tenant's id never named", async () => {
      const res = await auditGET(
        req("/api/admin/audit?q=admin_action&limit=200", superAdmin)
      );
      expect(res.status).toBe(200);
      const { entries } = await json<{
        entries: {
          details: string;
          actor: unknown;
          target: unknown;
          targetId: string;
        }[];
      }>(res);
      const mine = entries.filter((e) => e.details.includes(`usability-${RUN}`));
      expect(mine).toHaveLength(2);
      for (const e of mine)
        expect(e.actor).toMatchObject({ email: email("requester"), erased: false });
      const erased = mine.find((e) => e.targetId === erasedUser);
      expect(erased?.target).toEqual({
        email: null,
        role: expect.anything(),
        erased: true,
      });
      const foreign = mine.find((e) => e.targetId === otherTenantUser);
      // An id that names no account of this tenant: no name, the id only as a detail.
      expect(foreign?.target).toBeNull();
    });

    it("[hostile:role] the audit log stays its permission's: a free account is refused", async () => {
      const free = suiteCaller("free", RUN, { name: "free" });
      const res = await auditGET(req("/api/admin/audit", free));
      expect(res.status).toBe(403);
    });

    it("each per-account block names the account and who blocked it", async () => {
      const res = await perAccountGET(req("/api/admin/per-account", superAdmin));
      expect(res.status).toBe(200);
      const { restrictions } = await json<{
        restrictions: { user_id: string; user: unknown; created_by_account: unknown }[];
      }>(res);
      const row = restrictions.find((r) => r.user_id === approver.userId);
      expect(row).toMatchObject({
        user: { email: email("approver"), erased: false },
        created_by_account: { email: email("requester"), erased: false },
      });
    });
  }
);

dbDescribe("GET /api/operator/erasures (TASK-202, S3-E19)", () => {
  let pending: string;
  beforeAll(async () => {
    pending = await insertUser(a, {
      roleId: await seededRoleId("free"),
      email: null,
      deletedAt: new Date().toISOString(),
    });
    const asked = new Date().toISOString();
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    await withOwnerTx("tenant-lifecycle", (tx) =>
      tx.query(
        `insert into user_deletions (user_id, requested_by, tenant_id, purge_after, external_erasures)
         values ($1::uuid, $2, $3::uuid, now() + interval '30 days', $4::jsonb)`,
        [
          pending,
          superAdmin.userId,
          a.id,
          JSON.stringify({
            "identity-provider": {
              attempts: 3,
              poolUnverified: true,
              error: "not found",
              attestationRequest: {
                by: superAdmin.userId,
                at: asked,
                reason: "deleted_in_old_pool",
                expiresAt: expires,
              },
            },
          }),
        ]
      )
    );
  });

  it("lists the open erasure, its unverifiable step and who asked, by address — the erased account by id only", async () => {
    const res = await erasuresGET(req("/api/operator/erasures", approver));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await json<ErasureOverview>(res);
    const row = body.erasures.find((e) => e.userId === pending);
    expect(row).toMatchObject({
      tenantId: a.id,
      requestedBy: { kind: "account", email: email("requester") },
      purgedAt: null,
      steps: [
        {
          store: "identity-provider",
          done: false,
          attempts: 3,
          poolUnverified: true,
          attestationRequest: {
            by: { kind: "account", email: email("requester") },
            byViewer: false,
            reason: "deleted_in_old_pool",
            expired: false,
          },
        },
      ],
    });
    // The approver is a second operator; at least the two this suite made exist.
    expect(row?.secondOperator).toBe(true);
    expect(body.operators).toBeGreaterThanOrEqual(2);
    expect(body.reasons).toEqual([
      "pool_decommissioned",
      "deleted_in_old_pool",
      "identity_never_existed",
    ]);
    // The step's own error text is never sent.
    expect(JSON.stringify(row)).not.toContain("not found");
  });

  it("[hostile:self] the operator who asked is told the request is theirs", async () => {
    const res = await erasuresGET(req("/api/operator/erasures", superAdmin));
    const body = await json<ErasureOverview>(res);
    const row = body.erasures.find((e) => e.userId === pending);
    expect(row?.steps[0]?.attestationRequest?.byViewer).toBe(true);
  });

  it("[hostile:role] a tenant administrator (no platform_operate) and anonymous are refused", async () => {
    const denied = await erasuresGET(req("/api/operator/erasures", tenantAdmin));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe(
      "auth.permission_denied"
    );
    expect((await erasuresGET(req("/api/operator/erasures", "anonymous"))).status).toBe(
      401
    );
  });

  it("[hostile:store-down] the store unreachable: a coded 500, no partial list", async () => {
    const spy = jest
      .spyOn(data, "withOwnerTx")
      .mockRejectedValueOnce(new Error("connection refused"));
    try {
      const res = await erasuresGET(req("/api/operator/erasures", approver));
      expect(res.status).toBe(500);
      const body = (await res.json()) as { code: string; erasures?: unknown };
      expect(body.code).toBe("internal.error");
      expect(body.erasures).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
