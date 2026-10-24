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

import { withTenantTx } from "@/platform/data";
import { AuditWriteError, audited } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";

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

/**
 * Phase 1: Soft delete a user.
 * - Sets deleted_at on the user record
 * - Anonymizes PII (email, display_name, real_name)
 * - Runs soft delete on all registered modules
 * - Audit logged
 */
export async function softDeleteUser(
  userId: string,
  requestedBy: string
): Promise<{ success: boolean; errors: string[] }> {
  try {
    // Recorded before anything is deleted; no record, no deletion (Adversarial Validation, 6).
    // A partial deletion reports failure, which audited() records as a follow-up.
    return await audited(
      {
        action: "account_deleted",
        actorId: requestedBy,
        targetId: userId,
        details: {
          phase: "soft_delete",
          moduleCount: registeredModules.length,
        },
      },
      async () => {
        const errors: string[] = [];

        // 1. Anonymize user record (again is fine: an already-deleted user stays deleted).
        const userError = await failure(() =>
          withTenantTx(async (tx) => {
            await tx.query(
              `update users
                  set email = null, display_name = '[deleted]', real_name = null,
                      avatar_url = null, date_of_birth = null, deleted_at = now()
                where id = $1::uuid and deleted_at is null`,
              [userId]
            );
            const found = await tx.query("select 1 from users where id = $1::uuid", [
              userId,
            ]);
            if (found.rowCount === 0) throw new Error("no such user");
          })
        );

        if (userError) {
          // Nothing to erase is not an erasure: stop before the modules and the record.
          return { success: false, errors: [`users: ${userError}`] };
        }

        // 2. Run soft delete on all registered modules
        for (const mod of registeredModules) {
          const result = await mod.softDelete(userId);
          if (!result.success) {
            errors.push(`${mod.moduleName}: ${result.error || "Unknown error"}`);
          }
        }

        // 3. Record the erasure. It is what the hard purge works from: without it the erasure
        //    would never complete, so the deletion has not succeeded.
        const recordError = await failure(() =>
          withTenantTx((tx) =>
            tx.query(
              `insert into user_deletions (user_id, requested_by, modules)
               values ($1::uuid, $2, $3::jsonb)
               on conflict (tenant_id, user_id) do update
                 set requested_by = excluded.requested_by, modules = excluded.modules,
                     soft_deleted_at = now(), purge_after = now() + interval '30 days',
                     purged_at = null`,
              [
                userId,
                requestedBy,
                JSON.stringify(registeredModules.map((m) => m.moduleName)),
              ]
            )
          )
        );
        if (recordError) {
          logger.error("Failed to record the deletion", {
            userId,
            error: recordError,
            route: "platform/auth/gdpr-deletion",
          });
          errors.push(`deletion record: ${recordError}`);
        }

        return { success: errors.length === 0, errors };
      }
    );
  } catch (err) {
    if (err instanceof AuditWriteError)
      return { success: false, errors: ["audit unavailable"] };
    throw err;
  }
}

/**
 * Phase 2: Hard purge a user's data. Permanently removes all data across all modules. Called for
 * each account whose retention period has passed by purgeDueErasures.
 */
export async function hardPurgeUser(
  userId: string
): Promise<{ success: boolean; errors: string[] }> {
  const errors: string[] = [];

  // 1. Run hard purge on all registered modules
  for (const mod of registeredModules) {
    const result = await mod.hardPurge(userId);
    if (!result.success) {
      errors.push(`${mod.moduleName}: ${result.error || "Unknown error"}`);
    }
  }

  // 2. Delete user record
  const userError = await failure(() =>
    withTenantTx((tx) => tx.query("delete from users where id = $1::uuid", [userId]))
  );

  if (userError) {
    errors.push(`users: ${userError}`);
  }

  // 3. Mark the erasure complete — only when everything was removed.
  if (errors.length === 0) {
    const recordError = await failure(() =>
      withTenantTx((tx) =>
        tx.query(
          "update user_deletions set purged_at = now() where user_id = $1::uuid and purged_at is null",
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

  return { success: errors.length === 0, errors };
}

/** What one retention run did. */
export interface ErasureRunResult {
  /** Accounts whose retention period had passed (at most the run's limit). */
  readonly due: number;
  readonly purged: number;
  /** Erasures that could not complete; they stay due and are tried on the next run. */
  readonly failed: number;
  /** The run was told to stop (its signal) before every due account was handled. */
  readonly stopped: boolean;
}

/**
 * Erase every account of the current tenant whose retention period has passed (user_deletions
 * purge_after), at most `limit` per run, oldest first. Each erasure is recorded before it runs
 * (gdpr_purge_executed, by `agent`); one that cannot be recorded or does not complete is
 * counted as failed and stays due. `signal` (the job's): checked between accounts — aborted, the
 * run stops with `stopped` and the rest stay due.
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
        order by purge_after, user_id
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
          return r.success
            ? { success: true as const }
            : { success: false as const, error: r.errors.join("; ") };
        }
      );
      if (result.success) purged++;
      else failed++;
    } catch (err) {
      if (!(err instanceof AuditWriteError)) throw err;
      failed++;
    }
  }
  return { due: rows.length, purged, failed, stopped };
}
