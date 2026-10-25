/**
 * @jest-environment node
 */
/**
 * Review 7 M5: a cached permission set is dropped by every change that can alter it — a
 * permission removed from a role, a role deleted (with the inheritance links it held), and the
 * account's deletion — not served on until the cache's TTL runs out. Against Postgres, with the
 * real permissions cache: a set is cached, the change is made through the admin handler, and the
 * next read reflects it at once.
 *
 * Every catalog row is this file's own (random names), removed afterwards.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-test",
}));

import { randomUUID } from "node:crypto";
import { withOwnerTx } from "@/platform/data";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import {
  handleAssignPermissions,
  handleCreateRole,
  handleDeleteRole,
} from "@/app/api/admin/ai/handlers/roles";
import { getCachedPermissions } from "@/platform/auth/permissions-cache";
import { softDeleteUser } from "@/platform/auth/gdpr-deletion";
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
  catalogName,
  createCatalog,
  dropCatalog,
  insertUser,
  newRun,
  type TestCatalog,
} from "../helpers/db-admin";

const RUN = newRun();
let t: TestTenant;
let cat: TestCatalog;
let operator: VerifiedAdmin;

const perms = async (sub: string) =>
  t.run(async () => (await getCachedPermissions(sub))?.permissions ?? null);

if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    t = await createTestTenant();
    cat = await createCatalog(RUN, {
      permissions: ["x", "y", "z"],
      roles: { holder: ["x", "y"], parent: ["z"], child: [] },
    });
    operator = {
      userId: randomUUID(),
      sub: `sub-${RUN}`,
      roleName: "admin",
      permissions: [
        "admin_manage_roles",
        cat.codes.x,
        cat.codes.y,
        cat.codes.z,
        "platform_operate",
      ],
    };
  });
  afterAll(async () => {
    await dropTestTenants();
    await dropCatalog();
    await disconnectTestDatabase();
  });
}

dbDescribe(
  "review 7 M5: the permissions cache follows the role catalog and the account",
  () => {
    it("a permission removed from a role is gone from its holders' cached set at once", async () => {
      const id = await insertUser(t, { roleId: cat.roles.holder });
      const sub = `sub-${id}`;
      expect(await perms(sub)).toEqual(
        expect.arrayContaining([cat.codes.x, cat.codes.y])
      );
      const res = await t.run(() =>
        handleAssignPermissions(
          { role_name: cat.roleNames.holder, remove: [cat.codes.x] },
          operator
        )
      );
      expect(res.success).toBe(true);
      const after = await perms(sub);
      expect(after).not.toContain(cat.codes.x);
      expect(after).toContain(cat.codes.y);
    });

    it("a deleted role's inherited permissions are gone from the inheritors' cached set", async () => {
      await withOwnerTx("operator", (tx) =>
        tx.query(
          "insert into role_inheritance (role_id, inherits_from_id) values ($1::uuid, $2::uuid)",
          [cat.roles.child, cat.roles.parent]
        )
      );
      const id = await insertUser(t, { roleId: cat.roles.child });
      const sub = `sub-${id}`;
      expect(await perms(sub)).toContain(cat.codes.z);
      const res = await t.run(() =>
        handleDeleteRole({ role_name: cat.roleNames.parent }, operator)
      );
      expect(res.success).toBe(true);
      expect(await perms(sub)).not.toContain(cat.codes.z);
    });

    it("a role created then edited never serves its earlier set", async () => {
      const roleName = catalogName(RUN, "fresh");
      await t.run(() =>
        handleCreateRole(
          { name: roleName, display_name: "Fresh", permissions: [cat.codes.y] },
          operator
        )
      );
      const { rows } = await withOwnerTx("operator", (tx) =>
        tx.query<{ id: string }>("select id from roles where name = $1", [roleName])
      );
      const id = await insertUser(t, { roleId: rows[0].id });
      expect(await perms(`sub-${id}`)).toEqual([cat.codes.y]);
      await t.run(() =>
        handleAssignPermissions({ role_name: roleName, remove: [cat.codes.y] }, operator)
      );
      expect(await perms(`sub-${id}`)).toEqual([]);
    });

    it("a deleted account's cached set is dropped with it", async () => {
      const id = await insertUser(t, { roleId: cat.roles.holder });
      const sub = `sub-${id}`;
      expect(await perms(sub)).not.toBeNull();
      await expect(t.run(() => softDeleteUser(id, id))).resolves.toMatchObject({
        success: true,
      });
      expect(await perms(sub)).toBeNull();
    });
  }
);
