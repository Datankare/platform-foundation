/**
 * @jest-environment node
 */
/**
 * TASK-192 on Postgres: the roles in the owner's order (migration 059) and each role's
 * permissions by category, then display name — the order platform/auth/catalog-order.ts defines,
 * read through the routes and the command bar as the screens read them.
 *
 * Suites share one database and add roles of their own while this runs, so every order is checked
 * on the rows this suite knows (the seeded roles and its own), never on the whole list.
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { withOwnerTx } from "@/platform/data";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import {
  NEW_ROLE_SORT_ORDER,
  PERMISSION_CATEGORY_ORDER,
  SEEDED_ROLE_SORT_ORDER,
  comparePermissions,
  compareRoles,
  type ListedPermission,
} from "@/platform/auth/catalog-order";
import { handleCreateRole, handleDuplicateRole } from "@/app/api/admin/ai/handlers/roles";
import { handleSearch } from "@/app/api/admin/ai/handlers/search";
import { GET as rolesGET } from "@/app/api/admin/roles/route";
import { GET as usersGET } from "@/app/api/admin/users/route";
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
  catalogName,
  createCatalog,
  dropCatalog,
  newRun,
  suiteCaller,
  type TestCatalog,
} from "../helpers/db-admin";

const RUN = newRun();
const name = (label: string) => catalogName(RUN, label);
let a: TestTenant;
let cat: TestCatalog;

/** The owner's order, as names. */
const OWNER_ORDER = [
  "super_admin",
  "admin",
  "moderator",
  "safety_approver",
  "guest",
  "free",
  "daily",
  "monthly",
  "annual",
  "lifetime",
];

const operator: VerifiedAdmin = {
  userId: randomUUID(),
  sub: `sub-${RUN}`,
  roleName: "admin",
  permissions: [
    "admin_manage_roles",
    "admin_manage_users",
    "platform_operate",
    "can_play",
    "can_translate",
  ],
};

async function q<R extends Record<string, unknown>>(
  text: string,
  values: unknown[] = []
): Promise<R[]> {
  return (await withOwnerTx("operator", (tx) => tx.query<R>(text, values))).rows;
}

/** `names` in the order `listed` has them (anything else dropped). */
const inListOrder = (listed: readonly string[], names: readonly string[]) =>
  listed.filter((n) => names.includes(n));

if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    a = await createTestTenant();
    // Two roles of the run's own (column default), named so their order is by name: "b…" before
    // "m…" though created the other way round. Each with permissions of mixed categories.
    cat = await createCatalog(RUN, {
      permissions: [],
      roles: {
        mid: ["can_moderate", "can_play", "admin_view_audit", "can_export_data"],
        bee: [],
      },
    });
    // A permission in a category the platform does not order: after the known ones.
    const [odd] = await q<{ id: string }>(
      "insert into permissions (code, display_name, category) values ($1, 'Aaa first by name', $2) returning id",
      [name("odd"), name("zcat")]
    );
    await q(
      "insert into role_permissions (role_id, permission_id) values ($1::uuid, $2::uuid)",
      [cat.roles.mid, odd.id]
    );
  });
  afterAll(async () => {
    await dropTestTenants();
    await dropCatalog();
    await disconnectTestDatabase();
  });
}

dbDescribe("TASK-192 migration 059: the roles' sort_order", () => {
  it("each seeded role has the code's value, staff then the plans, in the owner's order", async () => {
    const rows = await q<{ name: string; sort_order: number }>(
      "select name, sort_order from roles where name = any($1::text[]) order by sort_order, name",
      [OWNER_ORDER]
    );
    expect(rows.map((r) => r.name)).toEqual(OWNER_ORDER);
    for (const r of rows) expect(r.sort_order).toBe(SEEDED_ROLE_SORT_ORDER[r.name]);
    expect(Object.keys(SEEDED_ROLE_SORT_ORDER)).toEqual(OWNER_ORDER);
  });

  it("no other role sorts among the seeded ones; the column defaults to NEW_ROLE_SORT_ORDER", async () => {
    const [col] = await q<{ column_default: string }>(
      `select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'roles' and column_name = 'sort_order'`
    );
    expect(Number(col.column_default)).toBe(NEW_ROLE_SORT_ORDER);
    const [own] = await q<{ sort_order: number }>(
      "select sort_order from roles where id = $1::uuid",
      [cat.roles.bee]
    );
    expect(own.sort_order).toBe(NEW_ROLE_SORT_ORDER);
    expect(NEW_ROLE_SORT_ORDER).toBeGreaterThan(
      Math.max(...Object.values(SEEDED_ROLE_SORT_ORDER))
    );
  });
});

dbDescribe("TASK-192 a role created or duplicated in the command bar", () => {
  it("sorts after the seeded roles, with the rest by name", async () => {
    expect(
      (
        await a.run(() =>
          handleCreateRole({ name: name("aaa_new"), display_name: "Aaa new" }, operator)
        )
      ).success
    ).toBe(true);
    expect(
      (
        await a.run(() =>
          handleDuplicateRole(
            {
              source_role: cat.roleNames.bee,
              new_name: name("zzz_copy"),
              new_display_name: "Zzz copy",
            },
            operator
          )
        )
      ).success
    ).toBe(true);
    const made = await q<{ name: string; sort_order: number }>(
      "select name, sort_order from roles where name = any($1::text[]) order by name",
      [[name("aaa_new"), name("zzz_copy")]]
    );
    expect(made.map((r) => r.sort_order)).toEqual([
      NEW_ROLE_SORT_ORDER,
      NEW_ROLE_SORT_ORDER,
    ]);
  });
});

dbDescribe("TASK-192 the screens' lists", () => {
  const caller = () => suiteCaller("super_admin", RUN);

  it("GET /api/admin/roles: the owner's order, then the rest by name", async () => {
    const res = await rolesGET(
      new NextRequest("http://localhost/api/admin/roles", {
        headers: asCallerIn(caller(), a),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      roles: { name: string; permissions: ListedPermission[] }[];
      availablePermissions: { code: string; display_name: string; category: string }[];
    };
    const names = body.roles.map((r) => r.name);
    const ours = [cat.roleNames.bee, cat.roleNames.mid];
    expect(inListOrder(names, [...OWNER_ORDER, ...ours])).toEqual([
      ...OWNER_ORDER,
      ...ours,
    ]);
    // Every seeded role comes before every role of the rest.
    expect(Math.max(...OWNER_ORDER.map((n) => names.indexOf(n)))).toBeLessThan(
      Math.min(...ours.map((n) => names.indexOf(n)))
    );

    // A role's permissions: by category (admin, moderation, gameplay, …, any other last), then
    // display name — whatever order role_permissions returned them in.
    const mid = body.roles.find((r) => r.name === cat.roleNames.mid)!;
    expect(mid.permissions.map((p) => p.code)).toEqual([
      "admin_view_audit",
      "can_moderate",
      "can_play",
      "can_export_data",
      name("odd"),
    ]);
    for (const r of body.roles) {
      expect([...r.permissions].sort(comparePermissions)).toEqual(r.permissions);
    }
    // super_admin holds every category: they appear in the defined order.
    const superAdmin = body.roles.find((r) => r.name === "super_admin")!;
    const categories = [...new Set(superAdmin.permissions.map((p) => p.category))];
    expect(categories.filter((c) => PERMISSION_CATEGORY_ORDER.includes(c))).toEqual(
      PERMISSION_CATEGORY_ORDER.filter((c) => categories.includes(c))
    );
    const avail = body.availablePermissions.map((p) => ({
      code: p.code,
      displayName: p.display_name,
      category: p.category,
    }));
    expect([...avail].sort(comparePermissions)).toEqual(avail);
  });

  it("GET /api/admin/users: the role picker's roles in the same order", async () => {
    const res = await usersGET(
      new NextRequest("http://localhost/api/admin/users", {
        headers: asCallerIn(caller(), a),
      })
    );
    expect(res.status).toBe(200);
    const names = ((await res.json()) as { roles: { name: string }[] }).roles.map(
      (r) => r.name
    );
    const ours = [cat.roleNames.bee, cat.roleNames.mid];
    expect(inListOrder(names, [...OWNER_ORDER, ...ours])).toEqual([
      ...OWNER_ORDER,
      ...ours,
    ]);
  });

  it("the command bar's search: roles in the screen's order, role permissions by role then category", async () => {
    const admin: VerifiedAdmin = { ...operator, permissions: ["admin_manage_roles"] };
    const roles = await a.run(() => handleSearch({ table: "roles", text: RUN }, admin));
    expect(roles.success).toBe(true);
    const nameCol = roles.table!.columns.indexOf("name");
    const found = roles.table!.rows.map((r) => r[nameCol] as string);
    expect(found.indexOf(cat.roleNames.bee)).toBeLessThan(
      found.indexOf(cat.roleNames.mid)
    );
    const seeded = await a.run(() => handleSearch({ table: "roles", text: "" }, admin));
    const all = seeded.table!.rows.map((r) => r[nameCol] as string);
    expect(inListOrder(all, OWNER_ORDER)).toEqual(OWNER_ORDER);
    expect(all.slice(0, OWNER_ORDER.length)).toEqual(OWNER_ORDER);

    const pairs = await a.run(() =>
      handleSearch({ table: "role_permissions", text: cat.roleNames.mid }, admin)
    );
    expect(pairs.success).toBe(true);
    const perm = pairs.table!.columns.indexOf("permission");
    expect(pairs.table!.rows.map((r) => r[perm])).toEqual([
      "admin_view_audit",
      "can_moderate",
      "can_play",
      "can_export_data",
      name("odd"),
    ]);
  });
});

dbDescribe("TASK-192 round 1: names in any case; a consumer's sort_order kept", () => {
  /** Roles named so a locale collation and the code-unit order disagree ("a_b" / "AB" / "ab"). */
  // Round 2: "😀" (U+1F600) and "～" (U+FF5E) — code point and UTF-16 code unit disagree on them.
  const mixed = ["Zed", "a_b", "AB", "😀", "ab", "～", "Ab", "mid_Case"].map((n) =>
    name(`mx_${n}`)
  );
  let mixedRole: string;
  const mixedPerms = [
    { label: "pb", display: "beta", category: "Admin" },
    { label: "pa", display: "Alpha", category: "ADMIN" },
    { label: "pc", display: "alpha", category: "admin" },
    { label: "pd", display: "Zed", category: "gameplay" },
    // Round 2: trailing whitespace trimmed in SQL as in the code — still Administration.
    { label: "pe", display: "Aardvark", category: "admin\t" },
  ];

  beforeAll(async () => {
    if (!DB_ENABLED) return;
    for (const n of mixed)
      await q("insert into roles (name, display_name) values ($1, $1)", [n]);
    [{ id: mixedRole }] = await q<{ id: string }>(
      "select id from roles where name = $1",
      [mixed[0]]
    );
    for (const p of mixedPerms) {
      const [row] = await q<{ id: string }>(
        "insert into permissions (code, display_name, category) values ($1, $2, $3) returning id",
        [name(p.label), p.display, p.category]
      );
      await q(
        "insert into role_permissions (role_id, permission_id) values ($1::uuid, $2::uuid)",
        [mixedRole, row.id]
      );
    }
    await q(
      "insert into role_permissions (role_id, permission_id) select $1::uuid, id from permissions where code = 'can_moderate'",
      [mixedRole]
    );
  });

  const expectedRoles = () =>
    mixed
      .map((n) => ({ name: n, sortOrder: NEW_ROLE_SORT_ORDER }))
      .sort(compareRoles)
      .map((r) => r.name);

  it("the routes and the search order mixed-case names as the browser's comparator does", async () => {
    // Case-insensitively, then exactly ("AB" < "Ab" < "ab"); "_" before letters, by code unit.
    expect(expectedRoles()).toEqual(
      ["a_b", "AB", "Ab", "ab", "mid_Case", "Zed", "～", "😀"].map((n) => name(`mx_${n}`))
    );
    const caller = suiteCaller("super_admin", RUN);
    const roles = (await (
      await rolesGET(
        new NextRequest("http://localhost/api/admin/roles", {
          headers: asCallerIn(caller, a),
        })
      )
    ).json()) as { roles: { name: string; permissions: ListedPermission[] }[] };
    expect(
      inListOrder(
        roles.roles.map((r) => r.name),
        mixed
      )
    ).toEqual(expectedRoles());

    const users = (await (
      await usersGET(
        new NextRequest("http://localhost/api/admin/users", {
          headers: asCallerIn(caller, a),
        })
      )
    ).json()) as { roles: { name: string }[] };
    expect(
      inListOrder(
        users.roles.map((r) => r.name),
        mixed
      )
    ).toEqual(expectedRoles());

    const admin: VerifiedAdmin = { ...operator, permissions: ["admin_manage_roles"] };
    const found = await a.run(() =>
      handleSearch({ table: "roles", text: `${RUN}_mx_` }, admin)
    );
    const nameCol = found.table!.columns.indexOf("name");
    expect(found.table!.rows.map((r) => r[nameCol])).toEqual(expectedRoles());

    // A category in another case is the known one; names by case, then exactly.
    const own = roles.roles.find((r) => r.name === mixed[0])!;
    expect(own.permissions.map((p) => p.code)).toEqual([
      name("pe"),
      name("pa"),
      name("pc"),
      name("pb"),
      "can_moderate",
      name("pd"),
    ]);
    const perms = await a.run(() =>
      handleSearch({ table: "permissions", text: RUN }, admin)
    );
    const code = perms.table!.columns.indexOf("code");
    const listed = perms.table!.rows.map((r) => r[code] as string);
    expect(
      inListOrder(
        listed,
        mixedPerms.map((p) => name(p.label))
      )
    ).toEqual([name("pe"), name("pa"), name("pc"), name("pb"), name("pd")]);
    const pairs = await a.run(() =>
      handleSearch({ table: "role_permissions", text: mixed[0] }, admin)
    );
    const pcol = pairs.table!.columns.indexOf("permission");
    expect(pairs.table!.rows.map((r) => r[pcol])).toEqual(
      own.permissions.map((p) => p.code)
    );
  });

  it("059 moves another role only from an old default: 55 is kept, 99 and 0 become 1000", async () => {
    const sql = readFileSync(
      join(__dirname, "../../supabase/migrations/059_roles_sort_order.sql"),
      "utf8"
    );
    const rest = sql.match(/update public\.roles set sort_order = 1000[\s\S]*?;/)![0];
    const ROLLBACK = new Error("rollback");
    let after: { name: string; sort_order: number }[] = [];
    await expect(
      withOwnerTx("operator", async (tx) => {
        await tx.query(
          `insert into roles (name, display_name, sort_order)
           values ($1, $1, 55), ($2, $2, 99), ($3, $3, 0)`,
          [name("keep55"), name("old99"), name("old0")]
        );
        await tx.query(rest);
        after = (
          await tx.query<{ name: string; sort_order: number }>(
            "select name, sort_order from roles where name = any($1::text[]) order by name",
            [[name("keep55"), name("old99"), name("old0")]]
          )
        ).rows;
        throw ROLLBACK;
      })
    ).rejects.toBe(ROLLBACK);
    expect(after).toEqual([
      { name: name("keep55"), sort_order: 55 },
      { name: name("old0"), sort_order: NEW_ROLE_SORT_ORDER },
      { name: name("old99"), sort_order: NEW_ROLE_SORT_ORDER },
    ]);
    expect(
      await q("select 1 from roles where name = any($1::text[])", [
        [name("keep55"), name("old99"), name("old0")],
      ])
    ).toHaveLength(0);
  });
});
