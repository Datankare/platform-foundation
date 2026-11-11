/**
 * @jest-environment node
 */
/**
 * __tests__/route-fixtures.test.ts — the bodies screen tests answer fetch with, made by the real
 * route handlers (TASK-200, rule 3)
 *
 * @guard a shared route fixture that is not what the real route handler answers
 *
 * A screen test that answers fetch with a body written by hand tests the screen against a reply
 * the route may never send (TASK-194: fixes passed against mock bodies the real route did not
 * return). The fixtures in __tests__/fixtures/route-responses.json are produced here, by calling
 * the route handlers themselves — through the real guard (helpers/test-identities.ts) with only
 * the stores below them stubbed — and a screen test takes its reply from there
 * (__tests__/fixtures/route-responses.ts). This test fails when a handler's answer drifts from
 * its fixture; `UPDATE_ROUTE_FIXTURES=1 npx jest __tests__/route-fixtures.test.ts` rewrites them.
 * Volatile values (times, request ids) are normalised so a fixture is stable, and the Jobs
 * console's list keeps the core's schedules and the test's own: a product module's or an app's
 * jobs differ with the modules an app registers (`npm run test:core` registers none).
 *
 * Hostile cases (TASK-200 rule 6) live with each route's own tests; this file records answers.
 * hostile:role n/a: the role cases are the route's own tests, jobs-operator-routes.test.ts
 * hostile:self n/a: records answers only; the self-target cases are in the route tests
 * hostile:store-down n/a: records answers only; the store-down cases are in the route tests
 * hostile:id-spelling n/a: records answers only; the id-spelling cases are in the route tests
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-test",
}));
// The deployment's tenancy as the verifier enters it (a producer for an operator route across
// tenants sets "shared", TASK-207).
const mockTenancy: { mode: "single" | "shared" } = { mode: "single" };
jest.mock("@/platform/auth/middleware", () => {
  const mocked = require("@/__tests__/helpers/test-identities").mockMiddleware();
  const { enterTenant } = jest.requireActual("@/platform/tenancy/context");
  // As the real verifier does: a verified caller's request runs in its tenant (TASK-207).
  const requireAuth = mocked.requireAuth;
  return {
    ...mocked,
    requireAuth: async (...a: unknown[]) => {
      const verified = await requireAuth(...a);
      if (!verified.error)
        enterTenant({
          tenantId: "aaaaaaaa-0000-4000-8000-00000000000a",
          mode: mockTenancy.mode,
        });
      return verified;
    },
  };
});
jest.mock("@/platform/auth/permissions-cache", () =>
  require("@/__tests__/helpers/test-identities").mockPermissionsCache()
);
jest.mock("@/platform/auth/account-status-guard", () =>
  require("@/__tests__/helpers/test-identities").mockAccountStatus()
);
jest.mock("@/platform/rate-limit", () =>
  require("@/__tests__/helpers/test-identities").mockRateLimit()
);
// The audit log beneath audited(): written, unless a producer makes it unavailable (TASK-207).
const mockAudit: { down?: boolean } = {};
jest.mock("@/platform/auth/audit", () => {
  const actual = jest.requireActual("@/platform/auth/audit");
  return {
    ...actual,
    audited: (entry: { action: string }, act: () => Promise<unknown>) =>
      mockAudit.down
        ? Promise.reject(
            new actual.AuditWriteError(entry.action, "audit_log is unavailable")
          )
        : act(),
    writeAuditLog: jest.fn(),
  };
});
const mockWrite = jest.fn();
const mockResetWrite = jest.fn();
jest.mock("@/platform/admin/governed-config", () => {
  const actual = jest.requireActual("@/platform/admin/governed-config");
  return {
    ...actual,
    writeGovernedConfig: (...a: unknown[]) => mockWrite(...a),
    resetGovernedConfig: (...a: unknown[]) => mockResetWrite(...a),
  };
});

// TASK-202: the settings, approvals and names the admin console's fixtures read — the stores
// beneath the routes, stubbed per producer; by default each is the real function.
const mockCfg: Record<string, jest.Mock> = {};
jest.mock("@/platform/auth/platform-config", () => {
  const actual = jest.requireActual("@/platform/auth/platform-config");
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of [
    "getEnhancedConfig",
    "listEnhancedConfig",
    "getConfigOrThrow",
    "setConfigWithHistory",
    "getPermissionTier",
    "publishConfigInvalidation",
  ]) {
    mockCfg[name] = jest.fn((...a: unknown[]) => actual[name](...a));
    wrapped[name] = (...a: unknown[]) => mockCfg[name](...a);
  }
  return wrapped;
});
const mockListApprovals = jest.fn();
// A config approval's record and its apply (TASK-207): the store's, unless a producer says.
const mockConfigApproval: {
  get?: (...a: unknown[]) => Promise<unknown>;
  apply?: (...a: unknown[]) => Promise<unknown>;
} = {};
jest.mock("@/platform/admin/config-approval", () => {
  const actual = jest.requireActual("@/platform/admin/config-approval");
  return {
    ...actual,
    getApproval: (...a: unknown[]) =>
      (mockConfigApproval.get ?? actual.getApproval)(...a),
    approveAndApply: (...a: unknown[]) =>
      (mockConfigApproval.apply ?? actual.approveAndApply)(...a),
    listApprovals: (...a: unknown[]) => mockListApprovals(...a),
    // Someone else could approve (TASK-203, N-24): the store beneath is not these fixtures'.
    configChangeWithoutApprover: async () => null,
  };
});
const mockNames = jest.fn();
jest.mock("@/platform/admin/account-names", () => {
  const actual = jest.requireActual("@/platform/admin/account-names");
  return { ...actual, namedAccounts: (...a: unknown[]) => mockNames(...a) };
});
const mockErasures = jest.fn();
const mockAttest = jest.fn();
const mockDecide = jest.fn();
jest.mock("@/platform/gdpr/erasure-status", () => {
  const actual = jest.requireActual("@/platform/gdpr/erasure-status");
  return { ...actual, listOpenErasures: (...a: unknown[]) => mockErasures(...a) };
});
jest.mock("@/platform/gdpr/erasure-attestation", () => {
  const actual = jest.requireActual("@/platform/gdpr/erasure-attestation");
  return {
    ...actual,
    requestErasureAttestation: (...a: unknown[]) => mockAttest(...a),
    decideErasureAttestation: (...a: unknown[]) => mockDecide(...a),
  };
});

// TASK-207 (N-17): the screens' every answer. A producer that reads rows sets them with `rows()`
// (helpers/fake-data.ts: each statement answered by the producer, audit rows kept); every other
// producer runs on the real data module, as before.
jest.mock("@/platform/data", () => {
  const actual = jest.requireActual("@/platform/data");
  const fake = require("@/__tests__/helpers/fake-data").fakeDataModule();
  const on = () =>
    (globalThis as { __ROUTE_FIXTURE_ROWS__?: boolean }).__ROUTE_FIXTURE_ROWS__ === true;
  const pick =
    (name: string) =>
    (...a: unknown[]) =>
      (on() ? fake : actual)[name](...a);
  return {
    ...actual,
    hasDatabase: pick("hasDatabase"),
    withTenantTx: pick("withTenantTx"),
    withPlatformTx: pick("withPlatformTx"),
    withOwnerTx: pick("withOwnerTx"),
  };
});

// The model beneath the AI routes: a producer sets what it answers (TASK-207); otherwise the
// platform's own orchestrator.
const mockModel: { complete?: (...a: unknown[]) => Promise<unknown> } = {};
jest.mock("@/platform/ai", () => {
  const actual = jest.requireActual("@/platform/ai");
  return {
    ...actual,
    getOrchestrator: (...a: unknown[]) =>
      mockModel.complete
        ? { complete: mockModel.complete }
        : actual.getOrchestrator(...a),
  };
});

// Guest tokens are minted by the platform (platform/auth/guest-token.ts); a producer can make the
// mint fail as it does in production without its secret (TASK-207).
const mockMint: { fail?: boolean } = {};
jest.mock("@/platform/auth/guest-token", () => {
  const actual = jest.requireActual("@/platform/auth/guest-token");
  return {
    ...actual,
    mintGuestToken: (...a: unknown[]) => {
      if (mockMint.fail) throw new Error("GUEST_TOKEN_SECRET is not set");
      return actual.mintGuestToken(...a);
    },
  };
});

import { CORE_FEATURE_REQUIREMENTS } from "@/platform/features/availability";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { authAs, type CallerName } from "@/__tests__/helpers/test-identities";
import { GET as jobsView } from "@/app/api/operator/jobs/route";
import { PATCH as patchSchedule } from "@/app/api/operator/jobs/schedules/[kind]/route";
import {
  InMemoryJobStore,
  registerJob,
  resetJobRegistry,
  resetJobStore,
  setJobStore,
} from "@/platform/jobs";
import {
  FIXTURE_NOW,
  fixtureDrift,
  normaliseBody,
  type RouteFixture,
} from "./fixtures/route-responses";
import { authAs as _authAs, identityFor } from "@/__tests__/helpers/test-identities";
import { GET as configGET } from "@/app/api/admin/config/route";
import { POST as configAiPOST } from "@/app/api/admin/config-ai/execute/route";
import { GET as approvalsGET } from "@/app/api/admin/approvals/route";
import { POST as executePOST } from "@/app/api/admin/ai/execute/route";
import { GET as agentRegistryGET } from "@/app/api/admin/agent-registry/route";
import { GET as erasuresGET } from "@/app/api/operator/erasures/route";
import { POST as attestationPOST } from "@/app/api/operator/tenants/[id]/erasures/[userId]/attestation/route";
import { resetProposalStore } from "@/platform/agents/proposal-store";
import type { EnhancedConfigEntry } from "@/platform/admin/types";
import { fakeData } from "@/__tests__/helpers/fake-data";
import { identityWithRole } from "@/__tests__/helpers/test-identities";
import { GET as sessionGET } from "@/app/api/admin/session/route";
import { GET as usersGET } from "@/app/api/admin/users/route";
import { GET as rolesGET } from "@/app/api/admin/roles/route";
import { GET as entitlementsGET } from "@/app/api/admin/entitlements/route";
import { GET as auditGET } from "@/app/api/admin/audit/route";
import { GET as passwordPolicyGET } from "@/app/api/admin/password-policy/route";
import { GET as perAccountGET } from "@/app/api/admin/per-account/route";
import { GET as approvalPolicyGET } from "@/app/api/admin/approval-policy/route";
import { GET as capabilitiesGET } from "@/app/api/admin/capabilities/route";
import { GET as capabilityMappingGET } from "@/app/api/admin/capability-mapping/route";
import { GET as tenantGET } from "@/app/api/admin/tenant/route";
import { GET as operatorTenantsGET } from "@/app/api/operator/tenants/route";
import { POST as signOutPOST } from "@/app/api/auth/sign-out/route";
import { POST as planPOST } from "@/app/api/admin/ai/route";
import { AIRefusalError } from "@/platform/ai/provider";
import { PATCH as usersPATCH } from "@/app/api/admin/users/route";
import { GET as gdprGET, POST as gdprPOST } from "@/app/api/admin/gdpr/route";
import { ROLE_PERMISSIONS } from "@/__tests__/helpers/test-identities";
import { POST as killSwitchPOST } from "@/app/api/admin/agents/suspend/route";
import { POST as tenantKillSwitchPOST } from "@/app/api/operator/tenants/[id]/agents/suspend/route";
import { AuditWriteError } from "@/platform/auth/audit";
import { POST as appealsPOST } from "@/app/api/moderation/appeals/route";
import { getModerationStore, resetModerationStore } from "@/platform/moderation/store";
import {
  getReviewQueueStore,
  resetReviewQueueStore,
} from "@/platform/moderation/review-store";
import { GET as reviewGET } from "@/app/api/moderation/review/route";
import { PATCH as reviewPATCH } from "@/app/api/moderation/review/[id]/route";
import { POST as assistPOST } from "@/app/api/moderation/review/[id]/assist/route";
import { runWithTenant } from "@/platform/tenancy/context";
import { CALLERS } from "@/__tests__/helpers/test-identities";
import { POST as refreshPOST } from "@/app/api/auth/refresh/route";
import { REFRESH_COOKIE, refreshCookieValue } from "@/platform/auth/auth-response";
import { GET as featuresGET } from "@/app/api/features/route";
import { POST as guestPOST } from "@/app/api/auth/guest/route";
import { POST as signInPOST } from "@/app/api/auth/sign-in/route";
import { POST as mfaSetupPOST } from "@/app/api/auth/mfa/setup/route";
import { POST as mfaVerifyPOST } from "@/app/api/auth/mfa/verify/route";
import { POST as runNowPOST } from "@/app/api/operator/jobs/schedules/[kind]/run/route";
import { POST as deadJobPOST } from "@/app/api/operator/jobs/dead/[id]/route";
import { clearConfigCache } from "@/platform/auth/platform-config";
import { POST as decisionPOST } from "@/app/api/admin/approvals/[id]/route";
import {
  getProposalStore,
  InMemoryProposalStore,
} from "@/platform/agents/proposal-store";
import { CONFIG_HOLDS, type HoldResumeResult } from "@/platform/admin/hold-authority";
import { PUT as configPUT, DELETE as configDELETE } from "@/app/api/admin/config/route";
import { getBudgetTracker } from "@/platform/agents/budget-tracker";
import { POST as tenantsPOST } from "@/app/api/operator/tenants/route";
import { POST as statePOST } from "@/app/api/operator/tenants/[id]/state/route";
import { POST as deletionPOST } from "@/app/api/operator/tenants/[id]/deletion/route";
import { POST as deletionDecidePOST } from "@/app/api/operator/deletions/[id]/route";
import {
  POST as domainsPOST,
  DELETE as domainsDELETE,
} from "@/app/api/operator/tenants/[id]/domains/route";
import { POST as adminsPOST } from "@/app/api/operator/tenants/[id]/admins/route";
import { POST as purgePOST } from "@/app/api/operator/purge/route";
import { GET as readinessGET } from "@/app/api/operator/readiness/route";
import {
  GET as tenantConfigGET,
  PUT as tenantConfigPUT,
  DELETE as tenantConfigDELETE,
} from "@/app/api/operator/tenants/[id]/config/route";
import { GET as tenantApprovalsGET } from "@/app/api/operator/tenants/[id]/approvals/route";
import { POST as tenantDecisionPOST } from "@/app/api/operator/tenants/[id]/approvals/[approvalId]/route";
import {
  getTenantDirectory,
  InMemoryTenantDirectory,
  setTenantDirectory,
  type TenantRecord,
} from "@/platform/tenancy/directory";
import { getAuthProvider, registerAuthProvider } from "@/platform/auth/config";
import { initAuth } from "@/platform/auth/auth-init";
import type { AuthProvider } from "@/platform/auth/provider";

const FILE = join(__dirname, "fixtures", "route-responses.json");
const TENANT = "aaaaaaaa-0000-4000-8000-00000000000a";

function req(
  url: string,
  method: string,
  caller: CallerName | ReturnType<typeof identityFor>,
  body?: unknown
): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: {
      ...(typeof caller === "string" ? authAs(caller) : _authAs(caller)),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function record(res: Response): Promise<RouteFixture> {
  return { status: res.status, body: normaliseBody(await res.json()) };
}

/** The Jobs console's answer with only the core's schedules and the test's own. */
async function recordJobs(res: Response): Promise<RouteFixture> {
  const f = await record(res);
  const body = f.body as { schedules?: { owner: string; kind: string }[] };
  if (!Array.isArray(body.schedules)) return f;
  return {
    ...f,
    body: {
      ...body,
      schedules: body.schedules.filter(
        (s) => s.owner === "core" || s.kind === "test.sched"
      ),
    },
  };
}

/**
 * /api/features' answer with only the core's features: a module's (or an app's) differ with the
 * modules registered (`npm run test:core` registers none), as the Jobs console's schedules do.
 */
async function recordFeatures(res: Response): Promise<RouteFixture> {
  const f = await record(res);
  const body = f.body as { features?: Record<string, unknown> };
  if (!body.features) return f;
  const core = new Set(CORE_FEATURE_REQUIREMENTS.map((r) => r.id));
  return {
    ...f,
    body: {
      ...body,
      features: Object.fromEntries(
        Object.entries(body.features).filter(([id]) => core.has(id))
      ),
    },
  };
}

const kind = (k: string) => ({ params: Promise.resolve({ kind: k }) });

// ── TASK-202: the admin console's screens ─────────────────────────────────────────────────────

/** A second super admin: the one who approves what the first asked. */
const APPROVER = identityFor("super_admin", { name: "fixture-approver" });

const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A body with its run-specific values fixed: every generated id (a hold's, a trajectory's, an
 * operation's) numbered in order of appearance — the first 00000000-0000-4000-8000-0000000000ff,
 * then …00000000fe and down, so two holds in one answer stay two (TASK-207) — and the config
 * route's trajectory, agent and steps.
 */
function stable(value: unknown): unknown {
  const ids = new Map<string, string>();
  const fix = (v: unknown, key = ""): unknown => {
    if (typeof v === "string") {
      if (UUID_ANY.test(v) && !/^0{8}-/.test(v) && !v.startsWith("aaaaaaaa")) {
        if (!ids.has(v))
          ids.set(
            v,
            `00000000-0000-4000-8000-${(0xff - ids.size).toString(16).padStart(12, "0")}`
          );
        return ids.get(v);
      }
      if (key === "trajectoryId" || key === "agentId" || key === "operationId")
        return `${key}-fixed`;
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => fix(x));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          k,
          k === "steps" || k === "durationMs" ? (Array.isArray(x) ? [] : 0) : fix(x, k),
        ])
      );
    return v;
  };
  return fix(value);
}

async function recordStable(res: Response): Promise<RouteFixture> {
  const f = await record(res);
  return { ...f, body: stable(f.body) };
}

/** Settings as the config store lists them (the shapes the screens read). */
const SETTING: Record<string, EnhancedConfigEntry> = {
  number: {
    key: "moderation.strike_ban_threshold",
    value: 5,
    description: "Strikes before an account is banned.",
    category: "moderation",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultValue: 5,
    valueType: "number",
    minValue: 1,
    maxValue: 20,
    allowedValues: null,
    permissionTier: "safety",
    tenantOverridable: true,
    overridden: false,
    platformValue: 5,
  },
  standard: {
    key: "default_language",
    value: "en",
    description: "The language a new account starts with.",
    category: "general",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultValue: "en",
    valueType: "string_enum",
    minValue: null,
    maxValue: null,
    allowedValues: ["en", "fr", "es"],
    permissionTier: "standard",
    tenantOverridable: true,
    overridden: false,
    platformValue: "en",
  },
  list: {
    key: "config.dual_control_keys",
    value: ["signups_enabled", "config.dual_control_keys"],
    description: "Keys that need an independent approver before a change applies.",
    category: "config",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultValue: ["signups_enabled", "config.dual_control_keys"],
    valueType: "json_array",
    minValue: null,
    maxValue: null,
    allowedValues: null,
    permissionTier: "safety",
    tenantOverridable: false,
    overridden: false,
    platformValue: ["signups_enabled", "config.dual_control_keys"],
  },
  toggle: {
    key: "signups_enabled",
    value: true,
    description: "Whether new accounts may sign up.",
    category: "auth",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultValue: true,
    valueType: "boolean",
    minValue: null,
    maxValue: null,
    allowedValues: null,
    permissionTier: "safety",
    tenantOverridable: true,
    overridden: false,
    platformValue: true,
  },
};

/** The config store as these producers see it: these settings, this dual-control list. */
function settings(dualControlled: readonly string[]): void {
  mockCfg.getEnhancedConfig.mockImplementation(async (key: string) =>
    Object.values(SETTING).find((e) => e.key === key)
  );
  mockCfg.listEnhancedConfig.mockImplementation(async () => Object.values(SETTING));
  mockCfg.getPermissionTier.mockImplementation(
    async (key: string) =>
      Object.values(SETTING).find((e) => e.key === key)?.permissionTier ?? "safety"
  );
  mockCfg.getConfigOrThrow.mockImplementation(async (key: string) => {
    if (key === "config.dual_control_keys") return dualControlled;
    if (key === "agent.trusted_agents")
      return [
        [
          "agent:research",
          {
            owner: "first-party",
            scopes: ["translate"],
            status: "active",
            maxTokenTtl: 300,
          },
        ],
      ];
    if (key === "config.require_two_person_approval") return false;
    throw new Error(`no ${key} here`);
  });
  mockCfg.setConfigWithHistory.mockImplementation(async () => ({ success: true }));
}

const updateConfig = (key: string, value: unknown, comment: string) =>
  configAiPOST(
    req("/api/admin/config-ai/execute", "POST", "super_admin", {
      toolId: "update_config",
      input: { key, value, changeComment: comment, confirmed: true },
    })
  );

/** The names the approvals and audit read: the requester by address and role. */
function names(): void {
  mockNames.mockImplementation(async (ids: readonly (string | null | undefined)[]) => {
    const requester = (ids as string[]).find(
      (i) => i && i.startsWith("00000000-0000-4000-9000")
    );
    return new Map(
      requester
        ? [
            [
              requester,
              {
                id: requester,
                email: "requester@example.test",
                role: "Super admin",
                erased: false,
              },
            ],
          ]
        : []
    );
  });
}

const OPEN_ERASURES = {
  operators: 1,
  reasons: ["pool_decommissioned", "deleted_in_old_pool", "identity_never_existed"],
  erasures: [
    {
      tenantId: "aaaaaaaa-0000-4000-8000-00000000000a",
      tenantSlug: "default",
      userId: "0f0fc9b2-0000-4000-8000-000000000001",
      requestedBy: { kind: "account", email: "requester@example.test" },
      softDeletedAt: "2026-01-01T00:00:00.000Z",
      purgeAfter: "2026-01-01T00:00:00.000Z",
      purgedAt: null,
      purgeAttempts: 0,
      purgeRetryAt: null,
      purgeFailing: false,
      steps: [
        { store: "identity-provider", done: false, attempts: 4, poolUnverified: true },
      ],
      secondOperator: false,
    },
  ],
};

// ── TASK-207 (N-17): every answer the screen tests give, each made by its route ──────────────

/** This producer's database: each statement answered by `answer` (helpers/fake-data.ts). */
function rows(
  answer: (sql: string, values: readonly unknown[]) => unknown[] | undefined
) {
  (globalThis as { __ROUTE_FIXTURE_ROWS__?: boolean }).__ROUTE_FIXTURE_ROWS__ = true;
  fakeData().reset();
  fakeData().answer = answer as never;
}

/** Back to the real data module (the producers before TASK-207 run on it). */
function noRows(): void {
  (globalThis as { __ROUTE_FIXTURE_ROWS__?: boolean }).__ROUTE_FIXTURE_ROWS__ = false;
  fakeData().reset();
}

/** A request with exactly these headers (a browser's, not a test caller's). */
function rawReq(
  url: string,
  method: string,
  headers: Record<string, string> = {},
  body?: unknown
): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

let mockRealProvider: AuthProvider | null = null;
/**
 * The identity provider answering these calls as `answers` says (the provider is the store beneath
 * the auth routes); every other call is the platform's test provider's.
 */
function provider(answers: Partial<AuthProvider>): void {
  initAuth();
  mockRealProvider ??= getAuthProvider();
  registerAuthProvider({ ...mockRealProvider, ...answers } as AuthProvider);
}
function realProvider(): void {
  if (mockRealProvider) registerAuthProvider(mockRealProvider);
}

/**
 * The next rate-limit check refused, as the shared limiter refuses it: the real enforcement, its
 * store answering "limited" with 30 seconds to wait (the limiter is the store beneath).
 */
function limitedOnce(): void {
  const actual = jest.requireActual("@/platform/rate-limit");
  const factory = jest.requireActual("@/platform/rate-limit/factory");
  jest
    .requireMock<{ enforceRateLimit: jest.Mock }>("@/platform/rate-limit")
    .enforceRateLimit.mockImplementationOnce(async (...a: unknown[]) => {
      const was = factory.peekRateLimiter();
      factory.setRateLimiter({
        name: "fixture",
        check: async () => ({
          allowed: false,
          limit: 10,
          remaining: 0,
          resetAt: 1767225600,
          retryAfterSeconds: 30,
        }),
      });
      try {
        return await actual.enforceRateLimit(...a);
      } finally {
        if (was) factory.setRateLimiter(was);
        else factory.resetRateLimiter();
      }
    });
}

/** The model answering every call with `complete` (the orchestrator beneath the AI routes). */
function model(complete: (...a: unknown[]) => Promise<unknown>): void {
  mockModel.complete = complete;
}

const plan = (caller: CallerName | ReturnType<typeof identityFor>, prompt = "do it") =>
  planPOST(req("/api/admin/ai", "POST", caller, { prompt, panel: "roles" }));

const MODERATOR_PERMISSIONS = ["can_access_admin", "can_moderate"];
/** A role an administrator made: roles only (TASK-184's "first permitted section is Roles"). */
const ROLES_ADMIN = identityWithRole("fixture-roles-admin", "roles_admin", [
  "can_access_admin",
  "admin_manage_roles",
]);
/** A moderator whose permission rows hold values that are not codes. */
const ODD_MODERATOR = identityWithRole("fixture-odd-moderator", "moderator", [
  null,
  42,
  { code: "*" },
  ["*"],
  ...MODERATOR_PERMISSIONS,
]);

/** Each admin console section's data route (app/admin/page.tsx), read by its GET. */
const PANEL_GETS: Readonly<Record<string, (r: NextRequest) => Promise<Response>>> = {
  "/api/admin/users": usersGET,
  "/api/admin/roles": rolesGET,
  "/api/admin/entitlements": entitlementsGET,
  "/api/admin/audit": auditGET,
  "/api/admin/approvals": approvalsGET,
  "/api/admin/password-policy": passwordPolicyGET,
  "/api/admin/agent-registry": agentRegistryGET,
  "/api/admin/per-account": perAccountGET,
  "/api/admin/approval-policy": approvalPolicyGET,
  "/api/admin/capabilities": capabilitiesGET,
  "/api/admin/capability-mapping": capabilityMappingGET,
  "/api/admin/tenant": tenantGET,
  "/api/operator/tenants": operatorTenantsGET,
  "/api/operator/jobs": jobsView,
};

/** The session route as the local development bypass answers it (ADMIN_DEV_BYPASS=true). */
async function devBypassSession(): Promise<Response> {
  const was = process.env.ADMIN_DEV_BYPASS;
  process.env.ADMIN_DEV_BYPASS = "true";
  try {
    let get: typeof sessionGET = sessionGET;
    jest.isolateModules(() => {
      get = require("@/app/api/admin/session/route").GET;
    });
    return await get(req("/api/admin/session", "GET", "anonymous"));
  } finally {
    if (was === undefined) delete process.env.ADMIN_DEV_BYPASS;
    else process.env.ADMIN_DEV_BYPASS = was;
  }
}

/** The admin console (app/admin/page.tsx): who it is open for, and each section's first read. */
const ADMIN_CONSOLE: Readonly<Record<string, () => Promise<RouteFixture>>> = {
  "GET /api/admin/session — a moderator": async () => {
    rows(() => []);
    return record(await sessionGET(req("/api/admin/session", "GET", "moderator")));
  },
  "GET /api/admin/session — a super admin": async () => {
    rows(() => []);
    return record(await sessionGET(req("/api/admin/session", "GET", "super_admin")));
  },
  "GET /api/admin/session — the development bypass": async () =>
    record(await devBypassSession()),
  "GET /api/admin/session — a role made for roles only": async () => {
    rows(() => []);
    return record(await sessionGET(req("/api/admin/session", "GET", ROLES_ADMIN)));
  },
  "GET /api/admin/session — a moderator whose permission rows hold non-codes":
    async () => {
      rows(() => []);
      return record(await sessionGET(req("/api/admin/session", "GET", ODD_MODERATOR)));
    },
  "GET /api/admin/session — refused (no second factor)": async () => {
    rows(() => []);
    return record(
      await sessionGET(req("/api/admin/session", "GET", "password_only_super_admin"))
    );
  },
  "GET /api/admin/session — refused (no administrative access)": async () =>
    record(await sessionGET(req("/api/admin/session", "GET", "free"))),
  "GET /api/admin/session — refused (signed out)": async () =>
    record(await sessionGET(req("/api/admin/session", "GET", "anonymous"))),
  "GET /api/admin/session — refused (a suspended staff account)": async () => {
    rows(() => []);
    return record(
      await sessionGET(req("/api/admin/session", "GET", "suspended_super_admin"))
    );
  },
  "GET /api/admin/session — the permissions store down": async () => {
    jest
      .requireMock<{ getCachedPermissions: jest.Mock }>(
        "@/platform/auth/permissions-cache"
      )
      .getCachedPermissions.mockRejectedValueOnce(new Error("permissions unavailable"));
    return record(await sessionGET(req("/api/admin/session", "GET", "super_admin")));
  },
  "GET /api/admin/approvals — none held": async () =>
    recordStable(await approvalsGET(req("/api/admin/approvals", "GET", "moderator"))),
  "GET /api/admin/tenant — to a moderator": async () => {
    rows((sql) =>
      sql.includes("directory_tenant")
        ? [{ slug: "default", name: "Default", status: "active" }]
        : []
    );
    return record(await tenantGET(req("/api/admin/tenant", "GET", "moderator")));
  },
  "GET /api/admin/users — no accounts": async () => {
    rows(() => []);
    return record(await usersGET(req("/api/admin/users", "GET", "super_admin")));
  },
  "GET /api/admin/roles — the roles": async () => {
    rows((sql) =>
      /from roles/.test(sql)
        ? [
            {
              id: "0000000a-0000-4000-8000-000000000001",
              name: "roles_admin",
              display_name: "Roles admin",
              description: null,
              description_note: null,
              created_at: new Date("2026-01-01T00:00:00.000Z"),
              updated_at: new Date("2026-01-01T00:00:00.000Z"),
            },
            // A role duplicated from it, as handleDuplicateRole stores one (TASK-207, N-107:
            // __tests__/db/admin-catalog.db.test.ts reads the row it writes).
            {
              id: "0000000a-0000-4000-8000-000000000002",
              name: "roles_admin_copy",
              display_name: "Roles admin (copy)",
              description: "Manages roles.",
              description_note: {
                key: "screens.admin_console.roles.duplicated_from",
                params: { source: "roles_admin" },
              },
              created_at: new Date("2026-01-01T00:00:00.000Z"),
              updated_at: new Date("2026-01-01T00:00:00.000Z"),
            },
          ]
        : []
    );
    return record(await rolesGET(req("/api/admin/roles", "GET", ROLES_ADMIN)));
  },
  "POST /api/auth/sign-out — signed out": async () =>
    record(
      await signOutPOST(
        rawReq("/api/auth/sign-out", "POST", {
          authorization: "Bearer staff-access-token",
        })
      )
    ),
  "POST /api/auth/sign-out — the provider failing": async () => {
    provider({
      signOut: async () => {
        throw new Error("provider unavailable");
      },
    });
    return record(
      await signOutPOST(
        rawReq("/api/auth/sign-out", "POST", {
          authorization: "Bearer staff-access-token",
        })
      )
    );
  },
  "POST /api/admin/ai — refused (rate limited)": async () => {
    limitedOnce();
    return record(await plan("super_admin"));
  },
  "POST /api/admin/ai — refused (signed out)": async () =>
    record(await plan("anonymous")),
  "POST /api/admin/ai — refused (a suspended staff account)": async () => {
    rows(() => []);
    return record(await plan("suspended_super_admin"));
  },
  "POST /api/admin/ai — the model declined": async () => {
    rows(() => []);
    model(async () => {
      throw new AIRefusalError();
    });
    return record(await plan("super_admin"));
  },
  ...Object.fromEntries(
    Object.entries(PANEL_GETS).map(([path, get]) => [
      `GET ${path} — refused (no permission)`,
      async () => record(await get(req(path, "GET", "free"))),
    ])
  ),
};

type Call = (caller: CallerName | ReturnType<typeof identityFor>) => Promise<Response>;

/**
 * What every guarded route refuses with, before it reads anything (requireAdmin): signed out, no
 * permission, a suspended account, no second factor, the rate limit, the permissions store down —
 * each as `<prefix> — refused (…)`.
 */
function guardRefusals(
  prefix: string,
  call: Call
): Record<string, () => Promise<RouteFixture>> {
  return {
    [`${prefix} — refused (signed out)`]: async () => record(await call("anonymous")),
    [`${prefix} — refused (no permission)`]: async () => record(await call("free")),
    [`${prefix} — refused (a suspended staff account)`]: async () => {
      rows(() => []);
      return record(await call("suspended_super_admin"));
    },
    [`${prefix} — refused (no second factor)`]: async () => {
      rows(() => []);
      return record(await call("password_only_super_admin"));
    },
    [`${prefix} — refused (rate limited)`]: async () => {
      limitedOnce();
      return record(await call("super_admin"));
    },
    [`${prefix} — refused (the permissions store down)`]: async () => {
      jest
        .requireMock<{ getCachedPermissions: jest.Mock }>(
          "@/platform/auth/permissions-cache"
        )
        .getCachedPermissions.mockRejectedValueOnce(new Error("permissions unavailable"));
      return record(await call("super_admin"));
    },
  };
}

// The Users screen's accounts and roles (components/admin/UsersPanel.tsx), as the tables hold them.
const ROLE_ID = {
  free: "0000000a-0000-4000-8000-0000000000f1",
  moderator: "0000000a-0000-4000-8000-0000000000f2",
  super_admin: "0000000a-0000-4000-8000-0000000000f3",
} as const;
const ROLE_ROWS = [
  { id: ROLE_ID.free, name: "free", display_name: "Free", is_default: true },
  {
    id: ROLE_ID.moderator,
    name: "moderator",
    display_name: "Moderator",
    is_default: false,
  },
  {
    id: ROLE_ID.super_admin,
    name: "super_admin",
    display_name: "Super Admin",
    is_default: false,
  },
];
interface UserRowShape {
  id: string;
  email: string | null;
  display_name: string | null;
  role_id: string;
  created_at: Date;
  deleted_at: Date | null;
  account_status: string;
  restricted_until: Date | null;
  suspended_until: Date | null;
  email_verified: boolean;
  last_login_at: Date | null;
  cognito_sub?: string | null;
}
const userRow = (over: Partial<UserRowShape> = {}): UserRowShape => ({
  id: "11111111-1111-4111-8111-111111111111",
  email: "ann@example.com",
  display_name: "Ann",
  role_id: ROLE_ID.free,
  created_at: new Date("2026-10-26T12:00:00.000Z"),
  deleted_at: null,
  account_status: "active",
  restricted_until: null,
  suspended_until: null,
  email_verified: true,
  last_login_at: new Date("2026-10-27T12:00:00.000Z"),
  cognito_sub: "ann-sub",
  ...over,
});
const ANN = userRow();
/** A super admin from before addresses were recorded: no address, never signed in. */
const OLD_STAFF = userRow({
  id: "22222222-2222-4222-8222-222222222222",
  email: null,
  display_name: "",
  role_id: ROLE_ID.super_admin,
  created_at: new Date("2026-06-07T12:00:00.000Z"),
  email_verified: false,
  last_login_at: null,
  cognito_sub: null,
});

/**
 * The users and roles tables as the Users screen's routes read them: the page, the grants, the
 * role catalog, a user or role by id, a role's permissions (the catalog's), a role change.
 */
function usersTables(
  users: readonly UserRowShape[],
  grants: readonly {
    user_id: string;
    code: string;
    display_name: string;
    expires_at: Date | null;
  }[] = []
): (sql: string, values: readonly unknown[]) => unknown[] | undefined {
  return (sql, values) => {
    if (/from users u /.test(sql)) return users.slice(0, Number(values[1]));
    if (/from user_entitlements ue/.test(sql)) return [...grants];
    if (/^select id, name, display_name from roles order by/.test(sql)) return ROLE_ROWS;
    if (/from roles where id = \$1/.test(sql))
      return ROLE_ROWS.filter((r) => r.id === values[0]);
    if (/from roles where name = \$1/.test(sql))
      return ROLE_ROWS.filter((r) => r.name === values[0]);
    if (/select p\.code from permissions p/.test(sql)) {
      const role = ROLE_ROWS.find((r) => r.id === values[0]);
      return (role ? (ROLE_PERMISSIONS[role.name] ?? []) : []).map((code) => ({ code }));
    }
    if (/from users where id = \$1::uuid/.test(sql))
      return users.filter((u) => u.id === values[0]);
    return [];
  };
}

/** The settings beneath an admin route: no action under dual control unless listed. */
function dualControlledActions(actions: readonly string[]): void {
  settings([]);
  const keys = mockCfg.getConfigOrThrow.getMockImplementation()!;
  mockCfg.getConfigOrThrow.mockImplementation(async (key: string) =>
    key === "admin.dual_control_actions" ? actions : keys(key)
  );
}

const listUsers = (caller: Parameters<Call>[0], query = "") =>
  usersGET(
    req(`/api/admin/users?sort=created&dir=desc&limit=25&offset=0${query}`, "GET", caller)
  );
const changeRole = (caller: Parameters<Call>[0], roleId: string = ROLE_ID.moderator) =>
  usersPATCH(req("/api/admin/users", "PATCH", caller, { userId: ANN.id, roleId }));
const eraseAnn = (caller: Parameters<Call>[0]) =>
  gdprPOST(
    req("/api/admin/gdpr", "POST", caller, { userId: ANN.id, reason: "admin-action" })
  );
const pendingErasure = (caller: Parameters<Call>[0]) =>
  gdprGET(req(`/api/admin/gdpr?userId=${ANN.id}`, "GET", caller));

/** Twenty-six accounts: a page of 25 with more to read. */
const MANY = [
  ANN,
  OLD_STAFF,
  ...Array.from({ length: 24 }, (_, i) =>
    userRow({
      id: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`,
      email: `member${i}@example.com`,
      display_name: `Member ${i}`,
    })
  ),
];

/** The Users screen (components/admin/UsersPanel.tsx). */
const USERS_SCREEN: Readonly<Record<string, () => Promise<RouteFixture>>> = {
  "GET /api/admin/users — Ann and a super admin who never signed in": async () => {
    rows(usersTables([ANN, OLD_STAFF]));
    return record(await listUsers("super_admin"));
  },
  "GET /api/admin/users — a page of 25, more to read": async () => {
    rows(usersTables(MANY));
    return record(await listUsers("super_admin"));
  },
  "GET /api/admin/users — the next page": async () => {
    rows(usersTables([ANN]));
    return record(await listUsers("super_admin", "&offset=25"));
  },
  "GET /api/admin/users — Ann alone": async () => {
    rows(usersTables([ANN]));
    return record(await listUsers("super_admin"));
  },
  "GET /api/admin/users — Ann, now a moderator": async () => {
    rows(usersTables([userRow({ role_id: ROLE_ID.moderator })]));
    return record(await listUsers("super_admin"));
  },
  "GET /api/admin/users — Ann suspended until 2 November": async () => {
    rows(
      usersTables([
        userRow({
          account_status: "suspended",
          suspended_until: new Date("2026-11-02T12:00:00.000Z"),
        }),
      ])
    );
    return record(await listUsers("super_admin"));
  },
  "GET /api/admin/users — Ann with Beta access until 1 December": async () => {
    rows(
      usersTables(
        [ANN, OLD_STAFF],
        [
          {
            user_id: ANN.id,
            code: "beta",
            display_name: "Beta access",
            expires_at: new Date("2026-12-01T12:00:00.000Z"),
          },
        ]
      )
    );
    return record(await listUsers("super_admin"));
  },
  "GET /api/admin/users — no account matches the search": async () => {
    rows(usersTables([]));
    return record(await listUsers("super_admin", "&q=zed"));
  },
  "GET /api/admin/users — the store failing": async () => {
    rows(() => {
      throw new Error("users unavailable");
    });
    return record(await listUsers("super_admin"));
  },
  ...guardRefusals("GET /api/admin/users", (c) => listUsers(c)),
  "PATCH /api/admin/users — changed": async () => {
    dualControlledActions([]);
    rows(usersTables([ANN, OLD_STAFF]));
    return record(await changeRole("super_admin"));
  },
  "PATCH /api/admin/users — held for a second admin": async () => {
    dualControlledActions(["change_user_role"]);
    rows(usersTables([ANN, OLD_STAFF]));
    return recordStable(await changeRole("super_admin"));
  },
  "PATCH /api/admin/users — refused (no such account)": async () => {
    dualControlledActions([]);
    rows(usersTables([OLD_STAFF]));
    return record(await changeRole("super_admin"));
  },
  "PATCH /api/admin/users — refused (a protected role)": async () => {
    dualControlledActions([]);
    rows(usersTables([ANN, OLD_STAFF]));
    return record(
      await usersPATCH(
        req("/api/admin/users", "PATCH", "admin", {
          userId: ANN.id,
          roleId: ROLE_ID.super_admin,
        })
      )
    );
  },
  "PATCH /api/admin/users — refused (the roles store down)": async () => {
    dualControlledActions([]);
    rows(() => {
      throw new Error("roles unavailable");
    });
    return record(await changeRole("super_admin"));
  },
  ...guardRefusals("PATCH /api/admin/users", (c) => changeRole(c)),
  "GET /api/admin/gdpr — no erasure pending": async () =>
    record(await pendingErasure("super_admin")),
  "GET /api/admin/gdpr — an erasure pending": async () => {
    rows(usersTables([ANN, OLD_STAFF]));
    await eraseAnn("super_admin");
    return recordStable(await pendingErasure("super_admin"));
  },
  "POST /api/admin/gdpr — held for a second admin": async () => {
    rows(usersTables([ANN, OLD_STAFF]));
    return recordStable(await eraseAnn("super_admin"));
  },
  "POST /api/admin/gdpr — refused (an erasure already pending)": async () => {
    rows(usersTables([ANN, OLD_STAFF]));
    await eraseAnn("super_admin");
    return record(await eraseAnn("super_admin"));
  },
  "POST /api/admin/gdpr — refused (no such account)": async () => {
    rows(usersTables([OLD_STAFF]));
    return record(await eraseAnn("super_admin"));
  },
  ...guardRefusals("POST /api/admin/gdpr", (c) => eraseAnn(c)),
};

const realDirectory = getTenantDirectory();
/**
 * A shared deployment (one operator, many tenants): the operator's own tenant and these, as the
 * directory holds them.
 */
async function shared(
  tenants: readonly Pick<TenantRecord, "id" | "slug" | "name">[] = []
): Promise<InMemoryTenantDirectory> {
  mockTenancy.mode = "shared";
  const directory = new InMemoryTenantDirectory({ withDefault: false });
  for (const t of [{ id: TENANT, slug: "home", name: "Home" }, ...tenants])
    await directory.createTenant(t);
  setTenantDirectory(directory);
  return directory;
}
function single(): void {
  mockTenancy.mode = "single";
  setTenantDirectory(realDirectory);
}

/** The agent registry as the config store holds it: these agents, each with this status. */
function registry(agents: Readonly<Record<string, "active" | "suspended">>): void {
  settings([]);
  const value = Object.entries(agents).map(([id, status]) => [
    id,
    { owner: "first-party", scopes: ["translate"], status, maxTokenTtl: 300 },
  ]);
  const entry: EnhancedConfigEntry = {
    key: "agent.trusted_agents",
    value,
    description: "The agents trusted to act, with their scopes.",
    category: "agents",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultValue: [],
    valueType: "json_array",
    minValue: null,
    maxValue: null,
    allowedValues: null,
    permissionTier: "safety",
    tenantOverridable: true,
    overridden: false,
    platformValue: value,
  };
  const others = mockCfg.getEnhancedConfig.getMockImplementation()!;
  mockCfg.getEnhancedConfig.mockImplementation(async (key: string) =>
    key === entry.key ? entry : others(key)
  );
  mockCfg.publishConfigInvalidation.mockImplementation(async () => true);
}

const suspendAll = (caller: Parameters<Call>[0] = "super_admin") =>
  killSwitchPOST(
    req("/api/admin/agents/suspend", "POST", caller, { reason: "incident 42" })
  );

/** The agent kill switch (components/admin/AgentKillSwitchPanel.tsx). */
const KILL_SWITCH: Readonly<Record<string, () => Promise<RouteFixture>>> = {
  "POST /api/admin/agents/suspend — two suspended, a held change withdrawn": async () => {
    registry({ "agent:x": "active", "agent:y": "active" });
    // A change to the registry held for a second admin before the suspension, withdrawn by it.
    rows((sql) =>
      /^update config_pending_approvals/.test(sql)
        ? [{ id: "0a1b2c3d-0000-4000-8000-0000000000a1" }]
        : sql.startsWith("select clock_timestamp()")
          ? [{ at: FIXTURE_NOW }]
          : []
    );
    return record(await suspendAll());
  },
  "POST /api/admin/agents/suspend — one suspended": async () => {
    registry({ "agent:x": "active", "agent:y": "suspended" });
    return record(await suspendAll());
  },
  "POST /api/admin/agents/suspend — none active, told again": async () => {
    registry({ "agent:x": "suspended" });
    return record(await suspendAll());
  },
  "POST /api/admin/agents/suspend — none active, the invalidation not published":
    async () => {
      registry({ "agent:x": "suspended" });
      mockCfg.publishConfigInvalidation.mockImplementation(async () => false);
      return record(await suspendAll());
    },
  "POST /api/admin/agents/suspend — refused (the registry unreadable)": async () => {
    settings([]);
    mockCfg.getEnhancedConfig.mockImplementation(async () => undefined);
    return record(await suspendAll());
  },
  "POST /api/admin/agents/suspend — refused (the audit log down)": async () => {
    registry({ "agent:x": "active" });
    mockCfg.setConfigWithHistory.mockImplementation(async () => {
      throw new AuditWriteError("admin_action", "audit unavailable");
    });
    return record(await suspendAll());
  },
  ...guardRefusals("POST /api/admin/agents/suspend", (c) => suspendAll(c)),
  "POST /api/operator/tenants/[id]/agents/suspend — one suspended": async () => {
    await shared();
    registry({ "agent:x": "active" });
    return record(
      await tenantKillSwitchPOST(
        req(`/api/operator/tenants/${TENANT}/agents/suspend`, "POST", "super_admin", {
          reason: "beta incident",
        }),
        { params: Promise.resolve({ id: TENANT }) }
      )
    );
  },
};

/** A block the guardian recorded on this caller's content, as the moderation store holds it. */
async function blocked(trajectoryId: string, userId: string): Promise<void> {
  await runWithTenant({ tenantId: TENANT, mode: "single" }, () =>
    getModerationStore().logAudit({
      inputHash: "0".repeat(64),
      direction: "input",
      contentType: "generation",
      contentRatingLevel: 1,
      userId,
      triggeredBy: "classifier",
      categoriesFlagged: ["harassment"],
      confidence: 0.92,
      severity: "high",
      actionTaken: "block",
      reasoning: "harassment, high confidence",
      severityAdjustment: 0,
      contextFactors: [],
      attributeToUser: true,
      classifierCostUsd: 0,
      trajectoryId,
      agentId: "guardian",
      pipelineLatencyMs: 12,
      requestId: "req_0000000000000001",
      timestamp: FIXTURE_NOW,
    } as never)
  );
}

const appeal = () =>
  appealsPOST(
    req("/api/moderation/appeals", "POST", "free", {
      originalDecisionId: "traj-1",
      appealReason: "This is a sufficiently long and detailed appeal reason.",
    })
  );
/** The users table as the appeal reads it: the caller's own account. */
const ownAccount = () =>
  rows((sql) =>
    /from users where cognito_sub/.test(sql) ? [{ id: CALLERS.free.userId }] : []
  );

/** The appeal form (components/AppealForm/AppealForm.tsx). */
const APPEALS: Readonly<Record<string, () => Promise<RouteFixture>>> = {
  "POST /api/moderation/appeals — submitted": async () => {
    ownAccount();
    await blocked("traj-1", CALLERS.free.userId);
    return record(await appeal());
  },
  "POST /api/moderation/appeals — refused (an appeal already pending)": async () => {
    ownAccount();
    await blocked("traj-1", CALLERS.free.userId);
    await appeal();
    return record(await appeal());
  },
};

/**
 * A made-up access token. The refresh route passes the provider's token through without reading
 * it (it compares the account), and the client reads an opaque token's expiry as "cannot tell", so
 * an opaque one records the route's answer as truly as a JWT would — and leaves the fixture file
 * nothing a secret scan reads as a credential (gitleaks' `jwt` and `generic-api-key` rules).
 */
const accessToken = (userId: string): string => `renewed-for-${userId}`;
const FIXTURE_SECONDS = Math.floor(Date.parse(FIXTURE_NOW) / 1000);

/** POST /api/auth/refresh with the refresh cookie the sign-in set for `userId`. */
const refresh = (userId?: string) =>
  refreshPOST(
    rawReq(
      "/api/auth/refresh",
      "POST",
      userId
        ? { cookie: `${REFRESH_COOKIE}=${refreshCookieValue(userId, "refresh-1")}` }
        : {}
    )
  );
const renewedFor = (userId: string) =>
  provider({
    refreshToken: async () => ({
      accessToken: accessToken(userId),
      userId,
      // The provider renews with the refresh token it was given; it issues no new one.
      refreshToken: "refresh-1",
      expiresAt: FIXTURE_SECONDS + 3600,
    }),
  } as Partial<AuthProvider>);

/** The process environment with these settings while `fn` runs. */
async function withEnv<T>(
  vars: Record<string, string>,
  fn: () => Promise<T>
): Promise<T> {
  const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(was)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const signIn = () =>
  signInPOST(
    rawReq(
      "/api/auth/sign-in",
      "POST",
      {},
      { email: "a@b.c", password: "a-long-password-1" }
    )
  );

/** The sign-in screen (components/auth/AuthPage.tsx) and the session (platform/auth/context.tsx). */
const SESSION: Readonly<Record<string, () => Promise<RouteFixture>>> = {
  "GET /api/features — no sign-in provider configured": async () =>
    recordFeatures(await featuresGET(rawReq("/api/features", "GET"))),
  "GET /api/features — Google sign-in configured": async () =>
    withEnv(
      {
        AUTH_PROVIDER: "cognito",
        NEXT_PUBLIC_COGNITO_USER_POOL_ID: "us-east-1_fixture",
        NEXT_PUBLIC_COGNITO_CLIENT_ID: "fixture-client",
        NEXT_PUBLIC_COGNITO_HOSTED_UI_DOMAIN: "auth.example.test",
        SSO_PROVIDERS: "google",
      },
      async () => recordFeatures(await featuresGET(rawReq("/api/features", "GET")))
    ),
  "POST /api/auth/guest — started": async () => {
    const f = await record(await guestPOST(rawReq("/api/auth/guest", "POST")));
    // The guest's id and token are random per mint: fixed here, as a request id is.
    const body = f.body as { guestId: string; token: string };
    return { ...f, body: { ...body, guestId: "guest_abc", token: "guest.p.m" } };
  },
  "POST /api/auth/guest — the mint failing": async () => {
    mockMint.fail = true;
    return record(await guestPOST(rawReq("/api/auth/guest", "POST")));
  },
  "POST /api/auth/sign-in — refused (wrong password)": async () => {
    provider({
      signIn: async () => ({
        success: false,
        error: "Incorrect email or password.",
        errorCode: "auth.invalid_credentials",
      }),
    } as Partial<AuthProvider>);
    return record(await signIn());
  },
  "POST /api/auth/refresh — renewed": async () => {
    renewedFor("user-1");
    return record(await refresh("user-1"));
  },
  "POST /api/auth/refresh — refused (no refresh cookie)": async () =>
    record(await refresh()),
  "POST /api/auth/refresh — refused (the provider renewed another account)": async () => {
    renewedFor("someone-else");
    return record(await refresh("user-1"));
  },
};

const MFA_URI =
  "otpauth://totp/PlatformFoundation?secret=JBSWY3DPEHPK3PXP&issuer=PlatformFoundation";
/** A staff member without a second factor enrols (components/admin/MfaEnrollment.tsx). */
const mfaSetup = () =>
  mfaSetupPOST(req("/api/auth/mfa/setup", "POST", "password_only_super_admin"));
const mfaVerify = (code: string) =>
  mfaVerifyPOST(
    req("/api/auth/mfa/verify", "POST", "password_only_super_admin", { code })
  );

const MFA: Readonly<Record<string, () => Promise<RouteFixture>>> = {
  "POST /api/auth/mfa/setup — the secret and its URI": async () => {
    provider({
      setupMfa: async () => ({
        success: true,
        secretCode: "JBSWY3DPEHPK3PXP",
        qrCodeUri: MFA_URI,
      }),
    } as Partial<AuthProvider>);
    return record(await mfaSetup());
  },
  "POST /api/auth/mfa/setup — the secret, no URI": async () => {
    provider({
      setupMfa: async () => ({ success: true, secretCode: "JBSWY3DPEHPK3PXP" }),
    } as Partial<AuthProvider>);
    return record(await mfaSetup());
  },
  "POST /api/auth/mfa/setup — refused (authenticator MFA off for the pool)": async () => {
    provider({
      setupMfa: async () => ({
        success: false,
        error: "Software token MFA is not enabled for this user pool.",
        errorCode: "feature.not_configured",
      }),
    } as Partial<AuthProvider>);
    return record(await mfaSetup());
  },
  "POST /api/auth/mfa/setup — refused (rate limited)": async () => {
    limitedOnce();
    return record(await mfaSetup());
  },
  "POST /api/auth/mfa/verify — enabled": async () => {
    rows(() => []);
    provider({
      verifyMfaSetup: async () => ({ success: true }),
    } as Partial<AuthProvider>);
    return record(await mfaVerify("123456"));
  },
  "POST /api/auth/mfa/verify — refused (the code is wrong)": async () => {
    provider({
      verifyMfaSetup: async () => ({
        success: false,
        error: "Invalid code received for user",
        errorCode: "auth.code_invalid",
      }),
    } as Partial<AuthProvider>);
    return record(await mfaVerify("000000"));
  },
};

/** Every generated id (a job's) numbered in order of appearance, so each stays distinct. */
async function recordNumbered(res: Response, keep: (kind: string) => boolean) {
  const f = await record(res);
  const ids = new Map<string, string>();
  const number = (v: unknown): unknown => {
    if (typeof v === "string" && UUID_ANY.test(v) && !v.startsWith("aaaaaaaa")) {
      if (!ids.has(v))
        ids.set(v, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`);
      return ids.get(v);
    }
    if (Array.isArray(v)) return v.map(number);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, number(x)]));
    return v;
  };
  const body = f.body as { schedules?: { kind: string }[] };
  return {
    ...f,
    body: number({
      ...body,
      ...(body.schedules
        ? { schedules: body.schedules.filter((x) => keep(x.kind)) }
        : {}),
    }),
  };
}

const TENANTS3 = [
  TENANT,
  "aaaaaaaa-0000-4000-8000-00000000000b",
  "aaaaaaaa-0000-4000-8000-00000000000c",
];

/**
 * The jobs a deployment has run, as its store holds them: the escalation reaper failing for one
 * tenant of three (one job queued, two dead), a module's schedule turned off with a tenant
 * opt-out, and dead letters — a handler's coded failure, and a record written before failures
 * were coded (TASK-206), its English text as stored (N-108).
 */
async function jobsHistory(): Promise<InMemoryJobStore> {
  let tick = 0;
  const store = new InMemoryJobStore({
    activeTenants: async () => TENANTS3,
    now: () => Date.parse(FIXTURE_NOW) + tick++ * 60_000,
  });
  setJobStore(store);
  registerJob("test.optout", async () => undefined, {
    description: "A module's recurring job.",
    schedule: {
      scope: "each-tenant",
      defaultIntervalMinutes: 1440,
      minIntervalMinutes: 60,
      maxIntervalMinutes: 10080,
      tenantOptOutKey: "social.scheduled_agents_enabled",
    },
  });
  rows((sql, values) =>
    values[0] === "jobs.test.optout.enabled" ? [{ value: false }] : []
  );
  const reaper = "moderation.escalation-reaper";
  await store.takeScheduleSlot({
    kind: reaper,
    scope: "each-tenant",
    intervalMs: 15 * 60_000,
    maxAttempts: 5,
    now: new Date(FIXTURE_NOW),
    tenantIds: TENANTS3,
  });
  const claimed = await store.claim({
    workerId: "fixture",
    kinds: [reaper],
    limit: 2,
    leaseMs: 60_000,
  });
  for (const job of claimed) await store.bury(job, "database_unavailable");
  await store.recordScheduleOutcome(reaper, TENANTS3[0], "dead", "database_unavailable");
  await store.recordScheduleOutcome(reaper, TENANTS3[1], "succeeded", null);
  await store.recordScheduleOutcome(reaper, TENANTS3[2], "succeeded", null);
  for (const [kind, error] of [
    ["gdpr.retention-purge", "reported:erasures_incomplete"],
    ["gdpr.retention-purge", "The database was unavailable."],
  ] as const) {
    await store.enqueue({
      tenantId: TENANT,
      kind,
      idempotencyKey: `fixture:${error}`,
      maxAttempts: 1,
      source: "schedule",
    });
    const [job] = await store.claim({
      workerId: "fixture",
      kinds: [kind],
      limit: 1,
      leaseMs: 60_000,
    });
    await store.bury(job!, error);
  }
  return store;
}

const JOB_KINDS = new Set([
  "moderation.escalation-reaper",
  "config.expire-approvals",
  "test.optout",
]);
const jobsNow = () => jobsView(req("/api/operator/jobs", "GET", "super_admin"));
const runNowOf = (kind: string) =>
  runNowPOST(req(`/api/operator/jobs/schedules/${kind}/run`, "POST", "super_admin"), {
    params: Promise.resolve({ kind }),
  });
const onDead = async (action: "replay" | "discard") => {
  const [dead] = await (await jobsHistory()).listJobs({ status: "dead", limit: 1 });
  return deadJobPOST(
    req(`/api/operator/jobs/dead/${dead!.id}`, "POST", "super_admin", { action }),
    { params: Promise.resolve({ id: dead!.id }) }
  );
};

/** The Jobs console (components/admin/JobsPanels.tsx). */
const JOBS: Readonly<Record<string, () => Promise<RouteFixture>>> = {
  "GET /api/operator/jobs — failures, dead letters and a record from before codes":
    async () => {
      await jobsHistory();
      return recordNumbered(await jobsNow(), (k) => JOB_KINDS.has(k));
    },
  "GET /api/operator/jobs — the dead letters gone": async () => {
    const store = await jobsHistory();
    for (const j of await store.listJobs({ status: "dead", limit: 100 }))
      await store.discard(j.id);
    return recordNumbered(await jobsNow(), (k) => JOB_KINDS.has(k));
  },
  "POST /api/operator/jobs/schedules/[kind]/run — refused (the audit log down)":
    async () => {
      await jobsHistory();
      mockAudit.down = true;
      return record(await runNowOf("test.optout"));
    },
  "POST /api/operator/jobs/dead/[id] — replayed": async () =>
    recordStable(await onDead("replay")),
  "POST /api/operator/jobs/dead/[id] — discarded": async () =>
    recordStable(await onDead("discard")),
};

/**
 * The dual-control list (config.dual_control_keys) holding `value`; `dualControlled` (the list the
 * writer reads) as settings() takes it.
 */
function dualControlList(
  value: readonly string[],
  dualControlled: readonly string[] = []
) {
  settings(dualControlled);
  const entry = { ...SETTING.list, value: [...value], platformValue: [...value] };
  const others = mockCfg.getEnhancedConfig.getMockImplementation()!;
  mockCfg.getEnhancedConfig.mockImplementation(async (key: string) =>
    key === entry.key ? entry : others(key)
  );
  mockCfg.listEnhancedConfig.mockImplementation(async () =>
    Object.values(SETTING).map((e) => (e.key === entry.key ? entry : e))
  );
}
const getDualKeys = () =>
  configAiPOST(
    req("/api/admin/config-ai/execute", "POST", "super_admin", {
      toolId: "get_config",
      input: { key: "config.dual_control_keys" },
    })
  );
const setDualKeys = (value: unknown) =>
  updateConfig("config.dual_control_keys", value, "Dual-control keys updated");

/** The dual-control keys panel (components/admin/DualControlKeysPanel.tsx). */
const DUAL_CONTROL: Readonly<Record<string, () => Promise<RouteFixture>>> = {
  ...Object.fromEntries(
    (
      [
        ["two keys", ["signups_enabled", "config.dual_control_keys"]],
        ["one key", ["signups_enabled"]],
        ["one key added", ["signups_enabled", "new.key"]],
        ["none", []],
      ] as const
    ).map(([label, value]) => [
      `POST /api/admin/config-ai/execute — get_config: the dual-control keys, ${label}`,
      async () => {
        dualControlList(value);
        return recordStable(await getDualKeys());
      },
    ])
  ),
  "POST /api/admin/config-ai/execute — get_config: the dual-control keys, refused (no permission)":
    async () => {
      dualControlList(["signups_enabled"]);
      return recordStable(
        await configAiPOST(
          req("/api/admin/config-ai/execute", "POST", "free", {
            toolId: "get_config",
            input: { key: "config.dual_control_keys" },
          })
        )
      );
    },
  // config.dual_control_keys is always dual-controlled (ALWAYS_DUAL_CONTROLLED): a change is held.
  "POST /api/admin/config-ai/execute — update_config: a dual-control key added, held":
    async () => {
      dualControlList(["signups_enabled"]);
      return recordStable(await setDualKeys(["signups_enabled", "new.key"]));
    },
  "POST /api/admin/config-ai/execute — update_config: a dual-control key removed, held":
    async () => {
      dualControlList(["signups_enabled", "config.dual_control_keys"]);
      return recordStable(await setDualKeys(["config.dual_control_keys"]));
    },
  "POST /api/admin/config-ai/execute — update_config: the dual-control list, refused (no safety tier)":
    async () => {
      dualControlList(["signups_enabled"]);
      return recordStable(
        await configAiPOST(
          req("/api/admin/config-ai/execute", "POST", "admin", {
            toolId: "update_config",
            input: {
              key: "config.dual_control_keys",
              value: ["signups_enabled", "new.key"],
              changeComment: "Dual-control keys updated",
              confirmed: true,
            },
          })
        )
      );
    },
};

/**
 * A change to the dual-control list held for a second admin (a runtime hold, as the Approvals
 * list shows it); its proposal id.
 */
async function heldChange(): Promise<string> {
  settings(["config.dual_control_keys"]);
  names();
  await updateConfig(
    "config.dual_control_keys",
    ["signups_enabled", "config.dual_control_keys", "default_language"],
    "Hold language changes too"
  );
  const [held] = await runWithTenant({ tenantId: TENANT, mode: "single" }, () =>
    getProposalStore().query({ statuses: ["proposed"] })
  );
  return held!.proposalId;
}

/** The held change approved, its run claimed and never finished: undecided (recoverStaleRuns). */
async function undecidedChange(): Promise<string> {
  const id = await heldChange();
  await runWithTenant({ tenantId: TENANT, mode: "single" }, async () => {
    const store = getProposalStore() as InMemoryProposalStore;
    await store.decide(id, "approved", APPROVER.userId);
    await store.claim(id);
    store.recoverStaleRuns(Date.now() + 1);
  });
  return id;
}

/** Ann's erasure held twice (the second undecided: approved, its run never finished); its id. */
async function undecidedErasure(): Promise<string> {
  rows(usersTables([ANN, OLD_STAFF]));
  await eraseAnn("super_admin");
  return runWithTenant({ tenantId: TENANT, mode: "single" }, async () => {
    const store = getProposalStore() as InMemoryProposalStore;
    const [first] = await store.query({ labels: ["purge_user_data"] });
    // A second erasure hold of the same account (one held before 061's unique index), a
    // minute later.
    jest.setSystemTime(Date.parse(FIXTURE_NOW) + 60_000);
    const second = await store.create({
      operationId: "fixture-op-2",
      sessionId: first!.sessionId,
      trajectoryId: "fixture-trajectory-2",
      label: first!.label,
      actor: first!.actor,
      effects: first!.effects,
      effectiveRisk: first!.effectiveRisk,
      payload: first!.payload,
    });
    await store.decide(second.proposalId, "approved", APPROVER.userId);
    await store.claim(second.proposalId);
    store.recoverStaleRuns(Date.now() + 1);
    return second.proposalId;
  });
}

/** The hold's run answering `ran` (the config tools' runner beneath the decision). */
function runAnswers(ran: HoldResumeResult): void {
  jest.spyOn(CONFIG_HOLDS, "resume").mockResolvedValueOnce(ran);
}

const decide = async (
  id: string,
  decision: string,
  by: Parameters<Call>[0] = APPROVER,
  source = "runtime"
) =>
  recordStable(
    await decisionPOST(
      req(`/api/admin/approvals/${id}`, "POST", by, { decision, source }),
      {
        params: Promise.resolve({ id }),
      }
    )
  );
const approvalsNow = async () =>
  recordStable(await approvalsGET(req("/api/admin/approvals", "GET", APPROVER)));

/** The held changes panel (components/admin/HeldActionsPanel.tsx): each decision's answer. */
const DECISIONS: Readonly<Record<string, () => Promise<RouteFixture>>> = {
  "GET /api/admin/approvals — a held change, undecided": async () => {
    await undecidedChange();
    return approvalsNow();
  },
  "POST /api/admin/approvals/[id] — approved, it took effect": async () =>
    decide(await heldChange(), "approve"),
  "POST /api/admin/approvals/[id] — rejected": async () =>
    decide(await heldChange(), "reject"),
  "POST /api/admin/approvals/[id] — approved, now waiting for a second approval":
    async () => {
      const id = await heldChange();
      runAnswers({
        kind: "pending",
        approval: { id: "0a1b2c3d-0000-4000-8000-0000000000b2" },
      });
      return decide(id, "approve");
    },
  "POST /api/admin/approvals/[id] — approved, the run failed": async () => {
    const id = await heldChange();
    runAnswers({
      kind: "failed",
      error: "The approved change could not be run.",
      approvalKept: true,
    });
    return decide(id, "approve");
  },
  ...Object.fromEntries(
    (
      [
        [
          "a change already waiting",
          "approvals.already_pending",
          { key: "config.dual_control_keys" },
        ],
        ["the audit log down", "service.unavailable", { service: "audit" }],
        [
          "the value now refused",
          "admin.config_invalid_value",
          { key: "config.dual_control_keys", reason: "type", expected: "json_array" },
        ],
        ["the setting gone", "admin.target_not_found", { target: "config_key" }],
      ] as const
    ).map(([label, code, params]) => [
      `POST /api/admin/approvals/[id] — approved, the run failed (${label})`,
      async () => {
        const id = await heldChange();
        runAnswers({
          kind: "failed",
          error: label,
          approvalKept: true,
          code,
          params: { ...params },
        } as HoldResumeResult);
        return decide(id, "approve");
      },
    ])
  ),
  "POST /api/admin/approvals/[id] — approved, its run's claim not given back":
    async () => {
      const id = await heldChange();
      runAnswers({ kind: "failed", error: "lost commit", approvalKept: false });
      return decide(id, "approve");
    },
  "POST /api/admin/approvals/[id] — approved, refused for good and withdrawn":
    async () => {
      const id = await heldChange();
      runAnswers({
        kind: "refused",
        error: "the value is refused",
        code: "admin.config_invalid_value",
        params: {
          key: "config.dual_control_keys",
          reason: "type",
          expected: "json_array",
        },
      } as HoldResumeResult);
      return decide(id, "approve");
    },
  "POST /api/admin/approvals/[id] — refused (its own requester)": async () =>
    decide(await heldChange(), "approve", "super_admin"),
  "POST /api/admin/approvals/[id] — an undecided run withdrawn": async () =>
    decide(await undecidedChange(), "withdraw"),
  "POST /api/admin/approvals/[id] — a two-person approval approved, its apply settling":
    async () => {
      settings([]);
      const record = {
        id: "0a1b2c3d-0000-4000-8000-0000000000a1",
        configKey: "moderation.strike_ban_threshold",
        currentValue: 5,
        proposedValue: 7,
        requestedBy: identityFor("super_admin").userId,
        changeComment: "Fewer bans for first offences",
        impactSummary: null,
        status: "pending",
        reviewedBy: null,
        reviewComment: null,
        reviewedAt: null,
        expiresAt: "2026-01-08T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        scope: "tenant",
        action: "set",
      };
      mockConfigApproval.get = async () => record;
      mockConfigApproval.apply = async () => ({
        success: false,
        error: "the commit was lost",
        errorCode: "admin.write_indeterminate",
        settling: true,
      });
      return decide(record.id, "approve", APPROVER, "config-approval");
    },
  "GET /api/admin/approvals — an undecided erasure, no one here may decide it":
    async () => {
      await undecidedErasure();
      names();
      return approvalsNow();
    },
  "GET /api/admin/approvals — an undecided erasure, another open": async () => {
    await undecidedErasure();
    names();
    // A second admin in good standing may decide it (the deciders statement's one row).
    const tables = usersTables([ANN, OLD_STAFF]);
    rows((sql, values) =>
      sql.startsWith("with eff as")
        ? (values[0] as string[]).map((hold) => ({
            hold_id: hold,
            user_id: APPROVER.userId,
            sub: APPROVER.sub,
            role_name: "super_admin",
            permissions: [...APPROVER.permissions],
            total: 1,
          }))
        : tables(sql, values)
    );
    return approvalsNow();
  },
  "POST /api/admin/approvals/[id] — an undecided erasure approved again, another open":
    async () => {
      const id = await undecidedErasure();
      return recordStable(
        await decisionPOST(
          req(`/api/admin/approvals/${id}`, "POST", APPROVER, {
            decision: "reapprove",
            source: "runtime",
          }),
          { params: Promise.resolve({ id }) }
        )
      );
    },
  "GET /api/admin/approvals — after a decision, the other held change": async () => {
    names();
    mockListApprovals.mockResolvedValueOnce([
      {
        id: "0a1b2c3d-0000-4000-8000-0000000000a1",
        configKey: "moderation.strike_ban_threshold",
        currentValue: 5,
        proposedValue: 7,
        requestedBy: identityFor("super_admin").userId,
        changeComment: "Fewer bans for first offences",
        impactSummary: null,
        status: "pending",
        reviewedBy: null,
        reviewComment: null,
        reviewedAt: null,
        expiresAt: "2026-01-08T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        scope: "tenant",
        action: "set",
      },
    ]);
    settings([]);
    return approvalsNow();
  },
};

/**
 * The review queue holding the guardian's escalations (each as the store keeps it): review-1
 * pending, then — `more` — review-2 claimed by the moderator.
 */
async function reviewQueue(more = false): Promise<void> {
  const escalation = (requestId: string) => ({
    source: "escalation" as const,
    priority: "high" as const,
    status: "pending" as const,
    moderationResult: {
      action: "escalate",
      triggeredBy: "classifier",
      direction: "input",
      contentType: "generation",
      contentRatingLevel: 1,
      blocklistMatches: [],
      classifierOutput: {
        safe: false,
        categories: ["violence"],
        confidence: 0.52,
        severity: "medium",
      },
      reasoning: "Low confidence — escalating.",
      severityAdjustment: 0,
      contextFactors: ["translation context"],
      attributeToUser: true,
      pipelineLatencyMs: 100,
      classifierCostUsd: 0.001,
      trajectoryId: "traj-1",
      agentId: "guardian-1",
    },
    explanationChain: {
      id: "exp-1",
      requestId,
      steps: [
        {
          phase: "classify",
          description: "ran the classifier",
          data: {},
          durationMs: 10,
        },
      ],
      conclusion: "Escalated for human review.",
      createdAt: FIXTURE_NOW,
    },
    targetUserId: "11111111-1111-4111-8111-111111111111",
    requestId,
  });
  await runWithTenant({ tenantId: TENANT, mode: "single" }, async () => {
    const store = getReviewQueueStore();
    await store.submit(escalation("req-1") as never);
    if (more) await store.submit(escalation("req-2") as never);
  });
  // The second claimed, as the dashboard claims one.
  if (more) await reviewAct("review-2", { action: "claim" });
}
const reviewList = async (query = "") =>
  record(await reviewGET(req(`/api/moderation/review${query}`, "GET", "moderator")));
const reviewAct = (
  id: string,
  body: Record<string, unknown>,
  by: Parameters<Call>[0] = "moderator"
) =>
  reviewPATCH(req(`/api/moderation/review/${id}`, "PATCH", by, body), {
    params: Promise.resolve({ id }),
  });
const assist = () =>
  assistPOST(req("/api/moderation/review/review-1/assist", "POST", "moderator"), {
    params: Promise.resolve({ id: "review-1" }),
  });

/** The review dashboard (components/ReviewDashboard/ReviewDashboard.tsx). */
const REVIEW: Readonly<Record<string, () => Promise<RouteFixture>>> = {
  "GET /api/moderation/review — none": async () => reviewList(),
  "GET /api/moderation/review — one pending escalation": async () => {
    await reviewQueue();
    return reviewList();
  },
  "GET /api/moderation/review — a pending and a claimed escalation": async () => {
    await reviewQueue(true);
    return reviewList();
  },
  "GET /api/moderation/review?status=pending — the pending escalation": async () => {
    await reviewQueue(true);
    return reviewList("?status=pending");
  },
  "GET /api/moderation/review?status=pending — none": async () =>
    reviewList("?status=pending"),
  "GET /api/moderation/review — the escalation claimed": async () => {
    await reviewQueue();
    await reviewAct("review-1", { action: "claim" });
    return reviewList();
  },
  "GET /api/moderation/review — the store failing": async () => {
    jest
      .spyOn(getReviewQueueStore(), "query")
      .mockRejectedValueOnce(new Error("review queue unavailable"));
    return reviewList();
  },
  "PATCH /api/moderation/review/[id] — claimed": async () => {
    await reviewQueue();
    return record(await reviewAct("review-1", { action: "claim" }));
  },
  "PATCH /api/moderation/review/[id] — released": async () => {
    await reviewQueue();
    await reviewAct("review-1", { action: "claim" });
    return record(await reviewAct("review-1", { action: "unclaim" }));
  },
  "PATCH /api/moderation/review/[id] — refused (claimed by another reviewer)":
    async () => {
      await reviewQueue();
      await reviewAct("review-1", { action: "claim" }, "admin");
      return record(await reviewAct("review-1", { action: "claim" }));
    },
  "PATCH /api/moderation/review/[id] — resolved, upheld": async () => {
    await reviewQueue();
    await reviewAct("review-1", { action: "claim" });
    return record(
      await reviewAct("review-1", {
        action: "resolve",
        decision: "uphold",
        reviewerNotes: "Looks correct.",
      })
    );
  },
  "PATCH /api/moderation/review/[id] — resolved, modified to a block": async () => {
    await reviewQueue();
    await reviewAct("review-1", { action: "claim" });
    return record(
      await reviewAct("review-1", {
        action: "resolve",
        decision: "modify",
        modifiedAction: "block",
        reviewerNotes: "Downgrade to block.",
      })
    );
  },
  "POST /api/moderation/review/[id]/assist — a suggestion": async () => {
    await reviewQueue();
    await reviewAct("review-1", { action: "claim" });
    model(async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            recommendation: "overturn",
            rationale: "Historical context likely benign.",
          }),
        },
      ],
      usage: { inputTokens: 10, outputTokens: 10 },
    }));
    return record(await assist());
  },
  "POST /api/moderation/review/[id]/assist — no suggestion (the model unavailable)":
    async () => {
      await reviewQueue();
      await reviewAct("review-1", { action: "claim" });
      model(async () => {
        throw new Error("model unavailable");
      });
      return record(await assist());
    },
};

// TASK-190's one list (the Users screen and the command bar's users search).
const MO = userRow({
  id: "33333333-3333-4333-8333-333333333333",
  email: "mo@example.com",
  display_name: "Mo",
  role_id: ROLE_ID.moderator,
  created_at: new Date("2026-10-29T09:15:00.000Z"),
  last_login_at: new Date("2026-10-29T10:00:00.000Z"),
});
const ANN_29 = userRow({
  created_at: new Date("2026-10-29T09:15:00.000Z"),
  last_login_at: new Date("2026-10-29T10:00:00.000Z"),
});
/** A moderator whose role an administrator gave user management (roles are edited, TASK-145). */
const USERS_MODERATOR = identityWithRole("fixture-users-moderator", "moderator", [
  "can_access_admin",
  "admin_manage_users",
]);
const QA_ROLE = {
  id: "0000000a-0000-4000-8000-0000000000f4",
  name: "qa",
  display_name: "QA Lead",
  is_default: false,
};

/** The command bar's plan for "show moderators" (the model's tool call, `role` as it gave it). */
function plansSearch(role: string): void {
  model(async () => ({
    content: [
      { type: "text", text: "Searching moderators." },
      { type: "tool_use", id: "tu-1", name: "search", input: { table: "users", role } },
    ],
    usage: { inputTokens: 10, outputTokens: 10 },
  }));
}
const planUsers = (prompt: string) =>
  planPOST(req("/api/admin/ai", "POST", "admin", { prompt, panel: "users" }));
const executeSearch = () =>
  executePOST(
    req("/api/admin/ai/execute", "POST", "admin", {
      actions: [{ tool: "search", input: { table: "users", role: "moderator" } }],
    })
  );

const ONE_LIST: Readonly<Record<string, () => Promise<RouteFixture>>> = {
  "GET /api/admin/users — Ann and Mo, a moderator": async () => {
    rows(usersTables([ANN_29, MO]));
    return record(await listUsers("super_admin"));
  },
  "GET /api/admin/users — the moderators: Mo": async () => {
    rows(usersTables([MO]));
    return record(await listUsers("super_admin", "&role=moderator"));
  },
  "GET /api/admin/users — no banned account": async () => {
    rows(usersTables([]));
    return record(await listUsers("super_admin", "&status=banned"));
  },
  "GET /api/admin/users — Mo, the roles with QA Lead": async () => {
    const tables = usersTables([MO]);
    rows((sql, values) =>
      /^select id, name, display_name from roles order by/.test(sql)
        ? [...ROLE_ROWS, QA_ROLE]
        : tables(sql, values)
    );
    return record(await listUsers("super_admin", "&role=qa&status=active"));
  },
  "GET /api/admin/users — a page of 25 free accounts, more to read": async () => {
    rows(
      usersTables(
        Array.from({ length: 26 }, (_, i) =>
          userRow({
            id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
            email: `u${i}@example.com`,
          })
        )
      )
    );
    return record(await listUsers("super_admin", "&role=free"));
  },
  "GET /api/admin/session — an admin": async () => {
    rows(() => []);
    return record(await sessionGET(req("/api/admin/session", "GET", "admin")));
  },
  "GET /api/admin/session — a moderator whose role was given user management":
    async () => {
      rows(() => []);
      return record(await sessionGET(req("/api/admin/session", "GET", USERS_MODERATOR)));
    },
  "POST /api/admin/ai — a plan: search users, role as the model gave it": async () => {
    rows(() => []);
    plansSearch(" MODERATOR  ");
    return record(await planUsers("show moderators"));
  },
  "POST /api/admin/ai — a plan: search users for moderators": async () => {
    rows(() => []);
    plansSearch("moderator");
    return record(await planUsers("show moderators"));
  },
  "POST /api/admin/ai/execute — search users: the moderators": async () => {
    rows((sql) =>
      sql.startsWith("select s.id, s.email")
        ? [
            {
              id: MO.id,
              email: MO.email,
              display_name: MO.display_name,
              role: "moderator",
              status: "active",
              status_until: null,
              email_verified: true,
              created_at: MO.created_at,
              last_sign_in_at: MO.last_login_at,
              total: 1,
            },
          ]
        : []
    );
    return record(await executeSearch());
  },
  "POST /api/admin/ai/execute — refused (rate limited)": async () => {
    limitedOnce();
    return record(await executeSearch());
  },
};

// ── The tenancy screens (components/admin/TenancyPanels.tsx) ──

const T = {
  acme: "aaaaaaaa-0000-4000-8000-0000000000a1",
  beta: "aaaaaaaa-0000-4000-8000-0000000000b1",
  gone: "aaaaaaaa-0000-4000-8000-0000000000c1",
  doomed: "aaaaaaaa-0000-4000-8000-0000000000d1",
  purged: "aaaaaaaa-0000-4000-8000-0000000000e1",
} as const;
const DELETION_REQUEST = "aaaaaaaa-0000-4000-8000-0000000000f1";
const OPERATOR = identityFor("super_admin");

/**
 * A shared deployment's tenants as the directory and the tenants table hold them: Acme active
 * (one address, four users), Beta suspended, Gone deleted (purged after 20 November), Doomed with
 * a deletion awaiting a second operator, Purged deleted and purged.
 */
async function tenancyWorld(): Promise<void> {
  const dir = await shared([
    { id: T.acme, slug: "acme", name: "Acme" },
    { id: T.beta, slug: "beta", name: "Beta" },
    { id: T.gone, slug: "gone", name: "Gone" },
    { id: T.doomed, slug: "doomed", name: "Doomed" },
    { id: T.purged, slug: "purged", name: "Purged" },
  ]);
  await dir.addDomain(T.acme, "acme.example.com");
  const set = (tenantId: string, to: "suspended" | "deleted") =>
    dir.setStatus({
      tenantId,
      from: ["active"],
      to,
      by: OPERATOR.userId,
      reason: "fixture",
    });
  await set(T.beta, "suspended");
  await set(T.gone, "deleted");
  await set(T.purged, "deleted");
  const overview = [
    { id: T.acme, user_count: 4 },
    { id: T.beta, user_count: 1 },
    { id: T.gone, user_count: 0, purge_after: new Date("2026-11-20T00:00:00.000Z") },
    {
      id: T.doomed,
      user_count: 2,
      pending_id: DELETION_REQUEST,
      pending_by: OPERATOR.userId,
    },
    {
      id: T.purged,
      user_count: 0,
      purge_after: new Date("2026-01-01T00:00:00.000Z"),
      purged_at: new Date("2026-01-02T00:00:00.000Z"),
    },
  ].map((r) => ({
    purge_after: null,
    purged_at: null,
    pending_id: null,
    pending_by: null,
    ...r,
  }));
  const status = (id: unknown) =>
    id === T.beta ? "suspended" : id === T.gone || id === T.purged ? "deleted" : "active";
  rows((sql, values) => {
    if (/^select t\.id, t\.purge_after/.test(sql)) return overview;
    if (/^select status from tenants where id/.test(sql))
      return [{ status: status(values[0]) }];
    if (/^insert into tenant_lifecycle_requests/.test(sql))
      return [
        {
          id: DELETION_REQUEST,
          tenant_id: values[0],
          requested_by: values[2],
          reason: values[1],
          status: "pending",
          created_at: new Date(FIXTURE_NOW),
          expires_at: new Date("2026-01-08T00:00:00.000Z"),
        },
      ];
    if (/from tenant_lifecycle_requests where id = \$1/.test(sql))
      return [
        {
          id: DELETION_REQUEST,
          tenant_id: T.doomed,
          requested_by: OPERATOR.userId,
          reason: "closed",
          status: "pending",
          created_at: new Date(FIXTURE_NOW),
          expires_at: new Date("2026-01-08T00:00:00.000Z"),
        },
      ];
    if (/^select count\(\*\)::int as n, coalesce\(bool_or/.test(sql))
      return [{ n: 1, mapped: true }];
    if (/^select id from users where tenant_id = \$1::uuid and lower\(email\)/.test(sql))
      return [{ id: "11111111-1111-4111-8111-1111111111a1" }];
    if (/^select id, email_verified from users/.test(sql))
      return [{ id: "11111111-1111-4111-8111-1111111111a1", email_verified: true }];
    if (/^select id, slug, name, status, created_at, updated_at/.test(sql)) {
      const t = [
        [T.acme, "acme", "Acme"],
        [T.beta, "beta", "Beta"],
        [T.gone, "gone", "Gone"],
        [T.doomed, "doomed", "Doomed"],
        [T.purged, "purged", "Purged"],
      ].find(([id]) => id === values[0]);
      return t
        ? [
            {
              id: t[0],
              slug: t[1],
              name: t[2],
              status: status(t[0]),
              created_at: new Date(FIXTURE_NOW),
              updated_at: new Date(FIXTURE_NOW),
              status_changed_at: null,
              status_changed_by: null,
              status_reason: null,
            },
          ]
        : [];
    }
    // The account made administrator, and the roles the rules read (role-lookup.ts).
    if (/from users where id = \$1::uuid and deleted_at is null/.test(sql))
      return [
        {
          id: "11111111-1111-4111-8111-1111111111a1",
          cognito_sub: "acme-user-sub",
          role_id: ROLE_ID.free,
        },
      ];
    const roles = [...ROLE_ROWS, { id: ADMIN_ROLE_ID, name: "admin", is_default: false }];
    if (/from roles where id = \$1/.test(sql))
      return roles.filter((r) => r.id === values[0]);
    if (/from roles where name = \$1/.test(sql))
      return roles.filter((r) => r.name === values[0]);
    if (/select p\.code from permissions p/.test(sql)) {
      const role = roles.find((r) => r.id === values[0]);
      return (role ? (ROLE_PERMISSIONS[role.name] ?? []) : []).map((code) => ({ code }));
    }
    return [];
  });
}
const ADMIN_ROLE_ID = "0000000a-0000-4000-8000-0000000000f5";

const op = (url: string, method: string, body?: unknown) =>
  req(url, method, "super_admin", body);
const idOf = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * The tenant's own settings as listEnhancedConfig gives them: signups_enabled overridden (or, after
 * a reset, not) and max_devices_per_player at the default (or, after a save, 7).
 */
function tenantSettings(after: "none" | "saved 7" | "reset" = "none"): void {
  settings([]);
  mockCfg.listEnhancedConfig.mockImplementation(async () => [
    after === "reset"
      ? { ...SETTING.toggle, description: "Whether new accounts may sign up" }
      : {
          ...SETTING.toggle,
          value: false,
          overridden: true,
          platformValue: true,
          description: "Whether new accounts may sign up",
        },
    {
      ...SETTING.number,
      key: "max_devices_per_player",
      description: null,
      value: after === "saved 7" ? 7 : 3,
      defaultValue: 3,
      platformValue: 3,
      overridden: after === "saved 7",
      permissionTier: "standard",
    },
    { ...SETTING.list },
  ]);
}

/** The tenant settings screen's own read: Acme in a shared deployment. */
async function acmeTenant(
  budget: { usedUsd: number; exhausted: boolean },
  after: Parameters<typeof tenantSettings>[0] = "none"
) {
  await tenancyWorld();
  tenantSettings(after);
  const tables = fakeData().answer;
  rows((sql, values) =>
    sql.includes("directory_tenant")
      ? [{ slug: "acme", name: "Acme", status: "active" }]
      : sql.includes("tenant_own_domains")
        ? [{ host: "acme.example.com", created_at: new Date(FIXTURE_NOW) }]
        : tables(sql, values)
  );
  jest.spyOn(getBudgetTracker(), "getTenantStatus").mockResolvedValueOnce({
    tenantId: TENANT,
    period: FIXTURE_NOW.slice(0, 10),
    budgetUsd: 100,
    ...budget,
  } as never);
  return record(await tenantGET(req("/api/admin/tenant", "GET", "super_admin")));
}

const putSetting = (key: string, value: unknown) =>
  configPUT(
    op("/api/admin/config", "PUT", { key, value, changeComment: "Tenant settings" })
  );
const resetSetting = (key: string) =>
  configDELETE(op(`/api/admin/config?key=${key}`, "DELETE"));
const governed = (outcome: unknown) => mockWrite.mockResolvedValueOnce(outcome);
const LOST = {
  kind: "failed",
  result: { success: false, error: "the commit was lost" },
  code: "admin.write_indeterminate",
};

const ACME = `/api/operator/tenants/${T.acme}`;

const TENANCY: Readonly<Record<string, () => Promise<RouteFixture>>> = {
  "GET /api/admin/tenant — a shared deployment's tenant, its spend under the cap":
    async () => acmeTenant({ usedUsd: 12.5, exhausted: false }),
  "GET /api/admin/tenant — a shared deployment's tenant, its cap reached": async () =>
    acmeTenant({ usedUsd: 100, exhausted: true }),
  "GET /api/admin/tenant — after a lost commit, max_devices_per_player 7": async () =>
    acmeTenant({ usedUsd: 12.5, exhausted: false }, "saved 7"),
  "GET /api/admin/tenant — after a lost commit, signups_enabled the platform's":
    async () => acmeTenant({ usedUsd: 12.5, exhausted: false }, "reset"),
  "GET /api/admin/tenant — a single deployment": async () => {
    tenantSettings();
    rows((sql) => (sql.includes("directory_tenant") ? [] : []));
    jest.spyOn(getBudgetTracker(), "getTenantStatus").mockResolvedValueOnce({
      tenantId: TENANT,
      period: FIXTURE_NOW.slice(0, 10),
      budgetUsd: 100,
      usedUsd: 12.5,
      exhausted: false,
    } as never);
    return record(await tenantGET(req("/api/admin/tenant", "GET", "super_admin")));
  },
  "PUT /api/admin/config — saved": async () => {
    governed({ kind: "applied", result: { success: true } });
    return record(await putSetting("max_devices_per_player", 5));
  },
  "PUT /api/admin/config — held for approval": async () => {
    governed({ kind: "pending", result: { success: true, held: true } });
    return record(await putSetting("signups_enabled", true));
  },
  "PUT /api/admin/config — refused (not this tenant's to set)": async () => {
    governed({ kind: "refused_scope", reason: "platform_only" });
    return record(await putSetting("signups_enabled", true));
  },
  "PUT /api/admin/config — the commit lost": async () => {
    governed(LOST);
    return record(await putSetting("max_devices_per_player", 7));
  },
  "DELETE /api/admin/config — the platform default again": async () => {
    mockResetWrite.mockResolvedValueOnce({ kind: "applied", result: { success: true } });
    return record(await resetSetting("signups_enabled"));
  },
  "DELETE /api/admin/config — the commit lost": async () => {
    mockResetWrite.mockResolvedValueOnce(LOST);
    return record(await resetSetting("signups_enabled"));
  },
  "GET /api/operator/tenants — every state": async () => {
    await tenancyWorld();
    return record(await operatorTenantsGET(op("/api/operator/tenants", "GET")));
  },
  "POST /api/operator/tenants/[id]/state — suspended": async () => {
    await tenancyWorld();
    return record(
      await statePOST(
        op(`${ACME}/state`, "POST", { action: "suspend", reason: "unpaid" }),
        idOf(T.acme)
      )
    );
  },
  "POST /api/operator/tenants/[id]/deletion — requested": async () => {
    await tenancyWorld();
    return recordStable(
      await deletionPOST(
        op(`${ACME}/deletion`, "POST", { reason: "closed" }),
        idOf(T.acme)
      )
    );
  },
  "POST /api/operator/deletions/[id] — refused (its own requester)": async () => {
    await tenancyWorld();
    return record(
      await deletionDecidePOST(
        op(`/api/operator/deletions/${DELETION_REQUEST}`, "POST", {
          decision: "approve",
        }),
        idOf(DELETION_REQUEST)
      )
    );
  },
  "POST /api/operator/tenants/[id]/domains — added": async () => {
    await tenancyWorld();
    return record(
      await domainsPOST(
        op(`/api/operator/tenants/${T.beta}/domains`, "POST", {
          host: "beta.example.com",
        }),
        idOf(T.beta)
      )
    );
  },
  "DELETE /api/operator/tenants/[id]/domains — removed": async () => {
    await tenancyWorld();
    return record(
      await domainsDELETE(
        op(`${ACME}/domains?host=acme.example.com`, "DELETE"),
        idOf(T.acme)
      )
    );
  },
  "POST /api/operator/tenants/[id]/admins — made administrator": async () => {
    await tenancyWorld();
    return record(
      await adminsPOST(
        op(`${ACME}/admins`, "POST", { email: "a@acme.example.com" }),
        idOf(T.acme)
      )
    );
  },
  "POST /api/operator/tenants — provisioned": async () => {
    await tenancyWorld();
    return recordStable(
      await tenantsPOST(
        op("/api/operator/tenants", "POST", {
          slug: "new",
          name: "New Co",
          domains: ["a.example.com", "b.example.com", "c.example.com"],
        })
      )
    );
  },
  "POST /api/operator/tenants — refused (the slug taken)": async () => {
    await tenancyWorld();
    return record(
      await tenantsPOST(
        op("/api/operator/tenants", "POST", { slug: "acme", name: "Acme 2" })
      )
    );
  },
  "POST /api/operator/purge — none due": async () => {
    await tenancyWorld();
    return record(await purgePOST(op("/api/operator/purge", "POST")));
  },
  "GET /api/operator/readiness — this deployment": async () => {
    await tenancyWorld();
    return record(await readinessGET(op("/api/operator/readiness", "GET")));
  },
  "GET /api/operator/readiness — refused (no permission)": async () => {
    await tenancyWorld();
    return record(await readinessGET(req("/api/operator/readiness", "GET", "admin")));
  },
};

/** One tenant's settings as an operator reads them (one only operators set). */
function acmeSettings(): void {
  settings([]);
  mockCfg.listEnhancedConfig.mockImplementation(async () => [
    {
      ...SETTING.number,
      key: "max_devices_per_player",
      description: "Devices",
      value: 5,
      defaultValue: 3,
      platformValue: 3,
      overridden: true,
      tenantOverridable: true,
      permissionTier: "standard",
    },
    {
      ...SETTING.number,
      key: "agent.budget.tenant_max_cost_per_day",
      description: "Tenant cap",
      value: 100,
      defaultValue: 100,
      platformValue: 100,
      overridden: false,
      tenantOverridable: false,
      permissionTier: "safety",
    },
  ]);
}
/** A two-person approval in the tenant, asked by `by` (a requester not in this tenant). */
const TENANT_APPROVAL = (by: string) => ({
  id: "0a1b2c3d-0000-4000-8000-0000000000c1",
  configKey: "moderation.strike_ban_threshold",
  currentValue: 5,
  proposedValue: 7,
  requestedBy: by,
  changeComment: "Fewer bans for first offences",
  impactSummary: null,
  status: "pending",
  reviewedBy: null,
  reviewComment: null,
  reviewedAt: null,
  expiresAt: "2026-01-08T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  scope: "tenant",
  action: "set",
});
const ELSEWHERE = "0b0b0b0b-0000-4000-8000-0000000000aa";

/** Ann's erasure held twice in Acme (the second undecided); the undecided one's id. */
async function acmeUndecidedErasure(): Promise<string> {
  rows(usersTables([ANN, OLD_STAFF]));
  // Asked by another admin: the operator deciding it is not its requester.
  await eraseAnn(APPROVER);
  const [first] = await runWithTenant({ tenantId: TENANT, mode: "single" }, () =>
    getProposalStore().query({ labels: ["purge_user_data"] })
  );
  await tenancyWorld();
  return runWithTenant({ tenantId: T.acme, mode: "shared" }, async () => {
    const store = getProposalStore() as InMemoryProposalStore;
    const copy = (n: number) =>
      store.create({
        operationId: `fixture-op-${n}`,
        sessionId: first!.sessionId,
        trajectoryId: `fixture-trajectory-${n}`,
        label: first!.label,
        actor: first!.actor,
        effects: first!.effects,
        effectiveRisk: first!.effectiveRisk,
        payload: first!.payload,
      });
    await copy(1);
    jest.setSystemTime(Date.parse(FIXTURE_NOW) + 60_000);
    const second = await copy(2);
    await store.decide(second.proposalId, "approved", APPROVER.userId);
    await store.claim(second.proposalId);
    store.recoverStaleRuns(Date.now() + 1);
    return second.proposalId;
  });
}
const acmeApprovals = () =>
  tenantApprovalsGET(op(`${ACME}/approvals`, "GET"), idOf(T.acme));
const acmeDecide = (approvalId: string, decision: string, source: string) =>
  tenantDecisionPOST(
    op(`${ACME}/approvals/${approvalId}`, "POST", { decision, source }),
    { params: Promise.resolve({ id: T.acme, approvalId }) }
  );

const TENANT_SETTINGS: Readonly<Record<string, () => Promise<RouteFixture>>> = {
  "GET /api/operator/tenants/[id]/config — every setting, one only operators set":
    async () => {
      await tenancyWorld();
      acmeSettings();
      return record(await tenantConfigGET(op(`${ACME}/config`, "GET"), idOf(T.acme)));
    },
  "GET /api/operator/tenants/[id]/approvals — none": async () => {
    await tenancyWorld();
    return recordStable(await acmeApprovals());
  },
  "GET /api/operator/tenants/[id]/approvals — a two-person approval, its requester not here":
    async () => {
      await tenancyWorld();
      settings([]);
      mockListApprovals.mockResolvedValue([TENANT_APPROVAL(ELSEWHERE)]);
      return recordStable(await acmeApprovals());
    },
  "PUT /api/operator/tenants/[id]/config — saved": async () => {
    await tenancyWorld();
    governed({ kind: "applied", result: { success: true } });
    return record(
      await tenantConfigPUT(
        op(`${ACME}/config`, "PUT", {
          key: "agent.budget.tenant_max_cost_per_day",
          value: 25,
          changeComment: "Set by an operator for this tenant",
        }),
        idOf(T.acme)
      )
    );
  },
  "PUT /api/operator/tenants/[id]/config — held for approval": async () => {
    await tenancyWorld();
    governed({ kind: "pending", result: { success: true, held: true } });
    return record(
      await tenantConfigPUT(
        op(`${ACME}/config`, "PUT", {
          key: "max_devices_per_player",
          value: 9,
          changeComment: "Set by an operator for this tenant",
        }),
        idOf(T.acme)
      )
    );
  },
  "DELETE /api/operator/tenants/[id]/config — the platform default again": async () => {
    await tenancyWorld();
    mockResetWrite.mockResolvedValueOnce({ kind: "applied", result: { success: true } });
    return record(
      await tenantConfigDELETE(
        op(`${ACME}/config?key=max_devices_per_player`, "DELETE"),
        idOf(T.acme)
      )
    );
  },
  "POST /api/operator/tenants/[id]/approvals/[approvalId] — refused (its own requester)":
    async () => {
      await tenancyWorld();
      settings([]);
      mockConfigApproval.get = async () => TENANT_APPROVAL(OPERATOR.userId);
      return record(
        await acmeDecide(
          "0a1b2c3d-0000-4000-8000-0000000000c1",
          "approve",
          "config-approval"
        )
      );
    },
  "POST /api/operator/tenants/[id]/approvals/[approvalId] — approved, its apply settling":
    async () => {
      await tenancyWorld();
      settings([]);
      mockConfigApproval.get = async () => TENANT_APPROVAL(ELSEWHERE);
      mockConfigApproval.apply = async () => ({
        success: false,
        error: "the commit was lost",
        errorCode: "admin.write_indeterminate",
        settling: true,
      });
      return record(
        await acmeDecide(
          "0a1b2c3d-0000-4000-8000-0000000000c1",
          "approve",
          "config-approval"
        )
      );
    },
  "POST /api/operator/tenants/[id]/approvals/[approvalId] — approved, stale and withdrawn":
    async () => {
      await tenancyWorld();
      settings([]);
      mockConfigApproval.get = async () => TENANT_APPROVAL(ELSEWHERE);
      mockConfigApproval.apply = async () => ({
        success: false,
        error: "the setting changed since it was requested",
        errorCode: "approvals.stale",
        withdrawn: true,
      });
      return record(
        await acmeDecide(
          "0a1b2c3d-0000-4000-8000-0000000000c1",
          "approve",
          "config-approval"
        )
      );
    },
  "GET /api/operator/tenants/[id]/approvals — an undecided erasure no one in it may decide":
    async () => {
      await acmeUndecidedErasure();
      names();
      return recordStable(await acmeApprovals());
    },
  "POST /api/operator/tenants/[id]/approvals/[approvalId] — an undecided erasure withdrawn":
    async () => {
      const id = await acmeUndecidedErasure();
      return recordStable(await acmeDecide(id, "withdraw", "runtime"));
    },
  "POST /api/operator/tenants/[id]/approvals/[approvalId] — an undecided erasure approved again, another open":
    async () => {
      const id = await acmeUndecidedErasure();
      return recordStable(await acmeDecide(id, "reapprove", "runtime"));
    },
  "GET /api/operator/tenants/[id]/config — refused (a single deployment)": async () =>
    record(await tenantConfigGET(op(`${ACME}/config`, "GET"), idOf(T.acme))),
  "GET /api/operator/tenants/[id]/approvals — refused (a single deployment)": async () =>
    record(await acmeApprovals()),
};

// ── end of TASK-207's producers ──

/** Each fixture: its name, and how the real handler is called to produce it. */
const PRODUCERS: Readonly<Record<string, () => Promise<RouteFixture>>> = {
  "GET /api/operator/jobs — an operator": async () =>
    recordJobs(await jobsView(req("/api/operator/jobs", "GET", "super_admin"))),
  "GET /api/operator/jobs — a tenant admin": async () =>
    record(await jobsView(req("/api/operator/jobs", "GET", "admin"))),
  "PATCH /api/operator/jobs/schedules/[kind] — turned off": async () => {
    mockWrite.mockResolvedValueOnce({ kind: "applied", result: { success: true } });
    return record(
      await patchSchedule(
        req("/api/operator/jobs/schedules/test.sched", "PATCH", "super_admin", {
          enabled: false,
          changeComment: "maintenance",
        }),
        kind("test.sched")
      )
    );
  },
  "PATCH /api/operator/jobs/schedules/[kind] — held for a second operator": async () => {
    mockWrite.mockResolvedValueOnce({
      kind: "pending",
      result: { success: true, held: true },
    });
    return record(
      await patchSchedule(
        req("/api/operator/jobs/schedules/test.sched", "PATCH", "super_admin", {
          intervalMinutes: 30,
          changeComment: "less often",
        }),
        kind("test.sched")
      )
    );
  },
  "GET /api/admin/config — every setting, with its metadata": async () => {
    settings([]);
    return record(
      await configGET(req("/api/admin/config?enhanced=true", "GET", "super_admin"))
    );
  },
  "POST /api/admin/config-ai/execute — update_config applied": async () => {
    settings([]);
    return recordStable(
      await updateConfig("default_language", "fr", "French by default")
    );
  },
  "POST /api/admin/config-ai/execute — update_config held for approval": async () => {
    settings(["moderation.strike_ban_threshold"]);
    return recordStable(
      await updateConfig(
        "moderation.strike_ban_threshold",
        7,
        "Fewer bans for first offences"
      )
    );
  },
  "POST /api/admin/config-ai/execute — update_config refused (out of range)":
    async () => {
      settings([]);
      return recordStable(
        await updateConfig("moderation.strike_ban_threshold", 99, "too many")
      );
    },
  "GET /api/admin/approvals — held changes, to a second admin who may decide them":
    async () => {
      settings(["config.dual_control_keys"]);
      names();
      // A held change to a list (dual control), asked through the config route…
      await updateConfig(
        "config.dual_control_keys",
        ["signups_enabled", "config.dual_control_keys", "default_language"],
        "Hold language changes too"
      );
      // …and a two-person approval of a safety setting.
      mockListApprovals.mockResolvedValueOnce([
        {
          id: "0a1b2c3d-0000-4000-8000-0000000000a1",
          configKey: "moderation.strike_ban_threshold",
          currentValue: 5,
          proposedValue: 7,
          requestedBy: identityFor("super_admin").userId,
          changeComment: "Fewer bans for first offences",
          impactSummary: null,
          status: "pending",
          reviewedBy: null,
          reviewComment: null,
          reviewedAt: null,
          expiresAt: "2026-01-08T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          scope: "tenant",
          action: "set",
        },
      ]);
      return recordStable(
        await approvalsGET(req("/api/admin/approvals", "GET", APPROVER))
      );
    },
  "GET /api/admin/agent-registry — the registry": async () => {
    settings([]);
    return record(
      await agentRegistryGET(req("/api/admin/agent-registry", "GET", "super_admin"))
    );
  },
  "POST /api/admin/ai/execute — register_agent held for approval": async () => {
    settings(["agent.trusted_agents"]);
    mockWrite.mockResolvedValueOnce({
      kind: "pending",
      result: { success: true, held: true },
    });
    return recordStable(
      await executePOST(
        req("/api/admin/ai/execute", "POST", "super_admin", {
          actions: [
            {
              tool: "register_agent",
              input: {
                agent_id: "agent:e2e-helper",
                scopes: ["translate"],
                max_token_ttl: 120,
              },
            },
          ],
        })
      )
    );
  },
  "POST /api/admin/ai/execute — register_agent applied": async () => {
    settings([]);
    mockWrite.mockResolvedValueOnce({ kind: "applied", result: { success: true } });
    return recordStable(
      await executePOST(
        req("/api/admin/ai/execute", "POST", "super_admin", {
          actions: [{ tool: "register_agent", input: { agent_id: "agent:e2e-helper" } }],
        })
      )
    );
  },
  "GET /api/admin/config — refused (no administrative access)": async () => {
    settings([]);
    return record(await configGET(req("/api/admin/config?enhanced=true", "GET", "free")));
  },
  "POST /api/admin/ai/execute — set_agent_scope refused (no admin_manage_agents)":
    async () =>
      recordStable(
        await executePOST(
          req("/api/admin/ai/execute", "POST", "moderator", {
            actions: [
              {
                tool: "set_agent_scope",
                input: { agent_id: "agent:research", scopes: [] },
              },
            ],
          })
        )
      ),
  "POST /api/operator/tenants/[id]/erasures/[userId]/attestation — refused (own request)":
    async () => {
      mockDecide.mockResolvedValueOnce({
        ok: false,
        code: "tenant.self_approval",
        message: "A different operator must approve an attestation you asked for.",
      });
      const tenant = OPEN_ERASURES.erasures[0].tenantId;
      const user = OPEN_ERASURES.erasures[0].userId;
      return record(
        await attestationPOST(
          req(
            `/api/operator/tenants/${tenant}/erasures/${user}/attestation`,
            "POST",
            "super_admin",
            {
              decision: "approve",
            }
          ),
          { params: Promise.resolve({ id: tenant, userId: user }) }
        )
      );
    },
  "POST /api/operator/tenants/[id]/erasures/[userId]/attestation — approved":
    async () => {
      mockDecide.mockResolvedValueOnce({
        ok: true,
        value: {
          doneAt: "2026-01-01T00:00:00.000Z",
          attempts: 4,
          attested: {
            by: APPROVER.userId,
            requestedBy: identityFor("super_admin").userId,
            at: "2026-01-01T00:00:00.000Z",
            reason: "deleted_in_old_pool",
          },
        },
      });
      const tenant = OPEN_ERASURES.erasures[0].tenantId;
      const user = OPEN_ERASURES.erasures[0].userId;
      return record(
        await attestationPOST(
          req(
            `/api/operator/tenants/${tenant}/erasures/${user}/attestation`,
            "POST",
            APPROVER,
            {
              decision: "approve",
              note: "checked",
            }
          ),
          { params: Promise.resolve({ id: tenant, userId: user }) }
        )
      );
    },
  "GET /api/operator/erasures — an unverifiable identity, one operator": async () => {
    mockErasures.mockResolvedValueOnce(OPEN_ERASURES);
    return record(await erasuresGET(req("/api/operator/erasures", "GET", "super_admin")));
  },
  "POST /api/operator/tenants/[id]/erasures/[userId]/attestation — asked": async () => {
    mockAttest.mockResolvedValueOnce({
      ok: true,
      value: {
        attempts: 4,
        poolUnverified: true,
        attestationRequest: {
          by: identityFor("super_admin").userId,
          at: "2026-01-01T00:00:00.000Z",
          reason: "deleted_in_old_pool",
          expiresAt: "2026-01-08T00:00:00.000Z",
        },
      },
    });
    const tenant = OPEN_ERASURES.erasures[0].tenantId;
    const user = OPEN_ERASURES.erasures[0].userId;
    return record(
      await attestationPOST(
        req(
          `/api/operator/tenants/${tenant}/erasures/${user}/attestation`,
          "POST",
          "super_admin",
          {
            reason: "deleted_in_old_pool",
            note: "absent from both pools",
          }
        ),
        { params: Promise.resolve({ id: tenant, userId: user }) }
      )
    );
  },
  ...ADMIN_CONSOLE,
  ...USERS_SCREEN,
  ...KILL_SWITCH,
  ...APPEALS,
  ...SESSION,
  ...MFA,
  ...JOBS,
  ...DUAL_CONTROL,
  ...DECISIONS,
  ...REVIEW,
  ...ONE_LIST,
  ...TENANCY,
  ...TENANT_SETTINGS,
};

/** Every fixture, each produced by its handler against a fresh registry and store. */
async function produceAll(): Promise<Record<string, RouteFixture>> {
  const produced: Record<string, RouteFixture> = {};
  // The clock frozen at FIXTURE_NOW (only Date: every timer runs as it does).
  jest.useFakeTimers({
    now: new Date(FIXTURE_NOW),
    doNotFake: [
      "hrtime",
      "nextTick",
      "performance",
      "queueMicrotask",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "cancelIdleCallback",
      "setImmediate",
      "clearImmediate",
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
    ],
  });
  try {
    await produceEach(produced);
  } finally {
    jest.useRealTimers();
  }
  return produced;
}

async function produceEach(produced: Record<string, RouteFixture>): Promise<void> {
  for (const [name, produce] of Object.entries(PRODUCERS)) {
    produced[name] = await produce();
    resetProposalStore();
    resetConfigMocks();
    noRows();
    single();
    resetModerationStore();
    resetReviewQueueStore();
    realProvider();
    delete mockModel.complete;
    delete mockMint.fail;
    delete mockAudit.down;
    delete mockConfigApproval.get;
    delete mockConfigApproval.apply;
    jest.setSystemTime(new Date(FIXTURE_NOW));
    jest.restoreAllMocks();
    clearConfigCache();
    resetJobRegistry();
    resetJobStore();
    freshJobs();
  }
}

function freshJobs(): void {
  setJobStore(new InMemoryJobStore({ activeTenants: async () => [TENANT] }));
  registerJob("test.sched", async () => undefined, {
    description: "A recurring test job.",
    schedule: {
      scope: "platform",
      defaultIntervalMinutes: 10,
      minIntervalMinutes: 5,
      maxIntervalMinutes: 60,
    },
  });
}

/** Each config store stub back to the real function; the approvals, names and erasures empty. */
function resetConfigMocks(): void {
  const actual = jest.requireActual("@/platform/auth/platform-config");
  for (const [name, fn] of Object.entries(mockCfg))
    fn.mockImplementation((...a: unknown[]) => actual[name](...a));
  mockListApprovals.mockReset().mockResolvedValue([]);
  mockNames.mockReset().mockResolvedValue(new Map());
  mockErasures.mockReset();
  mockAttest.mockReset();
  mockDecide.mockReset();
}

beforeEach(() => {
  mockWrite.mockReset();
  mockResetWrite.mockReset();
  resetProposalStore();
  resetConfigMocks();
  freshJobs();
});
afterEach(() => {
  resetJobRegistry();
  resetJobStore();
});

describe("route fixtures are what the route handlers answer (TASK-200, rule 3)", () => {
  it("every fixture is produced by its handler, unchanged", async () => {
    const produced = await produceAll();
    if (process.env.UPDATE_ROUTE_FIXTURES === "1") {
      writeFileSync(FILE, `${JSON.stringify(produced, null, 2)}\n`);
    }
    const file = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>;
    expect(fixtureDrift(file, produced)).toEqual([]);
  });

  it("[self-test] a fixture edited by hand, one missing and one no handler makes are each reported", async () => {
    const produced = await produceAll();
    const file = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, RouteFixture>;
    const held = "PATCH /api/operator/jobs/schedules/[kind] — held for a second operator";
    const admin = "GET /api/operator/jobs — a tenant admin";
    // The drift TASK-194 shipped: a held answer written as a success.
    const planted: Record<string, unknown> = {
      ...file,
      [held]: { ...file[held], body: { ...(file[held].body as object), success: true } },
      "GET /api/planted — by hand": { status: 200, body: { ok: true } },
    };
    delete planted[admin];
    expect(fixtureDrift(planted, produced)).toEqual([
      `${admin}: not in route-responses.json`,
      `${held}: the file's answer is not what the handler answers`,
      "GET /api/planted — by hand: no handler produces it",
    ]);
    // The real held answer is not a success (the hand-written body was).
    expect((produced[held].body as { success: unknown }).success).toBe(false);
  });

  it("normalises request ids (alone or quoted), nothing else: times are the frozen clock's", async () => {
    expect(
      normaliseBody({
        at: "2026-10-31T12:34:56.789Z",
        period: "2026-11-09",
        params: { requestId: "req_0123456789abcdef" },
        message: "Quote reference req_0123456789abcdef.",
        id: "aaaaaaaa-0000-4000-8000-00000000000a",
        note: "req_x",
      })
    ).toEqual({
      at: "2026-10-31T12:34:56.789Z",
      period: "2026-11-09",
      params: { requestId: "req_0000000000000000" },
      message: "Quote reference req_0000000000000000.",
      id: "aaaaaaaa-0000-4000-8000-00000000000a",
      note: "req_x",
    });
    // A time a route takes from the clock is FIXTURE_NOW: the budget's day is that day.
    const produced = await produceAll();
    const budget = (
      produced["GET /api/admin/tenant — to a moderator"].body as {
        budget: { period: string };
      }
    ).budget;
    expect(budget.period).toBe(FIXTURE_NOW.slice(0, 10));
  });
});
