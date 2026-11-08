/**
 * platform/admin/account-names.ts — the accounts a screen names, by address (TASK-202, N-63)
 *
 * The admin console named people by their raw id: "User c408… assigned", an audit row's actor, a
 * hold's requester. A person reads an address, not an id. Each screen that names an account gets
 * it from here, resolved on the server in the tenant's own transaction (row-level security: an
 * account of another tenant is never found, so never named), and shows the address — the id only
 * as a secondary detail.
 *
 * What is returned per account: its address (null once erased: an erasure anonymises it), its
 * role's display name, and whether it was erased. Nothing else of the account leaves here.
 *
 * Read-only, one statement for every id asked; ids are bound parameters. An id that is not an
 * account — an agent's id, a deleted row, a malformed value — is simply not in the answer, and
 * the screen says what it is instead. A read that fails answers an empty map: the screens then
 * name no one, rather than failing the whole read they belong to (each says "unknown").
 *
 * @module platform/admin
 */

import { withTenantTx } from "@/platform/data";
import { logger } from "@/lib/logger";
import { sameId } from "@/platform/auth/same-id";

/** An account as a screen names it. */
export interface NamedAccount {
  readonly id: string;
  /** The account's address; null when it has none (erased, or never set). */
  readonly email: string | null;
  /** Its role's display name (else its name); null when it has none. */
  readonly role: string | null;
  /** True when the account was erased (soft-deleted, its address removed). */
  readonly erased: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The most ids one read resolves: a screen's page, never an unbounded list. */
export const MAX_NAMED_ACCOUNTS = 500;

interface Row extends Record<string, unknown> {
  id: string;
  sub: string | null;
  email: string | null;
  role: string | null;
  erased: boolean;
}

/**
 * The accounts these ids name in the current tenant, keyed by every spelling asked — an account
 * id (any case) or an identity-provider subject (a hold recorded before Sprint 7X names its
 * requester by subject). Ids that name no account are absent.
 */
export async function namedAccounts(
  ids: readonly (string | null | undefined)[]
): Promise<ReadonlyMap<string, NamedAccount>> {
  const asked = [
    ...new Set(
      ids.filter(
        (x): x is string => typeof x === "string" && x.length > 0 && x.length <= 128
      )
    ),
  ].slice(0, MAX_NAMED_ACCOUNTS);
  if (asked.length === 0) return new Map();
  const uuids = asked.filter((x) => UUID.test(x)).map((x) => x.toLowerCase());
  let rows: Row[];
  try {
    rows = (
      await withTenantTx((tx) =>
        tx.query<Row>(
          `select u.id::text as id, u.cognito_sub as sub, u.email,
                  coalesce(r.display_name, r.name) as role,
                  (u.deleted_at is not null) as erased
             from users u
             left join roles r on r.id = u.role_id
            where u.id = any($1::uuid[]) or u.cognito_sub = any($2::text[])`,
          [uuids, asked]
        )
      )
    ).rows;
  } catch (err) {
    logger.warn("Account names could not be read", {
      error: err instanceof Error ? err.message : String(err),
      route: "platform/admin/account-names",
    });
    return new Map();
  }
  const out = new Map<string, NamedAccount>();
  for (const r of rows) {
    const named: NamedAccount = {
      id: r.id,
      email: r.erased ? null : (r.email ?? null),
      role: r.role ?? null,
      erased: r.erased === true,
    };
    for (const key of asked) {
      if (sameId(key, r.id) || sameId(key, r.sub)) out.set(key, named);
    }
  }
  return out;
}

/** The account `id` names, as a screen shows it — or undefined when it names none. */
export function accountOf(
  accounts: ReadonlyMap<string, NamedAccount>,
  id: string | null | undefined
): NamedAccount | undefined {
  return typeof id === "string" ? accounts.get(id) : undefined;
}
