/**
 * __tests__/helpers/db-admin.ts — admin routes and handlers against the real database
 *
 * The admin guard runs as in production; beneath it, token verification, the permission lookup
 * and the standing lookup answer from test callers (helpers/test-identities.ts). A request names
 * its tenant in test headers, which the mocked verifier enters as a real verifier would — so the
 * route's own transactions run in that tenant, under row-level security.
 *
 *   jest.mock("@/platform/auth/middleware", () =>
 *     require("@/__tests__/helpers/db-admin").mockTenantMiddleware());
 *
 * Callers are created per suite with random names (`suiteCaller`), and inserted as users of a
 * test tenant (`insertUser`) when a test needs them in the database: users.id is unique across
 * tenants, and suites run in parallel.
 *
 * Catalog rows (roles, permissions, entitlement groups) a suite needs are created with names
 * unique to the run (`createCatalog`) and removed by `dropCatalog` after `dropTestTenants`. The
 * seeded catalog is never changed: other suites read it in parallel.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { randomUUID } from "node:crypto";
import { withOwnerTx } from "@/platform/data";
import type { TenancyMode } from "@/platform/tenancy/context";
import type { TestTenant } from "./db";
import { authAs, identityFor, type TestIdentity } from "./test-identities";

const TENANT_HEADER = "x-test-tenant";
const MODE_HEADER = "x-test-mode";

/** The mocked middleware: test callers, and the request's tenant entered from its headers. */
export function mockTenantMiddleware(): any {
  const base = require("./test-identities").mockMiddleware();
  const { enterTenant } = jest.requireActual("@/platform/tenancy/context");
  const verify = base.requireAuth;
  base.requireAuth = jest.fn(async (request: any) => {
    const tenantId = request?.headers?.get?.(TENANT_HEADER);
    if (tenantId) {
      enterTenant({
        tenantId,
        mode: (request.headers.get(MODE_HEADER) ?? "shared") as TenancyMode,
      });
    }
    return verify(request);
  });
  // requireActor as in production — a signed-in user is the actor, users.id its id (the
  // platform provisions users.id = the token's subject; a test caller's is its userId). A guest
  // token is refused unless the route allows guests.
  const { apiError } = jest.requireActual("@/platform/errors");
  base.requireActor = jest.fn(async (request: any, options: { allowGuests: boolean }) => {
    const header: string = request?.headers?.get?.("authorization") ?? "";
    if (header.startsWith("Bearer guest.") && !options?.allowGuests) {
      return { error: apiError("auth.sign_in_required", { request }) };
    }
    const auth = await base.requireAuth(request);
    if (auth.error) return { error: auth.error };
    const identity = require("./test-identities").identityForSub(auth.user.sub);
    return {
      actor: {
        kind: "user",
        id: identity?.userId ?? auth.user.sub,
        tenantId: request?.headers?.get?.(TENANT_HEADER) ?? "",
        user: auth.user,
      },
    };
  });
  return base;
}

/** Headers that authenticate as `caller` in `tenant` (a shared deployment unless `mode`). */
export function asCallerIn(
  caller: Parameters<typeof authAs>[0],
  tenant: TestTenant,
  mode: TenancyMode = "shared"
): Record<string, string> {
  return { ...authAs(caller), [TENANT_HEADER]: tenant.id, [MODE_HEADER]: mode };
}

/** A caller holding `role`'s real permissions, with ids no other suite uses. */
export function suiteCaller(
  role: string,
  run: string,
  options: { name?: string; inGoodStanding?: boolean } = {}
): TestIdentity {
  return identityFor(role, { ...options, name: `${options.name ?? role}-${run}` });
}

/**
 * A caller holding `role`'s permissions whose id the audit log refuses (not a users.id) — so
 * every audited change it attempts finds the audit log unavailable (audit X-8).
 */
export function callerWithUnrecordableId(role: string, run: string): TestIdentity {
  const identity = suiteCaller(role, run, { name: `noaudit-${role}` });
  const unrecordable: TestIdentity = { ...identity, userId: `not-a-user-${run}` };
  ((globalThis as any).__TEST_IDENTITIES__ as Map<string, TestIdentity>).set(
    identity.sub,
    unrecordable
  );
  return unrecordable;
}

/** The id of a seeded role (read-only use). */
export async function seededRoleId(name: string): Promise<string> {
  const { rows } = await withOwnerTx("operator", (tx) =>
    tx.query<{ id: string }>("select id from roles where name = $1", [name])
  );
  if (!rows[0]) throw new Error(`No seeded role "${name}"`);
  return rows[0].id;
}

/** Insert a user of `tenant` with exactly these fields; returns its id. */
export async function insertUser(
  tenant: TestTenant,
  user: {
    id?: string;
    email?: string | null;
    displayName?: string | null;
    roleId: string;
    cognitoSub?: string | null;
    createdAt?: string;
    deletedAt?: string | null;
    /** Whether the identity provider had verified the email when the account was made. */
    emailVerified?: boolean;
  }
): Promise<string> {
  const id = user.id ?? randomUUID();
  await withOwnerTx("tenant-lifecycle", (tx) =>
    tx.query(
      `insert into users (id, cognito_sub, email, display_name, role_id, tenant_id, created_at, deleted_at, email_verified)
       values ($1::uuid, $2, $3, $4, $5::uuid, $6::uuid, coalesce($7::timestamptz, now()), $8::timestamptz, $9)`,
      [
        id,
        user.cognitoSub === undefined ? `sub-${id}` : user.cognitoSub,
        user.email ?? null,
        user.displayName ?? null,
        user.roleId,
        tenant.id,
        user.createdAt ?? null,
        user.deletedAt ?? null,
        user.emailVerified ?? false,
      ]
    )
  );
  return id;
}

export interface TestCatalog {
  /** Role ids by label. */
  readonly roles: Record<string, string>;
  /** Role names by label. */
  readonly roleNames: Record<string, string>;
  /** Permission codes by label. */
  readonly codes: Record<string, string>;
  /** Permission ids by label. */
  readonly permissionIds: Record<string, string>;
  /** Entitlement group ids by label. */
  readonly groups: Record<string, string>;
  /** Entitlement group codes by label. */
  readonly groupCodes: Record<string, string>;
}

const catalogs: { run: string }[] = [];

/** The name a run gives a catalog row with `label`. Every row of the run starts with its prefix. */
export function catalogName(run: string, label: string): string {
  return `t${run}_${label}`;
}

/**
 * Create permissions, roles (with their permission labels) and entitlement groups for this run.
 * Removed by dropCatalog (call after dropTestTenants: users must not hold the roles).
 */
export async function createCatalog(
  run: string,
  spec: {
    permissions: readonly string[];
    roles: Record<string, readonly string[]>;
    groups?: Record<
      string,
      { readonly permissions: readonly string[]; active?: boolean }
    >;
  }
): Promise<TestCatalog> {
  catalogs.push({ run });
  const out: TestCatalog = {
    roles: {},
    roleNames: {},
    codes: {},
    permissionIds: {},
    groups: {},
    groupCodes: {},
  };
  await withOwnerTx("operator", async (tx) => {
    // A label that is not one of this run's permissions names a seeded permission by its code
    // (linked to, never changed).
    const permissionId = async (label: string): Promise<string> => {
      if (out.permissionIds[label]) return out.permissionIds[label];
      const { rows } = await tx.query<{ id: string }>(
        "select id from permissions where code = $1",
        [label]
      );
      if (!rows[0]) throw new Error(`No permission "${label}"`);
      return rows[0].id;
    };
    for (const label of spec.permissions) {
      const code = catalogName(run, label);
      const { rows } = await tx.query<{ id: string }>(
        "insert into permissions (code, display_name, category) values ($1, $1, 'test') returning id",
        [code]
      );
      out.codes[label] = code;
      out.permissionIds[label] = rows[0].id;
    }
    for (const [label, perms] of Object.entries(spec.roles)) {
      const name = catalogName(run, label);
      const { rows } = await tx.query<{ id: string }>(
        // The column's default place: after the seeded roles, as a new role (TASK-192).
        "insert into roles (name, display_name, description) values ($1, $1, $2) returning id",
        [name, `Test role ${label}`]
      );
      out.roles[label] = rows[0].id;
      out.roleNames[label] = name;
      for (const p of perms) {
        await tx.query(
          "insert into role_permissions (role_id, permission_id) values ($1::uuid, $2::uuid)",
          [rows[0].id, await permissionId(p)]
        );
      }
    }
    for (const [label, g] of Object.entries(spec.groups ?? {})) {
      const code = catalogName(run, label);
      const { rows } = await tx.query<{ id: string }>(
        "insert into entitlement_groups (code, display_name, is_active) values ($1, $1, $2) returning id",
        [code, g.active ?? false]
      );
      out.groups[label] = rows[0].id;
      out.groupCodes[label] = code;
      for (const p of g.permissions) {
        await tx.query(
          "insert into entitlement_permissions (entitlement_group_id, permission_id) values ($1::uuid, $2::uuid)",
          [rows[0].id, await permissionId(p)]
        );
      }
    }
  });
  return out;
}

/** Remove every catalog row this file's runs created (by name prefix), links first. */
export async function dropCatalog(): Promise<void> {
  for (const { run } of catalogs.splice(0)) {
    const prefix = `t${run}\\_%`;
    await withOwnerTx("operator", async (tx) => {
      await tx.query(
        `delete from entitlement_permissions where entitlement_group_id in
           (select id from entitlement_groups where code like $1)
           or permission_id in (select id from permissions where code like $1)`,
        [prefix]
      );
      await tx.query("delete from entitlement_groups where code like $1", [prefix]);
      await tx.query(
        `delete from role_permissions where role_id in (select id from roles where name like $1)
           or permission_id in (select id from permissions where code like $1)`,
        [prefix]
      );
      await tx.query("delete from roles where name like $1", [prefix]);
      await tx.query("delete from permissions where code like $1", [prefix]);
    });
  }
}

/** A short random run id: lower-case hex, safe in names and codes. */
export function newRun(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}
