/**
 * platform/auth/role-lookup.ts — Read a role with its permissions, and a user by exact id or email
 *
 * Used by every role-changing path before it applies the rules in role-governance.ts (TASK-145).
 * Lookups are exact matches through bound filters — never a filter string assembled from input.
 *
 * @module platform/auth
 */

import type { SupabaseClient } from "@supabase/supabase-js";

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

/** The permission codes a role holds. */
async function permissionsOf(
  supabase: SupabaseClient,
  roleId: string
): Promise<string[]> {
  const { data: links, error } = await supabase
    .from("role_permissions")
    .select("permission_id")
    .eq("role_id", roleId);
  if (error) throw new LookupUnavailableError("role permissions", error.message);
  const ids = (links ?? []).map((l: { permission_id: string }) => l.permission_id);
  if (ids.length === 0) return [];
  const { data: perms, error: permError } = await supabase
    .from("permissions")
    .select("code")
    .in("id", ids);
  if (permError) throw new LookupUnavailableError("permissions", permError.message);
  return (perms ?? []).map((p: { code: string }) => p.code);
}

/** A role by id or by name, with its permission codes; null when it does not exist. */
export async function findRole(
  supabase: SupabaseClient,
  by: { readonly id: string } | { readonly name: string }
): Promise<RoleWithPermissions | null> {
  const query = supabase.from("roles").select("id, name");
  const { data: role, error } = await (
    "id" in by ? query.eq("id", by.id) : query.eq("name", by.name)
  ).maybeSingle();
  if (error) throw new LookupUnavailableError("role", error.message);
  if (!role) return null;
  return {
    id: role.id,
    name: role.name,
    permissions: await permissionsOf(supabase, role.id),
  };
}

/** A user by exact id (UUID) or exact email; null when none matches. */
export async function findUser(
  supabase: SupabaseClient,
  identifier: string
): Promise<UserRef | null> {
  const column = UUID.test(identifier) ? "id" : "email";
  const { data: user, error } = await supabase
    .from("users")
    .select("id, cognito_sub, role_id")
    .eq(column, identifier)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new LookupUnavailableError("user", error.message);
  return user
    ? { id: user.id, cognitoSub: user.cognito_sub ?? null, roleId: user.role_id ?? null }
    : null;
}
