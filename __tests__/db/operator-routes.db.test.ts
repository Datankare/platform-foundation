/**
 * @jest-environment node
 */
/**
 * The operator API routes and the tenant's own settings route, on Postgres (ADR-053 D5, D7)
 *
 * Each route handler runs for real against the replayed database: the admin guard, the operator
 * service (platform/tenancy/admin.ts), the Postgres tenant directory and the audit log. Only token
 * verification, the permission lookup, the standing lookup and the rate limiter are test callers
 * (helpers/db-admin.ts). The operator's own tenant is the tenant the request runs in.
 *
 * Asserted per route: anonymous → 401; a tenant administrator (no platform_operate) → 403; an
 * operator → the response and the database state afterwards; coded 400s for bad bodies; coded
 * 404s; the operator rules (own tenant, two-operator deletion, expiry, restore before purge);
 * audit-first (no record, no change).
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
import { logger } from "@/lib/logger";
import { withOwnerTx } from "@/platform/data";
import { CachedTenantDirectory, setTenantDirectory } from "@/platform/tenancy/directory";
import { PostgresTenantDirectory } from "@/platform/tenancy/postgres-directory";
import * as adminSvc from "@/platform/tenancy/admin";
import * as readinessMod from "@/platform/tenancy/readiness";
import { getBudgetTracker } from "@/platform/agents/budget-tracker";
import { GET as tenantGET } from "@/app/api/admin/tenant/route";
import { GET as tenantsGET, POST as tenantsPOST } from "@/app/api/operator/tenants/route";
import { PATCH as tenantPATCH } from "@/app/api/operator/tenants/[id]/route";
import {
  DELETE as domainDELETE,
  POST as domainPOST,
} from "@/app/api/operator/tenants/[id]/domains/route";
import { POST as statePOST } from "@/app/api/operator/tenants/[id]/state/route";
import { POST as deletionPOST } from "@/app/api/operator/tenants/[id]/deletion/route";
import { POST as adminsPOST } from "@/app/api/operator/tenants/[id]/admins/route";
import { GET as exportGET } from "@/app/api/operator/tenants/[id]/export/route";
import { POST as decidePOST } from "@/app/api/operator/deletions/[id]/route";
import { POST as purgePOST } from "@/app/api/operator/purge/route";
import { GET as readinessGET } from "@/app/api/operator/readiness/route";
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
  callerWithUnrecordableId,
  insertUser,
  newRun,
  seededRoleId,
  suiteCaller,
} from "../helpers/db-admin";
import type { TestIdentity } from "../helpers/test-identities";

const RUN = newRun();
let home: TestTenant; // the operators' own tenant
let op1: TestIdentity;
let op2: TestIdentity;
let tenantAdmin: TestIdentity;
let directory: CachedTenantDirectory;
let adminRole: string;
let freeRole: string;
/** Slugs of tenants provisioned through the route (removed in afterAll). */
const provisioned: string[] = [];

type Caller = Parameters<typeof asCallerIn>[0];

const slug = () => `op-${randomUUID().slice(0, 8)}`;
const host = () => `${randomUUID().slice(0, 8)}.operator.test.example`;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const GHOST = "6f1d3c2a-0000-4000-8000-000000000000";

function req(
  path: string,
  caller: Caller,
  options: {
    method?: string;
    body?: unknown;
    raw?: string;
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
    body:
      options.raw ??
      (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
}

async function expectCode(
  res: Response,
  status: number,
  code: string
): Promise<Record<string, unknown>> {
  const body = (await res.json()) as Record<string, unknown>;
  expect({ status: res.status, code: body.code }).toEqual({ status, code });
  return body;
}

async function q<R extends Record<string, unknown>>(
  text: string,
  values: unknown[] = []
): Promise<R[]> {
  return (await withOwnerTx("tenant-lifecycle", (tx) => tx.query<R>(text, values))).rows;
}

const tenantRow = async (id: string) =>
  (
    await q<{
      name: string;
      status: string;
      status_changed_by: string | null;
      status_reason: string | null;
      purge_after: Date | null;
      purged_at: Date | null;
    }>(
      "select name, status, status_changed_by, status_reason, purge_after, purged_at from tenants where id = $1::uuid",
      [id]
    )
  )[0];

const hostsOf = async (id: string) =>
  (
    await q<{ host: string }>(
      "select host from tenant_domains where tenant_id = $1::uuid order by host",
      [id]
    )
  ).map((r) => r.host);

/** The audit rows of operator action `type` naming `key` = `value`, in the operator's tenant. */
async function audits(
  type: string,
  value: string,
  key = "tenantId",
  tenant: TestTenant = home
) {
  return q<{ action: string; actor_id: string; details: Record<string, unknown> }>(
    `select action, actor_id, details from audit_log
      where tenant_id = $1::uuid and details->>'type' = $2 and details->>$3 = $4
      order by created_at, id`,
    [tenant.id, type, key, value]
  );
}

/** The guard: anonymous → 401, a tenant administrator → 403 (no platform_operate). */
async function expectOperatorOnly(call: (caller: Caller) => Promise<Response>) {
  await expectCode(await call("anonymous"), 401, "auth.required");
  const denied = await expectCode(await call(tenantAdmin), 403, "auth.permission_denied");
  expect(denied.params).toEqual({ permission: "platform_operate" });
}

async function requestDeletion(tenantId: string, by: Caller = op1) {
  const res = await deletionPOST(
    req(`/api/operator/tenants/${tenantId}/deletion`, by, {
      method: "POST",
      body: { reason: "Customer left" },
    }),
    ctx(tenantId)
  );
  expect(res.status).toBe(202);
  return ((await res.json()) as { result: { id: string } }).result.id;
}

const decide = (requestId: string, by: Caller, body: unknown, tenant?: TestTenant) =>
  decidePOST(
    req(`/api/operator/deletions/${requestId}`, by, { method: "POST", body, tenant }),
    ctx(requestId)
  );

const changeState = (tenantId: string, action: string, by: Caller = op1) =>
  statePOST(
    req(`/api/operator/tenants/${tenantId}/state`, by, {
      method: "POST",
      body: { action, reason: "Operator test" },
    }),
    ctx(tenantId)
  );

/** A deleted test tenant (requested by op1, approved by op2). */
async function deletedTenant(): Promise<TestTenant> {
  const t = await createTestTenant();
  const id = await requestDeletion(t.id);
  expect((await decide(id, op2, { decision: "approve" })).status).toBe(200);
  return t;
}

// Once per file; nothing connects when the database is absent.
if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    directory = new CachedTenantDirectory(new PostgresTenantDirectory());
    setTenantDirectory(directory);
    home = await createTestTenant();
    const superRole = await seededRoleId("super_admin");
    adminRole = await seededRoleId("admin");
    freeRole = await seededRoleId("free");
    op1 = suiteCaller("super_admin", RUN, { name: "op1" });
    op2 = suiteCaller("super_admin", RUN, { name: "op2" });
    tenantAdmin = suiteCaller("admin", RUN);
    await insertUser(home, { id: op1.userId, roleId: superRole });
    await insertUser(home, { id: op2.userId, roleId: superRole });
    await insertUser(home, { id: tenantAdmin.userId, roleId: adminRole });
  });
  afterAll(async () => {
    await withOwnerTx("tenant-lifecycle", async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "select id from tenants where slug = any($1::text[])",
        [provisioned]
      );
      for (const { id } of rows) {
        await tx.query(
          "update tenants set status = 'deleted', purge_after = now() where id = $1 and status <> 'deleted'",
          [id]
        );
        await tx.query("select * from public.tenant_purge($1::uuid)", [id]);
        await tx.query("delete from tenants where id = $1", [id]);
      }
    });
    await dropTestTenants();
    await disconnectTestDatabase();
  });
  afterEach(() => directory.clear());
}

const SUITE = "operator routes (ADR-053 D7)";

dbDescribe(`${SUITE} GET /api/admin/tenant`, () => {
  let t: TestTenant;
  let admin: TestIdentity;
  let free: TestIdentity;
  let h: string;
  beforeAll(async () => {
    t = await createTestTenant();
    admin = suiteCaller("admin", RUN, { name: "own-admin" });
    free = suiteCaller("free", RUN);
    await insertUser(t, { id: admin.userId, roleId: adminRole });
    await insertUser(t, { id: free.userId, roleId: freeRole });
    h = host();
    await q("insert into tenant_domains (host, tenant_id) values ($1, $2::uuid)", [
      h,
      t.id,
    ]);
    await q(
      `insert into tenant_config_overrides (tenant_id, key, value) values ($1::uuid, 'default_language', '"de"')`,
      [t.id]
    );
  });

  const get = (caller: Caller, mode?: "single" | "shared") =>
    tenantGET(req("/api/admin/tenant", caller, { tenant: t, mode }));

  it("refuses the anonymous and callers without admin access", async () => {
    await expectCode(await get("anonymous"), 401, "auth.required");
    await expectCode(await get(free), 403, "auth.permission_denied");
  });

  it("shows the tenant, its own addresses, budget and tenant-settable settings (shared)", async () => {
    const res = await get(admin);
    expect(res.status).toBe(200);
    const body = await res.json();
    const slugRow = (
      await q<{ slug: string; name: string }>(
        "select slug, name from tenants where id = $1::uuid",
        [t.id]
      )
    )[0];
    expect(body.tenant).toEqual({
      id: t.id,
      mode: "shared",
      slug: slugRow.slug,
      name: slugRow.name,
      status: "active",
    });
    expect(body.domains).toEqual([{ host: h, createdAt: expect.any(String) }]);
    expect(body.budget).toEqual(
      expect.objectContaining({
        tenantId: t.id,
        period: expect.any(String),
        usedUsd: expect.any(Number),
        budgetUsd: expect.any(Number),
        exhausted: expect.any(Boolean),
      })
    );
    const overridable = new Set(
      (
        await q<{ key: string }>(
          "select key from platform_config where tenant_overridable"
        )
      ).map((r) => r.key)
    );
    const keys = (body.settings as { key: string }[]).map((s) => s.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys)).toEqual(overridable);
    expect(
      body.settings.find((s: { key: string }) => s.key === "default_language")
    ).toEqual(
      expect.objectContaining({
        value: "de",
        platformValue: "en",
        overridden: true,
        valueType: "string",
      })
    );
    expect(
      body.settings.find((s: { key: string }) => s.key === "signups_enabled")
    ).toMatchObject({ overridden: false });
  });

  it("answers in a single deployment too", async () => {
    const res = await get(admin, "single");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenant).toMatchObject({ id: t.id, mode: "single", status: "active" });
    expect(body.domains.map((d: { host: string }) => d.host)).toEqual([h]);
  });

  it("shows its own name and slug even when the directory cache holds only its state", async () => {
    // Request resolution reads the tenant outside it (state only) and caches that answer.
    directory.clear();
    const cached = await directory.getTenant(t.id);
    expect(cached).toMatchObject({ status: "active", slug: null, name: null });
    const body = await (await get(admin)).json();
    expect(body.tenant.slug).toEqual(expect.any(String));
    expect(body.tenant.name).toEqual(expect.any(String));
  });

  it("answers a coded 500 when a read fails", async () => {
    const tracker = getBudgetTracker();
    const spy = jest
      .spyOn(tracker, "getTenantStatus")
      .mockRejectedValueOnce(new Error("down"));
    try {
      await expectCode(await get(admin), 500, "internal.error");
    } finally {
      spy.mockRestore();
    }
  });
});

dbDescribe(`${SUITE} /api/operator/tenants`, () => {
  const provision = (body: unknown, caller: Caller = op1, raw?: string) =>
    tenantsPOST(req("/api/operator/tenants", caller, { method: "POST", body, raw }));

  it("is operators' only", async () => {
    await expectOperatorOnly((c) => tenantsGET(req("/api/operator/tenants", c)));
    await expectOperatorOnly((c) => provision({ slug: slug(), name: "Nope Co" }, c));
  });

  it("provisions an active tenant with normalised addresses, recorded first", async () => {
    const s = slug();
    provisioned.push(s);
    const h = host();
    const res = await provision({
      slug: s,
      name: "  Acme   Co ",
      domains: [h.toUpperCase(), `${h}:8443`, `${h}.`],
    });
    expect(res.status).toBe(201);
    const { result } = await res.json();
    expect(result).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        slug: s,
        name: "Acme Co",
        status: "active",
        domains: [h],
      })
    );
    expect(await tenantRow(result.id)).toMatchObject({
      name: "Acme Co",
      status: "active",
    });
    expect(await hostsOf(result.id)).toEqual([h]);
    const rows = await audits("tenant_provisioned", result.id);
    expect(rows).toEqual([
      expect.objectContaining({
        action: "admin_action",
        actor_id: op1.userId,
        details: expect.objectContaining({ slug: s, hosts: [h], outcome: "attempted" }),
      }),
    ]);
  });

  it("lists every tenant with addresses, user count and pending deletion", async () => {
    const t = await createTestTenant();
    await t.user("a");
    await t.user("b");
    const h = host();
    await q("insert into tenant_domains (host, tenant_id) values ($1, $2::uuid)", [
      h,
      t.id,
    ]);
    const requestId = await requestDeletion(t.id);
    const res = await tenantsGET(req("/api/operator/tenants", op1));
    expect(res.status).toBe(200);
    const { tenants } = await res.json();
    expect(tenants.find((x: { id: string }) => x.id === t.id)).toEqual(
      expect.objectContaining({
        status: "active",
        domains: [h],
        userCount: 2,
        pendingDeletion: { requestId, requestedBy: op1.userId },
      })
    );
    expect(tenants.find((x: { id: string }) => x.id === home.id)).toMatchObject({
      userCount: 3,
    });
    expect(
      tenants.find((x: { id: string }) => x.id === home.id).pendingDeletion
    ).toBeUndefined();
  });

  it("refuses malformed bodies with coded 400s", async () => {
    await expectCode(
      await provision(undefined, op1, "{nope"),
      400,
      "request.invalid_json"
    );
    await expectCode(await provision(["a"]), 400, "request.invalid_body");
    await expectCode(await provision({ name: "No Slug" }), 400, "request.missing_fields");
    await expectCode(
      await provision({ slug: slug(), name: 7 }),
      400,
      "request.missing_fields"
    );
    await expectCode(
      await provision({ slug: slug(), name: "Co", domains: "a.example" }),
      400,
      "request.invalid_body"
    );
    await expectCode(
      await provision({ slug: slug(), name: "Co", domains: [1] }),
      400,
      "request.invalid_body"
    );
    await expectCode(
      await provision({
        slug: slug(),
        name: "Co",
        domains: Array.from({ length: 21 }, () => host()),
      }),
      400,
      "request.invalid_body"
    );
    const bad = slug();
    await expectCode(
      await provision({ slug: "Bad Slug", name: "Co" }),
      400,
      "tenant.invalid"
    );
    await expectCode(await provision({ slug: bad, name: "x" }), 400, "tenant.invalid");
    await expectCode(
      await provision({ slug: bad, name: "Co", domains: ["not a host"] }),
      400,
      "tenant.invalid"
    );
    expect(await q("select 1 from tenants where slug = $1", [bad])).toEqual([]);
  });

  it("refuses a taken slug, and reports a taken address after creating the tenant", async () => {
    const s = slug();
    provisioned.push(s);
    const h = host();
    expect((await provision({ slug: s, name: "First Co", domains: [h] })).status).toBe(
      201
    );
    const dupe = await expectCode(
      await provision({ slug: s, name: "Again Co" }),
      409,
      "tenant.conflict"
    );
    expect(dupe.params).toEqual({ reason: "Tenant slug is taken" });
    const s2 = slug();
    provisioned.push(s2);
    await expectCode(
      await provision({ slug: s2, name: "Second Co", domains: [h] }),
      409,
      "tenant.conflict"
    );
    const second = await q<{ id: string; status: string }>(
      "select id, status from tenants where slug = $1",
      [s2]
    );
    expect(second).toEqual([{ id: expect.any(String), status: "active" }]);
    expect(await hostsOf(second[0].id)).toEqual([]);
  });

  it("answers coded 500s when the service fails", async () => {
    const list = jest
      .spyOn(adminSvc, "listTenantOverviews")
      .mockRejectedValueOnce(new Error("down"));
    const prov = jest
      .spyOn(adminSvc, "provisionTenant")
      .mockRejectedValueOnce(new Error("down"));
    try {
      await expectCode(
        await tenantsGET(req("/api/operator/tenants", op1)),
        500,
        "internal.error"
      );
      await expectCode(
        await provision({ slug: slug(), name: "Co" }),
        500,
        "internal.error"
      );
    } finally {
      list.mockRestore();
      prov.mockRestore();
    }
  });
});

dbDescribe(`${SUITE} PATCH /api/operator/tenants/[id]`, () => {
  let t: TestTenant;
  beforeAll(async () => {
    t = await createTestTenant();
  });
  const rename = (id: string, body: unknown, caller: Caller = op1, raw?: string) =>
    tenantPATCH(
      req(`/api/operator/tenants/${id}`, caller, { method: "PATCH", body, raw }),
      ctx(id)
    );

  it("is operators' only", async () => {
    await expectOperatorOnly((c) => rename(t.id, { name: "Hijack Co" }, c));
    expect((await tenantRow(t.id)).name).toMatch(/^Test /);
  });

  it("renames, recorded first", async () => {
    const res = await rename(t.id, { name: " Renamed   Co " });
    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({ id: t.id, name: "Renamed Co" });
    expect((await tenantRow(t.id)).name).toBe("Renamed Co");
    expect(await audits("tenant_renamed", t.id)).toHaveLength(1);
  });

  it("refuses bad input and unknown tenants", async () => {
    await expectCode(
      await rename(t.id, undefined, op1, "nope"),
      400,
      "request.invalid_json"
    );
    await expectCode(await rename(t.id, {}), 400, "request.missing_fields");
    await expectCode(await rename(t.id, { name: "x" }), 400, "tenant.invalid");
    await expectCode(
      await rename("not-a-uuid", { name: "Valid Co" }),
      404,
      "tenant.not_found"
    );
    await expectCode(await rename(GHOST, { name: "Valid Co" }), 404, "tenant.not_found");
    expect((await tenantRow(t.id)).name).toBe("Renamed Co");
  });

  it("answers a coded 500 when the service fails", async () => {
    const spy = jest
      .spyOn(adminSvc, "renameTenant")
      .mockRejectedValueOnce(new Error("x"));
    try {
      await expectCode(await rename(t.id, { name: "Valid Co" }), 500, "internal.error");
    } finally {
      spy.mockRestore();
    }
  });
});

dbDescribe(`${SUITE} /api/operator/tenants/[id]/domains`, () => {
  let t: TestTenant;
  let other: TestTenant;
  beforeAll(async () => {
    t = await createTestTenant();
    other = await createTestTenant();
  });
  const add = (id: string, body: unknown, caller: Caller = op1, raw?: string) =>
    domainPOST(
      req(`/api/operator/tenants/${id}/domains`, caller, { method: "POST", body, raw }),
      ctx(id)
    );
  const remove = (id: string, hostParam: string | null, caller: Caller = op1) =>
    domainDELETE(
      req(
        `/api/operator/tenants/${id}/domains${
          hostParam === null ? "" : `?host=${encodeURIComponent(hostParam)}`
        }`,
        caller,
        { method: "DELETE" }
      ),
      ctx(id)
    );

  it("is operators' only", async () => {
    await expectOperatorOnly((c) => add(t.id, { host: host() }, c));
    await expectOperatorOnly((c) => remove(t.id, host(), c));
    expect(await hostsOf(t.id)).toEqual([]);
  });

  it("maps a normalised host, recorded first; a host serves one tenant", async () => {
    const h = host();
    const res = await add(t.id, { host: `${h.toUpperCase()}:443` });
    expect(res.status).toBe(201);
    expect((await res.json()).result).toEqual({
      host: h,
      tenantId: t.id,
      createdAt: expect.any(String),
    });
    expect(await hostsOf(t.id)).toEqual([h]);
    expect(await audits("tenant_domain_added", t.id)).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ host: h }) }),
    ]);
    await expectCode(await add(other.id, { host: h }), 409, "tenant.conflict");
    expect(await hostsOf(other.id)).toEqual([]);
  });

  it("refuses bad input and unknown tenants", async () => {
    await expectCode(await add(t.id, undefined, op1, "{"), 400, "request.invalid_json");
    await expectCode(await add(t.id, { host: 5 }), 400, "request.missing_fields");
    await expectCode(await add(t.id, { host: "10.0.0.1" }), 400, "tenant.invalid");
    await expectCode(await add("not-a-uuid", { host: host() }), 404, "tenant.not_found");
    await expectCode(await add(GHOST, { host: host() }), 404, "tenant.not_found");
  });

  it("unmaps a host, recorded first; an unmapped host is not found", async () => {
    const h = host();
    expect((await add(t.id, { host: h })).status).toBe(201);
    await expectCode(await remove(other.id, h), 404, "tenant.not_found");
    const res = await remove(t.id, h.toUpperCase());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: true });
    expect(await hostsOf(t.id)).not.toContain(h);
    expect(
      (await audits("tenant_domain_removed", t.id)).map((r) => r.details.outcome)
    ).toEqual(["attempted"]);
    await expectCode(await remove(t.id, h), 404, "tenant.not_found");
    await expectCode(await remove(t.id, null), 400, "request.missing_fields");
    await expectCode(await remove(t.id, "bad host"), 400, "tenant.invalid");
    await expectCode(await remove("not-a-uuid", h), 404, "tenant.not_found");
  });

  it("never removes the last address of the operators' own tenant; others' freely", async () => {
    // The operators act from `home`: its last address would lock everyone out of it.
    const first = host();
    const second = host();
    await q("insert into tenant_domains (host, tenant_id) values ($1, $2::uuid)", [
      first,
      home.id,
    ]);
    const attempts = async () =>
      (await audits("tenant_domain_removed", home.id)).filter(
        (r) => r.details.outcome === "attempted"
      ).length;
    const before = await attempts();
    await q("insert into tenant_domains (host, tenant_id) values ($1, $2::uuid)", [
      second,
      home.id,
    ]);
    // Two at once: exactly one may go — the other is then the last.
    const both = await Promise.all([remove(home.id, first), remove(home.id, second)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 403]);
    const left = await hostsOf(home.id);
    expect(left).toHaveLength(1);
    await expectCode(await remove(home.id, left[0]), 403, "tenant.own_tenant");
    expect(await hostsOf(home.id)).toEqual(left);
    expect(await attempts()).toBe(before + 3); // each attempt recorded first
    // Another tenant's last address is the operator's to remove.
    const h = host();
    expect((await add(t.id, { host: h })).status).toBe(201);
    for (const x of await hostsOf(t.id)) if (x !== h) await remove(t.id, x);
    expect((await remove(t.id, h)).status).toBe(200);
    expect(await hostsOf(t.id)).toEqual([]);
    await q("delete from tenant_domains where tenant_id = $1::uuid", [home.id]);
  });

  it("answers coded 500s when the service fails", async () => {
    const a = jest
      .spyOn(adminSvc, "addTenantDomain")
      .mockRejectedValueOnce(new Error("x"));
    const r = jest
      .spyOn(adminSvc, "removeTenantDomain")
      .mockRejectedValueOnce(new Error("x"));
    try {
      await expectCode(await add(t.id, { host: host() }), 500, "internal.error");
      await expectCode(await remove(t.id, host()), 500, "internal.error");
    } finally {
      a.mockRestore();
      r.mockRestore();
    }
  });
});

dbDescribe(`${SUITE} POST /api/operator/tenants/[id]/state`, () => {
  let t: TestTenant;
  beforeAll(async () => {
    t = await createTestTenant();
  });
  const post = (id: string, body: unknown, raw?: string) =>
    statePOST(
      req(`/api/operator/tenants/${id}/state`, op1, { method: "POST", body, raw }),
      ctx(id)
    );

  it("is operators' only", async () => {
    await expectOperatorOnly((c) => changeState(t.id, "suspend", c));
    expect((await tenantRow(t.id)).status).toBe("active");
  });

  it("refuses bad bodies, unknown actions and bad reasons", async () => {
    await expectCode(await post(t.id, undefined, "]"), 400, "request.invalid_json");
    await expectCode(
      await post(t.id, { action: "suspend" }),
      400,
      "request.missing_fields"
    );
    await expectCode(
      await post(t.id, { reason: "why not" }),
      400,
      "request.missing_fields"
    );
    for (const action of ["explode", "constructor", "__proto__"]) {
      await expectCode(
        await post(t.id, { action, reason: "Operator test" }),
        400,
        "request.invalid_body"
      );
    }
    for (const action of ["suspend", "resume", "restore"]) {
      await expectCode(await post(t.id, { action, reason: "no" }), 400, "tenant.invalid");
    }
    expect((await tenantRow(t.id)).status).toBe("active");
  });

  it("never suspends the operator's own tenant", async () => {
    await expectCode(await changeState(home.id, "suspend"), 403, "tenant.own_tenant");
    expect((await tenantRow(home.id)).status).toBe("active");
  });

  it("suspends and resumes, each recorded first; the wrong state is a conflict", async () => {
    const res = await changeState(t.id, "suspend");
    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({
      id: t.id,
      status: "suspended",
      statusChangedBy: op1.userId,
      statusReason: "Operator test",
    });
    expect(await tenantRow(t.id)).toMatchObject({
      status: "suspended",
      status_changed_by: op1.userId,
      status_reason: "Operator test",
    });
    expect(await audits("tenant_suspended", t.id)).toEqual([
      expect.objectContaining({
        actor_id: op1.userId,
        details: expect.objectContaining({
          reason: "Operator test",
          outcome: "attempted",
        }),
      }),
    ]);
    const again = await expectCode(
      await changeState(t.id, "suspend"),
      409,
      "tenant.conflict"
    );
    expect(again.params).toEqual({ reason: "The tenant is suspended, not active." });
    expect(
      (await audits("tenant_suspended", t.id)).map((r) => r.details.outcome)
    ).toEqual(["attempted", "attempted", "failed"]);
    expect((await changeState(t.id, "resume")).status).toBe(200);
    expect((await tenantRow(t.id)).status).toBe("active");
    await expectCode(await changeState(t.id, "resume"), 409, "tenant.conflict");
    await expectCode(await changeState(t.id, "restore"), 409, "tenant.conflict");
    expect((await tenantRow(t.id)).status).toBe("active");
  });

  it("answers not found for unknown tenants", async () => {
    for (const action of ["suspend", "resume", "restore"]) {
      await expectCode(await changeState("not-a-uuid", action), 404, "tenant.not_found");
      await expectCode(await changeState(GHOST, action), 404, "tenant.not_found");
    }
  });

  it("restores a deleted tenant, not yet purged, as suspended", async () => {
    const d = await deletedTenant();
    expect((await tenantRow(d.id)).status).toBe("deleted");
    const res = await changeState(d.id, "restore");
    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({ id: d.id, status: "suspended" });
    expect(await tenantRow(d.id)).toMatchObject({
      status: "suspended",
      purge_after: null,
    });
    expect(await audits("tenant_restored", d.id)).toHaveLength(1);
  });

  it("answers a coded 500 when the directory fails; the attempt stays recorded", async () => {
    // The route binds its actions at load, so the failure is injected beneath the service.
    const spy = jest
      .spyOn(directory, "setStatus")
      .mockRejectedValueOnce(new Error("down"));
    const before = (await audits("tenant_suspended", t.id)).length;
    try {
      await expectCode(await changeState(t.id, "suspend"), 500, "internal.error");
    } finally {
      spy.mockRestore();
    }
    expect(
      (await audits("tenant_suspended", t.id)).slice(before).map((r) => r.details.outcome)
    ).toEqual(["attempted", "failed"]);
    expect((await tenantRow(t.id)).status).toBe("active");
  });
});

dbDescribe(`${SUITE} POST /api/operator/tenants/[id]/deletion`, () => {
  const ask = (id: string, body: unknown, caller: Caller = op1, raw?: string) =>
    deletionPOST(
      req(`/api/operator/tenants/${id}/deletion`, caller, { method: "POST", body, raw }),
      ctx(id)
    );
  const requests = (tenantId: string) =>
    q<{ id: string; status: string; created_at: Date; expires_at: Date }>(
      "select id, status, created_at, expires_at from tenant_lifecycle_requests where tenant_id = $1::uuid order by created_at",
      [tenantId]
    );

  it("is operators' only", async () => {
    const t = await createTestTenant();
    await expectOperatorOnly((c) => ask(t.id, { reason: "Customer left" }, c));
    expect(await requests(t.id)).toEqual([]);
  });

  it("refuses bad bodies, unknown tenants and the operator's own tenant", async () => {
    const t = await createTestTenant();
    await expectCode(await ask(t.id, undefined, op1, "x"), 400, "request.invalid_json");
    await expectCode(await ask(t.id, {}), 400, "request.missing_fields");
    await expectCode(await ask(t.id, { reason: "no" }), 400, "tenant.invalid");
    await expectCode(
      await ask("not-a-uuid", { reason: "Gone" }),
      404,
      "tenant.not_found"
    );
    await expectCode(await ask(GHOST, { reason: "Gone" }), 404, "tenant.not_found");
    await expectCode(await ask(home.id, { reason: "Gone" }), 403, "tenant.own_tenant");
    expect(await requests(t.id)).toEqual([]);
    expect(await requests(home.id)).toEqual([]);
  });

  it("opens one request, for 7 days, recorded first; a second is a conflict", async () => {
    const t = await createTestTenant();
    const res = await ask(t.id, { reason: "  Customer left  " });
    expect(res.status).toBe(202);
    const { result } = await res.json();
    expect(result).toEqual({
      id: expect.any(String),
      tenantId: t.id,
      requestedBy: op1.userId,
      reason: "Customer left",
      status: "pending",
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
    });
    const [row] = await requests(t.id);
    expect(row).toMatchObject({ id: result.id, status: "pending" });
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(
      7 * 24 * 3600 * 1000
    );
    expect(await audits("tenant_deletion_requested", t.id)).toEqual([
      expect.objectContaining({ actor_id: op1.userId }),
    ]);
    await expectCode(await ask(t.id, { reason: "Again" }, op2), 409, "tenant.conflict");
    expect((await tenantRow(t.id)).status).toBe("active");
  });

  it("lets an expired request lapse, so a new one can be opened", async () => {
    const t = await createTestTenant();
    const first = await requestDeletion(t.id);
    await q(
      "update tenant_lifecycle_requests set expires_at = now() - interval '1 minute' where id = $1::uuid",
      [first]
    );
    const second = await requestDeletion(t.id, op2);
    expect(await requests(t.id)).toEqual([
      expect.objectContaining({ id: first, status: "expired" }),
      expect.objectContaining({ id: second, status: "pending" }),
    ]);
  });

  it("refuses a tenant already deleted", async () => {
    const d = await deletedTenant();
    await expectCode(await ask(d.id, { reason: "Again" }), 409, "tenant.conflict");
  });

  it("answers a coded 500 when the service fails", async () => {
    const spy = jest
      .spyOn(adminSvc, "requestTenantDeletion")
      .mockRejectedValueOnce(new Error("x"));
    try {
      await expectCode(await ask(GHOST, { reason: "Gone" }), 500, "internal.error");
    } finally {
      spy.mockRestore();
    }
  });
});

dbDescribe(`${SUITE} POST /api/operator/deletions/[id]`, () => {
  const statusOf = async (requestId: string) =>
    (
      await q<{
        status: string;
        decided_by: string | null;
        decision_note: string | null;
      }>(
        "select status, decided_by, decision_note from tenant_lifecycle_requests where id = $1::uuid",
        [requestId]
      )
    )[0];

  it("is operators' only", async () => {
    const t = await createTestTenant();
    const id = await requestDeletion(t.id);
    await expectOperatorOnly((c) => decide(id, c, { decision: "approve" }));
    expect((await statusOf(id)).status).toBe("pending");
  });

  it("refuses bad bodies and unknown requests", async () => {
    const t = await createTestTenant();
    const id = await requestDeletion(t.id);
    const raw = decidePOST(
      req(`/api/operator/deletions/${id}`, op2, { method: "POST", raw: "{" }),
      ctx(id)
    );
    await expectCode(await raw, 400, "request.invalid_json");
    await expectCode(await decide(id, op2, {}), 400, "request.missing_fields");
    await expectCode(
      await decide(id, op2, { decision: "maybe" }),
      400,
      "request.missing_fields"
    );
    await expectCode(
      await decide(id, op2, { decision: "approve", note: 3 }),
      400,
      "request.invalid_body"
    );
    await expectCode(
      await decide("nope", op2, { decision: "approve" }),
      404,
      "tenant.not_found"
    );
    await expectCode(
      await decide(GHOST, op2, { decision: "reject" }),
      404,
      "tenant.not_found"
    );
    expect((await statusOf(id)).status).toBe("pending");
  });

  it("refuses self-approval; a second operator's approval deletes the tenant", async () => {
    const t = await createTestTenant();
    const id = await requestDeletion(t.id);
    await expectCode(
      await decide(id, op1, { decision: "approve" }),
      403,
      "tenant.self_approval"
    );
    expect((await statusOf(id)).status).toBe("pending");
    expect((await tenantRow(t.id)).status).toBe("active");

    const res = await decide(id, op2, { decision: "approve", note: "Confirmed" });
    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({
      id,
      tenantId: t.id,
      status: "executed",
      requestedBy: op1.userId,
    });
    expect(await statusOf(id)).toEqual({
      status: "executed",
      decided_by: op2.userId,
      decision_note: "Confirmed",
    });
    const row = await tenantRow(t.id);
    expect(row.status).toBe("deleted");
    const days = (row.purge_after!.getTime() - Date.now()) / (24 * 3600 * 1000);
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    // The refused self-approval is recorded too (attempted, then failed), then op2's.
    expect(
      (await audits("tenant_deletion_approved", id, "requestId")).map((r) => [
        r.actor_id,
        r.details.outcome,
      ])
    ).toEqual([
      [op1.userId, "attempted"],
      [op1.userId, "failed"],
      [op2.userId, "attempted"],
    ]);
    await expectCode(
      await decide(id, op2, { decision: "approve" }),
      409,
      "tenant.conflict"
    );
  });

  it("lets the requester reject (withdraw) their own request", async () => {
    const t = await createTestTenant();
    const id = await requestDeletion(t.id);
    const res = await decide(id, op1, { decision: "reject" });
    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({ id, status: "rejected" });
    expect(await statusOf(id)).toEqual({
      status: "rejected",
      decided_by: op1.userId,
      decision_note: "",
    });
    expect((await tenantRow(t.id)).status).toBe("active");
  });

  it("refuses an expired request, and marks it expired", async () => {
    const t = await createTestTenant();
    const id = await requestDeletion(t.id);
    await q(
      "update tenant_lifecycle_requests set expires_at = now() - interval '1 second' where id = $1::uuid",
      [id]
    );
    const body = await expectCode(
      await decide(id, op2, { decision: "approve" }),
      409,
      "tenant.conflict"
    );
    expect(body.params).toEqual({ reason: "The request has expired." });
    expect((await statusOf(id)).status).toBe("expired");
    expect((await tenantRow(t.id)).status).toBe("active");
  });

  it("refuses approval from the tenant being deleted", async () => {
    const t = await createTestTenant();
    const id = await requestDeletion(t.id);
    await expectCode(
      await decide(id, op2, { decision: "approve" }, t),
      403,
      "tenant.own_tenant"
    );
    expect((await statusOf(id)).status).toBe("pending");
    expect((await tenantRow(t.id)).status).toBe("active");
  });

  it("answers a coded 500 when the service fails", async () => {
    const spy = jest
      .spyOn(adminSvc, "decideTenantDeletion")
      .mockRejectedValueOnce(new Error("x"));
    try {
      await expectCode(
        await decide(GHOST, op2, { decision: "reject" }),
        500,
        "internal.error"
      );
    } finally {
      spy.mockRestore();
    }
  });
});

dbDescribe(`${SUITE} POST /api/operator/purge`, () => {
  const purge = (caller: Caller = op1) =>
    purgePOST(req("/api/operator/purge", caller, { method: "POST" }));

  it("is operators' only", async () => {
    await expectOperatorOnly((c) => purge(c));
  });

  it("purges a deleted tenant whose time has passed; it can no longer be restored", async () => {
    const d = await deletedTenant();
    await d.user("a");
    await d.user("b");
    const h = host();
    await q("insert into tenant_domains (host, tenant_id) values ($1, $2::uuid)", [
      h,
      d.id,
    ]);
    const notDue = await deletedTenant();
    await notDue.user("kept");
    await q(
      "update tenants set purge_after = now() - interval '1 minute' where id = $1::uuid",
      [d.id]
    );
    const res = await purge();
    expect(res.status).toBe(200);
    const { result } = await res.json();
    expect(Array.isArray(result)).toBe(true);
    for (const r of result)
      expect(r).toEqual({ tenantId: expect.any(String), rows: expect.any(Number) });
    // Another suite's purge may run first; either way this tenant is purged exactly once.
    const mine = result.find((r: { tenantId: string }) => r.tenantId === d.id);
    if (mine) expect(mine.rows).toBeGreaterThanOrEqual(2);
    expect(
      result.find((r: { tenantId: string }) => r.tenantId === notDue.id)
    ).toBeUndefined();
    expect((await tenantRow(d.id)).purged_at).toBeInstanceOf(Date);
    expect(await q("select 1 from users where tenant_id = $1::uuid", [d.id])).toEqual([]);
    expect(await hostsOf(d.id)).toEqual([]);
    expect(
      await q("select 1 from users where tenant_id = $1::uuid", [notDue.id])
    ).toHaveLength(1);
    expect((await tenantRow(notDue.id)).purged_at).toBeNull();
    if (mine) expect(await audits("tenant_purged", d.id)).toHaveLength(1);

    const restore = await expectCode(
      await changeState(d.id, "restore"),
      409,
      "tenant.conflict"
    );
    expect(restore.params).toEqual({
      reason: "The tenant's data has been purged; it cannot be restored.",
    });
    expect((await tenantRow(d.id)).status).toBe("deleted");
  });

  it("answers a coded 500 when the service fails", async () => {
    const spy = jest
      .spyOn(adminSvc, "purgeDueTenants")
      .mockRejectedValueOnce(new Error("x"));
    try {
      await expectCode(await purge(), 500, "internal.error");
    } finally {
      spy.mockRestore();
    }
  });
});

dbDescribe(`${SUITE} POST /api/operator/tenants/[id]/admins`, () => {
  let t: TestTenant;
  let other: TestTenant;
  let user: string;
  const mail = (label: string) => `${label}-${RUN}@admins.test`;
  beforeAll(async () => {
    t = await createTestTenant();
    other = await createTestTenant();
    user = await insertUser(t, {
      roleId: freeRole,
      email: mail("first"),
      emailVerified: true,
    });
    await insertUser(other, {
      roleId: freeRole,
      email: mail("elsewhere"),
      emailVerified: true,
    });
  });
  const grant = (id: string, body: unknown, caller: Caller = op1, raw?: string) =>
    adminsPOST(
      req(`/api/operator/tenants/${id}/admins`, caller, { method: "POST", body, raw }),
      ctx(id)
    );
  const roleOf = async (id: string) =>
    (
      await q<{ role_id: string }>("select role_id from users where id = $1::uuid", [id])
    )[0].role_id;

  it("is operators' only", async () => {
    await expectOperatorOnly((c) => grant(t.id, { email: mail("first") }, c));
    expect(await roleOf(user)).toBe(freeRole);
  });

  it("refuses bad input, unknown tenants and users of other tenants", async () => {
    await expectCode(await grant(t.id, undefined, op1, "?"), 400, "request.invalid_json");
    await expectCode(await grant(t.id, {}), 400, "request.missing_fields");
    await expectCode(await grant(t.id, { email: "not-an-email" }), 400, "tenant.invalid");
    await expectCode(
      await grant("nope", { email: mail("first") }),
      404,
      "tenant.not_found"
    );
    await expectCode(
      await grant(t.id, { email: mail("elsewhere") }),
      404,
      "tenant.not_found"
    );
    await expectCode(
      await grant(t.id, { email: mail("nobody") }),
      404,
      "tenant.not_found"
    );
    expect(await roleOf(user)).toBe(freeRole);
  });

  it("makes the tenant's user its administrator, recorded first", async () => {
    const res = await grant(t.id, { email: `  ${mail("first").toUpperCase()} ` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { userId: user } });
    expect(await roleOf(user)).toBe(adminRole);
    expect(
      (await audits("tenant_admin_granted", t.id))
        .filter((r) => r.details.email === mail("first"))
        .map((r) => r.details.outcome)
    ).toEqual(["attempted"]);
  });

  it("refuses, as a conflict, an email two live accounts share and one never verified", async () => {
    const twinA = await insertUser(t, {
      roleId: freeRole,
      email: mail("twin"),
      emailVerified: true,
    });
    const twinB = await insertUser(t, {
      roleId: freeRole,
      email: mail("twin").toUpperCase(),
      emailVerified: true,
    });
    const shared = await grant(t.id, { email: mail("twin") });
    await expectCode(shared, 409, "tenant.conflict");
    const unverified = await insertUser(t, {
      roleId: freeRole,
      email: mail("unverified"),
    });
    await expectCode(
      await grant(t.id, { email: mail("unverified") }),
      409,
      "tenant.conflict"
    );
    for (const id of [twinA, twinB, unverified]) expect(await roleOf(id)).toBe(freeRole);
  });

  it("answers a coded 500 when the service fails", async () => {
    const spy = jest
      .spyOn(adminSvc, "makeTenantAdmin")
      .mockRejectedValueOnce(new Error("x"));
    try {
      await expectCode(
        await grant(t.id, { email: mail("first") }),
        500,
        "internal.error"
      );
    } finally {
      spy.mockRestore();
    }
  });
});

dbDescribe(`${SUITE} GET /api/operator/tenants/[id]/export`, () => {
  let t: TestTenant;
  let h: string;
  let users: string[];
  beforeAll(async () => {
    t = await createTestTenant();
    users = [await t.user("a"), await t.user("b")];
    h = host();
    await q("insert into tenant_domains (host, tenant_id) values ($1, $2::uuid)", [
      h,
      t.id,
    ]);
  });
  const exp = (id: string, caller: Caller = op1) =>
    exportGET(req(`/api/operator/tenants/${id}/export`, caller), ctx(id));
  const lines = async (res: Response) =>
    (await res.text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it("is operators' only", async () => {
    await expectOperatorOnly((c) => exp(t.id, c));
    expect(await audits("tenant_exported", t.id)).toEqual([]);
  });

  it("answers not found for unknown tenants", async () => {
    await expectCode(await exp("not-a-uuid"), 404, "tenant.not_found");
    await expectCode(await exp(GHOST), 404, "tenant.not_found");
  });

  it("streams every row of the tenant as NDJSON, recorded first", async () => {
    const res = await exp(t.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="tenant-${t.id}.ndjson"`
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const all = await lines(res);
    const slugRow = (
      await q<{ slug: string }>("select slug from tenants where id = $1::uuid", [t.id])
    )[0];
    expect(all[0]).toEqual({
      export: {
        format: 1,
        tenant: expect.objectContaining({
          id: t.id,
          slug: slugRow.slug,
          status: "active",
        }),
        domains: [h],
        at: expect.any(String),
      },
    });
    const rows = all.slice(1, -1);
    expect(all[all.length - 1]).toEqual({ done: true, rows: rows.length });
    for (const r of rows)
      expect(r).toEqual({ table: expect.any(String), row: expect.any(Object) });
    for (const r of rows) expect((r.row as { tenant_id: string }).tenant_id).toBe(t.id);
    const exportedUsers = rows
      .filter((r) => r.table === "users")
      .map((r) => (r.row as { id: string }).id)
      .sort();
    expect(exportedUsers).toEqual([...users].sort());
    expect(await audits("tenant_exported", t.id)).toEqual([
      expect.objectContaining({
        actor_id: op1.userId,
        details: expect.objectContaining({ outcome: "attempted" }),
      }),
    ]);
  });

  it("ends a failed export with an error line, never a done line", async () => {
    const spy = jest
      .spyOn(adminSvc, "exportTenantData")
      .mockImplementationOnce(async (_op, _id, write) => {
        await write(JSON.stringify({ export: {} }) + "\n");
        throw new Error("connection lost");
      });
    try {
      const res = await exp(t.id);
      expect(res.status).toBe(200);
      expect(await lines(res)).toEqual([{ export: {} }, { error: "export_failed" }]);
    } finally {
      spy.mockRestore();
    }
  });

  it("logs a failure after the reader has gone, without throwing", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spy = jest
      .spyOn(adminSvc, "exportTenantData")
      .mockImplementationOnce(async () => {
        await gate;
        // A non-Error rejection is logged as text.
        throw "connection lost";
      });
    (logger.error as jest.Mock).mockClear();
    try {
      const res = await exp(t.id);
      await res.body!.cancel();
      release();
      for (
        let i = 0;
        i < 50 && (logger.error as jest.Mock).mock.calls.length === 0;
        i++
      ) {
        await new Promise((r) => setImmediate(r));
      }
      expect(logger.error).toHaveBeenCalledWith(
        "Tenant export failed part-way",
        expect.objectContaining({ tenantId: t.id, error: "connection lost" })
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("answers a coded 500 when the directory fails", async () => {
    const spy = jest
      .spyOn(directory, "getTenant")
      .mockRejectedValueOnce(new Error("down"));
    try {
      await expectCode(await exp(t.id), 500, "internal.error");
    } finally {
      spy.mockRestore();
    }
  });
});

dbDescribe(`${SUITE} GET /api/operator/readiness`, () => {
  const get = (caller: Caller = op1) =>
    readinessGET(req("/api/operator/readiness", caller));
  const saved = {
    mode: process.env.TENANCY_MODE,
    tenant: process.env.TENANT_ID,
    hostHeader: process.env.TENANT_HOST_HEADER,
  };
  afterEach(() => {
    for (const [k, v] of [
      ["TENANCY_MODE", saved.mode],
      ["TENANT_ID", saved.tenant],
      ["TENANT_HOST_HEADER", saved.hostHeader],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("is operators' only", async () => {
    await expectOperatorOnly((c) => get(c));
  });

  it("reports each check with its state and reason (single)", async () => {
    delete process.env.TENANCY_MODE;
    process.env.TENANT_ID = home.id;
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ mode: "single", tenantId: home.id });
    expect(body.checks.map((c: { name: string }) => c.name)).toEqual([
      "mode",
      "database",
      "owner_connection",
      "directory",
      "identity",
    ]);
    for (const c of body.checks) {
      expect(c).toEqual({
        name: expect.any(String),
        state: expect.stringMatching(/^(ready|not_ready|not_needed|unknown)$/),
        detail: expect.any(String),
      });
    }
    const byName = Object.fromEntries(
      body.checks.map((c: { name: string; state: string }) => [c.name, c.state])
    );
    expect(byName).toMatchObject({
      mode: "ready",
      database: "ready",
      owner_connection: "ready",
      identity: "not_needed",
    });
    expect(body.ready).toBe(
      body.checks.every(
        (c: { state: string }) => c.state === "ready" || c.state === "not_needed"
      )
    );
  });

  it("reports the identity provider not ready in a shared test deployment", async () => {
    process.env.TENANCY_MODE = "shared";
    process.env.TENANT_HOST_HEADER = "host";
    const body = await (await get()).json();
    expect(body.mode).toBe("shared");
    expect(body.tenantId).toBeUndefined();
    expect(body.ready).toBe(false);
    expect(
      body.checks.find((c: { name: string }) => c.name === "identity")
    ).toMatchObject({
      state: "not_ready",
    });
  });

  it("answers a coded 500 when the check fails", async () => {
    const spy = jest
      .spyOn(readinessMod, "checkTenancyReadiness")
      .mockRejectedValueOnce(new Error("x"));
    try {
      await expectCode(await get(), 500, "internal.error");
    } finally {
      spy.mockRestore();
    }
  });
});

dbDescribe(`${SUITE} audit first: no record, no change`, () => {
  let noAudit: TestIdentity;
  beforeAll(() => {
    noAudit = callerWithUnrecordableId("super_admin", RUN);
  });

  it("refuses a suspension it cannot record; the tenant stays active", async () => {
    const t = await createTestTenant();
    const body = await expectCode(
      await changeState(t.id, "suspend", noAudit),
      503,
      "service.unavailable"
    );
    expect(body.params).toEqual({ service: "audit" });
    expect(await tenantRow(t.id)).toMatchObject({
      status: "active",
      status_changed_by: null,
    });
  });

  it("refuses a provisioning it cannot record; no tenant is created", async () => {
    const s = slug();
    provisioned.push(s);
    await expectCode(
      await tenantsPOST(
        req("/api/operator/tenants", noAudit, {
          method: "POST",
          body: { slug: s, name: "Unrecorded Co" },
        })
      ),
      503,
      "service.unavailable"
    );
    expect(await q("select 1 from tenants where slug = $1", [s])).toEqual([]);
  });

  it("refuses a deletion request it cannot record; no request is opened", async () => {
    const t = await createTestTenant();
    await expectCode(
      await deletionPOST(
        req(`/api/operator/tenants/${t.id}/deletion`, noAudit, {
          method: "POST",
          body: { reason: "Customer left" },
        }),
        ctx(t.id)
      ),
      503,
      "service.unavailable"
    );
    expect(
      await q("select 1 from tenant_lifecycle_requests where tenant_id = $1::uuid", [
        t.id,
      ])
    ).toEqual([]);
  });

  it("streams no data for an export it cannot record", async () => {
    const t = await createTestTenant();
    await t.user();
    const res = await exportGET(
      req(`/api/operator/tenants/${t.id}/export`, noAudit),
      ctx(t.id)
    );
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe(
      JSON.stringify({ error: "audit.unavailable" })
    );
  });
});
