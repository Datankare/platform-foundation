/**
 * platform/auth/user-provisioning.ts — Create the platform's user row on first use (TASK-117)
 *
 * Sign-up creates the identity in the auth provider (Cognito) only. Every platform check that
 * follows — account status, COPPA, permissions, data export, RLS — reads the user's row in
 * `users`, keyed by the provider's subject (`id = cognito_sub = sub`). Nothing created that row,
 * so on a new database every new account was refused (the guard read no row as a DB error and
 * failed closed as "banned").
 *
 * ensureUserProvisioned() creates the row the first time an authenticated user reaches a
 * guarded route: default role (DEFAULT_USER_ROLE), defaults for everything else, an
 * `account_created` audit entry, written before the row (no entry, no row: `failed`). It is
 * idempotent and race-safe on the identity, and it never changes an existing row (a banned user
 * stays banned): see "Concurrent first requests" below.
 *
 * Concurrent first requests (PF v6.0.x — found adopting PF in Playform): the row has two unique
 * keys on the identity, its id (players_pkey) and its cognito_sub (players_cognito_sub_key; and
 * (tenant_id, id)). The insert used to say `on conflict (id) do nothing`, which arbitrates only
 * the id: of two or three first requests at once, one could pass the id check before the
 * winner's row was in the index, then wait on the winner at the cognito_sub key and fail with a
 * unique violation there (about 2 in 900 concurrent attempts) — `failed`, so the request was
 * refused as account.not_provisioned. The insert now says `on conflict do nothing` with no
 * target, which arbitrates every unique key of the row atomically: Postgres waits for a
 * concurrent writer of the same id or subject to finish and then inserts nothing — never a
 * unique violation. Then, in the same transaction, a second statement (a fresh read-committed
 * snapshot, so the winner's committed row is visible) reads which row holds the identity:
 *
 *   - a row of this tenant with this id  → `existing` (the concurrent request created it);
 *   - a row of this tenant whose cognito_sub is this subject but whose id is not → `failed`
 *     (another account holds the subject — reported, never treated as this user's row);
 *   - no row visible → `failed` (the id or subject is held in another tenant: row-level
 *     security hides it, and it is never this tenant's account).
 *
 * No retry: no unique violation on the identity can reach the caller, so there is nothing to
 * retry (Playform's interim copy retried one 23505 on the cognito_sub key — consumers drop it).
 *
 * The row is written in the request's tenant (platform/data, ADR-053 D4): users.tenant_id is
 * filled by the column default and row-level security limits the read to that tenant.
 *
 * Ban evasion (audit A-11): an account that was erased is never provisioned again (its
 * user_deletions record outlives it — `erased`), and a new identity whose email belongs to a
 * banned account of the tenant — a live one, or one erased while banned (kept only as a hash of
 * the address) — starts banned, not clean.
 *
 * GenAI Principles: P11 (fail-closed — a provisioning failure is reported, never treated as
 * allowed), P13 (governance — the default role is a seeded role, not code-defined permissions)
 *
 * @module platform/auth
 */

import { createHash, createHmac } from "node:crypto";
import {
  TEST_DOUBLE_AUTH_PROVIDERS,
  getAuthProviderSetting,
  getErasureHashKey,
  getPreviousErasureHashKey,
  isProductionContext,
} from "@/platform/providers/environment-contract";
import { hasDatabase, withTenantTx } from "@/platform/data";
import { logger } from "@/lib/logger";
import { AuditWriteError, audited } from "@/platform/auth/audit";

/** The role every new account starts with (seeded by the schema baseline). */
export const DEFAULT_USER_ROLE = "free";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the caller knows about the user from their verified token, if anything. */
export interface ProvisioningProfile {
  readonly email?: string;
  readonly emailVerified?: boolean;
}

/**
 * - `existing`  — the row was already there (nothing changed);
 * - `created`   — this call created it;
 * - `skipped`   — no database is configured (mock/CI), so there is nothing to provision;
 * - `erased`    — this identity's account was erased (GDPR): it is not created again;
 * - `failed`    — the row could not be read or created; the caller must not allow the request.
 */
export type ProvisioningOutcome =
  "existing" | "created" | "skipped" | "erased" | "failed";

/**
 * Without ERASURE_HASH_KEY outside a deployment (local, tests, a CI harness on the mock auth
 * provider): a fixed key, so runs agree across processes. Never used by a deployment: the
 * environment contract requires the key with a real auth provider, and emailHash refuses there
 * without it.
 */
const DEVELOPMENT_KEY =
  "platform-foundation development erasure-hash key (not for production)";

/** The address as it is hashed: trimmed, lower-case. */
const normalised = (email: string): string => email.trim().toLowerCase();

/**
 * How a kept hash was made (user_deletions.email_hash_scheme, review 9 M6). Recorded, never
 * guessed: a hash of one scheme read as another and "upgraded" becomes a value that matches
 * nothing — the ban it carried is lost.
 *
 *   hmac-of-sha256  HMAC-SHA256 under the key (its id beside it) of the address's SHA-256 — what
 *                   this build writes (review 8 L6);
 *   sha256          the address's unkeyed SHA-256 (a pre-release Wave 2 build): upgradeable
 *                   without the address;
 *   hmac            HMAC-SHA256 under the key of the address itself (the pre-release review 7
 *                   build, no key id): not upgradeable without the address — rehashed when the
 *                   address next signs up.
 *
 * No environment ran either pre-release build (PF v5.1.1 and Playform v0.8.0 are the deployed
 * versions; Playform v0.9.0 was never deployed — docs/MIGRATION_v5_to_v6.md step 2.6), so no
 * row of the last two kinds is expected; migration 052 marks only rows it can identify (a key id
 * means hmac-of-sha256) and leaves any other unmarked — never upgraded, still matched.
 */
export type ErasureHashScheme = "hmac-of-sha256" | "sha256" | "hmac";

/** An erased banned address as kept: the hash, the id of the key that made it, and how. */
export interface ErasureHash {
  readonly hash: string;
  /** The key's id (16 hex), or null for a form an earlier build wrote without one. */
  readonly keyId: string | null;
  readonly scheme: ErasureHashScheme;
}

/** A key's id: derived from it (never the key), so rows say which key of the ring made them. */
export function erasureKeyId(key: string): string {
  return createHmac("sha256", key)
    .update("erasure-hash key id")
    .digest("hex")
    .slice(0, 16);
}

/** The legacy, unkeyed form: SHA-256 of the address, hex. */
const sha256Hex = (email: string): string =>
  createHash("sha256").update(normalised(email)).digest("hex");

/** HMAC-SHA256 under `key` of the address's SHA-256 (hex): so a legacy row can be upgraded. */
const keyed = (key: string, digestHex: string): string =>
  createHmac("sha256", key).update(digestHex).digest("hex");

/** The pre-release review 7 form: HMAC-SHA256 under `key` of the address itself. */
const keyedAddress = (key: string, email: string): string =>
  createHmac("sha256", key).update(normalised(email)).digest("hex");

/** The current key (ERASURE_HASH_KEY), or the development key outside a deployment. */
function currentKey(): string {
  const key = getErasureHashKey();
  // Required where the environment contract requires it: production with a real auth provider
  // (a production-build harness on the mock provider may run without it).
  if (
    !key &&
    isProductionContext() &&
    !TEST_DOUBLE_AUTH_PROVIDERS.has(getAuthProviderSetting() ?? "mock")
  ) {
    throw new Error("ERASURE_HASH_KEY is not set — refusing to hash an erased address");
  }
  return key ?? DEVELOPMENT_KEY;
}

/**
 * How an address is kept after its account is erased while banned: HMAC-SHA256, under the
 * server's ERASURE_HASH_KEY, of the address's SHA-256 — hex, never the address (audit A-11;
 * keyed, review 7 L4: an unsalted hash of an address is reversed by hashing a list of addresses,
 * the HMAC cannot be without the key). With the key's id (review 8 L6), so the key can rotate:
 * ERASURE_HASH_KEY_PREVIOUS still matches what the previous key made, and a match is rehashed
 * under the current key.
 */
export function emailHash(email: string): ErasureHash {
  const key = currentKey();
  return {
    hash: keyed(key, sha256Hex(email)),
    keyId: erasureKeyId(key),
    scheme: "hmac-of-sha256",
  };
}

/**
 * Every form the address may be kept in: the current key's, the previous key's (when
 * ERASURE_HASH_KEY_PREVIOUS is set), and the forms pre-release builds wrote — the unkeyed SHA-256
 * and the review 7 HMAC of the address under either key — so a ban follows the address whichever
 * made it. A match is positive identification (the address is known then), and is rehashed under
 * the current key. Only the first is ever written.
 */
export function erasureHashCandidates(email: string): readonly ErasureHash[] {
  const digest = sha256Hex(email);
  const current = currentKey();
  const previous = getPreviousErasureHashKey();
  const hasPrevious = Boolean(previous && previous !== current);
  return [
    {
      hash: keyed(current, digest),
      keyId: erasureKeyId(current),
      scheme: "hmac-of-sha256",
    },
    ...(hasPrevious
      ? [
          {
            hash: keyed(previous!, digest),
            keyId: erasureKeyId(previous!),
            scheme: "hmac-of-sha256" as const,
          },
        ]
      : []),
    { hash: digest, keyId: null, scheme: "sha256" },
    { hash: keyedAddress(current, email), keyId: null, scheme: "hmac" },
    ...(hasPrevious
      ? [{ hash: keyedAddress(previous!, email), keyId: null, scheme: "hmac" as const }]
      : []),
  ];
}

/**
 * The unkeyed SHA-256 form (which a list of addresses reverses) upgraded without the address:
 * the current key's HMAC of it — exactly what emailHash makes for the same address. Only for a
 * hash recorded as scheme "sha256" (review 9 M6): any other value fed in gives garbage.
 */
export function upgradeLegacyHash(legacyHex: string): ErasureHash {
  const key = currentKey();
  return {
    hash: keyed(key, legacyHex),
    keyId: erasureKeyId(key),
    scheme: "hmac-of-sha256",
  };
}

/**
 * Upgrade the current tenant's unkeyed rows (review 8 L6): every user_deletions hash recorded as
 * the unkeyed SHA-256 (email_hash_scheme = 'sha256') becomes the current key's, at most `limit`
 * per call. Only rows positively recorded as that scheme (review 9 M6): a row with no recorded
 * scheme is never upgraded — read as SHA-256 when it was the review 7 HMAC of the address, it
 * would become a hash that matches nothing. Run by the GDPR retention job (gdpr.retention-purge)
 * before it purges; idempotent. Rows of the previous key, or of the review 7 form, cannot be
 * upgraded without the address — each is rehashed when the address next signs up (the ban check).
 */
export async function upgradeLegacyErasureHashes(limit = 500): Promise<number> {
  return withTenantTx(async (tx) => {
    const { rows } = await tx.query<{ user_id: string; email_hash: string }>(
      `select user_id, email_hash from user_deletions
        where email_hash is not null and email_hash_scheme = 'sha256'
        order by user_id limit $1::int`,
      [limit]
    );
    for (const row of rows) {
      const upgraded = upgradeLegacyHash(row.email_hash);
      await tx.query(
        `update user_deletions set email_hash = $2, email_hash_key = $3, email_hash_scheme = $4
          where user_id = $1::uuid and email_hash_scheme = 'sha256'`,
        [row.user_id, upgraded.hash, upgraded.keyId, upgraded.scheme]
      );
    }
    return rows.length;
  });
}

function fail(userId: string, step: string, error: unknown): ProvisioningOutcome {
  logger.error("User provisioning failed", {
    userId,
    step,
    error: error instanceof Error ? error.message : String(error),
    route: "platform/auth/user-provisioning",
  });
  return "failed";
}

export async function ensureUserProvisioned(
  userId: string,
  profile: ProvisioningProfile = {}
): Promise<ProvisioningOutcome> {
  if (!hasDatabase()) return "skipped";
  if (!UUID_PATTERN.test(userId))
    return fail(userId, "validate", "not a provider subject");

  try {
    let roleId: string;
    try {
      const found = await withTenantTx(async (tx) => {
        const existing = await tx.query("select id from users where id = $1::uuid", [
          userId,
        ]);
        if (existing.rows.length > 0) return { existing: true as const };
        // An erased account stays erased: its identity does not get a fresh, clean row.
        const erased = await tx.query(
          "select 1 from user_deletions where user_id = $1::uuid",
          [userId]
        );
        if (erased.rows.length > 0) return { existing: false as const, erased: true };
        // The role catalog is platform-owned and readable from any tenant.
        const role = await tx.query<{ id: string }>(
          "select id from roles where name = $1",
          [DEFAULT_USER_ROLE]
        );
        return { existing: false as const, roleId: role.rows[0]?.id };
      });
      if (found.existing) return "existing";
      if ("erased" in found) return "erased";
      if (!found.roleId)
        return fail(userId, "role", `default role "${DEFAULT_USER_ROLE}" is missing`);
      roleId = found.roleId;
    } catch (err) {
      return fail(userId, "read", err);
    }

    const email = profile.email?.trim() ? profile.email.trim().toLowerCase() : null;
    // A ban follows the address to a new identity (A-11): another account of this tenant with
    // it is banned, or one erased while banned left its hash.
    let carriedBan = false;
    if (email) {
      try {
        const candidates = erasureHashCandidates(email);
        const [current] = candidates;
        carriedBan = await withTenantTx(async (tx) => {
          const { rows } = await tx.query(
            `select 1 from users
              where email = $1 and account_status = 'banned' and id <> $2::uuid
             limit 1`,
            [email, userId]
          );
          if (rows.length > 0) return true;
          const erased = await tx.query<{
            user_id: string;
            hash: string;
            key: string | null;
          }>(
            `select user_id, email_hash as hash, email_hash_key as key from user_deletions
              where email_hash = any($1::text[]) and standing = 'banned'`,
            [candidates.map((c) => c.hash)]
          );
          // Rehashed on a match (review 8 L6): a row the previous key or an earlier form made
          // is rewritten under the current key — from the address, known now, so the match is
          // the identification (review 9 M6) — and the previous key can be retired.
          for (const row of erased.rows)
            if (row.hash !== current.hash || row.key !== current.keyId)
              await tx.query(
                "update user_deletions set email_hash = $2, email_hash_key = $3, email_hash_scheme = $4 where user_id = $1::uuid",
                [row.user_id, current.hash, current.keyId, current.scheme]
              );
          return erased.rows.length > 0;
        });
      } catch (err) {
        return fail(userId, "ban-check", err);
      }
    }
    // Recorded before the account is created; no record, no account (Adversarial Validation, 6).
    // Two concurrent first requests each record an attempt; only one creates the row.
    let inserted: { created: boolean; error?: string };
    try {
      inserted = await audited(
        {
          action: "account_created",
          actorId: userId,
          targetId: userId,
          details: {
            role: DEFAULT_USER_ROLE,
            via: "first_authenticated_request",
            ...(carriedBan ? { banCarriedOver: true } : {}),
          },
        },
        async () => {
          try {
            return await withTenantTx(async (tx) => {
              // No conflict target: every unique key of the row (its id, its cognito_sub,
              // (tenant_id, id)) is an arbiter, so a concurrent first request that holds either
              // makes this insert nothing — never a unique violation (see the header).
              const { rows } = await tx.query(
                `insert into users (id, cognito_sub, email, email_verified, role_id,
                                    account_status, banned_at, ban_reason, status_changed_by,
                                    status_changed_at)
                 select $1::uuid, $2, $3, $4, $5::uuid,
                        case when $6 then 'banned' else 'active' end::account_status,
                        case when $6 then now() end,
                        case when $6 then 'A ban on this address carried over to a new account.' end,
                        case when $6 then 'platform:ban-carry-over' end,
                        case when $6 then now() end
                 on conflict do nothing
                 returning id`,
                [
                  userId,
                  userId,
                  email,
                  profile.emailVerified === true,
                  roleId,
                  carriedBan,
                ]
              );
              if (rows.length > 0) return { created: true };
              // Nothing inserted: which row holds the identity? A new statement, so a new
              // snapshot — the concurrent winner (the insert waited for it) is visible.
              const held = await tx.query<{ id: string }>(
                "select id from users where id = $1::uuid or cognito_sub = $2",
                [userId, userId]
              );
              if (held.rows.some((r) => r.id === userId)) return { created: false };
              return {
                created: false,
                error:
                  held.rows.length > 0
                    ? "the subject is held by another account of this tenant"
                    : "the identity is held outside this tenant",
              };
            });
          } catch (err) {
            return {
              created: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
      );
    } catch (err) {
      if (err instanceof AuditWriteError) return fail(userId, "audit", err);
      throw err;
    }
    if (inserted.error !== undefined) return fail(userId, "insert", inserted.error);

    // Nothing inserted, and the row with this id is this tenant's: another request created it
    // between the read and the insert.
    if (!inserted.created) return "existing";

    logger.info("User provisioned", {
      userId,
      role: DEFAULT_USER_ROLE,
      route: "platform/auth/user-provisioning",
    });
    return "created";
  } catch (err) {
    return fail(userId, "exception", err);
  }
}
