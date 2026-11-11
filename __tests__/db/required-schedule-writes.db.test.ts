/**
 * @jest-environment node
 */
/**
 * A required schedule's enabled setting cannot be written off by any config path, on Postgres
 * (TASK-194 round 19, I-1)
 *
 * config.expire-approvals is required (platform/jobs/duties.ts): the scheduler ignores its
 * `enabled` setting and the Jobs screen refuses to turn it off. Every other config path must
 * refuse it too, or a row says "off" while the job runs: the config page (PUT /api/admin/config),
 * an operator's tenant settings (PUT /api/operator/tenants/[id]/config), the config assistant
 * (POST /api/admin/config-ai/execute: update_config, request_approval) and the config store's
 * own write (setConfigWithHistory: approve-and-apply, the governed paths). Each answers
 * `jobs.schedule_required` (409) and changes, files and holds nothing; a two-person approval filed
 * before migration 062 is withdrawn when approved, never applied. A reset removes a tenant's
 * value only, so it never creates one. Shown with a required job of the suite's own (below), as
 * no DB suite writes a seeded key.
 *
 * Only token verification, the permission lookup, the standing lookup and the rate limiter are
 * test callers; every route, handler and store runs for real.
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

// hostile:role n/a: these routes' role cases are config-routes and r10-one-hold [hostile:role], and route-role-matrix for every route and role
// hostile:self n/a: approving one's own request is config-routes and r10-one-hold [hostile:self]
// hostile:store-down n/a: a store down on these routes is config-routes and r10-one-hold [hostile:store-down]
// hostile:id-spelling n/a: these writes name a setting key, not an account; an approver id spelled otherwise is approver-rules' case
import { renderShown, type ShownText } from "@/platform/errors/shown-text";
import { NextRequest } from "next/server";
import { withOwnerTx } from "@/platform/data";
import { clearConfigCache, setConfigWithHistory } from "@/platform/auth/platform-config";
import { CachedTenantDirectory, setTenantDirectory } from "@/platform/tenancy/directory";
import { PostgresTenantDirectory } from "@/platform/tenancy/postgres-directory";
import {
  DELETE as operatorConfigDELETE,
  PUT as operatorConfigPUT,
} from "@/app/api/operator/tenants/[id]/config/route";
import { PUT as adminConfigPUT } from "@/app/api/admin/config/route";
import { POST as configAiPOST } from "@/app/api/admin/config-ai/execute/route";
import { POST as adminDecidePOST } from "@/app/api/admin/approvals/[id]/route";
import { setProposalStore } from "@/platform/agents/proposal-store";
import { registerJob, scheduleKeys } from "@/platform/jobs/registry";
import { PostgresProposalStore } from "@/platform/agents/postgres-proposal-store";
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
  dropCatalog,
  insertUser,
  newRun,
  seededRoleId,
  suiteCaller,
} from "../helpers/db-admin";
import type { TestIdentity } from "../helpers/test-identities";

const RUN = newRun();
/**
 * A required job of the suite's own, its enabled setting a key of its own (D-18: no DB suite
 * writes a seeded key) — the check reads any job's `required`, as it reads
 * config.expire-approvals' (__tests__/jobs-required.test.ts: that job is required, and the check
 * refuses its key; migration 062's rows: the replay).
 */
const KIND = `test.r${RUN}`;
const KEY = scheduleKeys(KIND).enabled;

let home: TestTenant; // the operators' own tenant
let target: TestTenant; // the tenant they set
let single: TestTenant; // a single-tenant deployment's own
let op1: TestIdentity;
let op2: TestIdentity;
let admin1: TestIdentity;
let admin2: TestIdentity;

type Caller = Parameters<typeof asCallerIn>[0];

function req(
  path: string,
  caller: Caller,
  tenant: TestTenant,
  mode: "single" | "shared",
  options: { method?: string; body?: unknown } = {}
): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...asCallerIn(caller, tenant, mode),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function q<R extends Record<string, unknown>>(
  text: string,
  values: unknown[] = []
) {
  return (await withOwnerTx("operator", (tx) => tx.query<R>(text, values))).rows;
}

const platformValue = async () =>
  (
    await q<{ value: unknown }>("select value from platform_config where key = $1", [KEY])
  )[0]?.value;
const overrides = async () =>
  (
    await q<{ n: number }>(
      "select count(*)::int as n from tenant_config_overrides where key = $1",
      [KEY]
    )
  )[0].n;
const openApprovals = async () =>
  (
    await q<{ n: number }>(
      "select count(*)::int as n from config_pending_approvals where config_key = $1 and status in ('pending', 'approved')",
      [KEY]
    )
  )[0].n;
const heldProposals = async () =>
  (
    await q<{ n: number }>(
      "select count(*)::int as n from proposals where tenant_id = any($1::uuid[]) and status = 'proposed'",
      [[home.id, target.id, single.id]]
    )
  )[0].n;

/** Nothing changed, filed or held. */
async function nothingWritten(): Promise<void> {
  expect(await platformValue()).toBe(true);
  expect(await overrides()).toBe(0);
  expect(await openApprovals()).toBe(0);
  expect(await heldProposals()).toBe(0);
}

async function refusedAsRequired(res: Response): Promise<void> {
  const body = (await res.json()) as { code?: string };
  expect({ status: res.status, code: body.code }).toEqual({
    status: 409,
    code: "jobs.schedule_required",
  });
}

if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    setTenantDirectory(new CachedTenantDirectory(new PostgresTenantDirectory()));
    setProposalStore(new PostgresProposalStore());
    registerJob(KIND, async () => ({}), {
      description: "required, for this suite",
      schedule: {
        scope: "platform",
        defaultIntervalMinutes: 60,
        minIntervalMinutes: 15,
        maxIntervalMinutes: 1440,
        required: true,
      },
    });
    await q(
      `insert into platform_config
         (key, value, default_value, description, category, value_type, permission_tier, tenant_overridable)
       values ($1, 'true', 'true', 'required job, this suite', $2, 'boolean', 'safety', false)`,
      [KEY, `test-${RUN}`]
    );
    home = await createTestTenant();
    target = await createTestTenant();
    single = await createTestTenant();
    const superRole = await seededRoleId("super_admin");
    op1 = suiteCaller("super_admin", RUN, { name: "op1" });
    op2 = suiteCaller("super_admin", RUN, { name: "op2" });
    admin1 = suiteCaller("super_admin", RUN, { name: "single-admin-1" });
    admin2 = suiteCaller("super_admin", RUN, { name: "single-admin-2" });
    await insertUser(home, { id: op1.userId, roleId: superRole });
    await insertUser(home, { id: op2.userId, roleId: superRole });
    await insertUser(single, { id: admin1.userId, roleId: superRole });
    await insertUser(single, { id: admin2.userId, roleId: superRole });
  });
  // Whatever a failing run wrote is put back.
  afterEach(async () => {
    await q("update platform_config set value = 'true'::jsonb where key = $1", [KEY]);
    await q("delete from tenant_config_overrides where key = $1", [KEY]);
    await q("delete from config_pending_approvals where config_key = $1", [KEY]);
    await q("delete from platform_config_history where config_key = $1", [KEY]);
    clearConfigCache();
  });
  afterAll(async () => {
    await q("delete from platform_config where key = $1", [KEY]);
    await dropTestTenants();
    await dropCatalog();
    await disconnectTestDatabase();
  });
  beforeEach(() => clearConfigCache());
}

dbDescribe("a required schedule's enabled setting — every write path refuses it", () => {
  it("the config page (PUT /api/admin/config) refuses turning it off", async () => {
    const res = await adminConfigPUT(
      req("/api/admin/config", admin1, single, "single", {
        method: "PUT",
        body: { key: KEY, value: false, changeComment: "off" },
      })
    );
    await refusedAsRequired(res);
    await nothingWritten();
  });

  it("the config page refuses a string that reads as false", async () => {
    const res = await adminConfigPUT(
      req("/api/admin/config", admin1, single, "single", {
        method: "PUT",
        body: { key: KEY, value: "false", changeComment: "off" },
      })
    );
    await refusedAsRequired(res);
    await nothingWritten();
  });

  it("an operator's tenant settings refuse a tenant's own value, even true", async () => {
    for (const value of [false, true]) {
      const res = await operatorConfigPUT(
        req(`/api/operator/tenants/${target.id}/config`, op1, home, "shared", {
          method: "PUT",
          body: { key: KEY, value, changeComment: "per tenant" },
        }),
        { params: Promise.resolve({ id: target.id }) }
      );
      await refusedAsRequired(res);
    }
    await nothingWritten();
  });

  it("the config assistant's update_config refuses it, and holds nothing", async () => {
    const res = await configAiPOST(
      req("/api/admin/config-ai/execute", admin1, single, "single", {
        method: "POST",
        body: {
          toolId: "update_config",
          input: { key: KEY, value: false, changeComment: "off", confirmed: true },
        },
      })
    );
    await refusedAsRequired(res);
    await nothingWritten();
  });

  it("the config assistant's request_approval refuses it, and files nothing", async () => {
    const res = await configAiPOST(
      req("/api/admin/config-ai/execute", admin1, single, "single", {
        method: "POST",
        body: {
          toolId: "request_approval",
          input: { configKey: KEY, proposedValue: false, changeComment: "off" },
        },
      })
    );
    await refusedAsRequired(res);
    await nothingWritten();
  });

  it("the config store's write refuses it: off as the default, or any tenant value", async () => {
    const off = await home.run(() =>
      setConfigWithHistory(KEY, false, op1.userId, "off", "admin_ui", undefined, {
        scope: "platform",
        operator: true,
      })
    );
    expect(off).toMatchObject({ success: false, errorCode: "jobs.schedule_required" });
    const tenantOn = await target.run(() =>
      setConfigWithHistory(KEY, true, op1.userId, "per tenant", "admin_ui", undefined, {
        scope: "tenant",
        operator: true,
      })
    );
    expect(tenantOn).toMatchObject({
      success: false,
      errorCode: "jobs.schedule_required",
    });
    await nothingWritten();
  });

  it("setting it on as the default is no change, and is accepted", async () => {
    const on = await home.run(() =>
      setConfigWithHistory(KEY, true, op1.userId, "on", "admin_ui", undefined, {
        scope: "platform",
        operator: true,
      })
    );
    expect(on).toMatchObject({ success: true });
    expect(await platformValue()).toBe(true);
  });

  it("an operator's reset removes nothing and creates no tenant value", async () => {
    const res = await operatorConfigDELETE(
      req(
        `/api/operator/tenants/${target.id}/config?key=${encodeURIComponent(KEY)}`,
        op1,
        home,
        "shared",
        { method: "DELETE" }
      ),
      { params: Promise.resolve({ id: target.id }) }
    );
    expect(res.status).toBe(200);
    await nothingWritten();
  });
});

dbDescribe("a required schedule's enabled setting — an approval filed before 062", () => {
  it("approving it withdraws it, by the system and audited, and applies nothing", async () => {
    // Filed as requestApproval files one, before the job was required (migration 062).
    const [{ id }] = await q<{ id: string }>(
      `insert into config_pending_approvals
         (config_key, current_value, proposed_value, requested_by, change_comment, tenant_id, scope)
       values ($1, 'true'::jsonb, 'false'::jsonb, $2::uuid, 'turn it off', $3::uuid, 'platform')
       returning id`,
      [KEY, admin1.userId, single.id]
    );
    const res = await adminDecidePOST(
      req(`/api/admin/approvals/${id}`, admin2, single, "single", {
        method: "POST",
        body: { decision: "approve", source: "config-approval" },
      }),
      { params: Promise.resolve({ id }) }
    );
    const body = (await res.json()) as { code?: string; withdrawn?: boolean };
    expect({ status: res.status, code: body.code, withdrawn: body.withdrawn }).toEqual({
      status: 409,
      code: "jobs.schedule_required",
      withdrawn: true,
    });
    expect(await platformValue()).toBe(true);
    const [row] = await q<{
      status: string;
      reviewed_by: string | null;
      comment: string | null;
      note: ShownText;
    }>(
      "select status::text, reviewed_by, review_comment as comment, review_shown as note from config_pending_approvals where id = $1",
      [id]
    );
    expect(row).toMatchObject({ status: "rejected", reviewed_by: null, comment: null });
    // The system's record, worded by the catalog (TASK-209: it was English).
    expect(renderShown(row.note)).toMatch(
      /^withdrawn by the system: "jobs\.test\.r\w+\.enabled" turns on a job that is now required/
    );
    const audit = await q<{ reason: string }>(
      `select details->>'reason' as reason from audit_log
        where tenant_id = $1 and details->>'type' = 'approval_withdrawn'
          and details->'holdIds' ? $2`,
      [single.id, id]
    );
    expect(audit).toEqual([{ reason: "refused" }]);
    expect(await openApprovals()).toBe(0);
  });
});

/**
 * A change filed while its job was not yet required (before migration 062, or before an app's
 * job was declared required), then decided: a job of the suite's own, declared required between
 * the filing and the decision — the filing through the real route, the decision too.
 */
dbDescribe(
  "a required schedule's enabled setting — changes filed before it was required",
  () => {
    const filedThenRequired = async (kind: string) => {
      const key = scheduleKeys(kind).enabled;
      await q(
        `insert into platform_config
         (key, value, default_value, description, category, value_type, permission_tier, tenant_overridable)
       values ($1, 'true', 'true', 'not yet required', $2, 'boolean', 'safety', false)`,
        [key, `test-${RUN}`]
      );
      return {
        key,
        require: () =>
          registerJob(kind, async () => ({}), {
            description: "required since it was filed",
            schedule: {
              scope: "platform",
              defaultIntervalMinutes: 60,
              minIntervalMinutes: 15,
              maxIntervalMinutes: 1440,
              required: true,
            },
          }),
        drop: async () => {
          await q("delete from tenant_config_overrides where key = $1", [key]);
          await q("delete from platform_config_history where config_key = $1", [key]);
          await q("delete from platform_config where key = $1", [key]);
        },
      };
    };
    const operatorPut = (key: string) =>
      adminConfigPUT(
        req("/api/admin/config", op1, home, "shared", {
          method: "PUT",
          body: { key, value: false, scope: "platform", changeComment: "turn it off" },
        })
      );
    const decide = (id: string, source: string) =>
      adminDecidePOST(
        req(`/api/admin/approvals/${id}`, op2, home, "shared", {
          method: "POST",
          body: { decision: "approve", source },
        }),
        { params: Promise.resolve({ id }) }
      );
    const withdrawnAudit = (id: string) =>
      q<{ reason: string }>(
        `select details->>'reason' as reason from audit_log
        where tenant_id = $1 and details->>'type' = 'approval_withdrawn'
          and (details->>'holdId' = $2 or details->'holdIds' ? $2)`,
        [home.id, id]
      );

    // Round 20, residual A: a runtime hold (dual control) — refused when approved now — is
    // withdrawn by the system, recorded, never left approved to be approved again for ever.
    it("a runtime hold: approving it withdraws it, recorded, and applies nothing", async () => {
      const job = await filedThenRequired(`test.a${RUN}`);
      const dual = (
        await q<{ value: string[] }>(
          "select value from platform_config where key = 'config.dual_control_keys'"
        )
      )[0].value;
      await q(
        `insert into tenant_config_overrides (tenant_id, key, value)
       values ($1, 'config.dual_control_keys', $2::jsonb)
       on conflict (tenant_id, key) do update set value = excluded.value`,
        [home.id, JSON.stringify([...dual, job.key])]
      );
      try {
        clearConfigCache();
        expect((await operatorPut(job.key)).status).toBe(202);
        const [hold] = await q<{ id: string }>(
          "select id from proposals where tenant_id = $1 and status = 'proposed' and payload->>'key' = $2",
          [home.id, job.key]
        );
        expect(hold).toBeDefined();
        job.require();
        const res = await decide(hold.id, "runtime");
        const body = (await res.json()) as { code?: string; withdrawn?: boolean };
        expect({
          status: res.status,
          code: body.code,
          withdrawn: body.withdrawn,
        }).toEqual({
          status: 409,
          code: "jobs.schedule_required",
          withdrawn: true,
        });
        const [after] = await q<{ status: string }>(
          "select status::text from proposals where tenant_id = $1 and id = $2",
          [home.id, hold.id]
        );
        expect(after.status).toBe("rejected");
        expect(await withdrawnAudit(hold.id)).toEqual([{ reason: "refused" }]);
        // Withdrawn by the system, the decider as who found it (round 21, I-2).
        const [by] = await q<{ agent: string; found_by: string; approved_by: string }>(
          `select details->>'agent' as agent, details->>'foundBy' as found_by,
                  details->>'approvedBy' as approved_by
             from audit_log where tenant_id = $1 and details->>'type' = 'approval_withdrawn'
              and details->>'holdId' = $2`,
          [home.id, hold.id]
        );
        expect(by).toEqual({
          agent: "system:held-change-refused",
          found_by: op2.userId,
          approved_by: op2.userId,
        });
        expect(
          (
            await q<{ value: unknown }>(
              "select value from platform_config where key = $1",
              [job.key]
            )
          )[0].value
        ).toBe(true);
      } finally {
        await q(
          "delete from tenant_config_overrides where tenant_id = $1 and key = 'config.dual_control_keys'",
          [home.id]
        );
        await job.drop();
      }
    });

    // Round 20, residual C: a shared deployment's platform-default approval carries the tenant that
    // filed it (the operator's), so its withdrawal — in that tenant's transaction, as it was read —
    // is made and recorded: withdrawn, never left settling.
    it("a shared deployment's platform-default approval: withdrawn when approved, not settling", async () => {
      const job = await filedThenRequired(`test.c${RUN}`);
      await q(
        `insert into tenant_config_overrides (tenant_id, key, value)
       values ($1, 'config.require_two_person_approval', 'true')
       on conflict (tenant_id, key) do update set value = excluded.value`,
        [home.id]
      );
      try {
        clearConfigCache();
        expect((await operatorPut(job.key)).status).toBe(202);
        const [filed] = await q<{ id: string; tenant_id: string | null; scope: string }>(
          "select id, tenant_id, scope from config_pending_approvals where config_key = $1 and status = 'pending'",
          [job.key]
        );
        expect(filed).toMatchObject({ tenant_id: home.id, scope: "platform" });
        job.require();
        const res = await decide(filed.id, "config-approval");
        const body = (await res.json()) as {
          code?: string;
          withdrawn?: boolean;
          settling?: boolean;
        };
        expect(body).toMatchObject({ code: "jobs.schedule_required", withdrawn: true });
        expect(body.settling).toBeUndefined();
        const [row] = await q<{ status: string; note: ShownText }>(
          "select status::text, review_shown as note from config_pending_approvals where id = $1",
          [filed.id]
        );
        expect(row.status).toBe("rejected");
        expect(renderShown(row.note)).toMatch(
          /^withdrawn by the system: "jobs\.test\.c\w+\.enabled" turns on a job that is now required/
        );
        expect(await withdrawnAudit(filed.id)).toEqual([{ reason: "refused" }]);
      } finally {
        await q(
          "delete from tenant_config_overrides where tenant_id = $1 and key = 'config.require_two_person_approval'",
          [home.id]
        );
        await q("delete from config_pending_approvals where config_key = $1", [job.key]);
        await job.drop();
      }
    });
  }
);
