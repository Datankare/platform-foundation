/**
 * @jest-environment node
 */
/**
 * The Jobs console's routes (/api/operator/jobs/**, ADR-056 D2/D3): operators only, through the
 * real guard (helpers/test-identities.ts); each answer coded (ADR-051). The governed write and
 * the audit log are stubbed here — their own tests cover them; what is pinned is that every
 * change goes through them, and that nothing happens for anyone but an operator.
 *
 * Hostile cases: every role without platform_operate (a tenant admin included), a suspended
 * operator, an unknown kind, two settings in one request, a non-integer interval, a missing
 * reason, replaying a dead job twice, a malformed or unknown job id, an action outside the two.
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
const mockAudited = jest.fn();
const mockAuditLog = jest.fn();
jest.mock("@/platform/auth/audit", () => {
  const actual = jest.requireActual("@/platform/auth/audit");
  return {
    ...actual,
    audited: (...args: unknown[]) => mockAudited(...args),
    writeAuditLog: (...args: unknown[]) => mockAuditLog(...args),
  };
});
const mockWrite = jest.fn();
jest.mock("@/platform/admin/governed-config", () => {
  const actual = jest.requireActual("@/platform/admin/governed-config");
  return { ...actual, writeGovernedConfig: (...a: unknown[]) => mockWrite(...a) };
});

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { authAs, type CallerName } from "@/__tests__/helpers/test-identities";
import { GET as view } from "@/app/api/operator/jobs/route";
import { PATCH as patchSchedule } from "@/app/api/operator/jobs/schedules/[kind]/route";
import { POST as runNowRoute } from "@/app/api/operator/jobs/schedules/[kind]/run/route";
import { POST as deadAction } from "@/app/api/operator/jobs/dead/[id]/route";
import {
  InMemoryJobStore,
  registerJob,
  resetJobRegistry,
  resetJobStore,
  setJobStore,
} from "@/platform/jobs";
import { AuditWriteError } from "@/platform/auth/audit";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
let store: InMemoryJobStore;
let ran: number;

function req(
  url: string,
  method: string,
  caller: CallerName = "super_admin",
  body?: unknown
): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { ...authAs(caller), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const kindParams = (kind: string) => ({ params: Promise.resolve({ kind }) });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  mockAudited.mockReset();
  mockAudited.mockImplementation((_entry: unknown, act: () => Promise<unknown>) => act());
  mockWrite.mockReset();
  store = new InMemoryJobStore({ activeTenants: async () => [A] });
  setJobStore(store);
  ran = 0;
  registerJob(
    "test.sched",
    async () => {
      ran++;
    },
    {
      description: "A recurring test job.",
      schedule: {
        scope: "platform",
        defaultIntervalMinutes: 10,
        minIntervalMinutes: 5,
        maxIntervalMinutes: 60,
      },
    }
  );
});
afterEach(() => {
  resetJobRegistry();
  resetJobStore();
});

async function deadJob(): Promise<string> {
  const { id } = await store.enqueue({
    tenantId: A,
    kind: "test.sched",
    idempotencyKey: `d${randomUUID()}`,
    maxAttempts: 1,
    source: "schedule",
  });
  const claimed = await store.claim({
    workerId: "w",
    kinds: ["test.sched"],
    limit: 10,
    leaseMs: 60_000,
  });
  for (const job of claimed) await store.bury(job, "The job failed for good.");

  return id;
}

const NOT_OPERATORS = [
  "anonymous",
  "guest",
  "free",
  "moderator",
  "safety_approver",
  "admin",
  "suspended_super_admin",
] as const;

describe("only operators reach the Jobs console", () => {
  it.each(NOT_OPERATORS)(
    "refuses %s on every route and changes nothing",
    async (caller) => {
      const id = await deadJob();
      const answers = await Promise.all([
        view(req("/api/operator/jobs", "GET", caller)),
        patchSchedule(
          req("/api/operator/jobs/schedules/test.sched", "PATCH", caller, {
            enabled: false,
            changeComment: "stop it",
          }),
          kindParams("test.sched")
        ),
        runNowRoute(
          req("/api/operator/jobs/schedules/test.sched/run", "POST", caller),
          kindParams("test.sched")
        ),
        deadAction(
          req(`/api/operator/jobs/dead/${id}`, "POST", caller, { action: "replay" }),
          idParams(id)
        ),
      ]);
      for (const res of answers) expect([401, 403]).toContain(res.status);
      expect(mockWrite).not.toHaveBeenCalled();
      expect(ran).toBe(0);
      expect((await store.getJob(id))?.status).toBe("dead");
    }
  );
});

describe("GET /api/operator/jobs", () => {
  it("lists every recurring job with its settings and state, and the dead letters", async () => {
    const id = await deadJob();
    const res = await view(req("/api/operator/jobs", "GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const mine = body.schedules.find((s: { kind: string }) => s.kind === "test.sched");
    expect(mine).toMatchObject({
      owner: "app",
      scope: "platform",
      enabled: true,
      intervalMinutes: 10,
      minIntervalMinutes: 5,
      maxIntervalMinutes: 60,
      settings: {
        enabled: "jobs.test.sched.enabled",
        interval: "jobs.test.sched.interval_minutes",
      },
      state: null,
    });
    expect(body.schedules.map((s: { kind: string }) => s.kind)).toContain(
      "moderation.escalation-reaper"
    );
    expect(body.deadLetters).toEqual([
      expect.objectContaining({
        id,
        kind: "test.sched",
        lastError: "The job failed for good.",
      }),
    ]);
  });
});

describe("PATCH /api/operator/jobs/schedules/[kind]", () => {
  const patch = (body: unknown, kind = "test.sched") =>
    patchSchedule(
      req(`/api/operator/jobs/schedules/${kind}`, "PATCH", "super_admin", body),
      {
        params: Promise.resolve({ kind }),
      }
    );

  it("turns a schedule off through the governed write, as the platform default", async () => {
    mockWrite.mockResolvedValue({ kind: "applied", result: { success: true } });
    const res = await patch({ enabled: false, changeComment: "maintenance window" });
    expect(res.status).toBe(200);
    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({ userId: expect.any(String) }),
      {
        key: "jobs.test.sched.enabled",
        value: false,
        changeComment: "maintenance window",
        scope: "platform",
      }
    );
  });

  it("changes an interval; a held change answers 202", async () => {
    mockWrite.mockResolvedValue({
      kind: "pending",
      result: { success: true, held: true },
    });
    const res = await patch({ intervalMinutes: 30, changeComment: "less often" });
    expect(res.status).toBe(202);
    expect((await res.json()).pending).toBe(true);
    expect(mockWrite.mock.calls[0][1]).toMatchObject({
      key: "jobs.test.sched.interval_minutes",
      value: 30,
    });
  });

  it.each([
    [
      { kind: "invalid", errors: ["Value 1 is below minimum 5"] },
      422,
      "admin.config_invalid_value",
    ],
    [
      { kind: "refused", permission: "config_manage_safety" },
      403,
      "auth.permission_denied",
    ],
    [{ kind: "refused_scope", reason: "x" }, 403, "admin.config_scope_refused"],
  ])("answers the governed write's refusal %#", async (outcome, status, code) => {
    mockWrite.mockResolvedValue(outcome);
    const res = await patch({ intervalMinutes: 1, changeComment: "too often" });
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
  });

  it.each([
    [
      "both settings at once",
      { enabled: true, intervalMinutes: 10, changeComment: "both" },
    ],
    ["neither setting", { changeComment: "nothing" }],
    ["a non-boolean flag", { enabled: "false", changeComment: "string" }],
    ["a fractional interval", { intervalMinutes: 7.5, changeComment: "fraction" }],
    ["an interval as text", { intervalMinutes: "10", changeComment: "text" }],
  ])("refuses %s (400) without writing", async (_l, body) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("needs a reason", async () => {
    const res = await patch({ enabled: false });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("request.missing_fields");
  });

  it("does not know a kind that is not recurring, or does not exist (404)", async () => {
    registerJob("test.oneoff", async () => undefined, { description: "No schedule." });
    for (const kind of ["test.oneoff", "test.nobody", "../../etc"]) {
      const res = await patch({ enabled: false, changeComment: "x y z" }, kind);
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("jobs.not_found");
    }
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe("POST /api/operator/jobs/schedules/[kind]/run", () => {
  it("records, enqueues and runs the kind now", async () => {
    const res = await runNowRoute(
      req("/api/operator/jobs/schedules/test.sched/run", "POST"),
      kindParams("test.sched")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.enqueued).toBe(1);
    expect(body.result.report).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(ran).toBe(1);
    expect(mockAudited).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin_action",
        details: { type: "job_run_now", kind: "test.sched" },
      }),
      expect.any(Function)
    );
    const jobs = await store.listJobs({ kind: "test.sched" });
    expect(jobs[0].source).toBe("manual");
  });

  // Review finding 14: run now enqueued tenant by tenant, each in its own transaction, inside
  // the request's time, and the audit said only that it was attempted. It is one fan-out now,
  // and a second record says what actually happened.
  it("enqueues in one fan-out and records what actually happened", async () => {
    const fanOut = jest.spyOn(store, "fanOut");
    const enqueue = jest.spyOn(store, "enqueue");
    const res = await runNowRoute(
      req("/api/operator/jobs/schedules/test.sched/run", "POST"),
      kindParams("test.sched")
    );
    expect(res.status).toBe(200);
    expect(fanOut).toHaveBeenCalledTimes(1);
    expect(fanOut.mock.calls[0][0]).toMatchObject({
      kind: "test.sched",
      source: "manual",
      idempotencyKey: expect.stringMatching(/^manual:/),
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin_action",
        details: expect.objectContaining({
          type: "job_run_now",
          kind: "test.sched",
          outcome: "completed",
          enqueued: 1,
          claimed: 1,
          succeeded: 1,
          dead: 0,
        }),
      })
    );
  });

  it("runs nothing when the record cannot be written (503)", async () => {
    mockAudited.mockRejectedValue(new AuditWriteError("admin_action", "down"));
    const res = await runNowRoute(
      req("/api/operator/jobs/schedules/test.sched/run", "POST"),
      kindParams("test.sched")
    );
    expect(res.status).toBe(503);
    expect(ran).toBe(0);
    expect(await store.listJobs({ kind: "test.sched" })).toEqual([]);
  });

  it("does not know an unknown kind (404)", async () => {
    const res = await runNowRoute(
      req("/api/operator/jobs/schedules/test.nobody/run", "POST"),
      kindParams("test.nobody")
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/operator/jobs/dead/[id]", () => {
  const act = (id: string, body: unknown) =>
    deadAction(
      req(`/api/operator/jobs/dead/${id}`, "POST", "super_admin", body),
      idParams(id)
    );

  it("replays a dead job once; a second replay finds it not dead (409)", async () => {
    const id = await deadJob();
    const first = await act(id, { action: "replay" });
    expect(first.status).toBe(200);
    expect((await first.json()).result).toEqual({ id, kind: "test.sched" });
    expect(await store.getJob(id)).toMatchObject({ status: "queued", attempts: 0 });
    const second = await act(id, { action: "replay" });
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe("jobs.not_dead");
    expect(mockAudited).toHaveBeenCalledTimes(1);
    expect(mockAudited.mock.calls[0][0]).toMatchObject({
      details: { type: "job_replayed", jobId: id, kind: "test.sched", tenantId: A },
    });
  });

  it("discards a dead job; then it is not found", async () => {
    const id = await deadJob();
    expect((await act(id, { action: "discard" })).status).toBe(200);
    expect(await store.getJob(id)).toBeNull();
    const again = await act(id, { action: "discard" });
    expect(again.status).toBe(404);
    expect((await again.json()).code).toBe("jobs.not_found");
  });

  it("changes nothing when the record cannot be written", async () => {
    const id = await deadJob();
    mockAudited.mockRejectedValue(new AuditWriteError("admin_action", "down"));
    expect((await act(id, { action: "discard" })).status).toBe(503);
    expect((await store.getJob(id))?.status).toBe("dead");
  });

  it.each([
    ["an unknown id", "11111111-1111-4111-8111-111111111111", 404],
    ["a malformed id", "not-a-uuid'; drop table jobs;--", 404],
  ])("answers %s with %s", async (_l, id, status) => {
    expect((await act(id, { action: "replay" })).status).toBe(status);
  });

  it.each([[{ action: "delete" }], [{}], [{ action: ["replay"] }]])(
    "refuses an action outside replay and discard: %j",
    async (body) => {
      const id = await deadJob();
      const res = await act(id, body);
      expect(res.status).toBe(400);
      expect((await store.getJob(id))?.status).toBe("dead");
    }
  );
});

describe("the operator service, directly", () => {
  const ops =
    require("@/platform/jobs/operator") as typeof import("@/platform/jobs/operator");
  const admin = {
    userId: "11111111-1111-4111-8111-111111111111",
    sub: "s",
    roleName: "super_admin",
    permissions: ["*"],
  };

  it("reports a race: another operator acted between the check and the change", async () => {
    const id = await deadJob();
    // The job is dead when checked; by the time the change runs it has been replayed.
    mockAudited.mockImplementationOnce(
      async (_e: unknown, act: () => Promise<unknown>) => {
        await store.replay(id);
        return act();
      }
    );
    expect(await ops.replayDeadJob(admin, id)).toEqual({
      ok: false,
      code: "jobs.not_dead",
    });
    const other = await deadJob();
    mockAudited.mockImplementationOnce(
      async (_e: unknown, act: () => Promise<unknown>) => {
        await store.discard(other);
        return act();
      }
    );
    expect(await ops.discardDeadJob(admin, other)).toEqual({
      ok: false,
      code: "jobs.not_found",
    });
  });

  it("lets an unexpected audit failure through rather than mislabel it", async () => {
    const id = await deadJob();
    mockAudited.mockRejectedValueOnce(new TypeError("bug"));
    await expect(ops.replayDeadJob(admin, id)).rejects.toThrow(TypeError);
    mockAudited.mockRejectedValueOnce(new TypeError("bug"));
    await expect(ops.runNow(admin, "test.sched")).rejects.toThrow(TypeError);
  });

  it("runs a per-tenant kind now for the one tenant of a dedicated deployment, or every active tenant", async () => {
    registerJob("test.each", async () => undefined, {
      description: "Per tenant.",
      schedule: {
        scope: "each-tenant",
        defaultIntervalMinutes: 10,
        minIntervalMinutes: 5,
        maxIntervalMinutes: 60,
      },
    });
    const single = await ops.runNow(admin, "test.each");
    expect(single).toMatchObject({ ok: true, value: { enqueued: 1 } });
    const saved = process.env.TENANCY_MODE;
    process.env.TENANCY_MODE = "shared";
    try {
      store = new InMemoryJobStore({
        activeTenants: async () => [A, "bbbbbbbb-0000-4000-8000-00000000000b"],
      });
      setJobStore(store);
      const shared = await ops.runNow(admin, "test.each");
      expect(shared).toMatchObject({ ok: true, value: { enqueued: 2 } });
    } finally {
      if (saved === undefined) delete process.env.TENANCY_MODE;
      else process.env.TENANCY_MODE = saved;
    }
  });

  it("changes both settings when asked, each through the governed write", async () => {
    mockWrite.mockResolvedValue({ kind: "applied", result: { success: true } });
    const r = await ops.setSchedule(admin, "test.sched", {
      enabled: true,
      intervalMinutes: 20,
      changeComment: "both",
    });
    expect(r.ok && r.value.map((c) => c.key)).toEqual([
      "jobs.test.sched.enabled",
      "jobs.test.sched.interval_minutes",
    ]);
  });

  it("shows a tenant only its own history", async () => {
    await deadJob();
    await store.enqueue({
      tenantId: null,
      kind: "test.sched",
      idempotencyKey: "p",
      maxAttempts: 1,
      source: "enqueue",
    });
    const { runWithTenant } = require("@/platform/tenancy/context");
    const mine = await runWithTenant({ tenantId: A, mode: "shared" }, () =>
      ops.listTenantJobHistory()
    );
    expect(mine.every((j: { tenantId: string }) => j.tenantId === A)).toBe(true);
    expect(mine).toHaveLength(1);
    expect(await ops.listTenantJobHistory()).toEqual([]);
  });
});
