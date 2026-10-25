/**
 * platform/admin/agent-kill-switch.ts — Suspend every agent of a tenant at once (review 11 M-2)
 *
 * The emergency path: an operator suspends every registered agent of the current tenant in one
 * call, without a second admin — a strict reduction of power (power-reduction.ts proves it of the
 * exact change made), compare-and-set against the registry it replaces, recorded in config
 * history, audited (agents_emergency_suspended) and alerted. Reactivating an agent afterwards is a
 * widening, held for a second admin as before.
 *
 * Recorded before it is made and its outcome after (review 12 L3: audited() — attempted, then
 * succeeded or failed; no record, no suspension). On success, every pending hold on the registry
 * is withdrawn (review 12 H2: an approval of an older change would otherwise restore the agents it
 * replaces — and if a withdrawal does not land, that approval refuses stale), and the change is
 * published to every instance's config cache (review 12 L7). Run again when every agent is already
 * suspended, it writes nothing but publishes the invalidation again (review 13 L2): the recovery
 * when the first run's publish failed.
 *
 * Reached by POST /api/operator/tenants/[id]/agents/suspend (platform_operate) and, in every
 * deployment mode, by POST /api/admin/agents/suspend for the current tenant — a single-tenant
 * deployment's own administrators, holding config_manage_safety (review 12 L7). The runbook:
 * docs/runbooks/approvals-and-agents.md.
 *
 * @module platform/admin
 */

import {
  getEnhancedConfig,
  publishConfigInvalidation,
  setConfigWithHistory,
} from "@/platform/auth/platform-config";
import { audited } from "@/platform/auth/audit";
import { withdrawSupersededHolds } from "@/platform/admin/hold-withdrawal";
import type { VerifiedAdmin } from "@/platform/auth/role-governance";
import { isOperator, resolveConfigTarget } from "@/platform/admin/config-scope";
import { everyAgentSuspended, powerReduction } from "@/platform/admin/power-reduction";
import { raiseAlert } from "@/platform/observability/alert";
import { TRUSTED_AGENTS_KEY } from "@/platform/agents/governed-agent-config";

export { TRUSTED_AGENTS_KEY };

export type KillSwitchOutcome =
  | {
      readonly ok: true;
      readonly suspended: readonly string[];
      /** Pending holds on the registry withdrawn (review 12 H2). */
      readonly withdrawn?: readonly string[];
      /**
       * Nothing was active, so nothing was written; whether the registry's invalidation was
       * published again to every instance (review 13 L2 — the recovery for
       * config.invalidation_unpublished).
       */
      readonly republished?: boolean;
    }
  | { readonly ok: false; readonly error: string };

/** Suspend every active agent of the current tenant, as `admin` (an operator), for `reason`. */
export async function suspendAllAgents(
  admin: VerifiedAdmin,
  reason: string
): Promise<KillSwitchOutcome> {
  const entry = await getEnhancedConfig(TRUSTED_AGENTS_KEY);
  if (!entry) return { ok: false, error: "The agent registry could not be read." };
  const target = resolveConfigTarget(isOperator(admin), entry, undefined);
  if (!target.ok) return { ok: false, error: target.reason };
  const before = target.target.scope === "platform" ? entry.platformValue : entry.value;
  const after = everyAgentSuspended(before);
  const diff = powerReduction(TRUSTED_AGENTS_KEY, before, after);
  if (!diff.reduces) {
    // Nothing active: nothing to write — but the invalidation is published again (review 13 L2):
    // the run that suspended them may have failed to publish it (config.invalidation_unpublished),
    // and running the kill switch again is the runbook's recovery. Idempotent: a new stamp only
    // makes every instance re-read the registry. Anything else: the registry is not a well-formed
    // one, and a change that cannot be proved a reduction is not made unheld.
    if (diff.reason !== "nothing would change") {
      return { ok: false, error: `Not suspended: ${diff.reason}` };
    }
    const republished = await publishConfigInvalidation(TRUSTED_AGENTS_KEY);
    return { ok: true, suspended: [], republished };
  }
  const suspended = diff.changes.map((c) => c.replace(/^suspend /, ""));
  // Recorded before it takes effect (no record, no change), and its outcome after: a failed
  // compare-and-set is on file as failed, never read as done (review 12 L3).
  const result = await audited(
    {
      action: "admin_action",
      actorId: admin.userId,
      details: {
        type: "agents_emergency_suspended",
        key: TRUSTED_AGENTS_KEY,
        agents: suspended.slice(0, 200),
        reason: reason.slice(0, 500),
      },
    },
    () =>
      setConfigWithHistory(
        TRUSTED_AGENTS_KEY,
        after,
        admin.userId,
        `Emergency: every agent suspended — ${reason}`.slice(0, 1000),
        "admin_ui",
        entry,
        target.target,
        { expectPrevious: { value: before } }
      ),
    { recordSuccess: true }
  );
  if (!result.success) {
    return { ok: false, error: result.error ?? "The registry could not be written." };
  }
  // Every change held against the registry before the suspension is withdrawn (review 12 H2).
  const withdrawal = await withdrawSupersededHolds(
    TRUSTED_AGENTS_KEY,
    admin.userId,
    `every agent was suspended: ${reason}`,
    target.target.scope
  );
  raiseAlert({
    name: "agents.emergency_suspended",
    message:
      `Every agent of the tenant was suspended by an operator (${suspended.length}): ${reason}`.slice(
        0,
        500
      ),
    count: suspended.length,
  });
  return {
    ok: true,
    suspended,
    withdrawn: [...withdrawal.holds, ...withdrawal.approvals],
  };
}
