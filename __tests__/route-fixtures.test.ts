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

const FILE = join(__dirname, "fixtures", "route-responses.json");
const TENANT = "aaaaaaaa-0000-4000-8000-00000000000a";

function req(
  url: string,
  method: string,
  caller: CallerName,
  body?: unknown
): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { ...authAs(caller), "content-type": "application/json" },
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

beforeEach(() => {
  mockWrite.mockReset();
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
