/**
 * platform/admin/hold-withdrawal.ts — Pending holds on a key withdrawn when the key is reduced
 * (review 12 H2)
 *
 * A change held for a second admin was requested against the value the key held then. When the
 * kill switch or any power reduction applied unheld changes the key, every pending hold on it —
 * runtime holds (proposed, or approved and not yet run) and two-person approvals — is withdrawn:
 * each would otherwise be decided against a value that no longer stands (an approved scope change
 * re-activated every agent the kill switch had just suspended). Each withdrawal is audited
 * (approval_withdrawn, reason "superseded", with why) before it is made: no record, no
 * withdrawal. A hold whose withdrawal did not land is still safe: its approval applies only onto
 * the value it was requested against (compare-and-set, stale-change.ts), and refuses as
 * approvals.stale.
 *
 * Only the holds of the scope that was reduced (review 13 L1): a reduction of the tenant's own
 * value withdraws the tenant-scope holds on the key (and resets, which are tenant-scope), never a
 * pending change to the platform default — and a reduction of the platform default withdraws
 * only platform-scope holds. A hold of the other scope was requested against a value the
 * reduction did not change; it stands (and its compare-and-set still guards it).
 *
 * Bounded (review 13 L7): the holds on the key are found in the store by label and key (never by
 * reading every hold of the tenant), and withdrawn in batches of WITHDRAWAL_BATCH — one audit
 * record per batch (`holdIds`), then one statement (ProposalStore.supersede) — at most
 * WITHDRAWAL_MAX_HOLDS per call; two-person approvals likewise, in batches, each batch audited in
 * its transaction. Anything left — past the bound, or a two-person approval skipped because a
 * concurrent reviewer held its row (review 14 L-3: always counted now) — is logged and alerted
 * (`approvals.withdrawal_incomplete`, with how many); it refuses stale when approved.
 *
 * A platform-scope reduction in a shared deployment reaches every tenant (review 14 L-4): a
 * platform default's holds and approvals are requested from — and stored in — whichever tenant the
 * operator acted in, so withdrawing only the current tenant's left the others pending. The tenants
 * holding pending platform-scope holds or approvals of the key are found on the owner connection
 * (purpose "operator", the one cross-tenant read), and the withdrawal then runs in each, as that
 * tenant: in its own transactions under row-level security, audited in its own log
 * (approval_withdrawn). A tenant that cannot be reached is reported in `failed` and alerted; its
 * holds still refuse stale.
 *
 * @module platform/admin
 */

import { getProposalStore } from "@/platform/agents/proposal-store";
import { withOwnerTx } from "@/platform/data";
import { peekTenant, runWithTenant } from "@/platform/tenancy/context";
import { audited } from "@/platform/auth/audit";
import { logger } from "@/lib/logger";
import { CONFIG_HOLD_TOOLS, proposalConfigKey } from "@/platform/admin/hold-keys";
import { withdrawPendingApprovalsForKey } from "@/platform/admin/config-approval";
import { isSharedDeployment } from "@/platform/admin/config-scope";
import { raiseAlert } from "@/platform/observability/alert";
import type { ConfigScope } from "@/platform/admin/types";
import type { ProposalRecord, ProposalStore } from "@/platform/kernel/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Holds withdrawn per audit record and statement. */
export const WITHDRAWAL_BATCH = 100;
/** The most holds one call looks at (the rest refuse stale when approved). */
export const WITHDRAWAL_MAX_HOLDS = 2_000;

/** What a withdrawal of superseded holds did. */
export interface SupersededWithdrawal {
  /** Runtime holds withdrawn (proposal ids). */
  readonly holds: readonly string[];
  /** Two-person approvals withdrawn (approval ids). */
  readonly approvals: readonly string[];
  /** Holds found that could not be withdrawn (their audit record or the write failed). */
  readonly failed: readonly string[];
  /** Holds and approvals left pending (past the bound, or held by a concurrent reviewer). */
  readonly remaining: number;
  /** The tenants other than the current one whose platform-scope holds were withdrawn. */
  readonly tenants: readonly string[];
}

/**
 * The scope a held config change writes (review 13 L1): a reset is always the tenant's own value;
 * an update names its scope, else (as resolveConfigTarget) the tenant's own value in a shared
 * deployment and the platform default in a single-tenant one.
 */
export function holdScope(p: Pick<ProposalRecord, "label" | "payload">): ConfigScope {
  if (p.label === "reset_config") return "tenant";
  const requested = p.payload["scope"];
  if (requested === "platform") return "platform";
  return isSharedDeployment() ? "tenant" : "platform";
}

/**
 * Withdraw every pending hold on `key` of `scope` — in the current tenant, and for a platform-scope
 * reduction in a shared deployment in every tenant holding one (review 14 L-4) — as `actorId` (a
 * users.id, or an agent/system name), for `reason`. Never throws: a hold left pending is refused
 * stale on approval.
 */
export async function withdrawSupersededHolds(
  key: string,
  actorId: string,
  reason: string,
  scope: ConfigScope
): Promise<SupersededWithdrawal> {
  const here = await withdrawInTenant(key, actorId, reason, scope);
  const holds = [...here.holds];
  const approvals = [...here.approvals];
  const failed = [...here.failed];
  let remaining = here.remaining;
  let incomplete = here.incomplete;
  const reached: string[] = [];
  const current = peekTenant();
  if (scope === "platform" && current && isSharedDeployment()) {
    let others: string[] = [];
    try {
      others = (await tenantsHoldingPlatformScope(key)).filter(
        (id) => id !== current.tenantId
      );
    } catch (err) {
      incomplete = true;
      failed.push(`tenants:${key}`);
      logger.error(
        "The tenants holding platform-scope holds on a reduced key could not be listed (each hold will refuse stale)",
        {
          key,
          error: err instanceof Error ? err.message : String(err),
          route: "platform/admin/hold-withdrawal",
        }
      );
    }
    for (const tenantId of others) {
      try {
        const r = await runWithTenant({ tenantId, mode: current.mode }, () =>
          withdrawInTenant(key, actorId, reason, scope)
        );
        holds.push(...r.holds);
        approvals.push(...r.approvals);
        failed.push(...r.failed);
        remaining += r.remaining;
        if (r.incomplete) incomplete = true;
        reached.push(tenantId);
      } catch (err) {
        incomplete = true;
        failed.push(`tenant:${tenantId}`);
        logger.error("A tenant's platform-scope holds could not be withdrawn", {
          key,
          tenantId,
          error: err instanceof Error ? err.message : String(err),
          route: "platform/admin/hold-withdrawal",
        });
      }
    }
  }
  if (incomplete) {
    raiseAlert({
      name: "approvals.withdrawal_incomplete",
      message:
        `Pending holds or approvals on ${key} (${scope}) were left pending: ${remaining} still pending${failed.length ? `, ${failed.length} not withdrawn` : ""} — past the bound of ${WITHDRAWAL_MAX_HOLDS}, held by a concurrent reviewer, or in a tenant that could not be reached. Each still refuses as stale when approved (its compare-and-set applies it only onto the value it was requested against). Expire or reject them (runbook: approvals-and-agents §3).`.slice(
          0,
          500
        ),
      tags: { key, scope, remaining: String(remaining) },
      count: Math.max(1, remaining),
    });
  }
  return { holds, approvals, failed, remaining, tenants: reached };
}

/**
 * The tenants holding a pending platform-scope hold or two-person approval of `key` — read on the
 * owner connection (it spans tenants), ids only.
 */
async function tenantsHoldingPlatformScope(key: string): Promise<string[]> {
  const { rows } = await withOwnerTx("operator", (tx) =>
    tx.query<{ id: string }>(
      `select tenant_id::text as id from config_pending_approvals
        where config_key = $1 and scope = 'platform' and status = 'pending'
       union
       select tenant_id::text as id from proposals
        where status in ('proposed', 'approved') and label = any($2::text[])
          and label <> 'reset_config' and payload->>'scope' = 'platform'
          and coalesce(payload->>'key', payload->>'configKey') = $1
       order by 1`,
      [key, [...CONFIG_HOLD_TOOLS]]
    )
  );
  return rows.map((r) => r.id).filter((id) => UUID_RE.test(id));
}

/** The withdrawal in the current tenant: runtime holds, then two-person approvals. */
async function withdrawInTenant(
  key: string,
  actorId: string,
  reason: string,
  scope: ConfigScope
): Promise<{
  holds: string[];
  approvals: readonly string[];
  failed: string[];
  remaining: number;
  incomplete: boolean;
}> {
  const who = UUID_RE.test(actorId) ? { actorId } : { agent: actorId };
  const note = `withdrawn: superseded — ${reason}`.slice(0, 500);
  const holds: string[] = [];
  const failed: string[] = [];
  const store = getProposalStore();
  const seen: string[] = [];
  let incomplete = false;
  let remaining = 0;
  try {
    for (;;) {
      if (seen.length >= WITHDRAWAL_MAX_HOLDS) {
        incomplete = true;
        break;
      }
      const page = await store.query({
        statuses: ["proposed", "approved"],
        labels: [...CONFIG_HOLD_TOOLS],
        payloadKey: key,
        excludeIds: seen,
        limit: WITHDRAWAL_BATCH,
      });
      if (!page.length) break;
      for (const p of page) seen.push(p.proposalId);
      // The store filtered by key; checked again here (a store that ignores a filter cannot
      // widen what is withdrawn), and by scope.
      const batch = page.filter(
        (p) =>
          CONFIG_HOLD_TOOLS.has(p.label) &&
          proposalConfigKey(p.payload) === key &&
          (p.status === "proposed" || p.status === "approved") &&
          holdScope(p) === scope
      );
      if (batch.length) {
        const r = await withdrawBatch(store, batch, {
          key,
          scope,
          reason,
          note,
          who,
          actorId,
        });
        holds.push(...r.withdrawn);
        failed.push(...r.failed);
      }
      if (page.length < WITHDRAWAL_BATCH) break;
    }
  } catch (err) {
    logger.error("Pending holds on a reduced key could not be listed", {
      key,
      error: err instanceof Error ? err.message : String(err),
      route: "platform/admin/hold-withdrawal",
    });
  }
  let approvals: readonly string[] = [];
  try {
    const r = await withdrawPendingApprovalsForKey(key, actorId, note, reason, scope);
    approvals = r.withdrawn;
    remaining += r.remaining;
    if (r.incomplete) incomplete = true;
  } catch (err) {
    failed.push(`config-approval:${key}`);
    logger.error(
      "Pending approvals on a reduced key could not be withdrawn (each will refuse stale)",
      {
        key,
        error: err instanceof Error ? err.message : String(err),
        route: "platform/admin/hold-withdrawal",
      }
    );
  }
  return { holds, approvals, failed, remaining, incomplete };
}

/** One batch: audited (one record, every id), then withdrawn in one statement where possible. */
async function withdrawBatch(
  store: ProposalStore,
  batch: readonly ProposalRecord[],
  ctx: {
    readonly key: string;
    readonly scope: ConfigScope;
    readonly reason: string;
    readonly note: string;
    readonly who: { actorId: string } | { agent: string };
    readonly actorId: string;
  }
): Promise<{ withdrawn: string[]; failed: string[] }> {
  const ids = batch.map((p) => p.proposalId);
  let withdrawn: string[] = [];
  try {
    const done = await audited(
      {
        action: "admin_action",
        ...ctx.who,
        details: {
          type: "approval_withdrawn",
          reason: "superseded",
          cause: ctx.reason.slice(0, 500),
          holdIds: ids,
          source: "runtime",
          key: ctx.key,
          scope: ctx.scope,
          count: ids.length,
        },
      },
      async () => {
        withdrawn = store.supersede
          ? [...(await store.supersede(ids, ctx.actorId, ctx.note))]
          : await oneByOne(store, batch, ctx.actorId, ctx.note);
        return withdrawn.length === ids.length
          ? { success: true as const }
          : {
              success: false as const,
              error: `${ids.length - withdrawn.length} already decided or run`,
            };
      }
    );
    void done;
  } catch (err) {
    logger.error(
      "Superseded holds could not be withdrawn (each one's approval will refuse stale)",
      {
        key: ctx.key,
        proposalIds: ids,
        error: err instanceof Error ? err.message : String(err),
        route: "platform/admin/hold-withdrawal",
      }
    );
    return { withdrawn: [], failed: ids };
  }
  return { withdrawn, failed: [] };
}

async function oneByOne(
  store: ProposalStore,
  batch: readonly ProposalRecord[],
  actorId: string,
  note: string
): Promise<string[]> {
  const out: string[] = [];
  for (const p of batch) {
    const r =
      p.status === "approved"
        ? await store.withdraw(p.proposalId, actorId, note)
        : await store.decide(p.proposalId, "rejected", actorId, note);
    if (r) out.push(p.proposalId);
  }
  return out;
}
