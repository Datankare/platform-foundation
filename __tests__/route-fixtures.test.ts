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
jest.mock("@/platform/auth/middleware", () =>
  require("@/__tests__/helpers/test-identities").mockMiddleware()
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
jest.mock("@/platform/auth/audit", () => {
  const actual = jest.requireActual("@/platform/auth/audit");
  return {
    ...actual,
    audited: (_entry: unknown, act: () => Promise<unknown>) => act(),
    writeAuditLog: jest.fn(),
  };
});
const mockWrite = jest.fn();
jest.mock("@/platform/admin/governed-config", () => {
  const actual = jest.requireActual("@/platform/admin/governed-config");
  return { ...actual, writeGovernedConfig: (...a: unknown[]) => mockWrite(...a) };
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
  ]) {
    mockCfg[name] = jest.fn((...a: unknown[]) => actual[name](...a));
    wrapped[name] = (...a: unknown[]) => mockCfg[name](...a);
  }
  return wrapped;
});
const mockListApprovals = jest.fn();
jest.mock("@/platform/admin/config-approval", () => {
  const actual = jest.requireActual("@/platform/admin/config-approval");
  return {
    ...actual,
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

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
import { normaliseBody, type RouteFixture } from "./fixtures/route-responses";
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

const kind = (k: string) => ({ params: Promise.resolve({ kind: k }) });

// ── TASK-202: the admin console's screens ─────────────────────────────────────────────────────

/** A second super admin: the one who approves what the first asked. */
const APPROVER = identityFor("super_admin", { name: "fixture-approver" });

const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A body with its run-specific values fixed: every generated id (a hold's, a trajectory's, an
 * operation's), the config route's trajectory, agent and steps.
 */
function stable(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (UUID_ANY.test(value) && !/^0{8}-/.test(value) && !value.startsWith("aaaaaaaa"))
      return "00000000-0000-4000-8000-0000000000ff";
    if (key === "trajectoryId" || key === "agentId" || key === "operationId")
      return `${key}-fixed`;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => stable(v));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        k === "steps" || k === "durationMs" ? (Array.isArray(v) ? [] : 0) : stable(v, k),
      ])
    );
  return value;
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
};

/**
 * How the fixture file differs from what the handlers answered: each fixture whose recorded
 * answer is not the handler's, each the file lacks, each the file has that no handler produces.
 * Compared as JSON: what the file can hold (an undefined field is no field).
 */
export function fixtureDrift(
  file: Readonly<Record<string, unknown>>,
  produced: Readonly<Record<string, RouteFixture>>
): string[] {
  const out: string[] = [];
  for (const [name, answer] of Object.entries(produced)) {
    if (!(name in file)) out.push(`${name}: not in route-responses.json`);
    else if (!isDeepStrictEqual(file[name], JSON.parse(JSON.stringify(answer))))
      out.push(`${name}: the file's answer is not what the handler answers`);
  }
  for (const name of Object.keys(file))
    if (!(name in produced)) out.push(`${name}: no handler produces it`);
  return out;
}

/** Every fixture, each produced by its handler against a fresh registry and store. */
async function produceAll(): Promise<Record<string, RouteFixture>> {
  const produced: Record<string, RouteFixture> = {};
  for (const [name, produce] of Object.entries(PRODUCERS)) {
    produced[name] = await produce();
    resetProposalStore();
    resetConfigMocks();
    resetJobRegistry();
    resetJobStore();
    freshJobs();
  }
  return produced;
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

  it("normalises times and request ids, nothing else", () => {
    expect(
      normaliseBody({
        at: "2026-10-31T12:34:56.789Z",
        params: { requestId: "req_0123456789abcdef" },
        id: "aaaaaaaa-0000-4000-8000-00000000000a",
      })
    ).toEqual({
      at: "2026-01-01T00:00:00.000Z",
      params: { requestId: "req_0000000000000000" },
      id: "aaaaaaaa-0000-4000-8000-00000000000a",
    });
  });
});
