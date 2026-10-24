/**
 * @jest-environment node
 */
/**
 * An operator sets one tenant's settings, on Postgres (ADR-053 D5, D7)
 *
 * /api/operator/tenants/[id]/config (GET, PUT, DELETE), ./approvals (GET) and
 * ./approvals/[approvalId] (POST) run for real in the TARGET tenant: the governed write, its
 * history and audit, two-person approval and dual-control holds are that tenant's. Only token
 * verification, the permission lookup, the standing lookup and the rate limiter are test callers.
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

import { NextRequest } from "next/server";
import { withOwnerTx } from "@/platform/data";
import { clearConfigCache, getConfig } from "@/platform/auth/platform-config";
import { CachedTenantDirectory, setTenantDirectory } from "@/platform/tenancy/directory";
import { PostgresTenantDirectory } from "@/platform/tenancy/postgres-directory";
import {
  DELETE as configDELETE,
  GET as configGET,
  PUT as configPUT,
} from "@/app/api/operator/tenants/[id]/config/route";
import { GET as approvalsGET } from "@/app/api/operator/tenants/[id]/approvals/route";
import { POST as decidePOST } from "@/app/api/operator/tenants/[id]/approvals/[approvalId]/route";
import { DELETE as adminConfigDELETE } from "@/app/api/admin/config/route";
import { GET as adminApprovalsGET } from "@/app/api/admin/approvals/route";
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
const OPEN = `test.${RUN}.open`; // its administrators may set it
const LOCKED = `test.${RUN}.locked`; // governs the platform (operators only)
const SAFE = `test.${RUN}.safe`; // safety tier, operators only
const KEYS = [OPEN, LOCKED, SAFE];
const DUAL = "signups_enabled"; // in config.dual_control_keys

let home: TestTenant; // the operators' own tenant
let target: TestTenant; // the tenant they set
let op1: TestIdentity;
let op2: TestIdentity;
let targetAdmin: TestIdentity;

type Caller = Parameters<typeof asCallerIn>[0];
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const ctx2 = (id: string, approvalId: string) => ({
  params: Promise.resolve({ id, approvalId }),
});

function req(
  path: string,
  caller: Caller,
  options: {
    method?: string;
    body?: unknown;
    tenant?: TestTenant;
    mode?: "single" | "shared";
  } = {}
): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...asCallerIn(caller, options.tenant ?? home, options.mode),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}
const base = (t: TestTenant | string) =>
  `/api/operator/tenants/${typeof t === "string" ? t : t.id}`;
const get = (by: Caller, t: TestTenant | string = target, mode?: "single" | "shared") =>
  configGET(
    req(`${base(t)}/config`, by, { mode }),
    ctx(typeof t === "string" ? t : t.id)
  );
const put = (by: Caller, body: unknown, t: TestTenant = target) =>
  configPUT(req(`${base(t)}/config`, by, { method: "PUT", body }), ctx(t.id));
const del = (by: Caller, key: string, t: TestTenant = target) =>
  configDELETE(
    req(`${base(t)}/config?key=${encodeURIComponent(key)}`, by, { method: "DELETE" }),
    ctx(t.id)
  );
const held = async (by: Caller = op2) => {
  const res = await approvalsGET(req(`${base(target)}/approvals`, by), ctx(target.id));
  expect(res.status).toBe(200);
  return (
    (await res.json()) as { approvals: { id: string; source: string; label: string }[] }
  ).approvals;
};
const decide = (by: Caller, approvalId: string, source: string, decision = "approve") =>
  decidePOST(
    req(`${base(target)}/approvals/${approvalId}`, by, {
      method: "POST",
      body: { decision, source },
    }),
    ctx2(target.id, approvalId)
  );

async function q<R extends Record<string, unknown>>(
  text: string,
  values: unknown[] = []
) {
  return (await withOwnerTx("operator", (tx) => tx.query<R>(text, values))).rows;
}
const override = async (t: TestTenant, key: string) =>
  (
    await q<{ value: unknown }>(
      "select value from tenant_config_overrides where tenant_id = $1::uuid and key = $2",
      [t.id, key]
    )
  )[0]?.value;
const valueIn = (t: TestTenant, key: string) => {
  clearConfigCache();
  return t.run(() => getConfig(key));
};

if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    setTenantDirectory(new CachedTenantDirectory(new PostgresTenantDirectory()));
    await q(
      `insert into platform_config
         (key, value, default_value, description, category, value_type, permission_tier, tenant_overridable)
       values ($1, '"base"', '"base"', 'open', $4, 'string', 'standard', true),
              ($2, '10', '10', 'locked', $4, 'number', 'standard', false),
              ($3, '3', '3', 'safe', $4, 'number', 'safety', false)`,
      [OPEN, LOCKED, SAFE, `test-${RUN}`]
    );
    home = await createTestTenant();
    target = await createTestTenant();
    const superRole = await seededRoleId("super_admin");
    op1 = suiteCaller("super_admin", RUN, { name: "op1" });
    op2 = suiteCaller("super_admin", RUN, { name: "op2" });
    targetAdmin = suiteCaller("admin", RUN, { name: "target-admin" });
    await insertUser(home, { id: op1.userId, roleId: superRole });
    await insertUser(home, { id: op2.userId, roleId: superRole });
    await insertUser(target, {
      id: targetAdmin.userId,
      roleId: await seededRoleId("admin"),
    });
  });
  afterAll(async () => {
    await q("delete from platform_config_history where config_key = any($1)", [KEYS]);
    await q("delete from config_pending_approvals where config_key = any($1)", [KEYS]);
    await q(
      "delete from tenant_config_overrides where key = any($1) or tenant_id = any($2::uuid[])",
      [KEYS, [home.id, target.id]]
    );
    await q("delete from platform_config where key = any($1)", [KEYS]);
    await dropTestTenants();
    await disconnectTestDatabase();
  });
  beforeEach(() => clearConfigCache());
}

dbDescribe("operator per-tenant settings — who and where", () => {
  it("operators only, on every route", async () => {
    for (const call of [
      (c: Caller) => get(c),
      (c: Caller) => put(c, { key: OPEN, value: "x" }),
      (c: Caller) => del(c, OPEN),
      (c: Caller) => approvalsGET(req(`${base(target)}/approvals`, c), ctx(target.id)),
      (c: Caller) => decide(c, "00000000-0000-4000-8000-000000000000", "config-approval"),
    ]) {
      expect((await call("anonymous")).status).toBe(401);
      expect((await call(targetAdmin)).status).toBe(403);
    }
  });

  it("a single deployment has no per-tenant settings", async () => {
    const res = await get(op1, target, "single");
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("tenant.not_shared");
  });

  it("an unknown or malformed tenant is 404; a deleted one is refused", async () => {
    expect((await get(op1, "6f1d3c2a-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await get(op1, "not-a-uuid")).status).toBe(404);
    const gone = await createTestTenant();
    await q(
      "update tenants set status = 'deleted', purge_after = now() + interval '30 days' where id = $1",
      [gone.id]
    );
    const res = await get(op1, gone);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("tenant.not_active");
  });
});

dbDescribe("operator per-tenant settings — read and write in the target tenant", () => {
  it("lists every setting with the target's own values, including operators-only keys", async () => {
    await q(
      "insert into tenant_config_overrides (tenant_id, key, value) values ($1, $2, '\"theirs\"')",
      [target.id, OPEN]
    );
    const res = await get(op1);
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as {
      entries: {
        key: string;
        value: unknown;
        overridden: boolean;
        tenantOverridable: boolean;
      }[];
    };
    const by = Object.fromEntries(entries.map((e) => [e.key, e]));
    expect(by[OPEN]).toMatchObject({
      value: "theirs",
      overridden: true,
      tenantOverridable: true,
    });
    expect(by[LOCKED]).toMatchObject({
      value: 10,
      overridden: false,
      tenantOverridable: false,
    });
    await q("delete from tenant_config_overrides where tenant_id = $1 and key = $2", [
      target.id,
      OPEN,
    ]);
  });

  it("sets an operators-only key for the target only, with its history and audit there", async () => {
    const res = await put(op1, { key: LOCKED, value: 4, changeComment: "smaller" });
    expect(res.status).toBe(200);
    expect(await override(target, LOCKED)).toBe(4);
    expect(await override(home, LOCKED)).toBeUndefined();
    await expect(valueIn(target, LOCKED)).resolves.toBe(4);
    await expect(valueIn(home, LOCKED)).resolves.toBe(10);
    const history = await q<{ tenant_id: string; scope: string; changed_by: string }>(
      "select tenant_id, scope, changed_by from platform_config_history where config_key = $1",
      [LOCKED]
    );
    expect(history).toEqual([
      { tenant_id: target.id, scope: "tenant", changed_by: op1.userId },
    ]);
    const audit = await q<{ n: number }>(
      "select count(*)::int as n from audit_log where tenant_id = $1 and details->>'key' = $2",
      [target.id, LOCKED]
    );
    expect(audit[0].n).toBeGreaterThan(0);
  });

  it("the target's own administrator cannot remove what an operator set", async () => {
    const res = await adminConfigDELETE(
      req(`/api/admin/config?key=${encodeURIComponent(LOCKED)}`, targetAdmin, {
        method: "DELETE",
        tenant: target,
      })
    );
    expect(res.status).toBe(403);
    expect(await override(target, LOCKED)).toBe(4);
  });

  it("an operator resets it: the target follows the platform default again", async () => {
    const res = await del(op1, LOCKED);
    expect(res.status).toBe(200);
    expect(await override(target, LOCKED)).toBeUndefined();
    await expect(valueIn(target, LOCKED)).resolves.toBe(10);
    const again = await del(op1, LOCKED);
    expect(await again.json()).toMatchObject({ success: true, unchanged: true });
  });

  it("refuses an invalid value, an unknown key, and a platform-scope change on this route", async () => {
    expect((await put(op1, { key: LOCKED, value: "ten" })).status).toBe(422);
    expect((await put(op1, { key: `test.${RUN}.nope`, value: 1 })).status).toBe(404);
    expect((await put(op1, { key: LOCKED, value: 2, scope: "platform" })).status).toBe(
      400
    );
    expect((await put(op1, { value: 2 })).status).toBe(400);
    expect(await override(target, LOCKED)).toBeUndefined();
  });
});

dbDescribe("operator per-tenant settings — approvals and holds are the target's", () => {
  beforeAll(async () => {
    // Two-person approval on, for the target tenant only.
    await q(
      `insert into tenant_config_overrides (tenant_id, key, value)
       values ($1, 'config.require_two_person_approval', 'true')
       on conflict (tenant_id, key) do update set value = excluded.value`,
      [target.id]
    );
  });

  it("a safety key waits for a second operator; the requester cannot approve it", async () => {
    const res = await put(op1, { key: SAFE, value: 5, changeComment: "raise" });
    expect(res.status).toBe(202);
    expect(await override(target, SAFE)).toBeUndefined();
    const pending = (await held()).find((h) => h.label === SAFE);
    expect(pending).toMatchObject({ source: "config-approval" });
    // Not in the operators' own tenant's queue.
    const homeQueue = await adminApprovalsGET(req("/api/admin/approvals", op2));
    expect(
      ((await homeQueue.json()) as { approvals: { label: string }[] }).approvals.map(
        (a) => a.label
      )
    ).not.toContain(SAFE);
    const self = await decide(op1, pending!.id, "config-approval");
    expect(self.status).toBe(409);
    expect((await self.json()).code).toBe("approvals.self_approval");
    const ok = await decide(op2, pending!.id, "config-approval");
    expect(ok.status).toBe(200);
    expect(await override(target, SAFE)).toBe(5);
  });

  it("a reset of a safety key is approved the same way, and removes the value", async () => {
    const res = await del(op1, SAFE);
    expect(res.status).toBe(202);
    expect(await override(target, SAFE)).toBe(5);
    const pending = (await held()).find((h) => h.label === SAFE);
    const rows = await q<{ action: string; scope: string }>(
      "select action, scope from config_pending_approvals where id = $1",
      [pending!.id]
    );
    expect(rows[0]).toEqual({ action: "reset", scope: "tenant" });
    expect((await decide(op2, pending!.id, "config-approval")).status).toBe(200);
    expect(await override(target, SAFE)).toBeUndefined();
  });

  it("a dual-controlled key is held at runtime in the target, and applied when another operator approves", async () => {
    const res = await put(op1, {
      key: DUAL,
      value: false,
      changeComment: "close sign-ups",
    });
    expect(res.status).toBe(202);
    expect(await override(target, DUAL)).toBeUndefined();
    const hold = (await held()).find((h) => h.source === "runtime");
    expect(hold).toBeDefined();
    const self = await decide(op1, hold!.id, "runtime");
    expect((await self.json()).code).toBe("approvals.self_approval");
    const ok = await decide(op2, hold!.id, "runtime");
    expect(ok.status).toBe(200);
    // A safety key under two-person approval: the runtime approval releases it into the
    // second gate, not straight into effect.
    const released = (await ok.json()) as {
      applied: boolean;
      pendingApproval?: { id: string };
    };
    expect(released.applied).toBe(false);
    expect(await override(target, DUAL)).toBeUndefined();
    // Approving the same hold again does not release a second change.
    expect((await decide(op2, hold!.id, "runtime")).status).not.toBe(200);
    const second = (await held()).find(
      (h) => h.source === "config-approval" && h.label === DUAL
    );
    expect(second?.id).toBe(released.pendingApproval!.id);
    expect((await decide(op2, second!.id, "config-approval")).status).toBe(200);
    expect(await override(target, DUAL)).toBe(false);
    expect(await override(home, DUAL)).toBeUndefined();
  });

  it("without two-person approval, approving a runtime hold applies the change at once", async () => {
    await q(
      "update tenant_config_overrides set value = 'false' where tenant_id = $1 and key = 'config.require_two_person_approval'",
      [target.id]
    );
    const res = await put(op1, { key: DUAL, value: true, changeComment: "reopen" });
    expect(res.status).toBe(202);
    const hold = (await held()).find((h) => h.source === "runtime");
    const ok = await decide(op2, hold!.id, "runtime");
    expect(await ok.json()).toMatchObject({ outcome: "approved", applied: true });
    expect(await override(target, DUAL)).toBe(true);
    await q(
      "update tenant_config_overrides set value = 'true' where tenant_id = $1 and key = 'config.require_two_person_approval'",
      [target.id]
    );
  });

  it("rejecting a held change leaves the value as it was", async () => {
    const res = await put(op1, { key: SAFE, value: 7, changeComment: "again" });
    expect(res.status).toBe(202);
    const pending = (await held()).find((h) => h.label === SAFE);
    expect((await decide(op2, pending!.id, "config-approval", "reject")).status).toBe(
      200
    );
    expect(await override(target, SAFE)).toBeUndefined();
  });
});
