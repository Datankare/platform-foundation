/**
 * platform/auth/gdpr-deletion.ts — GDPR deletion manifest
 *
 * Implements the right to erasure (GDPR Article 17) using a
 * deletion manifest pattern. Each module registers what data
 * it holds for a user, and the manifest coordinates deletion
 * across all registered modules.
 *
 * Two-phase approach:
 * 1. Soft delete — mark user as deleted_at, anonymize PII
 * 2. Hard purge — removes all data after the retention period (purgeDueErasures, run for every
 *    active tenant by the gdpr.retention-purge job, platform/jobs/duties.ts)
 *
 * The user row is anonymized and removed in the request's tenant (platform/data, ADR-053 D4).
 *
 * Each erasure is recorded in user_deletions (migration 049): when the account was anonymized,
 * when it may be purged (30 days), which modules took part, and when it was purged. The record
 * outlives the account. (It used to be written to deletion_manifest — the platform's registry of
 * deletion modules, with no per-user columns — so it never was.)
 *
 * Sprint 5, Tasks 5.1 + 5.2
 */

import { withOwnerTx, withTenantTx } from "@/platform/data";
import { AuditWriteError, audited } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";
import { emailHash } from "@/platform/auth/user-provisioning";
import { invalidatePermissions } from "@/platform/auth/permissions-cache";
import {
  CROSS_TENANT_ERASURE,
  CROSS_TENANT_ERASURE_PAGES,
  eraseUserData,
  type ErasureStep,
} from "@/platform/auth/user-data";
import { raiseAlert } from "@/platform/observability/alert";
import {
  EXTERNAL_ERASURE_ALERT_ATTEMPTS,
  provenIdentityPool,
  listExternalErasures,
  pendingExternalErasures,
  runExternalErasures,
  type RecordedExternalErasure,
} from "@/platform/gdpr/external-erasure";

export interface DeletionModule {
  moduleName: string;
  description: string;
  tables: string[];
  /** Soft delete: anonymize PII, set deleted_at */
  softDelete: (userId: string) => Promise<{ success: boolean; error?: string }>;
  /** Hard purge: permanently remove all data */
  hardPurge: (userId: string) => Promise<{ success: boolean; error?: string }>;
}

const registeredModules: DeletionModule[] = [];

/**
 * Where an account's address can stand for the account, replaced by its id at the soft delete:
 * only whole JSON strings equal to the address ($1, ignoring case) — values and object keys —
 * become the id ($2) (public.jsonb_replace_text_value, migration 052; review 9 L7 added keys).
 * An address inside a longer text — a note quoting it — is free text, another person's writing,
 * and stays; a near miss (joann@ for ann@, a plus or sub-domain variant) is another address and
 * stays. The function is non-recursive and cannot fail on any document (review 9 H2), so one
 * row's document can never block another account's erasure; jsonb_may_mention_text is its cheap,
 * sound pre-filter (false only where nothing can be replaced).
 */
export const ADDRESS_REPLACEMENTS: readonly string[] = [
  "update proposals set payload = jsonb_replace_text_value(payload, $1::text, $2::text), effects = jsonb_replace_text_value(effects, $1::text, $2::text) where jsonb_may_mention_text(payload, $1::text) or jsonb_may_mention_text(effects, $1::text)",
  "update agent_trajectories set steps = jsonb_replace_text_value(steps, $1::text, $2::text) where jsonb_may_mention_text(steps, $1::text)",
  "update audit_log set details = jsonb_replace_text_value(details, $1::text, $2::text) where jsonb_may_mention_text(details, $1::text)",
  "update review_queue set moderation_result = jsonb_replace_text_value(moderation_result, $1::text, $2::text), explanation_chain = jsonb_replace_text_value(explanation_chain, $1::text, $2::text) where jsonb_may_mention_text(moderation_result, $1::text) or jsonb_may_mention_text(explanation_chain, $1::text)",
  "update app_sessions set state = jsonb_replace_text_value(state, $1::text, $2::text) where jsonb_may_mention_text(state, $1::text)",
];

/** Run a write; its error message, or undefined when it succeeded. */
async function failure(write: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await write();
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * A module's step; one that throws has failed (it never stops the others or the record).
 *
 * @external A registered module's erasure hook may reach outside the database (an identity
 * provider, a file store): an audited act that runs one passes `{ external: true }` (review 13 L5;
 * __tests__/audited-external-guard.test.ts reads this tag).
 */
async function runModule(
  step: () => Promise<{ success: boolean; error?: string }>
): Promise<{ success: boolean; error?: string }> {
  try {
    return await step();
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Register a module's deletion handler.
 * Called at startup by each module that stores user data.
 */
export function registerDeletionModule(module: DeletionModule): void {
  const existing = registeredModules.find((m) => m.moduleName === module.moduleName);
  if (existing) {
    logger.warn("Deletion module already registered, replacing", {
      moduleName: module.moduleName,
      route: "platform/auth/gdpr-deletion",
    });
    const idx = registeredModules.indexOf(existing);
    registeredModules[idx] = module;
    return;
  }
  registeredModules.push(module);
}

/**
 * Get all registered deletion modules.
 */
export function getDeletionModules(): DeletionModule[] {
  return [...registeredModules];
}

/** Days from the soft delete to the purge (the retention period). */
export const ERASURE_RETENTION_DAYS = 30;

/** How the soft delete is asked for. */
export interface SoftDeleteOptions {
  /**
   * The system asks (a job), not a person: `requestedBy` is the agent's name, recorded as the
   * audit record's agent (a person's request names their users.id, the actor).
   */
  readonly system?: boolean;
  /** Days until the purge (default ERASURE_RETENTION_DAYS); 0 purges at the next run. */
  readonly purgeAfterDays?: number;
  /** Why, for the audit record (e.g. "parental_consent_expired"). */
  readonly trigger?: string;
}

/** What the soft delete did; `external`: the stores outside the database still to be erased. */
export interface SoftDeleteResult {
  readonly success: boolean;
  readonly errors: string[];
  /** The external stores (platform/gdpr/external-erasure.ts) not yet erased; retried by the job. */
  readonly externalPending?: readonly string[];
}

/**
 * The users columns the soft delete clears, with what they become (TASK-193, audit A-16: the
 * parent's address, the ban reason, the time zone and language stayed until the purge, and went
 * out in any tenant export meanwhile). __tests__/db/erasure-reconciliation.db.test.ts requires
 * every column of users that can hold personal data to be here or in SOFT_DELETE_KEPT.
 */
export const SOFT_DELETE_CLEARED: readonly string[] = [
  "email",
  "display_name",
  "real_name",
  "avatar_url",
  "date_of_birth",
  "parental_consent_email",
  "ban_reason",
  "timezone",
  "language_preference",
  "last_login_at",
];

/** The users columns the soft delete keeps until the purge, with why. */
export const SOFT_DELETE_KEPT: Readonly<Record<string, string>> = {
  id: "the account's key, which the erasure record and every mention use",
  cognito_sub:
    "the closed identity: an erased account's identity is refused at sign-in until the purge (it is also on the erasure record)",
  tenant_id: "the account's tenant",
  role_id: "a reference to the role catalog",
  account_status: "the account's standing, which a ban keeps (A-11; also on the record)",
  status_changed_by:
    "the staff member's id on a standing change (their record, not this account's)",
};

/**
 * Phase 1: Soft delete a user — recorded, anonymised, and the erasure scheduled, as ONE
 * transaction (TASK-193, audit B-6/D-10: the record was written in a later transaction, after the
 * modules ran, so a failure in between left an account marked deleted — refused at sign-in, so
 * the user could not retry — that no purge would ever select; a banned address's hash, written
 * from the address the first attempt had already cleared, was lost on any retry). Then the app's
 * modules' soft deletes, and the stores outside the database (the sign-in identity first),
 * whose outcomes are recorded on the erasure and retried by the job until done.
 *
 * reconcileErasures (the gdpr.retention-purge job) records any account marked deleted without an
 * erasure record — one left by the code before this change — so every erasure completes.
 */
export async function softDeleteUser(
  userId: string,
  requestedBy: string,
  options: SoftDeleteOptions = {}
): Promise<SoftDeleteResult> {
  const purgeAfterDays = Math.max(0, options.purgeAfterDays ?? ERASURE_RETENTION_DAYS);
  try {
    // Recorded before anything is deleted; no record, no deletion (Adversarial Validation, 6).
    // A partial deletion reports failure, which audited() records as a follow-up.
    return await audited(
      {
        action: "account_deleted",
        ...(options.system ? { agent: requestedBy } : { actorId: requestedBy }),
        targetId: userId,
        details: {
          phase: "soft_delete",
          moduleCount: registeredModules.length,
          ...(options.trigger ? { trigger: options.trigger } : {}),
        },
      },
      async (): Promise<SoftDeleteResult> => {
        const errors: string[] = [];

        // 1. Anonymise the user record and record the erasure, in one transaction (B-6). Again is
        //    fine: an already-deleted user stays deleted, and its record keeps what it had. A
        //    banned account's address is kept only as a hash, so the ban follows the address to a
        //    new identity and erasing the account does not lift it (audit A-11).
        let subject: string | null = null;
        const userError = await failure(() =>
          withTenantTx(async (tx) => {
            const before = await tx.query<{
              email: string | null;
              status: string;
              sub: string | null;
            }>(
              "select email, account_status::text as status, cognito_sub as sub from users where id = $1::uuid for update",
              [userId]
            );
            if (before.rowCount === 0) throw new Error("no such user");
            const standing = before.rows[0]?.status ?? null;
            subject = before.rows[0]?.sub ?? null;
            const email = before.rows[0]?.email;
            const addressHash = standing === "banned" && email ? emailHash(email) : null;
            // A held action or a run may name the account by its address (change_user_role takes
            // an email or an id): the address becomes the id here, while it is still known, so
            // the hard purge finds every mention by the id (review 7 M4). Only a JSON string value
            // equal to the address (ignoring case) is replaced — review 8 H-C: a substring replace
            // corrupted another account's "joann@…" into "jo<id>", which the purge then deleted.
            // The prefilter looks for the address as a JSON string (quoted, escaped as jsonb
            // prints it), so it selects exactly the documents that hold such a value.
            if (email) {
              for (const text of ADDRESS_REPLACEMENTS)
                await tx.query(text, [email, userId]);
            }
            await tx.query(
              `update users
                  set email = null, display_name = '[deleted]', real_name = null,
                      avatar_url = null, date_of_birth = null, parental_consent_email = null,
                      ban_reason = null, timezone = 'UTC', language_preference = 'en',
                      last_login_at = null, deleted_at = now()
                where id = $1::uuid and deleted_at is null`,
              [userId]
            );
            // The record the hard purge works from — in the same transaction: no anonymised
            // account without it, and no record of an erasure that did not happen.
            await tx.query(
              `insert into user_deletions (user_id, requested_by, modules, standing, email_hash, email_hash_key, email_hash_scheme, cognito_sub, purge_after)
               values ($1::uuid, $2, $3::jsonb, $4, $5, $6, $7, $8, now() + make_interval(days => $9::int))
               on conflict (tenant_id, user_id) do update
                 set requested_by = excluded.requested_by, modules = excluded.modules,
                     cognito_sub = coalesce(excluded.cognito_sub, user_deletions.cognito_sub),
                     -- Asked again (round 1): the erasure keeps its schedule and its attempts —
                     -- only ever brought forward (a consent expiry purges at once).
                     purge_after = least(user_deletions.purge_after, excluded.purge_after),
                     standing = coalesce(excluded.standing, user_deletions.standing),
                     email_hash_key = case when excluded.email_hash is null then user_deletions.email_hash_key else excluded.email_hash_key end,
                     email_hash_scheme = case when excluded.email_hash is null then user_deletions.email_hash_scheme else excluded.email_hash_scheme end,
                     email_hash = coalesce(excluded.email_hash, user_deletions.email_hash)`,
              [
                userId,
                requestedBy,
                JSON.stringify(registeredModules.map((m) => m.moduleName)),
                standing,
                addressHash?.hash ?? null,
                addressHash?.keyId ?? null,
                addressHash?.scheme ?? null,
                // The identity, so it is never given a fresh account — kept for an account
                // re-linked to a new pool, whose subject is not its id (TASK-174, migration 054).
                subject,
                purgeAfterDays,
              ]
            );
          })
        );

        if (userError) {
          // Nothing to erase is not an erasure; an erasure not recorded did not happen.
          return {
            success: false,
            errors: [
              userError === "no such user"
                ? "users: no such user"
                : `users: ${userError}`,
            ],
          };
        }
        // The deleted account's cached permissions go at once, here and on every instance
        // (review 7 M5: they were served until the cache's TTL ran out).
        if (subject) await invalidatePermissions(subject);

        // 2. Run soft delete on all registered modules
        for (const mod of registeredModules) {
          const result = await runModule(() => mod.softDelete(userId));
          if (!result.success) {
            errors.push(`${mod.moduleName}: ${result.error || "Unknown error"}`);
          }
        }

        // 3. The stores outside the database — the sign-in identity first (B-8/D-9): erased with
        //    the administrative credentials, each outcome recorded; one not done is retried by the
        //    gdpr.retention-purge job until it is, and blocks the purge's completion meanwhile.
        //    First the pool, recorded only when the identity is proven present in it (S2 round 2:
        //    an old-pool account, never re-linked, is not proven here — its "not found" stays
        //    unverified until two operators attest it). Never replaced once recorded.
        await recordProvenIdentityPool(userId, subject);
        const external = await eraseExternalStores(userId);

        return {
          success: errors.length === 0,
          errors,
          ...(external.pending.length > 0 ? { externalPending: external.pending } : {}),
        };
      },
      // The registered modules and the external stores reach outside the database (an identity
      // provider, a file store): never inside a caller's transaction, whose rollback could not
      // undo them (review 13 L5).
      { external: true }
    );
  } catch (err) {
    if (err instanceof AuditWriteError)
      return { success: false, errors: ["audit unavailable"] };
    throw err;
  }
}

/** Record the pool the identity is proven present in, if it is, on an erasure with none. */
async function recordProvenIdentityPool(
  userId: string,
  sub: string | null
): Promise<void> {
  const pool = await provenIdentityPool({ userId, sub });
  if (!pool) return;
  const error = await failure(() =>
    withTenantTx((tx) =>
      tx.query(
        "update user_deletions set identity_pool = $2 where user_id = $1::uuid and identity_pool is null",
        [userId, pool]
      )
    )
  );
  if (error) {
    logger.warn("An erasure's identity pool could not be recorded; it stays unverified", {
      userId,
      error,
      route: "platform/auth/gdpr-deletion",
    });
  }
}

/** Who records an erasure found without its record (reconcileErasures). */
export const ERASURE_RECONCILE_ACTOR = "system:erasure-reconcile";

/**
 * Record every account of the current tenant marked deleted that has no erasure record (TASK-193,
 * audit B-6): left by the soft delete before it wrote both in one transaction, or by anything that
 * sets deleted_at alone. Each is given its record — the purge due a retention period after it was
 * deleted, its identity kept for the external erasure — so it is purged like any other, and the
 * system's recording of it is audited; an alert says how many were found. At most `limit` per run.
 *
 * @scheduled gdpr.retention-purge
 */
export async function reconcileErasures(agent: string, limit = 500): Promise<number> {
  const { rows } = await withTenantTx((tx) =>
    tx.query<{ user_id: string }>(
      `with orphan as (
         select u.id, u.deleted_at, u.cognito_sub, u.account_status::text as standing
           from users u
          where u.deleted_at is not null
            and not exists (select 1 from user_deletions d where d.user_id = u.id)
          order by u.deleted_at
          limit $3::int
       ),
       recorded as (
         insert into user_deletions (user_id, requested_by, modules, standing, cognito_sub, soft_deleted_at, purge_after)
         select o.id, $1, $2::jsonb, o.standing, o.cognito_sub, o.deleted_at,
                o.deleted_at + make_interval(days => $4::int)
           from orphan o
         on conflict (tenant_id, user_id) do nothing
         returning user_id
       ),
       audit as (
         insert into audit_log (action, target_id, details)
         select 'account_deleted'::audit_action, r.user_id,
                jsonb_build_object('phase', 'erasure_recorded', 'trigger', 'reconcile',
                                   'agent', $1::text, 'by', $5::text, 'outcome', 'succeeded')
           from recorded r
       )
       select user_id from recorded`,
      [
        ERASURE_RECONCILE_ACTOR,
        JSON.stringify(registeredModules.map((m) => m.moduleName)),
        limit,
        ERASURE_RETENTION_DAYS,
        agent,
      ]
    )
  );
  if (rows.length > 0) {
    raiseAlert({
      name: "gdpr.erasure_unrecorded",
      message: `${rows.length} account(s) marked deleted had no erasure record; each is now recorded and will be purged on schedule. Find what deleted them without the erasure pipeline (docs/runbooks/jobs.md).`,
      count: rows.length,
    });
  }
  return rows.length;
}

/**
 * Erase `userId` from every registered external store not yet done for it, and record each outcome
 * on its erasure record (platform/gdpr/external-erasure.ts). Returns the stores still pending. An
 * account with no erasure record has nothing to run (the reconcile records it first).
 */
async function eraseExternalStores(
  userId: string,
  /** The subject when the account has no erasure record (a purge without one): not recorded. */
  unrecordedSub?: string | null
): Promise<{ readonly pending: readonly string[] }> {
  const { rows } = await withTenantTx((tx) =>
    tx.query<{
      sub: string | null;
      pool: string | null;
      external: Record<string, RecordedExternalErasure>;
    }>(
      "select cognito_sub as sub, identity_pool as pool, external_erasures as external from user_deletions where user_id = $1::uuid",
      [userId]
    )
  );
  if (!rows.length) {
    if (unrecordedSub === undefined) return { pending: pendingExternalErasures({}) };
    const once = await runExternalErasures(
      // Proven present first, as the soft delete's record is (S2 round 2).
      {
        userId,
        sub: unrecordedSub,
        pool: await provenIdentityPool({ userId, sub: unrecordedSub }),
      },
      {}
    );
    return { pending: once.pending };
  }
  const run = await runExternalErasures(
    { userId, sub: rows[0].sub, pool: rows[0].pool },
    rows[0].external ?? {}
  );
  const writeError = await failure(() =>
    withTenantTx((tx) =>
      tx.query(
        // Merged per store (round 1, attestation): a store an operator attested meanwhile keeps
        // its record, and an attestation request made or withdrawn meanwhile stands as it is now —
        // while the step is still unverifiable: any other outcome (S2 round 2: refused,
        // unavailable) drops an open request, which was asked about a pool it no longer shows.
        `update user_deletions d
            set external_erasures = d.external_erasures || coalesce((
              select jsonb_object_agg(n.key,
                       case when d.external_erasures -> n.key ? 'doneAt' then d.external_erasures -> n.key
                            else (n.value - 'attestationRequest')
                                 || case when d.external_erasures -> n.key ? 'attestationRequest'
                                          and coalesce((n.value ->> 'poolUnverified')::boolean, false)
                                         then jsonb_build_object('attestationRequest', d.external_erasures -> n.key -> 'attestationRequest')
                                         else '{}'::jsonb end
                       end)
                from jsonb_each($2::jsonb) n), '{}'::jsonb)
          where d.user_id = $1::uuid`,
        [userId, JSON.stringify(run.outcomes)]
      )
    )
  );
  if (writeError) {
    logger.error(
      "An external erasure's outcome could not be recorded; it will run again",
      {
        userId,
        error: writeError,
        route: "platform/auth/gdpr-deletion",
      }
    );
  }
  return { pending: run.pending };
}

/** What one external-erasure retry run did. */
export interface ExternalRetryResult {
  readonly due: number;
  readonly done: number;
  readonly pending: number;
  readonly stopped: boolean;
}

/**
 * Retry the external erasures still pending in the current tenant (TASK-193, audit B-8/D-9) —
 * every erasure, purged or not, whose stores outside the database are not all done and whose
 * retry is due — at most `limit` per run. A store still pending after
 * EXTERNAL_ERASURE_ALERT_ATTEMPTS attempts is alerted (gdpr.external_erasure_pending).
 *
 * @scheduled gdpr.retention-purge
 */
export async function retryExternalErasures(
  limit = 100,
  signal?: AbortSignal
): Promise<ExternalRetryResult> {
  const names = listExternalErasures().map((e) => e.name);
  const { rows } = await withTenantTx((tx) =>
    tx.query<{ user_id: string }>(
      `select user_id from user_deletions
        where exists (select 1 from unnest($1::text[]) as n(name)
                       where external_erasures -> n.name ->> 'doneAt' is null
                         and coalesce((external_erasures -> n.name ->> 'retryAt')::timestamptz, '-infinity'::timestamptz) <= now())
        order by soft_deleted_at, user_id
        limit $2::int`,
      [names, limit]
    )
  );
  let done = 0;
  let pending = 0;
  let stopped = false;
  for (const { user_id: userId } of rows) {
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    const r = await eraseExternalStores(userId);
    if (r.pending.length === 0) done++;
    else pending++;
  }
  const { rows: stuck } = await withTenantTx((tx) =>
    tx.query<{ n: number }>(
      `select count(*)::int as n from user_deletions
        where exists (select 1 from unnest($1::text[]) as n(name)
                       where external_erasures -> n.name ->> 'doneAt' is null
                         and coalesce((external_erasures -> n.name ->> 'poolUnverified')::boolean, false) = false
                         and coalesce((external_erasures -> n.name ->> 'attempts')::int, 0) >= $2::int)`,
      [names, EXTERNAL_ERASURE_ALERT_ATTEMPTS]
    )
  );
  if ((stuck[0]?.n ?? 0) > 0) {
    raiseAlert({
      name: "gdpr.external_erasure_pending",
      message: `${stuck[0].n} erasure(s) could not remove the person from a store outside the database (the identity provider: check its administrative credentials and their AdminDeleteUser permission). They are retried until done (docs/runbooks/jobs.md).`,
      count: stuck[0].n,
    });
  }
  const { rows: unverified } = await withTenantTx((tx) =>
    tx.query<{ n: number }>(
      `select count(*)::int as n from user_deletions
        where exists (select 1 from unnest($1::text[]) as n(name)
                       where external_erasures -> n.name ->> 'doneAt' is null
                         and coalesce((external_erasures -> n.name ->> 'poolUnverified')::boolean, false))`,
      [names]
    )
  );
  if ((unverified[0]?.n ?? 0) > 0) {
    raiseAlert({
      name: "gdpr.identity_pool_unverified",
      message: `${unverified[0].n} erasure(s) did not find the person's identity, but in a pool not shown to be the one the account was in (an older pool, or one not confirmed): they stay pending. Delete the identity from its pool, or confirm the pool (docs/runbooks/jobs.md §6).`,
      count: unverified[0].n,
    });
  }
  return { due: rows.length, done, pending, stopped };
}

/**
 * Phase 2: Hard purge a user's data. Permanently removes all data across all modules. Called for
 * each account whose retention period has passed by purgeDueErasures, and by the admin purge.
 *
 * The app's modules run first; then the platform's register (platform/auth/user-data.ts) erases
 * every platform table that holds the user's data, user row last, in one transaction — all of
 * it or none (audit X-15, E-8: before, only the user row was deleted). The erasure is marked
 * complete only when every store outside the database is erased too (TASK-193, B-8/D-9): one
 * still pending is tried again here, and while it stays pending the purge reports failure and is
 * retried.
 */
export async function hardPurgeUser(
  userId: string
): Promise<{ success: boolean; errors: string[]; steps?: readonly ErasureStep[] }> {
  const errors: string[] = [];
  let steps: readonly ErasureStep[] | undefined;
  // The account's identity, read before its row goes: what the external stores know it by when
  // it has no erasure record to keep it.
  const subject = await withTenantTx((tx) =>
    tx.query<{ sub: string | null }>(
      "select cognito_sub as sub from users where id = $1::uuid",
      [userId]
    )
  )
    .then((r) => r.rows[0]?.sub ?? null)
    .catch(() => null);

  // 1. Run hard purge on all registered modules
  for (const mod of registeredModules) {
    const result = await runModule(() => mod.hardPurge(userId));
    if (!result.success) {
      errors.push(`${mod.moduleName}: ${result.error || "Unknown error"}`);
    }
  }

  // 2. The platform's tables, the user row last, in one transaction.
  const userError = await failure(async () => {
    steps = await withTenantTx((tx) => eraseUserData(tx, userId));
  });

  if (userError) {
    errors.push(`users: ${userError}`);
  }

  // 3. The stores outside the database: none may still hold the person when it is complete.
  const external = await eraseExternalStores(userId, subject).catch((err: unknown) => ({
    pending: [err instanceof Error ? err.message : String(err)],
  }));
  if (external.pending.length > 0) {
    errors.push(`external: ${external.pending.join(", ")} not yet erased`);
  }

  // 4. Mark the erasure complete — only when everything was removed.
  if (errors.length === 0) {
    const recordError = await failure(() =>
      withTenantTx((tx) =>
        tx.query(
          "update user_deletions set purged_at = now(), purge_retry_at = null, last_purge_error = null where user_id = $1::uuid and purged_at is null",
          [userId]
        )
      )
    );
    if (recordError) {
      logger.error("Failed to mark the deletion purged", {
        userId,
        error: recordError,
        route: "platform/auth/gdpr-deletion",
      });
      errors.push(`deletion record: ${recordError}`);
    }
  }

  return { success: errors.length === 0, errors, ...(steps ? { steps } : {}) };
}

/** What one retention run did. */
export interface ErasureRunResult {
  /** Accounts whose retention period had passed (at most the run's limit). */
  readonly due: number;
  readonly purged: number;
  /** Erasures that could not complete; they stay due and are tried again later (backoff). */
  readonly failed: number;
  /** Erasures that have failed PURGE_ALERT_ATTEMPTS times or more (alerted). */
  readonly stuck: number;
  /** The run was told to stop (its signal) before every due account was handled. */
  readonly stopped: boolean;
}

/** After this many failed purges an erasure is alerted (gdpr.erasure_stuck). */
export const PURGE_ALERT_ATTEMPTS = 5;

/**
 * Erase every account of the current tenant whose retention period has passed (user_deletions
 * purge_after), at most `limit` per run — those tried fewest times first, then oldest. Each
 * erasure is recorded before it runs (gdpr_purge_executed, by `agent`). One that cannot be
 * recorded or does not complete is counted as failed and tried again after a growing interval
 * (purge_attempts, purge_retry_at: 1 hour, doubling, at most 7 days), with the steps that failed
 * (last_purge_error) — so erasures that always fail never hold the others back (TASK-193, audit
 * B-7: the oldest 100 were retried first, every run, for ever). One that has failed
 * PURGE_ALERT_ATTEMPTS times is alerted. `signal` (the job's): checked between accounts —
 * aborted, the run stops with `stopped` and the rest stay due.
 *
 * @scheduled gdpr.retention-purge
 */
export async function purgeDueErasures(
  agent: string,
  limit = 100,
  signal?: AbortSignal
): Promise<ErasureRunResult> {
  const { rows } = await withTenantTx((tx) =>
    tx.query<{ user_id: string }>(
      `select user_id from user_deletions
        where purged_at is null and purge_after <= now()
          and (purge_retry_at is null or purge_retry_at <= now())
        order by purge_attempts, purge_after, user_id
        limit $1::int`,
      [limit]
    )
  );
  let purged = 0;
  let failed = 0;
  let stopped = false;
  for (const { user_id: userId } of rows) {
    // Told to stop (its job's time is up, or the instance is stopping): between accounts, never
    // inside one — the rest stay due and the next part takes them.
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    let failedSteps: string | undefined;
    try {
      const result = await audited(
        {
          action: "gdpr_purge_executed",
          agent,
          targetId: userId,
          details: { phase: "hard_purge", trigger: "retention_period_passed" },
        },
        async () => {
          const r = await hardPurgeUser(userId);
          if (!r.success) failedSteps = failingSteps(r.errors);
          return r.success
            ? { success: true as const }
            : { success: false as const, error: r.errors.join("; ") };
        },
        // The modules' hard purge may reach outside the database (review 13 L5).
        { external: true }
      );
      if (result.success) purged++;
      else failed++;
    } catch (err) {
      if (!(err instanceof AuditWriteError)) throw err;
      failedSteps = "audit";
      failed++;
    }
    if (failedSteps !== undefined) await deferPurge(userId, failedSteps);
  }
  const { rows: stuck } = await withTenantTx((tx) =>
    tx.query<{ n: number }>(
      // One alert per cause (round 1): an erasure held only by a store outside the database is
      // that store's alert (retryExternalErasures), not this one.
      "select count(*)::int as n from user_deletions where purged_at is null and purge_attempts >= $1::int and coalesce(last_purge_error, '') <> 'external'",
      [PURGE_ALERT_ATTEMPTS]
    )
  );
  const stuckCount = stuck[0]?.n ?? 0;
  if (stuckCount > 0) {
    raiseAlert({
      name: "gdpr.erasure_stuck",
      message: `${stuckCount} erasure(s) have failed ${PURGE_ALERT_ATTEMPTS} or more times; each is retried with a growing interval. user_deletions.last_purge_error names the steps that failed (docs/runbooks/jobs.md).`,
      count: stuckCount,
    });
  }
  return { due: rows.length, purged, failed, stuck: stuckCount, stopped };
}

/** The names of the steps that failed (`module: message` → `module`), never their messages. */
function failingSteps(errors: readonly string[]): string {
  return errors
    .map((e) => e.split(":")[0]?.trim() || "unknown")
    .join(", ")
    .slice(0, 500);
}

/** Record a failed purge and when it is tried again (1 h, doubling, at most 7 days). */
async function deferPurge(userId: string, steps: string): Promise<void> {
  const writeError = await failure(() =>
    withTenantTx((tx) =>
      tx.query(
        `update user_deletions
            set purge_attempts = purge_attempts + 1,
                purge_retry_at = now() + least(interval '7 days', interval '1 hour' * power(2, least(purge_attempts, 8))),
                last_purge_error = $2
          where user_id = $1::uuid and purged_at is null`,
        [userId, steps]
      )
    )
  );
  if (writeError) {
    logger.error("A failed purge's retry could not be recorded; it is due again", {
      userId,
      error: writeError,
      route: "platform/auth/gdpr-deletion",
    });
  }
}

/**
 * For every erasure of the current tenant that is complete and whose mentions in other tenants
 * are not yet erased (user_deletions.mentions_erased_at), run CROSS_TENANT_ERASURE on the owner
 * connection (TASK-193, audit A-3): an operator's act about the account is recorded in the
 * operator's own tenant, which the account's erasure — in its own tenant — never reached. A job
 * step, never a request's (the admin purge's mentions are erased by the next run). At most
 * `limit` per run; `signal` is checked between accounts.
 *
 * @scheduled gdpr.retention-purge
 */
export async function eraseMentionsInOtherTenants(
  limit = 100,
  signal?: AbortSignal
): Promise<{ readonly due: number; readonly erased: number; readonly stopped: boolean }> {
  const { rows } = await withTenantTx((tx) =>
    tx.query<{ user_id: string }>(
      `select user_id from user_deletions
        where purged_at is not null and mentions_erased_at is null
        order by purged_at, user_id
        limit $1::int`,
      [limit]
    )
  );
  let erased = 0;
  let stopped = false;
  for (const { user_id: userId } of rows) {
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    const id = userId.toLowerCase();
    let aborted = false;
    const error = await failure(async () => {
      // In page ranges, one transaction each (review round 1, item 6: one statement read the
      // whole audit log, every tenant's, in one transaction). Records written after the size is
      // read are new — none names an account erased before them.
      const { rows: size } = await withOwnerTx("platform-job", (tx) =>
        tx.query<{ pages: number }>(
          "select (pg_relation_size('public.audit_log') / current_setting('block_size')::int)::int as pages"
        )
      );
      const pages = size[0]?.pages ?? 0;
      for (let from = 0; from <= pages; from += CROSS_TENANT_ERASURE_PAGES) {
        if (signal?.aborted) {
          aborted = true;
          return;
        }
        const range = [id, `(${from},0)`, `(${from + CROSS_TENANT_ERASURE_PAGES},0)`];
        await withOwnerTx("platform-job", async (tx) => {
          for (const text of CROSS_TENANT_ERASURE) await tx.query(text, range);
        });
      }
      await withTenantTx((tx) =>
        tx.query(
          "update user_deletions set mentions_erased_at = now() where user_id = $1::uuid",
          [userId]
        )
      );
    });
    if (aborted) {
      // Not marked: the next run erases its mentions again from the start (idempotent).
      stopped = true;
      break;
    }
    if (error) {
      logger.error("An erased account's mentions in other tenants could not be erased", {
        userId,
        error,
        route: "platform/auth/gdpr-deletion",
      });
    } else erased++;
  }
  return { due: rows.length, erased, stopped };
}
