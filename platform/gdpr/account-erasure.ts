/**
 * platform/gdpr/account-erasure.ts — The platform's purge handler: the account and every
 * platform table that holds its data (audit X-15)
 *
 * The admin purge route used to run a pipeline with no handler (it then answered 503, having
 * erased nothing). The platform now registers its own: the account is erased (softDeleteUser:
 * recorded, anonymised, a banned address kept as a hash — A-11) and at once purged
 * (hardPurgeUser: the app's modules, then the register of platform tables in one transaction,
 * platform/auth/user-data.ts). A dry run counts the rows the purge would erase. An app adds its
 * own handlers to the same pipeline.
 *
 * Each purge that runs is written to purge_log, in the request's tenant (it never was: no route
 * gave the pipeline a record writer). The purge itself is recorded in the audit log before it
 * runs (the route's auditedResponse); a purge_log row that cannot be written is logged.
 *
 * @module platform/gdpr
 */

import { withTenantTx } from "@/platform/data";
import { eraseUserData } from "@/platform/auth/user-data";
import { hardPurgeUser, softDeleteUser } from "@/platform/auth/gdpr-deletion";
import { PurgePipeline } from "./hard-purge";
import type { PurgeAuditEntry, PurgeConfig, PurgeHandler } from "./types";

/** Erases the account and the platform's tables (priority 10: first). */
export class AccountErasureHandler implements PurgeHandler {
  readonly name = "platform:account";
  readonly priority = 10;

  constructor(private readonly requestedBy: string) {}

  async execute(userId: string, dryRun: boolean): Promise<number> {
    if (dryRun) {
      const steps = await withTenantTx((tx) =>
        eraseUserData(tx, userId, { dryRun: true })
      );
      return steps.reduce((sum, s) => sum + s.rows, 0);
    }
    const erased = await softDeleteUser(userId, this.requestedBy);
    if (!erased.success) throw new Error(erased.errors.join("; "));
    const purged = await hardPurgeUser(userId);
    if (!purged.success) throw new Error(purged.errors.join("; "));
    return (purged.steps ?? []).reduce((sum, s) => sum + s.rows, 0);
  }
}

/** Write one purge's record to purge_log (the request's tenant). Throws when it cannot. */
export async function recordPurge(entry: PurgeAuditEntry): Promise<void> {
  await withTenantTx((tx) =>
    tx.query(
      `insert into purge_log
         (purge_id, user_id, requested_by, reason, status, steps_json, total_deleted,
          requested_at, completed_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::int, $8::timestamptz, $9::timestamptz)`,
      [
        entry.purge_id,
        entry.user_id,
        entry.requested_by,
        entry.reason,
        entry.status,
        entry.steps_json,
        entry.total_deleted,
        entry.requested_at,
        entry.completed_at,
      ]
    )
  );
}

/**
 * The platform's purge pipeline for one request: the account erasure handler, then `extra`
 * (an app's handlers), with its record written to purge_log.
 *
 * @external Running it runs every registered module's erasure hook and an app's handlers, which may
 * reach outside the database: an audited act that runs it passes `{ external: true }` (review 14
 * L-6; __tests__/audited-external-guard.test.ts reads this tag).
 */
export function createPlatformPurgePipeline(
  requestedBy: string,
  extra: readonly PurgeHandler[] = [],
  config: PurgeConfig = { timeoutMs: 30_000 }
): PurgePipeline {
  const pipeline = new PurgePipeline(config);
  pipeline.register(new AccountErasureHandler(requestedBy));
  for (const handler of extra) pipeline.register(handler);
  pipeline.onAudit(recordPurge);
  return pipeline;
}
