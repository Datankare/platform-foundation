/**
 * platform/agents/effect-settlement.ts — every external effect's ledger entry ends resolved
 * (TASK-215, audit B-12; ADR-031 D7)
 *
 * The ledger writes an entry `pending` before an external call and resolves it after. Two states
 * had no way out (status-lifecycle B-12): an entry left `pending` by a process that stopped
 * mid-call, which only a retry of the same operation would ever look at again; and an
 * `indeterminate` one — the downstream neither confirmed nor denied — which ADR-031 D7 leaves to a
 * person, and which no screen listed and no one could decide. Now:
 *
 *   pending        past effects.pending_timeout_minutes, it is settled `indeterminate` (with
 *                  EFFECT_UNRESOLVED) by the data.retention job in every tenant — exactly what a
 *                  retry finding it unresolved would do without a reconcile (performExternalEffect):
 *                  never guessed confirmed or failed, never fired again;
 *   indeterminate  waits for a person: listed on the operator console's Jobs page, where an
 *                  operator who has checked the downstream marks it took effect (`confirmed`) or
 *                  did not (`failed`) — recorded in the audit log before it changes. While any
 *                  waits, each data.retention run raises the alert effects.indeterminate;
 *   confirmed, failed   deleted after retention.effect_ledger_days (platform/jobs/retention.ts).
 *
 * @module platform/agents
 */

import { withOwnerTx, withTenantTx } from "@/platform/data";
import { getConfigNumber } from "@/platform/auth/platform-config";
import { audited, AuditWriteError } from "@/platform/auth/audit";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import { raiseAlert } from "@/platform/observability/alert";
import { EFFECT_UNRESOLVED } from "./external-effect";

/** The governed bound on a pending entry, in minutes (migration 073). */
export const PENDING_TIMEOUT_SETTING = "effects.pending_timeout_minutes";
export const PENDING_TIMEOUT_DEFAULT = 60;
export const PENDING_TIMEOUT_MIN = 5;
export const PENDING_TIMEOUT_MAX = 10_080;

/** Entries one run settles at most; a full batch continues in the job's next part. */
export const SETTLE_BATCH = 1000;

/** The bound in whole minutes: its governed value, clamped, else the default. */
export async function pendingTimeoutMinutes(): Promise<number> {
  try {
    const v = await getConfigNumber(PENDING_TIMEOUT_SETTING, PENDING_TIMEOUT_DEFAULT);
    if (!Number.isFinite(v)) return PENDING_TIMEOUT_DEFAULT;
    return Math.min(PENDING_TIMEOUT_MAX, Math.max(PENDING_TIMEOUT_MIN, Math.floor(v)));
  } catch {
    return PENDING_TIMEOUT_DEFAULT;
  }
}

export interface Settlement {
  /** Pending entries settled indeterminate this run. */
  readonly settled: number;
  /** Indeterminate entries now waiting for a person, in this tenant. */
  readonly waiting: number;
  /** A full batch was settled: there may be more. */
  readonly more: boolean;
}

/**
 * In the current tenant: settle every entry pending for longer than the bound as indeterminate,
 * then count those waiting for a person and raise effects.indeterminate while any do.
 *
 * @scheduled data.retention
 */
export async function settleStaleEffects(
  now: () => number = Date.now,
  batch = SETTLE_BATCH
): Promise<Settlement> {
  const minutes = await pendingTimeoutMinutes();
  const cutoff = new Date(now() - minutes * 60_000).toISOString();
  const { settled, waiting } = await withTenantTx(async (tx) => {
    const { rowCount } = await tx.query(
      `update effect_ledger set status = 'indeterminate', error = $3, resolved_at = now()
        where ctid in (select ctid from effect_ledger
                        where status = 'pending' and created_at < $1 limit $2)`,
      [cutoff, batch, EFFECT_UNRESOLVED]
    );
    const { rows } = await tx.query<{ n: number }>(
      "select count(*)::int as n from effect_ledger where status = 'indeterminate'"
    );
    return { settled: rowCount ?? 0, waiting: rows[0]?.n ?? 0 };
  });
  if (waiting > 0) {
    raiseAlert({
      name: "effects.indeterminate",
      message: `${waiting} external call(s) ended with an unknown outcome: the downstream neither confirmed nor denied them, and nothing calls them again. Check each with the downstream, then mark it on the operator console's Jobs page ("External calls with an unknown outcome"): took effect, or did not.`,
      count: waiting,
    });
  }
  return { settled, waiting, more: settled >= batch };
}

/** An external call whose outcome a person must decide, as the operator console lists it. */
export interface UnresolvedEffect {
  readonly id: string;
  readonly tenantId: string;
  readonly operationId: string;
  readonly effectKey: string;
  readonly effectType: string;
  readonly status: "indeterminate";
  readonly attempts: number;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

/** Every tenant's indeterminate entries, oldest first (the operator console). */
export async function listUnresolvedEffects(limit = 100): Promise<UnresolvedEffect[]> {
  const { rows } = await withOwnerTx("operator", (tx) =>
    tx.query<{
      id: string;
      tenant_id: string;
      operation_id: string;
      effect_key: string;
      effect_type: string;
      attempts: number;
      created_at: Date;
      resolved_at: Date | null;
    }>(
      `select id, tenant_id, operation_id, effect_key, effect_type, attempts, created_at, resolved_at
         from effect_ledger where status = 'indeterminate'
        order by created_at, id limit $1`,
      [limit]
    )
  );
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    operationId: r.operation_id,
    effectKey: r.effect_key,
    effectType: r.effect_type,
    status: "indeterminate",
    attempts: r.attempts,
    createdAt: new Date(r.created_at).toISOString(),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
  }));
}

/** What a person decided an external call did. */
export type EffectOutcome = "took_effect" | "no_effect";

export type ResolveOutcome =
  | { readonly ok: true; readonly status: "confirmed" | "failed" }
  | {
      readonly ok: false;
      readonly code: "effects.not_found" | "effects.not_indeterminate";
    }
  | { readonly ok: false; readonly code: "audit.unavailable" };

/**
 * An operator's decision on an indeterminate entry: `took_effect` → confirmed, `no_effect` →
 * failed. Recorded in the audit log first (no record, no change); only an entry still
 * indeterminate changes, so two operators deciding at once change it once.
 */
export async function resolveIndeterminateEffect(
  admin: VerifiedAdmin,
  id: string,
  outcome: EffectOutcome
): Promise<ResolveOutcome> {
  const status = outcome === "took_effect" ? "confirmed" : "failed";
  const { rows } = await withOwnerTx("operator", (tx) =>
    tx.query<{
      tenant_id: string;
      status: string;
      operation_id: string;
      effect_key: string;
    }>(
      "select tenant_id, status, operation_id, effect_key from effect_ledger where id::text = $1",
      [id]
    )
  );
  const entry = rows[0];
  if (!entry) return { ok: false, code: "effects.not_found" };
  if (entry.status !== "indeterminate")
    return { ok: false, code: "effects.not_indeterminate" };
  try {
    const r = await audited(
      {
        action: "admin_action",
        actorId: admin.userId,
        details: {
          type: "effect_resolved",
          effectId: id,
          tenantId: entry.tenant_id,
          operationId: entry.operation_id,
          effectKey: entry.effect_key,
          decision: outcome,
        },
      },
      async () => {
        const { rowCount } = await withOwnerTx("operator", (tx) =>
          tx.query(
            `update effect_ledger set status = $2, resolved_at = now()
              where id::text = $1 and status = 'indeterminate'`,
            [id, status]
          )
        );
        return (rowCount ?? 0) === 1
          ? { success: true as const }
          : { success: false as const, error: "effects.not_indeterminate" };
      }
    );
    return r.success
      ? { ok: true, status }
      : { ok: false, code: "effects.not_indeterminate" };
  } catch (err) {
    if (err instanceof AuditWriteError) return { ok: false, code: "audit.unavailable" };
    throw err;
  }
}
