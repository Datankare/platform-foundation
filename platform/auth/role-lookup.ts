/**
 * platform/auth/role-lookup.ts — Read a role with its permissions, and a user by exact id or email
 *
 * Used by every role-changing path before it applies the rules in role-governance.ts (TASK-145).
 * Each lookup runs in the caller's transaction (platform/data, ADR-053 D4), so the rules are
 * applied to what the change itself sees: a role's permissions in the transaction that changes
 * the role, a user in the tenant transaction that changes the user. Lookups are exact matches on
 * bound parameters — never SQL or a filter assembled from input.
 *
 * The role catalog is shared by every tenant and readable in any transaction; a user is found
 * only in the transaction's own tenant, under row-level security.
 *
 * @module platform/auth
 */

import type { Tx } from "@/platform/data";

export interface RoleWithPermissions {
  readonly id: string;
  readonly name: string;
  readonly permissions: readonly string[];
}

export interface UserRef {
  readonly id: string;
  readonly cognitoSub: string | null;
  readonly roleId: string | null;
}

/**
 * A role or user lookup could not be answered. Thrown, never turned into "no permissions": an
 * empty permission list passes the grant rule, so a read error must stop the change (release
 * review, Sprint 7X).
 */
export class LookupUnavailableError extends Error {
  constructor(what: string, detail: string) {
    super(`${what} could not be read: ${detail}`);
    this.name = "LookupUnavailableError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Run a lookup query; any error becomes LookupUnavailableError naming `what`. */
async function read<R extends Record<string, unknown>>(
  tx: Tx,
  what: string,
  text: string,
  values: readonly unknown[]
): Promise<R[]> {
  try {
    return (await tx.query<R>(text, values)).rows;
  } catch (err) {
    throw new LookupUnavailableError(
      what,
      err instanceof Error ? err.message : String(err)
    );
  }
}

/** The permission codes a role holds. */
async function permissionsOf(tx: Tx, roleId: string): Promise<string[]> {
  const rows = await read<{ code: string }>(
    tx,
    "role permissions",
    `select p.code from role_permissions rp
       join permissions p on p.id = rp.permission_id
      where rp.role_id = $1::uuid
      order by p.code`,
    [roleId]
  );
  return rows.map((r) => r.code);
}

/**
 * A role by id or by name, with its permission codes; null when it does not exist. With
 * `forUpdate` (owner transactions only: the request role cannot lock the catalog) the role row
 * stays locked until the transaction ends, so the rules checked against it still hold when the
 * change is written.
 */
export async function findRole(
  tx: Tx,
  by: { readonly id: string } | { readonly name: string },
  options: { readonly forUpdate?: boolean } = {}
): Promise<RoleWithPermissions | null> {
  let rows: { id: string; name: string }[];
  if ("id" in by) {
    // An id that is not a UUID names no role (the column is uuid; the cast would fail).
    if (!UUID.test(by.id)) return null;
    rows = await read(
      tx,
      "role",
      options.forUpdate
        ? "select id, name from roles where id = $1::uuid for update"
        : "select id, name from roles where id = $1::uuid",
      [by.id]
    );
  } else {
    rows = await read(
      tx,
      "role",
      options.forUpdate
        ? "select id, name from roles where name = $1 for update"
        : "select id, name from roles where name = $1",
      [by.name]
    );
  }
  const role = rows[0];
  if (!role) return null;
  return {
    id: role.id,
    name: role.name,
    permissions: await permissionsOf(tx, role.id),
  };
}

/**
 * A user of the transaction's tenant by exact id (UUID) or exact email; null when none matches.
 * With `forUpdate` the user row stays locked until the transaction ends.
 */
export async function findUser(
  tx: Tx,
  identifier: string,
  options: { readonly forUpdate?: boolean } = {}
): Promise<UserRef | null> {
  const byId = UUID.test(identifier);
  let text: string;
  if (byId) {
    text = options.forUpdate
      ? "select id, cognito_sub, role_id from users where id = $1::uuid and deleted_at is null for update"
      : "select id, cognito_sub, role_id from users where id = $1::uuid and deleted_at is null";
  } else {
    text = options.forUpdate
      ? "select id, cognito_sub, role_id from users where email = $1 and deleted_at is null limit 2 for update"
      : "select id, cognito_sub, role_id from users where email = $1 and deleted_at is null limit 2";
  }
  const rows = await read<{
    id: string;
    cognito_sub: string | null;
    role_id: string | null;
  }>(tx, "user", text, [identifier]);
  // An email two accounts share names neither: the change would go to a guessed user. The
  // single-row lookup this replaces failed in the same case.
  if (rows.length > 1) {
    throw new LookupUnavailableError("user", "more than one user has that email");
  }
  const user = rows[0];
  return user
    ? { id: user.id, cognitoSub: user.cognito_sub ?? null, roleId: user.role_id ?? null }
    : null;
}
