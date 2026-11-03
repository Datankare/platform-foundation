/**
 * components/admin/decision-outcome.ts — what a refused approval decision says, and what to do
 * next (TASK-194 round 15, I-1; round 16, items 1–4; round 17)
 *
 * One reader for every screen that decides held changes — the Approvals panel (HeldActionsPanel)
 * and an operator's Held changes of a tenant (TenancyPanels) — so neither says less than the
 * decision route answered: what became of the approval (kept, not kept, settling, withdrawn), and
 * when it is settled.
 */

import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { ERROR_CODES, isErrorCode } from "@/platform/errors/registry";
import { CONFIG_HOLD_TOOLS } from "@/platform/admin/hold-keys";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.held.${key}`, values);

/** What a refused decision's body says of the approval. */
export interface DecisionOutcome {
  /** Runtime holds: whether the approval stands (true: approving again retries it). */
  readonly approvalKept?: unknown;
  /** Not kept: within how many minutes the run is listed as undecided. */
  readonly undecidedWithinMinutes?: unknown;
  /** A config approval approved and not known to be applied: its outcome is being checked. */
  readonly settling?: unknown;
  readonly settlesWithinMinutes?: unknown;
  /** Withdrawn by the system (stale, or a value its entry refuses): the requester asks again. */
  readonly withdrawn?: unknown;
  /** The answer's code (the body carries it). */
  readonly code?: unknown;
}

/**
 * When it is settled, as the messages' `when` select takes it: within a number of minutes, or —
 * no bound given (round 17, nit 2: none is invented) — once its lease has passed.
 */
function when(minutes: unknown): MessageValues {
  return typeof minutes === "number" && Number.isFinite(minutes)
    ? { when: "minutes", minutes }
    : { when: "lease" };
}

/** Whether the outcome says the approval is gone, settling or not kept: read the list again. */
export function changesTheList(outcome: DecisionOutcome): boolean {
  return (
    outcome.withdrawn === true ||
    // Stale (round 21): withdrawn or not, the row is no longer what it was.
    outcome.code === "approvals.stale" ||
    outcome.settling === true ||
    outcome.approvalKept === false
  );
}

/**
 * What to say of a refused decision, beyond its row's message (undefined: the message alone).
 * What to do next depends on what became of the approval and why:
 *   - withdrawn by the system: the requester asks again;
 *   - stale, its withdrawal not recorded: nothing was changed — reject it if it is still listed
 *     (settling: once it is listed again, when), and the requester asks again;
 *   - settling — a config approval whose apply lost its commit, or one refused or stale whose
 *     withdrawal did not land (round 23): its outcome is being checked by the approval-expiry job,
 *     and it is listed again if it did not apply (a refused or stale one never did); stale has its
 *     own text, above (listed again: reject it then);
 *   - not kept (`approvalKept: false` — a run whose write lost its commit, or whose claim could not
 *     be given back): listed as undecided, to verify and mark executed or withdraw — never
 *     approved again blind; a config hold may also be approved again, since a retry of one that
 *     took effect is refused as stale;
 *   - kept (`approvalKept: true`): a change to the key already waiting, or being settled, must be
 *     done first; the requester's own standing (approvals.requester_lacks_permission) is said by
 *     its message; a service unavailable: approving it again retries it; another refusal (4xx)
 *     would meet a retry the same way: reject it.
 * `approvalKept` absent (a config approval, or no run): only the codes that say more themselves.
 */
export function refusedDecisionText(
  label: string,
  refused: { readonly code: string; readonly message: string },
  outcome: DecisionOutcome = {}
): string | undefined {
  const reason = refused.message;
  // An undecided duplicate is not approved again (round 6, I-2): what to do instead.
  // The catalog's message is generic; for an erasure the panel names it (round 9, N-1).
  if (refused.code === "approvals.duplicate_undecided")
    return label === "purge_user_data"
      ? t("result_duplicate_undecided", { label })
      : `${label}: ${reason}`;
  if (outcome.withdrawn === true)
    return t("result_approved_withdrawn", { label, reason });
  // Stale, its withdrawal not recorded (round 21): what to do — never that it was withdrawn. Left
  // settling (round 22, I-1: a two-person approval whose withdrawal did not land waits for the
  // approval-expiry job): it is not listed until then — when, and to reject it then.
  if (refused.code === "approvals.stale")
    return outcome.settling === true
      ? t("result_approved_stale_settling", {
          label,
          ...when(outcome.settlesWithinMinutes),
        })
      : t("result_approved_stale", { label });
  if (outcome.settling === true)
    return t("result_approved_settling", {
      label,
      reason,
      ...when(outcome.settlesWithinMinutes),
    });
  if (outcome.approvalKept === false)
    return t(
      CONFIG_HOLD_TOOLS.has(label)
        ? "result_approved_undecided_config"
        : "result_approved_undecided",
      { label, ...when(outcome.undecidedWithinMinutes) }
    );
  // Approved, and the run failed: the approval stands (approving again retries it).
  if (refused.code === "approvals.run_failed")
    return t("result_approved_failed", { label, reason });
  if (outcome.approvalKept === true) {
    if (refused.code === "approvals.already_pending")
      return t("result_approved_waiting", { label, reason });
    if (refused.code === "approvals.settling")
      return t("result_approved_after_settling", { label, reason });
    // The requester's standing, in its own words — never the approver's (round 17, I-3).
    if (refused.code === "approvals.requester_lacks_permission")
      return t("result_approved_failed", { label, reason });
    // A service unavailable may answer next time; a refusal (a value its entry no longer takes,
    // a target gone, a place it may not go) would meet the retry the same way.
    const status = isErrorCode(refused.code) ? ERROR_CODES[refused.code].status : 500;
    return status >= 500
      ? t("result_approved_retry", { label, reason })
      : t("result_approved_refused", { label, reason });
  }
  return undefined;
}
