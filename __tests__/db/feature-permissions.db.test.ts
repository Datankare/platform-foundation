/**
 * @jest-environment node
 */
/**
 * No account loses a feature when its permission starts being enforced (TASK-194, audit C-4;
 * Postgres)
 *
 * requireActorWithStatus now requires each feature's permission (platform/auth/
 * feature-permissions.ts). Before, every account in good standing used those features whatever
 * its role. Migration 061 grants the permissions to every role, so — for every role in the
 * replayed database (the seeded ones and any other), as a real user of a test tenant — the
 * permission is resolved through the real lookup (platform/auth/permissions.ts) for every feature
 * that requires one. And a role without it is refused through the real guard: enforcement bites.
 *
 * Round 1 (TASK-194): resolved by the account (C3) — a legacy row whose cognito_sub is null and an
 * account re-linked to a new subject both resolve by users.id, where the subject lookup finds
 * neither; a guest's permission is the guest role's (C2) — taking can_translate from guest takes
 * effect.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-test",
}));

import { withOwnerTx } from "@/platform/data";
import { runWithTenant } from "@/platform/tenancy/context";
import {
  resolveAccountPermissions,
  resolvePermissions,
  resolveRolePermissions,
} from "@/platform/auth/permissions";
import {
  clearPermissionsCache,
  hasAccountPermission,
  hasGuestPermission,
} from "@/platform/auth/permissions-cache";
import { FEATURE_PERMISSIONS } from "@/platform/auth/feature-permissions";
import {
  connectTestDatabase,
  createTestTenant,
  dbDescribe,
  DB_ENABLED,
  disconnectTestDatabase,
  dropTestTenants,
  type TestTenant,
} from "../helpers/db";
import { createCatalog, dropCatalog, insertUser, newRun } from "../helpers/db-admin";

const RUN = newRun();
let t: TestTenant;
let roles: { id: string; name: string }[] = [];
const subs: Record<string, string> = {};
let bareSub: string;

if (DB_ENABLED) {
  beforeAll(async () => {
    await connectTestDatabase();
    t = await createTestTenant();
    // Every role of the database before this suite adds its own.
    roles = (
      await withOwnerTx("operator", (tx) =>
        tx.query<{ id: string; name: string }>(
          "select id, name from roles where name not like 't%\\_%' order by name"
        )
      )
    ).rows;
    for (const r of roles) {
      subs[r.name] = `feat-${RUN}-${r.name}`;
      await insertUser(t, { roleId: r.id, cognitoSub: subs[r.name] });
    }
    // A role made after 061 with none of them: the permission is what now decides.
    const cat = await createCatalog(RUN, { permissions: [], roles: { bare: [] } });
    bareSub = `feat-${RUN}-bare`;
    await insertUser(t, { roleId: cat.roles.bare, cognitoSub: bareSub });
  });
  afterAll(async () => {
    await dropTestTenants();
    await dropCatalog();
    await disconnectTestDatabase();
  });
}

const perms = (sub: string) =>
  runWithTenant({ tenantId: t.id, mode: "shared" }, () => resolvePermissions(sub));

dbDescribe("every role keeps the features it had (TASK-194, C-4; Postgres)", () => {
  it("reads the seeded roles (self-test)", () => {
    expect(roles.map((r) => r.name)).toEqual(
      expect.arrayContaining(["guest", "free", "moderator", "safety_approver", "admin"])
    );
  });

  it("each role's users hold every enforced feature permission", async () => {
    const missing: string[] = [];
    for (const r of roles) {
      const held = (await perms(subs[r.name]))?.permissions ?? [];
      for (const [feature, permission] of Object.entries(FEATURE_PERMISSIONS)) {
        if (!held.includes(permission))
          missing.push(`${r.name}: ${feature} (${permission})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("a role made without them holds none: the guard now refuses it (enforcement bites)", async () => {
    const held = (await perms(bareSub))?.permissions ?? [];
    for (const permission of Object.values(FEATURE_PERMISSIONS))
      expect(held).not.toContain(permission);
  });

  it("resolves by the account: a legacy row with no subject, and a re-linked account (round 1, C3)", async () => {
    const free = roles.find((r) => r.name === "free")!.id;
    const legacy = await insertUser(t, { roleId: free, cognitoSub: null });
    const relinked = await insertUser(t, { roleId: free, cognitoSub: `old-${RUN}` });
    await withOwnerTx("operator", (tx) =>
      tx.query("update users set cognito_sub = $2 where id = $1::uuid", [
        relinked,
        `new-${RUN}`,
      ])
    );
    const inTenant = <T>(fn: () => Promise<T>) =>
      runWithTenant({ tenantId: t.id, mode: "shared" }, fn);
    // By the old subject: the re-linked account is not found (nor, by any subject, the legacy one).
    expect(await inTenant(() => resolvePermissions(`old-${RUN}`))).toBeNull();
    for (const id of [legacy, relinked]) {
      const p = await inTenant(() => resolveAccountPermissions(id));
      expect({ id, translate: p?.permissions.includes("can_translate") }).toEqual({
        id,
        translate: true,
      });
    }
    expect(
      await inTenant(() => hasAccountPermission(`new-${RUN}`, relinked, "can_translate"))
    ).toBe(true);
    // A deleted account resolves to nothing.
    await withOwnerTx("operator", (tx) =>
      tx.query("update users set deleted_at = now() where id = $1::uuid", [legacy])
    );
    expect(await inTenant(() => resolveAccountPermissions(legacy))).toBeNull();
  });

  it("a guest's permission is the guest role's, and taking it away takes effect (round 1, C2)", async () => {
    const inTenant = <T>(fn: () => Promise<T>) =>
      runWithTenant({ tenantId: t.id, mode: "shared" }, fn);
    expect((await inTenant(() => resolveRolePermissions("guest")))?.permissions).toEqual(
      expect.arrayContaining(["can_translate"])
    );
    await inTenant(() => clearPermissionsCache());
    expect(await inTenant(() => hasGuestPermission("can_translate"))).toBe(true);
    const grant = await withOwnerTx("operator", (tx) =>
      tx.query<{ role_id: string; permission_id: string }>(
        `delete from role_permissions rp using roles r, permissions p
          where rp.role_id = r.id and rp.permission_id = p.id
            and r.name = 'guest' and p.code = 'can_translate'
          returning rp.role_id, rp.permission_id`
      )
    );
    try {
      // The administrator's catalog change clears every cached permission set.
      await inTenant(() => clearPermissionsCache());
      expect(await inTenant(() => hasGuestPermission("can_translate"))).toBe(false);
    } finally {
      for (const row of grant.rows)
        await withOwnerTx("operator", (tx) =>
          tx.query(
            "insert into role_permissions (role_id, permission_id) values ($1::uuid, $2::uuid)",
            [row.role_id, row.permission_id]
          )
        );
      await inTenant(() => clearPermissionsCache());
    }
  });
});
