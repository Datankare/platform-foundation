/**
 * __tests__/db/task-189-search.db.test.ts — The command bar's search against Postgres (TASK-189)
 *
 * Each table's fixed statement runs for real, in a test tenant: it returns exactly its allowlisted
 * columns (each row's keys as Postgres returns them, not only what the handler copies), a row's sensitive columns —
 * stored with telling values — never reach the result, each filter narrows what it says, a LIKE
 * metacharacter is matched as itself, another tenant's rows are never read, and platform_config
 * shows the value in effect for the tenant and leaves out retired settings. Round 1: a role by
 * name or display name, an active restriction and suspension with their ends, sign-ins ordered by
 * the last, the match count before the limit, a config value as JSON.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-test",
}));

import { randomUUID } from "node:crypto";
import { withOwnerTx, withTenantTx } from "@/platform/data";
import {
  handleSearch,
  SEARCH_COLUMNS,
  SEARCH_SQL,
  searchParams,
  type SearchableTable,
} from "@/app/api/admin/ai/handlers/search";
import { SEARCHABLE_TABLES } from "@/app/api/admin/ai/tool-permissions";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import {
  DB_ENABLED,
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";
import { insertUser, newRun, seededRoleId } from "../helpers/db-admin";

const RUN = newRun();
let a: TestTenant;
let b: TestTenant;
let freeRole: string;
let moderatorRole: string;

let kim: string; // A: moderator, signed in 2 days ago, sensitive columns filled in
let lee: string; // A: free, never signed in, created 400 days ago, "john_doe" in the name
let lapsed: string; // A: restricted until yesterday → shown active
let erased: string; // A: deleted
let held: string; // A: restricted until tomorrow, role Support Lead, signed in 12 hours ago
let paused: string; // A: suspended until next week
let supportRole: string; // a run's own role: display name "Support Lead"
let outsider: string; // B

const admin: VerifiedAdmin = {
  userId: randomUUID(),
  sub: "s",
  roleName: "admin",
  permissions: [...new Set(Object.values(SEARCHABLE_TABLES))],
};

const mail = (label: string) => `${label}-${RUN}@x.test`;
const owner = (text: string, values: unknown[] = []) =>
  withOwnerTx("tenant-lifecycle", (tx) => tx.query(text, values));

const search = async (input: Record<string, unknown>, tenant: TestTenant = a) => {
  const res = await tenant.run(() => handleSearch(input, admin));
  if (!res.success || !res.table)
    throw new Error(`search failed: ${JSON.stringify(res)}`);
  return res.table;
};
const column = (
  t: { columns: readonly string[]; rows: readonly (readonly unknown[])[] },
  name: string
) => t.rows.map((r) => r[t.columns.indexOf(name)]);

if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    a = await createTestTenant();
    b = await createTestTenant();
    freeRole = await seededRoleId("free");
    moderatorRole = await seededRoleId("moderator");

    kim = await insertUser(a, {
      roleId: moderatorRole,
      email: mail("kim"),
      displayName: `Kim ${RUN}`,
      emailVerified: true,
    });
    lee = await insertUser(a, {
      roleId: freeRole,
      email: mail("lee"),
      displayName: `john_doe ${RUN}`,
      createdAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
    });
    lapsed = await insertUser(a, { roleId: freeRole, email: mail("lapsed") });
    supportRole = (
      await withOwnerTx("operator", (tx) =>
        tx.query<{ id: string }>(
          "insert into roles (name, display_name) values ($1, 'Support Lead') returning id",
          [`t${RUN}_support`]
        )
      )
    ).rows[0].id;
    held = await insertUser(a, { roleId: supportRole, email: mail("held") });
    paused = await insertUser(a, { roleId: freeRole, email: mail("paused") });
    erased = await insertUser(a, {
      roleId: freeRole,
      email: mail("erased"),
      deletedAt: new Date().toISOString(),
    });
    outsider = await insertUser(b, {
      roleId: moderatorRole,
      email: mail("outsider"),
      displayName: `Kim ${RUN}`,
    });
    await owner(
      `update users set last_login_at = now() - interval '2 days', date_of_birth = '2012-03-04',
              real_name = 'REAL-NAME-SECRET', ban_reason = 'BAN-SECRET', status_changed_by = 'CHANGED-SECRET',
              parental_consent_email = 'parent-secret@x.test'
        where id = $1::uuid`,
      [kim]
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
    await owner(
      `update users set account_status = 'suspended', suspended_until = now() + interval '7 days'
        where id = $1::uuid`,
      [paused]
    );
    await owner(
      `insert into audit_log (tenant_id, action, actor_id, target_id, details, ip_address, user_agent)
       values ($1::uuid, 'role_changed', $2::uuid, $3::uuid, '{"secret":"DETAILS-SECRET"}', '10.1.2.3', 'UA-SECRET'),
              ($1::uuid, 'profile_updated', $3::uuid, $3::uuid, '{}', null, null),
              ($4::uuid, 'role_changed', $2::uuid, $3::uuid, '{}', null, null)`,
      [a.id, admin.userId, kim, b.id]
    );
    await withOwnerTx("operator", (tx) =>
      tx.query(
        "insert into entitlement_groups (code, display_name) values ($1, 'Search group')",
        [`t${RUN}_group`]
      )
    );
    await owner(
      `insert into tenant_config_overrides (tenant_id, key, value) values ($1::uuid, 'default_language', '"de"')`,
      [a.id]
    );
  });
  afterAll(async () => {
    await withOwnerTx("operator", (tx) =>
      tx.query("delete from entitlement_groups where code = $1", [`t${RUN}_group`])
    );
    await dropTestTenants();
    await withOwnerTx("operator", (tx) =>
      tx.query("delete from roles where name = $1", [`t${RUN}_support`])
    );
    await disconnectTestDatabase();
  });
}

const TABLES = Object.keys(SEARCHABLE_TABLES) as SearchableTable[];

dbDescribe("TASK-189 search: each statement returns exactly its allowlist", () => {
  it.each(TABLES)("%s", async (table) => {
    const result = await a.run(() =>
      withTenantTx((tx) => tx.query(SEARCH_SQL[table], searchParams(table, {})))
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows)
      expect(Object.keys(row)).toEqual([...SEARCH_COLUMNS[table], "total"]);
    expect(result.rows.length).toBeLessThanOrEqual(20);
  });

  it("no sensitive value of a user or an audit entry reaches a result", async () => {
    const users = await search({ table: "users", text: "kim" });
    const audit = await search({ table: "audit_log" });
    const text = JSON.stringify([users, audit]);
    expect(text).toContain(kim);
    expect(text).not.toMatch(/SECRET|2012-03-04|10\.1\.2\.3|sub-/i);
  });
});

dbDescribe("TASK-189 search: users filters", () => {
  it("text: address or display name, this tenant's only", async () => {
    const t = await search({ table: "users", text: `Kim ${RUN}` });
    expect(column(t, "id")).toEqual([kim]);
    expect(column(t, "id")).not.toContain(outsider);
  });

  it("text: `_` is matched as itself, not as any character", async () => {
    expect(
      column(await search({ table: "users", text: `john_doe ${RUN}` }), "id")
    ).toEqual([lee]);
    expect(
      column(await search({ table: "users", text: `johnXdoe ${RUN}` }), "id")
    ).toEqual([]);
    expect(
      column(await search({ table: "users", text: `john%doe ${RUN}` }), "id")
    ).toEqual([]);
  });

  it("an injection attempt in text matches nothing and changes nothing", async () => {
    const t = await search({ table: "users", text: "' or '1'='1" });
    expect(t.rows).toEqual([]);
  });

  it("role: by name or display name, any case (round 1)", async () => {
    for (const role of ["moderator", "Moderator", "MODERATOR"]) {
      expect(column(await search({ table: "users", role, text: RUN }), "id")).toEqual([
        kim,
      ]);
    }
    for (const role of ["Support Lead", "support lead", `t${RUN}_support`]) {
      expect(column(await search({ table: "users", role, text: RUN }), "id")).toEqual([
        held,
      ]);
    }
    expect((await search({ table: "users", role: "Support", text: RUN })).rows).toEqual(
      []
    );
  });

  it("status: as the Users screen reads it", async () => {
    const shown = await search({ table: "users", text: RUN });
    const byId = new Map(
      shown.rows.map((r) => [r[0], r[shown.columns.indexOf("status")]])
    );
    expect(byId.get(lapsed)).toBe("active");
    expect(byId.get(erased)).toBe("deleted");
    expect(byId.get(kim)).toBe("active");
    expect(
      column(await search({ table: "users", status: "deleted", text: RUN }), "id")
    ).toEqual([erased]);
    // An active restriction and suspension, with their ends (round 1).
    const restricted = await search({ table: "users", status: "restricted", text: RUN });
    expect(column(restricted, "id")).toEqual([held]);
    expect(column(restricted, "status_until")[0]).toEqual(expect.any(String));
    expect(Date.parse(String(column(restricted, "status_until")[0]))).toBeGreaterThan(
      Date.now()
    );
    const suspended = await search({ table: "users", status: "suspended", text: RUN });
    expect(column(suspended, "id")).toEqual([paused]);
    expect(Date.parse(String(column(suspended, "status_until")[0]))).toBeGreaterThan(
      Date.now() + 5 * 86_400_000
    );
    expect(byId.get(lapsed)).toBe("active");
    const lapsedUntil = shown.rows.find((r) => r[0] === lapsed)![
      shown.columns.indexOf("status_until")
    ];
    expect(lapsedUntil).toBeNull();
  });

  it("signed_in_within_days and created_within_days", async () => {
    // Most recent sign-in first (round 1): held (12 hours ago), then kim (2 days ago).
    expect(
      column(await search({ table: "users", text: RUN, signed_in_within_days: 7 }), "id")
    ).toEqual([held, kim]);
    expect(
      column(await search({ table: "users", text: RUN, signed_in_within_days: 1 }), "id")
    ).toEqual([held]);
    const recent = column(
      await search({ table: "users", text: RUN, created_within_days: 30 }),
      "id"
    );
    expect(recent).toContain(kim);
    expect(recent).not.toContain(lee);
  });

  it("the role is shown by its display name (TASK-190), the address verification as yes/no", async () => {
    const t = await search({ table: "users", text: `Kim ${RUN}` });
    expect(column(t, "role")).toEqual(["Moderator"]);
    expect(column(t, "email_verified")).toEqual([true]);
    expect(typeof column(t, "last_sign_in_at")[0]).toBe("string");
  });
});

dbDescribe("TASK-189 search: the match count (round 1)", () => {
  it("counts every match, before the limit", async () => {
    const res = await a.run(() => handleSearch({ table: "permissions" }, admin));
    const total = Number(
      (await owner("select count(*)::int as n from permissions")).rows[0].n
    );
    expect(total).toBeGreaterThan(20);
    expect(res.table?.rows).toHaveLength(20);
    expect(res.table?.matched).toBe(total);
    expect(res.result).toBe(`Showing 20 of ${total} matching rows of permissions.`);
    const mine = await a.run(() => handleSearch({ table: "users", text: RUN }, admin));
    expect(mine.table?.matched).toBe(mine.table?.rows.length);
    expect(mine.result).toBe(`${mine.table?.rows.length} rows of users.`);
  });
});

dbDescribe("TASK-189 search: audit_log filters", () => {
  it("action, actor, target and within days — this tenant's only", async () => {
    const changed = await search({ table: "audit_log", action: "role_changed" });
    expect(changed.rows).toHaveLength(1);
    expect(column(changed, "actor_id")).toEqual([admin.userId]);
    expect(column(await search({ table: "audit_log", actor_id: kim }), "action")).toEqual(
      ["profile_updated"]
    );
    expect((await search({ table: "audit_log", target_id: kim })).rows).toHaveLength(2);
    expect((await search({ table: "audit_log", within_days: 1 })).rows).toHaveLength(2);
    expect(
      column(await search({ table: "audit_log", text: "profile" }), "action")
    ).toEqual(["profile_updated"]);
    expect((await search({ table: "audit_log" }, b)).rows).toHaveLength(1);
  });
});

dbDescribe("TASK-189 search: platform_config and the catalog", () => {
  it("platform_config: the tenant's value in effect, overridden marked; no retired setting", async () => {
    const t = await search({ table: "platform_config", text: "default_language" });
    expect(column(t, "key")).toEqual(["default_language"]);
    // A JSON value is shown as its JSON text (a string quoted).
    expect(column(t, "value")).toEqual(['"de"']);
    expect(column(t, "overridden")).toEqual([true]);
    const other = await search({ table: "platform_config", text: "default_language" }, b);
    expect(column(other, "overridden")).toEqual([false]);
    const retired = await search({
      table: "platform_config",
      text: "moderation.blocklist_only_surfaces",
    });
    expect(retired.rows).toEqual([]);
    const byCategory = await search({ table: "platform_config", category: "i18n" });
    expect(byCategory.rows.length).toBeGreaterThan(0);
    const categories = column(byCategory, "category");
    expect(categories.length).toBeGreaterThan(0);
    expect(categories.every((c) => c === "i18n")).toBe(true);
    // A boolean setting is its JSON text, not a yes/no (round 1).
    const flag = await search({
      table: "platform_config",
      text: "ai.prompt_cache_enabled",
    });
    expect(column(flag, "value")).toEqual(["false"]);
  });

  it("roles, permissions, role_permissions and entitlement_groups take text", async () => {
    expect(column(await search({ table: "roles", text: "moderator" }), "name")).toContain(
      "moderator"
    );
    const perms = await search({ table: "permissions", text: "admin_view_audit" });
    expect(column(perms, "code")).toContain("admin_view_audit");
    const grants = await search({ table: "role_permissions", text: "admin_view_audit" });
    expect(grants.rows.length).toBeGreaterThan(0);
    const permissions = column(grants, "permission");
    expect(permissions.length).toBeGreaterThan(0);
    expect(permissions.every((p) => p === "admin_view_audit")).toBe(true);
    const groups = await search({ table: "entitlement_groups", text: `t${RUN}_group` });
    expect(column(groups, "code")).toEqual([`t${RUN}_group`]);
    expect(column(groups, "is_active")).toEqual([true]);
    expect(
      (await search({ table: "entitlement_groups", text: `t${RUN}%group` })).rows
    ).toEqual([]);
  });
});
