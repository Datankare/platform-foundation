/**
 * @jest-environment node
 */
/**
 * The route-level role matrix, against the replayed database (TASK-146)
 *
 * Every privileged route — administration, operation, moderation, a user's own data rights —
 * called as every role of the real catalog (and as nobody, as a suspended super_admin, and as a
 * super_admin who signed in with a password only) in a test tenant, its transactions running
 * against Postgres under row-level security. Only token verification and the standing lookup are
 * test callers (helpers/db-admin.ts); the permission lookup is the platform's own, reading each
 * caller's role from the database, and what each role may do is read from the database's role
 * tables (review 7 L5 — it came from scripts/role-catalog.cjs, the migrations as parsed text, so
 * a role table that disagreed with them went unseen). The guard, the staff second-factor rule
 * (read from the database's governed setting), the route and its SQL are real. The one platform
 * duty a route runs across every tenant (POST /api/operator/purge) is replaced: suites run in
 * parallel, and it would purge other suites' tenants.
 *
 *   - A role without the route's permission is refused: 401 or 403, and nothing is recorded.
 *   - A role with it is let through: never 401/403 (it may still be told its body is wrong).
 *   - Nobody gets a 500, whatever the role or body (an uncoded failure is a defect).
 *   - Hostile bodies (null, an array, a string, a huge or malformed id) are answered with a 4xx
 *     by every route, for the callers allowed through.
 *
 * The bodies are deliberately incomplete: a caller allowed through reaches the route's own
 * validation, and nothing is changed. Valid bodies (review 7 L5: generated bodies rarely passed
 * validation, so the handlers behind it went unexercised) reach each handler past its shape
 * checks, aimed at targets that do not exist or belong to the test tenant, so nothing outside it
 * changes; they are answered by the handler's own rules, never a 500 or a guard's refusal.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-matrix",
}));
jest.mock("@/platform/auth/middleware", () =>
  require("@/__tests__/helpers/db-admin").mockTenantMiddleware()
);
// The tenant purge runs across every tenant: replaced, so this suite never purges another's.
jest.mock("@/platform/tenancy/admin", () => ({
  ...jest.requireActual("@/platform/tenancy/admin"),
  purgeDueTenants: jest.fn(async () => ({ ok: true, value: [] })),
}));
jest.mock("@/platform/auth/account-status-guard", () =>
  require("@/__tests__/helpers/test-identities").mockAccountStatus()
);
jest.mock("@/platform/rate-limit", () =>
  require("@/__tests__/helpers/test-identities").mockRateLimit()
);
// No paid call leaves the suite: the AI routes get an orchestrator that answers nothing useful.
jest.mock("@/platform/ai", () => {
  const actual = jest.requireActual("@/platform/ai");
  return {
    ...actual,
    getOrchestrator: () => ({
      complete: async () => ({
        content: [{ type: "text", text: "{}" }],
        model: "matrix",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      }),
      stream: async function* () {},
      getCircuitState: () => "closed",
      resetCircuit: () => undefined,
    }),
  };
});

import fc from "fast-check";
import { NextRequest } from "next/server";
import { fuzzParams, fuzzParamsPart } from "../helpers/fuzz";
import { withOwnerTx } from "@/platform/data";
import { clearConfigCache } from "@/platform/auth/platform-config";
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
import {
  ROLE_PERMISSIONS,
  identityFor,
  type TestIdentity,
} from "../helpers/test-identities";

type Handler = (
  request: NextRequest,
  context: {
    params: Promise<{ id: string; kind: string; approvalId: string; userId: string }>;
  }
) => Promise<Response>;

interface RouteCase {
  readonly path: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly load: () => Promise<Record<string, unknown>>;
  /** The permission the route requires; "signed-in": any signed-in user. */
  readonly permission: string;
  readonly body?: unknown;
  /** Bodies the route's shape checks accept (review 7 L5), aimed at nothing outside the tenant. */
  readonly valid?: () => fc.Arbitrary<unknown>;
  /** A query string sent with the valid bodies (a route that reads its target from the query). */
  readonly validQuery?: string;
  /** A POST that reads no body: a hostile one is not refused (it is not read), never a 500. */
  readonly readsNoBody?: true;
}

const ID = "00000000-0000-4000-8000-00000000abcd";
const RUN = newRun();
const text = (min = 1, max = 60) => fc.string({ minLength: min, maxLength: max });
const aUuid = () => fc.uuid();
/** Free text a route requires to say something (at least a word: never only spaces). */
const words = () => text(0).map((x) => `matrix ${x}`);
const R = (path: string) => () => import(`@/app/api/${path}/route`);
/**
 * A held change's decision and source: approve or reject either source; a decision on an
 * undecided run (review 11 H-1) a runtime hold only.
 */
const decisionBody = (extra: Record<string, fc.Arbitrary<unknown>> = {}) =>
  fc.oneof(
    fc.record({
      decision: fc.constantFrom("approve", "reject"),
      source: fc.constantFrom("runtime", "config-approval"),
      ...extra,
    }),
    fc.record({
      decision: fc.constantFrom("mark_executed", "reapprove"),
      source: fc.constant("runtime"),
      ...extra,
    })
  );
/** An operator route about a tenant that does not exist. */
const op = (
  path: string,
  method: RouteCase["method"],
  file: string,
  valid?: RouteCase["valid"],
  body: unknown = method === "GET" ? undefined : {}
): RouteCase => ({
  path: `operator/${path}`,
  method,
  load: R(`operator/${file}`),
  permission: "platform_operate",
  ...(body === undefined ? {} : { body }),
  ...(valid ? { valid } : {}),
});

const ROUTES: readonly RouteCase[] = [
  {
    path: "admin/agent-registry",
    method: "GET",
    load: R("admin/agent-registry"),
    permission: "admin_manage_agents",
  },
  {
    path: "admin/ai",
    method: "POST",
    load: R("admin/ai"),
    permission: "can_access_admin",
    body: {},
    valid: () =>
      fc.record({
        prompt: text(),
        panel: fc.constantFrom("roles", "users", "entitlements", "approvals"),
      }),
  },
  {
    path: "admin/ai/execute",
    method: "POST",
    load: R("admin/ai/execute"),
    permission: "can_access_admin",
    body: {},
    valid: () =>
      fc.record({
        actions: fc.array(
          fc.record({
            tool: fc.constant("search"),
            input: fc.record({
              query: text(),
              table: fc.constantFrom("users", "roles", "audit_log"),
            }),
          }),
          { minLength: 1, maxLength: 2 }
        ),
      }),
  },
  // Review 12 L7: the kill switch for the current tenant, in every deployment mode.
  {
    path: "admin/agents/suspend",
    method: "POST",
    load: R("admin/agents/suspend"),
    permission: "config_manage_safety",
    body: {},
    valid: () => fc.record({ reason: words() }),
  },
  {
    path: "admin/approval-policy",
    method: "GET",
    load: R("admin/approval-policy"),
    permission: "admin_manage_approval_policy",
  },
  {
    path: "admin/approvals",
    method: "GET",
    load: R("admin/approvals"),
    permission: "can_access_admin",
  },
  {
    path: `admin/approvals/${ID}`,
    method: "POST",
    load: R("admin/approvals/[id]"),
    permission: "can_access_admin",
    body: {},
    valid: () =>
      decisionBody({
        note: text(0),
      }),
  },
  {
    path: "admin/audit",
    method: "GET",
    load: R("admin/audit"),
    permission: "admin_view_audit",
  },
  {
    path: "admin/capabilities",
    method: "GET",
    load: R("admin/capabilities"),
    permission: "admin_view_audit",
  },
  {
    path: "admin/capability-mapping",
    method: "GET",
    load: R("admin/capability-mapping"),
    permission: "admin_manage_config",
  },
  {
    path: "admin/config",
    method: "GET",
    load: R("admin/config"),
    permission: "config_view",
  },
  {
    path: "admin/config",
    method: "PUT",
    load: R("admin/config"),
    permission: "config_view",
    body: {},
    valid: () =>
      fc.record({
        key: fc.constant(`matrix.${RUN}.absent`),
        value: fc.jsonValue({ maxDepth: 1 }),
        scope: fc.constantFrom("tenant", "platform"),
        comment: words(),
      }),
  },
  {
    path: "admin/config",
    method: "DELETE",
    load: R("admin/config"),
    permission: "config_view",
    body: {},
    valid: () => fc.constant({}),
    validQuery: `?key=matrix.${RUN}.absent`,
  },
  {
    path: "admin/config-ai",
    method: "POST",
    load: R("admin/config-ai"),
    permission: "config_view",
    body: {},
    valid: () => fc.record({ message: text() }),
  },
  {
    path: "admin/config-ai/execute",
    method: "POST",
    load: R("admin/config-ai/execute"),
    permission: "config_view",
    body: {},
    valid: () =>
      fc.record({
        toolId: fc.constantFrom("search_config", "get_config", "get_history"),
        input: fc.record({ key: fc.constant(`matrix.${RUN}.absent`), query: text() }),
      }),
  },
  {
    path: "admin/entitlements",
    method: "GET",
    load: R("admin/entitlements"),
    permission: "admin_manage_entitlements",
  },
  {
    path: "admin/entitlements",
    method: "PATCH",
    load: R("admin/entitlements"),
    permission: "admin_manage_entitlements",
    body: {},
    valid: () => fc.record({ groupId: aUuid(), isActive: fc.boolean() }),
  },
  {
    path: "admin/gdpr",
    method: "POST",
    load: R("admin/gdpr"),
    permission: "admin_purge_user_data",
    body: {},
    valid: () =>
      fc.record({
        userId: aUuid(),
        reason: fc.constantFrom(
          "user-request",
          "admin-action",
          "account-deletion",
          "legal-order"
        ),
        dryRun: fc.constant(true),
      }),
  },
  {
    path: "admin/password-policy",
    method: "GET",
    load: R("admin/password-policy"),
    permission: "admin_manage_config",
  },
  {
    path: "admin/password-policy",
    method: "PUT",
    load: R("admin/password-policy"),
    permission: "admin_manage_config",
    body: {},
    valid: () => fc.record({ minLength: fc.integer({ min: 8, max: 64 }) }),
  },
  {
    path: "admin/per-account",
    method: "GET",
    load: R("admin/per-account"),
    permission: "admin_manage_account_restrictions",
  },
  {
    path: "admin/roles",
    method: "GET",
    load: R("admin/roles"),
    permission: "admin_manage_roles",
  },
  {
    path: "admin/session",
    method: "GET",
    load: R("admin/session"),
    permission: "can_access_admin",
  },
  {
    path: "admin/tenant",
    method: "GET",
    load: R("admin/tenant"),
    permission: "can_access_admin",
  },
  {
    path: "admin/users",
    method: "GET",
    load: R("admin/users"),
    permission: "admin_manage_users",
  },
  {
    path: "admin/users",
    method: "PATCH",
    load: R("admin/users"),
    permission: "admin_manage_users",
    body: {},
    valid: () => fc.record({ userId: aUuid(), roleId: aUuid() }),
  },
  {
    path: `moderation/appeals/${ID}`,
    method: "PATCH",
    load: R("moderation/appeals/[id]"),
    permission: "can_moderate",
    body: {},
    valid: () =>
      fc.record({
        action: fc.constantFrom("claim", "unclaim", "resolve"),
        decision: fc.constantFrom("uphold", "overturn", "modify"),
        reviewerNotes: text(),
      }),
  },
  {
    path: "moderation/review",
    method: "GET",
    load: R("moderation/review"),
    permission: "can_moderate",
  },
  {
    path: "moderation/review",
    method: "POST",
    load: R("moderation/review"),
    permission: "can_moderate",
    body: {},
    valid: () =>
      fc.record({
        source: fc.constant("escalation"),
        moderationResult: fc.constant({
          action: "escalate",
          triggeredBy: "content-rating",
          reasoning: "matrix",
          trajectoryId: "t",
          agentId: "guardian",
          contextFactors: [],
          blocklistMatches: [],
        }),
        targetUserId: fc.constant(callers.free.userId),
      }),
  },
  {
    path: `moderation/review/${ID}`,
    method: "PATCH",
    load: R("moderation/review/[id]"),
    permission: "can_moderate",
    body: {},
    valid: () =>
      fc.record({
        action: fc.constantFrom("claim", "unclaim", "resolve"),
        decision: fc.constantFrom("uphold", "overturn", "modify"),
        reviewerNotes: text(),
      }),
  },
  {
    path: `moderation/review/${ID}/assist`,
    method: "POST",
    load: R("moderation/review/[id]/assist"),
    permission: "can_moderate",
    body: {},
    valid: () => fc.constant({}),
  },
  {
    path: "moderation/appeals",
    method: "POST",
    load: R("moderation/appeals"),
    permission: "signed-in",
    body: {},
    valid: () => fc.record({ originalDecisionId: aUuid(), appealReason: text(10, 200) }),
  },
  {
    path: "account/export",
    method: "GET",
    load: R("account/export"),
    permission: "can_export_data",
  },
  {
    path: "account/delete",
    method: "POST",
    load: R("account/delete"),
    permission: "can_delete_account",
    body: {},
  },
  // Operation (review 7 L5: these were outside the matrix), about a tenant that does not exist.
  op("deletions/" + ID, "POST", "deletions/[id]", () =>
    fc.record({ decision: fc.constantFrom("approve", "reject"), note: text(0) })
  ),
  op("jobs", "GET", "jobs"),
  op("jobs/dead/" + ID, "POST", "jobs/dead/[id]", () =>
    fc.record({ action: fc.constantFrom("replay", "discard") })
  ),
  op("jobs/schedules/" + ID, "PATCH", "jobs/schedules/[kind]", () =>
    fc.record({ enabled: fc.boolean(), changeComment: words() })
  ),
  op("jobs/schedules/" + ID + "/run", "POST", "jobs/schedules/[kind]/run", () =>
    fc.constant({})
  ),
  // Reads no body: whatever it is sent, it purges (the duty is replaced here).
  { ...op("purge", "POST", "purge", () => fc.constant({})), readsNoBody: true },
  op("readiness", "GET", "readiness"),
  op("tenants", "GET", "tenants"),
  // A valid slug and name would provision a tenant: the valid bodies carry a slug no tenant may
  // have, so the handler's own check refuses them.
  op("tenants", "POST", "tenants", () =>
    fc.record({
      slug: fc.constant("Not A Slug!"),
      name: text(),
      domains: fc.constant([]),
    })
  ),
  op(`tenants/${ID}`, "PATCH", "tenants/[id]", () => fc.record({ name: text() })),
  op(`tenants/${ID}/admins`, "POST", "tenants/[id]/admins", () =>
    fc.record({ email: fc.constant(`matrix-${RUN}@x.test`) })
  ),
  op(`tenants/${ID}/approvals`, "GET", "tenants/[id]/approvals"),
  // Review 11 M-2: the agent kill switch, for a tenant that does not exist.
  op(`tenants/${ID}/agents/suspend`, "POST", "tenants/[id]/agents/suspend", () =>
    fc.record({ reason: words() })
  ),
  op(`tenants/${ID}/approvals/${ID}`, "POST", "tenants/[id]/approvals/[approvalId]", () =>
    decisionBody()
  ),
  op(`tenants/${ID}/config`, "GET", "tenants/[id]/config"),
  op(`tenants/${ID}/config`, "PUT", "tenants/[id]/config", () =>
    fc.record({
      key: fc.constant(`matrix.${RUN}.absent`),
      value: fc.integer(),
      comment: words(),
    })
  ),
  op(`tenants/${ID}/config`, "DELETE", "tenants/[id]/config"),
  op(`tenants/${ID}/deletion`, "POST", "tenants/[id]/deletion", () =>
    fc.record({ reason: words() })
  ),
  op(`tenants/${ID}/domains`, "POST", "tenants/[id]/domains", () =>
    fc.record({ host: fc.constant(`m-${RUN}.example.test`) })
  ),
  {
    ...op(`tenants/${ID}/domains`, "DELETE", "tenants/[id]/domains", () =>
      fc.constant({})
    ),
    validQuery: `?host=m-${RUN}.example.test`,
  },
  op(
    `tenants/${ID}/erasures/${ID}/attestation`,
    "POST",
    "tenants/[id]/erasures/[userId]/attestation",
    () =>
      fc.record({
        reason: fc.constantFrom("pool_decommissioned", "deleted_in_old_pool"),
        note: text(),
      })
  ),
  op(`tenants/${ID}/export`, "GET", "tenants/[id]/export"),
  op(`tenants/${ID}/state`, "POST", "tenants/[id]/state", () =>
    fc.record({ action: fc.constantFrom("suspend", "resume"), reason: words() })
  ),
  {
    path: "account/age",
    method: "POST",
    load: R("account/age"),
    permission: "signed-in",
    body: {},
    valid: () =>
      fc
        .date({
          min: new Date("1950-01-01"),
          max: new Date("1995-12-31"),
          noInvalidDate: true,
        })
        .map((d) => ({ dateOfBirth: d.toISOString().slice(0, 10) })),
  },
];

fc.configureGlobal(fuzzParams());

/** The field names the routes read, so generated bodies reach past the shape checks. */
const FIELDS = [
  "userId",
  "roleId",
  "role",
  "reason",
  "dryRun",
  "key",
  "value",
  "scope",
  "comment",
  "configKey",
  "proposedValue",
  "actions",
  "prompt",
  "message",
  "decision",
  "reviewerNotes",
  "modifiedAction",
  "confirm",
  "dateOfBirth",
  "originalDecisionId",
  "appealReason",
  "groupId",
  "active",
  "minLength",
  "id",
  "tool",
  "input",
  "feature",
  "approve",
  "note",
  "status",
];
const hostileValue = fc.oneof(
  fc.jsonValue({ maxDepth: 2 }),
  fc.uuid(),
  fc.constantFrom(
    "",
    " ",
    "x".repeat(5000),
    "'; drop table users; --",
    "../..",
    "\u0000",
    "NaN"
  ),
  fc.integer(),
  fc.constant(null)
);
const hostileBody = fc.oneof(
  fc.jsonValue({ maxDepth: 3 }),
  fc.dictionary(fc.constantFrom(...FIELDS), hostileValue, { maxKeys: 6 })
);

let t: TestTenant;
const callers: Record<string, TestIdentity> = {};
const SPECIAL = [
  "anonymous",
  "suspended_super_admin",
  "password_only_super_admin",
] as const;

function request(
  route: RouteCase,
  caller: string,
  body?: unknown,
  raw?: string,
  query = ""
): NextRequest {
  const identity = callers[caller];
  return new NextRequest(`http://localhost/api/${route.path}${query}`, {
    method: route.method,
    headers: {
      "content-type": "application/json",
      ...(identity ? asCallerIn(identity, t) : asCallerIn("anonymous", t)),
    },
    ...(route.method === "GET"
      ? {}
      : { body: raw ?? JSON.stringify(body === undefined ? (route.body ?? {}) : body) }),
  });
}

async function call(
  route: RouteCase,
  caller: string,
  body?: unknown,
  raw?: string,
  query = ""
) {
  const mod = await route.load();
  const handler = mod[route.method] as Handler;
  return handler(request(route, caller, body, raw, query), {
    params: Promise.resolve({ id: ID, kind: ID, approvalId: ID, userId: ID }),
  });
}

/** Whether `caller` may pass the route's guard. */
function allowed(route: RouteCase, caller: string): boolean {
  if (caller === "anonymous") return false;
  // Standing gates the staff routes. A suspended account may still appeal its suspension, and
  // still export or erase its data and declare its age (GDPR rights do not depend on standing).
  const staffRoute =
    !route.path.startsWith("account/") && route.permission !== "signed-in";
  if (caller === "suspended_super_admin" && staffRoute) return false;
  if (route.permission === "signed-in") return true;
  // Staff sign in with a second factor (A-9): a password-only super_admin passes only the
  // routes that are not administrative.
  if (caller === "password_only_super_admin" && !route.path.startsWith("account/"))
    return false;
  return dbPermissions[callers[caller].roleName].includes(route.permission);
}

/** What each seeded role may do, read from the database's role tables (review 7 L5). */
const dbPermissions: Record<string, string[]> = {};
async function readRolePermissions(): Promise<void> {
  const { rows } = await withOwnerTx("operator", (tx) =>
    tx.query<{ name: string; codes: string[] }>(
      `select r.name, coalesce(array_agg(distinct p.code) filter (where p.code is not null), '{}') as codes
         from roles r
         left join (select rp.role_id, rp.permission_id from role_permissions rp
                    union
                    select ri.role_id, rp.permission_id from role_inheritance ri
                      join role_permissions rp on rp.role_id = ri.inherits_from_id) x on x.role_id = r.id
         left join permissions p on p.id = x.permission_id
        where r.name = any($1::text[])
        group by r.name`,
      [Object.keys(ROLE_PERMISSIONS)]
    )
  );
  for (const r of rows) dbPermissions[r.name] = r.codes;
}

const auditCount = async () =>
  (
    await withOwnerTx("operator", (tx) =>
      tx.query<{ n: number }>(
        "select count(*)::int as n from audit_log where tenant_id = $1::uuid",
        [t.id]
      )
    )
  ).rows[0].n;

if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    clearConfigCache();
    t = await createTestTenant();
    for (const role of Object.keys(ROLE_PERMISSIONS)) {
      callers[role] = suiteCaller(role, RUN);
      // The row is the caller's own account (cognito_sub = its identity's sub): a route that
      // resolves the caller's account — the appeal route does — finds it. With a different sub,
      // any body that passed validation was answered 403 account.not_found.
      await insertUser(t, {
        id: callers[role].userId,
        roleId: await seededRoleId(role),
        cognitoSub: callers[role].sub,
      });
    }
    callers.suspended_super_admin = identityFor("super_admin", {
      name: `suspended-${RUN}`,
      inGoodStanding: false,
    });
    callers.password_only_super_admin = identityFor("super_admin", {
      name: `password-only-${RUN}`,
      mfaEnabled: false,
    });
    await readRolePermissions();
    const superRole = await seededRoleId("super_admin");
    await insertUser(t, {
      id: callers.suspended_super_admin.userId,
      roleId: superRole,
      cognitoSub: callers.suspended_super_admin.sub,
    });
    await insertUser(t, {
      id: callers.password_only_super_admin.userId,
      roleId: superRole,
      cognitoSub: callers.password_only_super_admin.sub,
    });
  });
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });
}

const CALLERS = [...Object.keys(ROLE_PERMISSIONS), ...SPECIAL];

/**
 * Each property runs as PROPERTY_PARTS tests, each a quarter of the run count (review 14 M-1,
 * helpers/fuzz.ts fuzzParamsPart): the same depth as one test — in the fuzz job too — but no single
 * test near its bound. One property of 200 HTTP round trips took 1.7 s idle, and many times that on
 * a loaded CI machine sharing the database with parallel workers.
 */
const PROPERTY_PARTS = [1, 2, 3, 4] as const;

dbDescribe("route role matrix (TASK-146, Postgres)", () => {
  it("covers every privileged route file", () => {
    // A new admin, moderation or account route must be added to the matrix.
    const { readdirSync, statSync } = jest.requireActual("fs") as typeof import("fs");
    const { join } = jest.requireActual("path") as typeof import("path");
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name === "route.ts")
          found.push(p.replace(/^app\/api\//, "").replace(/\/route\.ts$/, ""));
      }
    };
    for (const root of [
      "app/api/admin",
      "app/api/operator",
      "app/api/moderation",
      "app/api/account",
    ])
      walk(root);
    const covered = new Set(
      ROUTES.map((r) =>
        r.path
          .replace(
            `/approvals/${ID}`,
            r.path.startsWith("operator/") ? "/approvals/[approvalId]" : "/approvals/[id]"
          )
          .replace(`schedules/${ID}`, "schedules/[kind]")
          .replace(`erasures/${ID}`, "erasures/[userId]")
          .replaceAll(ID, "[id]")
      )
    );
    expect(found.filter((p) => !covered.has(p)).sort()).toEqual([]);
  });

  describe.each(ROUTES.map((r) => [`${r.method} /api/${r.path}`, r] as const))(
    "%s",
    (_name, route) => {
      it.each(CALLERS)(
        "as %s: refused exactly when it lacks the permission; never a 500",
        async (caller) => {
          const before = await auditCount();
          const res = await call(route, caller);
          expect([caller, res.status]).not.toEqual([caller, 500]);
          if (allowed(route, caller)) {
            expect([caller, res.status]).not.toEqual([caller, 401]);
            expect([caller, res.status]).not.toEqual([caller, 403]);
          } else {
            expect([401, 403]).toContain(res.status);
            // A refused caller leaves no trace in the tenant's records beyond what refusals log.
            const after = await auditCount();
            expect(after - before).toBeLessThanOrEqual(0);
          }
        }
      );

      if (route.method !== "GET") {
        it.each(PROPERTY_PARTS)(
          `property (part %i of ${PROPERTY_PARTS.length}): any generated body is answered without a 500, for every caller let through (TASK-147)`,
          async (part) => {
            const through = CALLERS.filter((c) => allowed(route, c));
            await fc.assert(
              fc.asyncProperty(
                hostileBody,
                fc.constantFrom(...through),
                async (body, caller) => {
                  const res = await call(route, caller, body);
                  return res.status !== 500 && res.status !== 401 && res.status !== 403;
                }
              ),
              fuzzParamsPart(PROPERTY_PARTS.length, part)
            );
          }
        );

        if (route.valid) {
          const valid = route.valid;
          it.each(PROPERTY_PARTS)(
            `property (part %i of ${PROPERTY_PARTS.length}): a valid body reaches the handler past its shape checks, for every caller let through (review 7 L5)`,
            async (part) => {
              const through = CALLERS.filter((c) => allowed(route, c));
              await fc.assert(
                fc.asyncProperty(
                  valid(),
                  fc.constantFrom(...through),
                  async (body, caller) => {
                    const res = await call(
                      route,
                      caller,
                      body,
                      undefined,
                      route.validQuery ?? ""
                    );
                    const code = String(
                      ((await res.json().catch(() => ({}))) as { code?: unknown }).code ??
                        ""
                    );
                    // Answered by the handler: not a 500, not the guard (401, auth.*, standing), not
                    // the shape checks (request.*).
                    return (
                      res.status !== 500 &&
                      res.status !== 401 &&
                      !code.startsWith("auth.permission") &&
                      !code.startsWith("auth.mfa") &&
                      code !== "account.restricted" &&
                      !code.startsWith("request.")
                    );
                  }
                ),
                fuzzParamsPart(PROPERTY_PARTS.length, part)
              );
            }
          );
        }

        if (route.path === "moderation/appeals")
          it("finds the caller's own account: a well-formed appeal of an unknown decision is 404 (fast-check counterexample, 2026-10-24)", async () => {
            const body = {
              appealReason: "00000000-0000-1000-8000-000000000000",
              originalDecisionId: "'; drop table users; --",
            };
            for (const caller of CALLERS.filter((c) => allowed(route, c))) {
              const res = await call(route, caller, body);
              expect([caller, res.status]).toEqual([caller, 404]);
            }
          });

        it.each([
          ["null", "null"],
          ["an array", "[1,2,3]"],
          ["a string", '"x"'],
          ["malformed JSON", "{"],
          ["a huge body", JSON.stringify({ x: "y".repeat(200_000) })],
        ])(
          "answers %s with a 4xx for the callers it lets through",
          async (_label, raw) => {
            for (const caller of CALLERS.filter((c) => allowed(route, c))) {
              const res = await call(route, caller, undefined, raw);
              if (route.readsNoBody) {
                expect([caller, res.status < 500]).toEqual([caller, true]);
                continue;
              }
              expect([caller, res.status >= 400 && res.status < 500]).toEqual([
                caller,
                true,
              ]);
            }
          }
        );
      }
    }
  );
});
