/**
 * @jest-environment node
 */
/**
 * TASK-216 (SF-admin-041) — the Users list's count, on a real database: `page.total` is how many
 * of the TENANT's accounts match the search and the filters — the list's own conditions, under
 * row-level security — whatever the page and the offset, and never another tenant's accounts.
 * Read as the screen reads it: POST /api/admin/users/search, the search text in the body
 * (TASK-215, A-17); GET /api/admin/users, which takes no search text, answers the same count.
 *
 * hostile:role n/a: the route's guard is the list's own (admin-authorization-matrix); the count adds no path
 * hostile:self n/a: the route is a read and takes no target account the caller could be
 * hostile:store-down n/a: the count is in the list's transaction; the list's own failure tests cover it
 * hostile:id-spelling n/a: no id is taken
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
import { GET as usersGET } from "@/app/api/admin/users/route";
import { POST as usersSearchPOST } from "@/app/api/admin/users/search/route";
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
let caller: TestIdentity;
const mail = (label: string) => `${label}-${RUN}@count.test`;

async function page(
  query: Record<string, string | number>,
  tenant: TestTenant = a
): Promise<{ total: number; totalCapped: boolean; hasMore: boolean; shown: number }> {
  const res = await usersSearchPOST(
    new NextRequest("http://localhost/api/admin/users/search", {
      method: "POST",
      headers: { ...asCallerIn(caller, tenant), "Content-Type": "application/json" },
      body: JSON.stringify(query),
    })
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    users: unknown[];
    page: { total: number; totalCapped: boolean; hasMore: boolean };
  };
  return { ...body.page, shown: body.users.length };
}

if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    a = await createTestTenant();
    b = await createTestTenant();
    caller = suiteCaller("super_admin", RUN);
    const free = await seededRoleId("free");
    const moderator = await seededRoleId("moderator");
    for (let i = 0; i < 5; i += 1)
      await insertUser(a, {
        roleId: free,
        email: mail(`free${i}`),
        displayName: `Free ${i}`,
      });
    for (let i = 0; i < 2; i += 1)
      await insertUser(a, {
        roleId: moderator,
        email: mail(`mod${i}`),
        displayName: `Mod ${i}`,
      });
    // Another tenant's accounts match every condition below, and are never counted.
    for (let i = 0; i < 3; i += 1)
      await insertUser(b, {
        roleId: free,
        email: mail(`free${i}`),
        displayName: `Free ${i}`,
      });
  });
  afterAll(async () => {
    await dropTestTenants();
    await disconnectTestDatabase();
  });
}

dbDescribe("the Users list's page.total (TASK-216)", () => {
  const marker = `-${RUN}@count.test`;

  it("counts what the search matches in this tenant — whatever the page and the offset", async () => {
    const first = await page({ q: marker, limit: 3, offset: 0 });
    expect(first).toMatchObject({
      total: 7,
      totalCapped: false,
      hasMore: true,
      shown: 3,
    });
    const last = await page({ q: marker, limit: 3, offset: 6 });
    expect(last).toMatchObject({ total: 7, hasMore: false, shown: 1 });
    // Past the end: nothing shown, and the count is still the count.
    expect(await page({ q: marker, limit: 3, offset: 30 })).toMatchObject({
      total: 7,
      shown: 0,
    });
  });

  it("with a filter: the filter's own count, as the list applies it", async () => {
    expect(await page({ q: marker, role: "moderator" })).toMatchObject({
      total: 2,
      shown: 2,
    });
    expect(await page({ q: marker, role: "MODERATOR", text: "Mod 1" })).toMatchObject({
      total: 1,
    });
    expect(await page({ q: marker, status: "banned" })).toMatchObject({
      total: 0,
      shown: 0,
    });
    expect(await page({ q: marker, created_within_days: 1 })).toMatchObject({ total: 7 });
    expect(await page({ q: marker, signed_in_within_days: 1 })).toMatchObject({
      total: 0,
    });
  });

  it("[hostile] LIKE metacharacters in the search are text: they count what they name, not everything", async () => {
    expect(await page({ q: `%${marker}` })).toMatchObject({ total: 0 });
    expect(await page({ q: "____________________" })).toMatchObject({ total: 0 });
  });

  it("GET, with no search text, counts as the search does", async () => {
    const res = await usersGET(
      new NextRequest("http://localhost/api/admin/users?role=moderator&limit=1", {
        headers: asCallerIn(caller, a),
      })
    );
    expect(res.status).toBe(200);
    const listed = (await res.json()) as { page: { total: number } };
    expect(listed.page.total).toBe((await page({ role: "moderator", limit: 1 })).total);
    expect(listed.page.total).toBeGreaterThanOrEqual(2);
  });

  it("another tenant's accounts are never counted", async () => {
    expect(await page({ q: marker }, b)).toMatchObject({ total: 3, shown: 3 });
  });
});
