/**
 * platform/auth/account-identity.ts — Which account a verified identity names (ADR-012
 * amendment, TASK-174)
 *
 * An account (`users.id`) and the identity that signs in to it (`users.cognito_sub`, the
 * provider's subject) are two things. Provisioning makes them equal (`id = cognito_sub = sub`),
 * so for most accounts the subject is the id — but not always: when a deployment moves to a new
 * identity pool, every identity gets a new subject, and the operator command
 * (scripts/relink-identity.mjs, platform/auth/identity-relink.ts) re-links each existing account
 * to its new subject without changing its id — the id every foreign key, audit record,
 * trajectory, proposal and erasure record names.
 *
 * So the subject is never used as the account id. The binding is `users.cognito_sub`, read here:
 *
 *   - `bound`          a row of this tenant has this subject: its id is the account;
 *   - `unprovisioned`  no row has it, and no account holds the id a first request would create
 *                      (the subject itself): the account is created on first use with that id;
 *   - `conflict`       no row has the subject, but its id is held by an account bound to another
 *                      subject — never this identity's account (refused, never served).
 *
 * A row with the subject's id and no subject at all (a legacy row) is that account. Row-level
 * security limits the read to the request's tenant; an identity is bound to its tenant before
 * this is asked (platform/tenancy/request.ts).
 *
 * GenAI Principles: P11 (fail-closed — an unreadable binding is an error, never an account)
 *
 * @module platform/auth
 */

import { hasDatabase, withTenantTx } from "@/platform/data";
import { auditableUserId } from "@/platform/auth/auth-events";
import { logger } from "@/lib/logger";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AccountResolution =
  | { readonly kind: "bound"; readonly accountId: string }
  | { readonly kind: "unprovisioned"; readonly accountId: string }
  | { readonly kind: "conflict" };

/** What a set of rows (each with its id and subject) says about `subject`. */
export function bindingOf(
  subject: string,
  rows: readonly { readonly id: string; readonly cognito_sub: string | null }[]
): AccountResolution {
  const bound = rows.find((r) => r.cognito_sub === subject);
  if (bound) return { kind: "bound", accountId: bound.id };
  const sameId = UUID.test(subject)
    ? rows.find((r) => r.id.toLowerCase() === subject.toLowerCase())
    : undefined;
  if (!sameId) return { kind: "unprovisioned", accountId: subject };
  return sameId.cognito_sub === null
    ? { kind: "bound", accountId: sameId.id }
    : { kind: "conflict" };
}

/**
 * What the account row bound to an identity says about its address (users.email,
 * users.email_verified) — read in the same statement as the binding, so keeping the flag in step
 * with the identity provider costs no read of its own (platform/auth/email-verification.ts).
 */
export interface StoredAddress {
  readonly email: string | null;
  readonly verified: boolean;
  /**
   * The account's status (users.account_status), read in the same statement: a banned
   * account's address is never moved (TASK-185 — the ban follows the address). Absent: unknown,
   * and treated as not active.
   */
  readonly status?: string;
  /**
   * The account is erased and awaiting its purge (users.deleted_at): nothing is written to it
   * (TASK-185 — every request would otherwise try a write that matches nothing).
   */
  readonly deleted?: boolean;
}

/** The binding, and — for a bound account — its stored address. */
export interface AccountRecord {
  readonly resolution: AccountResolution;
  /** Only when `resolution.kind` is "bound". */
  readonly address?: StoredAddress;
}

/**
 * The account `subject` (a verified identity's subject) names in the current tenant, with its
 * stored address when it is bound. Throws when the binding cannot be read. Without a database
 * (local, CI on the mock provider) there are no rows: the subject is the account.
 */
export async function resolveAccountRecord(subject: string): Promise<AccountRecord> {
  if (!hasDatabase())
    return { resolution: { kind: "unprovisioned", accountId: subject } };
  const { rows } = await withTenantTx((tx) =>
    tx.query<{
      id: string;
      cognito_sub: string | null;
      email: string | null;
      email_verified: boolean | null;
      account_status: string | null;
      deleted: boolean | null;
    }>(
      "select id, cognito_sub, email, email_verified, account_status, deleted_at is not null as deleted from users where cognito_sub = $1 or id = $2::uuid",
      [subject, UUID.test(subject) ? subject : null]
    )
  );
  const resolution = bindingOf(subject, rows);
  if (resolution.kind !== "bound") return { resolution };
  const row = rows.find((r) => r.id === resolution.accountId)!;
  return {
    resolution,
    address: {
      email: row.email,
      verified: row.email_verified === true,
      ...(row.account_status ? { status: row.account_status } : {}),
      ...(row.deleted ? { deleted: true } : {}),
    },
  };
}

/**
 * The account `subject` (a verified identity's subject) names in the current tenant. Throws when
 * the binding cannot be read. Without a database (local, CI on the mock provider) there are no
 * rows: the subject is the account.
 */
export async function resolveAccount(subject: string): Promise<AccountResolution> {
  return (await resolveAccountRecord(subject)).resolution;
}

/**
 * The account id to record an authentication event under: the account `subject` names, or the
 * subject itself when it names none yet (a first sign-in) or the binding cannot be read — the
 * event is recorded either way (never lost to a lookup), and only an id is ever recorded.
 *
 * A conflict records no actor (review 15 L3): the subject's id is then another identity's
 * account (typically an account re-linked to a new pool, whose old subject this is), and an
 * event recorded under it would be attributed to the account it no longer names. The event is
 * still recorded, without an actor.
 */
export async function auditableAccountId(subject: unknown): Promise<string | undefined> {
  const id = auditableUserId(subject);
  if (!id) return undefined;
  try {
    const resolved = await resolveAccount(id);
    return resolved.kind === "conflict" ? undefined : resolved.accountId;
  } catch (err) {
    logger.warn("Account for an authentication event not resolved; recorded by subject", {
      route: "platform/auth/account-identity",
      error: err instanceof Error ? err.message : String(err),
    });
    return id;
  }
}
