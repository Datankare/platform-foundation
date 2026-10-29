/**
 * __tests__/db/task-190-users-filters.db.test.ts — The Users list's filters against Postgres
 * (TASK-190: one list, not two)
 *
 * A command-bar search of users hands its validated filters to the Users screen, whose list
 * (GET /api/admin/users) applies them. Here, in a test tenant, the list and the search find the
 * same accounts for each filter and combination — role by name or display name in any case, the
 * standing as the guard reads it (an expired restriction is active, an erased account deleted),
 * sign-in and created windows, text with `_` and `%` matched as themselves — under every sort;
 * another tenant's accounts are never listed; a refused value reads nothing.
 *
 * Round 1: a role with no display name (blank — roles.display_name is NOT NULL) is read by its
 * stored name in both, and both screens write it "Qa lead"; a user with no role cannot exist
 * (users.role_id is NOT NULL, a foreign key to roles), so neither reader has a no-role row to show.
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
import { withOwnerTx } from "@/platform/data";
import { handleSearch } from "@/app/api/admin/ai/handlers/search";
import { SEARCHABLE_TABLES } from "@/app/api/admin/ai/tool-permissions";
import { GET as usersGET } from "@/app/api/admin/users/route";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import { shownCell } from "@/components/admin/ExecutionResultsPanel";
import { readableRole } from "@/components/admin/admin-format";
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
let moderatorCaller: TestIdentity;

let mo: string; // moderator, signed in 2 days ago
let fay: string; // free, "john_doe" in the name, created 400 days ago, never signed in
let lapsed: string; // free, restricted until yesterday → active
let held: string; // Support Lead, restricted until tomorrow, signed in 12 hours ago
let erased: string; // free, deleted
let pct: string; // free, "100% sure" in the name
let outsider: string; // tenant B, moderator
let qa: string; // a run's own role with a blank display name

const searcher: VerifiedAdmin = {
  userId: randomUUID(),
  sub: "s",
  roleName: "admin",
  permissions: [...new Set(Object.values(SEARCHABLE_TABLES))],
};

const mail = (label: string) => `${label}-${RUN}@x.test`;
const owner = (text: string, values: unknown[] = []) =>
  withOwnerTx("tenant-lifecycle", (tx) => tx.query(text, values));

const req = (path: string, who: TestIdentity = caller, tenant: TestTenant = a) =>
  new NextRequest(`http://localhost${path}`, { headers: asCallerIn(who, tenant) });

/** The ids the Users list shows for these filters (only this run's accounts, by its marker). */
async function listed(
  filters: Record<string, string | number>,
  extra = "",
  tenant: TestTenant = a
): Promise<string[]> {
  const qs = new URLSearchParams({
    limit: "100",
    ...Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, String(v)])),
  });
  const res = await usersGET(req(`/api/admin/users?${qs}${extra}`, caller, tenant));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { users: { id: string; email: string | null }[] };
  return body.users
    .filter((u) => u.email?.endsWith(`-${RUN}@x.test`))
    .map((u) => u.id)
    .sort();
}

/** The ids the command bar's search finds for the same filters. */
async function searched(filters: Record<string, string | number>): Promise<string[]> {
  const res = await a.run(() => handleSearch({ table: "users", ...filters }, searcher));
  if (!res.success || !res.table) throw new Error(JSON.stringify(res));
  const t = res.table;
  const email = t.columns.indexOf("email");
  return t.rows
    .filter((r) => String(r[email]).endsWith(`-${RUN}@x.test`))
    .map((r) => String(r[0]))
    .sort();
}

if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    a = await createTestTenant();
    b = await createTestTenant();
    caller = suiteCaller("super_admin", RUN);
    moderatorCaller = suiteCaller("moderator", RUN);
    const free = await seededRoleId("free");
    const moderator = await seededRoleId("moderator");
    const support = (
      await withOwnerTx("operator", (tx) =>
        tx.query<{ id: string }>(
          "insert into roles (name, display_name) values ($1, 'Support Lead') returning id",
          [`t${RUN}_support`]
        )
      )
    ).rows[0]!.id;
    mo = await insertUser(a, { roleId: moderator, email: mail("mo"), displayName: "Mo" });
    fay = await insertUser(a, {
      roleId: free,
      email: mail("fay"),
      displayName: `john_doe ${RUN}`,
      createdAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
    });
    lapsed = await insertUser(a, { roleId: free, email: mail("lapsed") });
    held = await insertUser(a, { roleId: support, email: mail("held") });
    erased = await insertUser(a, {
      roleId: free,
      email: mail("erased"),
      deletedAt: new Date().toISOString(),
    });
    pct = await insertUser(a, {
      roleId: free,
      email: mail("pct"),
      displayName: `100% sure ${RUN}`,
    });
    const qaRole = (
      await withOwnerTx("operator", (tx) =>
        tx.query<{ id: string }>(
          "insert into roles (name, display_name) values ($1, '  ') returning id",
          [`t${RUN}_qa_lead`]
        )
      )
    ).rows[0]!.id;
    qa = await insertUser(a, { roleId: qaRole, email: mail("qa") });
    outsider = await insertUser(b, {
      roleId: moderator,
      email: mail("outsider"),
      displayName: "Mo",
    });
    await owner(
      "update users set last_login_at = now() - interval '2 days' where id = $1::uuid",
      [mo]
    );
    await owner(
      `update users set account_status = 'restricted', restricted_until = now() - interval '1 day'
        where id = $1::uuid`,
      [lapsed]
    );
    await owner(
      `update users set account_status = 'restricted', restricted_until = now() + interval '1 day',
              last_login_at = now() - interval '12 hours'
        where id = $1::uuid`,
      [held]
    );
  });
  afterAll(async () => {
    await dropTestTenants();
    await withOwnerTx("operator", (tx) =>
      tx.query("delete from roles where name = any($1::text[])", [
        [`t${RUN}_support`, `t${RUN}_qa_lead`],
      ])
    );
    await disconnectTestDatabase();
  });
}

dbDescribe("TASK-190 the Users list's filters: the same accounts as the search", () => {
  const CASES: [string, Record<string, string | number>, () => string[]][] = [
    ["role by name", { role: "moderator" }, () => [mo]],
    ["role by display name, any case", { role: "MODERATOR" }, () => [mo]],
    ["a run's own role by display name", { role: "support lead" }, () => [held]],
    [
      "status active (an expired restriction is over)",
      { status: "active" },
      () => [mo, fay, lapsed, pct, qa],
    ],
    ["status restricted (until tomorrow)", { status: "restricted" }, () => [held]],
    ["status deleted (erased)", { status: "deleted" }, () => [erased]],
    ["signed in within 7 days", { signed_in_within_days: 7 }, () => [mo, held]],
    ["signed in within 1 day", { signed_in_within_days: 1 }, () => [held]],
    [
      "created within 30 days",
      { created_within_days: 30 },
      () => [mo, lapsed, held, erased, pct, qa],
    ],
    ["text: _ as itself", { text: "john_doe" }, () => [fay]],
    ["text: % as itself", { text: "100%" }, () => [pct]],
    ["role and a window", { role: "moderator", signed_in_within_days: 7 }, () => [mo]],
    ["nothing matches", { role: "moderator", status: "deleted" }, () => []],
  ];

  it.each(CASES)("%s", async (_label, filters, expected) => {
    const want = expected().sort();
    expect(await listed(filters)).toEqual(want);
    expect(await searched(filters)).toEqual(want);
  });

  it("every sort applies the filters", async () => {
    for (const sort of ["created", "last_sign_in"])
      for (const dir of ["desc", "asc"])
        expect(await listed({ role: "moderator" }, `&sort=${sort}&dir=${dir}`)).toEqual([
          mo,
        ]);
  });

  it("the search box and the text filter both apply", async () => {
    expect(
      await listed({ text: "john" }, `&q=${encodeURIComponent(`doe ${RUN}`)}`)
    ).toEqual([fay]);
    expect(await listed({ text: "john" }, "&q=nobody-here")).toEqual([]);
  });

  it("another tenant's accounts are never listed", async () => {
    expect(await listed({ role: "moderator" })).not.toContain(outsider);
    expect(await listed({ role: "moderator" }, "", b)).toEqual([outsider]);
  });

  it("a refused value reads nothing, and a moderator is refused before any filter", async () => {
    const bad = await usersGET(req("/api/admin/users?status=superuser"));
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("request.invalid_value");
    const hostile = await usersGET(
      req(`/api/admin/users?role=${encodeURIComponent("x' or '1'='1")}`)
    );
    expect(hostile.status).toBe(200);
    expect((await hostile.json()).users).toEqual([]);
    expect(
      (await usersGET(req("/api/admin/users?role=moderator", moderatorCaller))).status
    ).toBe(403);
  });

  it("round 1: a role with no display name — read by its name, written 'Qa lead' in both", async () => {
    const role = `t${RUN}_qa_lead`;
    expect(await listed({ role })).toEqual([qa]);
    expect(await searched({ role })).toEqual([qa]);
    // The search's role cell is the stored name (the display name is blank).
    const res = await a.run(() => handleSearch({ table: "users", role }, searcher));
    const cell = res.table!.rows[0]![res.table!.columns.indexOf("role")];
    expect(cell).toBe(role);
    // The list's row, as the Users screen reads it.
    const body = (await (
      await usersGET(req(`/api/admin/users?role=${role}`))
    ).json()) as { users: { roleName: string; roleDisplayName: string | null }[] };
    const row = body.users[0]!;
    expect(row.roleName).toBe(role);
    const listedAs = readableRole(row.roleName, row.roleDisplayName);
    expect(listedAs).toBe(`T${RUN} qa lead`);
    expect(shownCell("users", "role", String(cell)).text).toBe(listedAs);
  });

  it("round 1: a user with no role cannot exist — the schema refuses one", async () => {
    await expect(
      owner(
        `insert into users (id, cognito_sub, email, role_id, tenant_id)
         values ($1::uuid, $2, $3, null, $4::uuid)`,
        [randomUUID(), `sub-${RUN}-norole`, mail("norole"), a.id]
      )
    ).rejects.toMatchObject({ code: "23502" });
    await expect(
      owner(
        `insert into users (id, cognito_sub, email, role_id, tenant_id)
         values ($1::uuid, $2, $3, $4::uuid, $5::uuid)`,
        [randomUUID(), `sub-${RUN}-ghost`, mail("ghost"), randomUUID(), a.id]
      )
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("the search hands back filters the list takes as they are", async () => {
    const res = await a.run(() =>
      handleSearch({ table: "users", role: "  Moderator ", text: " Mo " }, searcher)
    );
    const handed = res.table!.filters!;
    expect(handed).toEqual({ role: "Moderator", text: "Mo" });
    expect(await listed(handed)).toEqual([mo]);
  });
});
