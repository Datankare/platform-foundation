"use client";

/**
 * components/admin/HeldActionsPanel.tsx — the pending-approvals surface (ADR-040, 040a read +
 * 040c decision). One card per held change; each decision clears it through the deterministic
 * decision route (POST /api/admin/approvals/[id]), which checks the decider's authority and
 * independence itself.
 *
 * What the approver decides, in full (TASK-202, N-61): each card says what the change is — a
 * setting by name with its value now and after (a list's items added and removed), an account by
 * address with its role from → to and the permissions it grants by name, an erasure's account and
 * the kind of reason it was asked for — who asked (address and role, never an id), when, and
 * their own words. The route gives what a hold changes only to a viewer who could decide it.
 *
 * On the console's shared parts (TASK-220):
 *
 *   - every decision confirms, in one step that takes focus and gives it back (SF-admin-030, 034):
 *     Approve, Reject — and, on a run whose outcome is unknown, Took effect, Approve again and
 *     Withdraw, which acted on one click; approving is as grave as the change (approving an
 *     erasure erases), rejecting and withdrawing cannot be undone;
 *   - a decision the route would refuse is not offered blind (E-56, SF-admin-032): without the
 *     hold's permission every decision is disabled, saying which permission by name; on one's own
 *     request Approve is (rejecting one's own request stays open); on a hold that acts on one's own
 *     account, every decision; Approve, when the account's role changed since the request;
 *   - codes are names: permissions, features, roles, settings, an erasure's kind of reason
 *     (SF-admin-031, 036); "who can approve" names the permission;
 *   - what became of a decision is said once, in the console's outcome list, kept until dismissed
 *     (SF-admin-033, 037: a refusal was also repeated under its card, keyed by id alone);
 *   - after a decision the section is read again through the console (no read of its own).
 *
 * @module components/admin
 */

import { renderShown } from "@/platform/errors/shown-text";
import React, { useRef, useState } from "react";
import type { PendingApproval } from "@/platform/admin/pending-approvals";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { PURGE_REASONS } from "@/platform/gdpr/types";
import {
  changesTheList,
  refusedDecisionText,
  type DecisionOutcome,
} from "./decision-outcome";
import { result, type ShownResult } from "./ResultList";
import { ExpandableText } from "./ExpandableText";
import { changeValueText, listChange, sameValue } from "./config-value";
import { formatDateTime, fullTimestamp, readableRole } from "./admin-format";
import { adminCall } from "@/components/admin/ui/admin-call";
import { ConfirmStep } from "@/components/admin/ui/ConfirmStep";
import { GatedButton, needsPermission } from "@/components/admin/ui/PermissionGate";
import { outcome, type OutcomeEntry } from "@/components/admin/ui/Outcome";
import { IdDetail } from "@/components/admin/ui/Ref";
import {
  featureLabel,
  labelled,
  permissionLabel,
  purgeReasonLabel,
  roleLabel,
  settingLabel,
  toolLabel,
} from "@/components/admin/ui/labels";
import { BUTTON, SURFACE, TEXT } from "@/components/admin/ui/tokens";
import { useOutcomes, ListUnreadable } from "@/components/admin/views/kit";
import { ReadFailed } from "@/components/admin/ui/PanelState";
import { handleRefusal } from "@/platform/errors/refusal";
import type { SectionViewProps } from "@/components/admin/section-views";
import { sectionTitle } from "@/components/admin/ui/sections";

export type Decision = "approve" | "reject" | "mark_executed" | "reapprove" | "withdraw";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.held.${key}`, values);

/** Who may approve a hold, in words (its required permission, by name). */
export function approverText(permission: string): string {
  switch (permission) {
    case "config_manage_safety":
      return t("approver_safety");
    case "config_manage_standard":
      return t("approver_standard");
    default:
      return t("approver_other", { permission: permissionLabel(permission) });
  }
}

/**
 * The account a hold acts on, by address (never its id) — or, with no address to give, the
 * catalog's words for it ("an account that is no longer found"). `known` says which: a template
 * that names "the account {account}" takes only an address (TASK-208, N-111).
 */
function accountText(
  summary: PendingApproval["summary"]
): { readonly text: string; readonly known: boolean } | undefined {
  const target = summary?.target;
  if (!target) return undefined;
  if (target.notFound) return { text: t("account_missing"), known: false };
  return target.email
    ? { text: target.email, known: true }
    : { text: t("requester_no_email"), known: false };
}

/** A tool's name in words (the catalog's), for a hold whose details the viewer does not see. */
function toolText(label: string): string {
  return toolLabel(label);
}

/**
 * What a hold is, in one line — the result texts name it too (N-62): a setting by its name, an
 * account's change by its address, a role or group by its name; else the kind of change.
 */
export function describeWhat(
  a: Pick<PendingApproval, "change" | "summary" | "label" | "configKey">
): string {
  if (a.change)
    return a.change.action === "reset"
      ? t("what_config_reset", { key: settingLabel(a.change.key) })
      : t("what_config", { key: settingLabel(a.change.key) });
  const s = a.summary;
  const named = accountText(s);
  const account = named?.text;
  switch (a.label) {
    case "change_user_role":
      return account ? t("what_role_change", { account }) : toolText(a.label);
    case "purge_user_data":
      return named
        ? t("what_erasure", { account: named.text, known: String(named.known) })
        : toolText(a.label);
    case "block_user_feature":
      return account && s?.feature
        ? t("what_block", { account, feature: featureLabel(s.feature) })
        : toolText(a.label);
    case "unblock_user_feature":
      return account && s?.feature
        ? t("what_unblock", { account, feature: featureLabel(s.feature) })
        : toolText(a.label);
    case "create_role":
      return s?.role
        ? t("what_create_role", { role: roleLabel(s.role) })
        : toolText(a.label);
    case "delete_role":
      return s?.role
        ? t("what_delete_role", { role: roleLabel(s.role) })
        : toolText(a.label);
    case "duplicate_role":
      return s?.role && s.fromRole
        ? t("what_duplicate_role", {
            role: roleLabel(s.role),
            from: roleLabel(s.fromRole),
          })
        : toolText(a.label);
    case "assign_permissions":
      return s?.role
        ? t("what_assign_permissions", { role: roleLabel(s.role) })
        : toolText(a.label);
    case "create_entitlement_group":
      return s?.group ? t("what_create_group", { group: s.group }) : toolText(a.label);
    case "set_entitlement_group_active":
      return s?.group
        ? t("what_group_active", { group: s.group, active: String(s.active === true) })
        : toolText(a.label);
    case "set_approval_policy":
      return t("what_policy");
    default:
      // A config hold the viewer may not decide: its setting, which the listing gives everyone.
      return a.configKey
        ? t("what_config", { key: settingLabel(a.configKey) })
        : toolText(a.label);
  }
}

/** An erasure's kind of reason by its label (SF-admin-036); any other reason as written. */
function reasonText(reason: string): string {
  return (PURGE_REASONS as readonly string[]).includes(reason)
    ? purgeReasonLabel(reason)
    : reason;
}

/**
 * An erasure's kind of reason (PURGE_REASONS), by its label — what its requester gave as their
 * reason: an erasure's hold keeps no free text (TASK-194 round 9, I-3), so this is all they said
 * (TASK-220, SF-admin-036: the card read "Reason: admin-action" and "Their reason: No reason
 * given." together).
 */
export function erasureReason(
  a: Pick<PendingApproval, "label" | "summary">
): string | null {
  const reason = a.summary?.reason;
  return a.label === "purge_user_data" &&
    typeof reason === "string" &&
    (PURGE_REASONS as readonly string[]).includes(reason)
    ? purgeReasonLabel(reason)
    : null;
}

/** The lines of a hold's summary beyond its one-line what (role, permissions, reason, policy). */
export function summaryLines(
  summary: PendingApproval["summary"],
  /** The reason is said elsewhere on the card (an erasure's, as its requester's reason). */
  withoutReason = false
): string[] {
  if (!summary) return [];
  const lines: string[] = [];
  const role = (name: string | null | undefined) =>
    name ? roleLabel(name) : t("summary_role_unknown");
  if (summary.fromRole || summary.toRole)
    lines.push(
      t("summary_role", { from: role(summary.fromRole), to: role(summary.toRole) })
    );
  if (summary.roleChangedSince)
    lines.push(t("summary_role_changed", { role: role(summary.roleChangedSince.now) }));
  if (summary.permissionsGranted?.length)
    lines.push(
      t("summary_granted", {
        permissions: labelled(summary.permissionsGranted, permissionLabel),
      })
    );
  if (summary.permissionsRemoved?.length)
    lines.push(
      t("summary_removed", {
        permissions: labelled(summary.permissionsRemoved, permissionLabel),
      })
    );
  if (summary.feature)
    lines.push(t("summary_feature", { feature: featureLabel(summary.feature) }));
  if (summary.reason && !withoutReason)
    lines.push(t("summary_reason", { reason: reasonText(summary.reason) }));
  if (summary.dryRun) lines.push(t("summary_dry_run"));
  // A held policy change: each rule it would store, then its default approver (round 12, I-2) —
  // risks, effects and approvers in the catalog's words (round 13, nit 6: ICU selects).
  if (summary.approvalPolicy) {
    const policy = summary.approvalPolicy;
    if (policy.rules.length === 0) lines.push(t("summary_policy_no_rules"));
    policy.rules.forEach((rule, i) =>
      lines.push(
        rule.effects && rule.effects.length > 0
          ? t("summary_policy_rule_effects", {
              n: i + 1,
              risk: rule.maxRisk,
              effects: rule.effects.map((effect) =>
                t("summary_policy_effect", { effect })
              ),
              approver: rule.requiredApprover,
            })
          : t("summary_policy_rule", {
              n: i + 1,
              risk: rule.maxRisk,
              approver: rule.requiredApprover,
            })
      )
    );
    lines.push(
      policy.defaultApprover
        ? t("summary_policy_default", { approver: policy.defaultApprover })
        : t("summary_policy_default_kept")
    );
    // What the rules do not change (round 13, I-A; ADR-030/ADR-040 addendum).
    lines.push(t("summary_policy_restricted"));
  }
  return lines;
}

/** Who asked, by address and role — never an id (N-61). Shared with the operators' Tenant panel. */
export function requesterText(a: Pick<PendingApproval, "requestedBy">): string {
  const r = a.requestedBy;
  if (!r || r.kind === "unknown") return t("requester_unknown");
  if (r.kind === "erased") return t("requester_erased");
  if (!r.email) return t("requester_no_email");
  // The role as the Users screen reads one ("Super Admin" → "Super admin", TASK-190).
  return r.role
    ? `${t("requester_account", { email: r.email })} (${t("requester_role", {
        role: readableRole(r.role, null),
      })})`
    : t("requester_account", { email: r.email });
}

/** A setting's change: its value now and after; a list's items added and removed. */
export function ChangeDiff({
  change,
}: {
  readonly change: NonNullable<PendingApproval["change"]>;
}) {
  const items = listChange(change.before, change.after, change.key);
  return (
    <div className="mt-2 space-y-1 text-xs" data-diff="true">
      {change.scope ? (
        <p className={TEXT.faint}>
          {change.scope === "platform"
            ? t("diff_scope_platform")
            : t("diff_scope_tenant")}
        </p>
      ) : null}
      {sameValue(change.before, change.after) ? (
        <p className={TEXT.faint}>{t("diff_unchanged")}</p>
      ) : items && (items.added.length > 0 || items.removed.length > 0) ? (
        <>
          {items.added.map((x) => (
            <p key={`+${x}`} className="break-words text-green-300">
              <span className="sr-only">{t("diff_added")}: </span>+ {x}
            </p>
          ))}
          {items.removed.map((x) => (
            <p key={`-${x}`} className="break-words text-red-300">
              <span className="sr-only">{t("diff_removed")}: </span>− {x}
            </p>
          ))}
        </>
      ) : (
        <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
          <span className={TEXT.faint}>{t("diff_before")}</span>
          <span className="min-w-0 text-red-200">
            <ExpandableText
              text={changeValueText(change.key, change.before)}
              column={t("diff_before")}
              mono
            />
          </span>
          <span className={TEXT.faint}>{t("diff_after")}</span>
          <span className="min-w-0 text-green-200">
            <ExpandableText
              text={changeValueText(change.key, change.after)}
              column={t("diff_after")}
              mono
            />
          </span>
        </div>
      )}
    </div>
  );
}

/** What a hold changes, in full: its what, its diff, its summary lines. */
function WhatItChanges({ a }: { readonly a: PendingApproval }) {
  const lines = summaryLines(a.summary, erasureReason(a) !== null);
  return (
    <div>
      <p className={`break-words text-sm font-semibold ${TEXT.strong}`}>
        {describeWhat(a)}
      </p>
      {a.change ? <ChangeDiff change={a.change} /> : null}
      {lines.map((line) => (
        <span
          key={line}
          data-summary="true"
          className={`block break-words text-xs ${TEXT.body}`}
        >
          {line}
        </span>
      ))}
      {!a.change && !a.summary ? (
        <span className={`block text-xs ${TEXT.faint}`}>{t("hidden")}</span>
      ) : null}
    </div>
  );
}

/** What a decision the server accepted did, naming the change (its 200 body; N-62). */
export function acceptedResult(
  decision: Decision,
  a: PendingApproval,
  body: Record<string, unknown>
): ShownResult {
  const what = describeWhat(a);
  if (decision === "reject")
    return result("applied", t("result_rejected_what", { what }));
  if (decision === "mark_executed") return result("applied", t("result_done", { what }));
  if (decision === "withdraw")
    return result("applied", t("result_withdrawn_now", { what }));
  if (body.pendingApproval) return result("held", t("result_waits", { what }));
  if (body.recorded === false) return result("applied", t("result_unrecorded", { what }));
  // A config change applied: what it is now. A two-person approval's 200 is its apply.
  if (a.change && (a.source === "config-approval" || body.applied === true))
    return result(
      "applied",
      t("result_applied_config", {
        what,
        value: changeValueText(a.change.key, a.change.after),
      })
    );
  return result("applied", t("result_applied", { what }));
}

/**
 * Why a hold waits, in the catalog's words (N-61): a two-person approval of a setting, a change
 * under dual control, or a run to retry or verify.
 */
export function whyHeld(a: PendingApproval): string {
  if (a.state === "undecided" || a.undecided) return t("why_undecided");
  if (a.state === "retry") return t("why_retry");
  return a.source === "config-approval" ? t("why_two_person") : t("why_dual_control");
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Why each decision is not offered to this viewer (null: it is) — display only (E-56). */
export interface DecisionGate {
  readonly approve: string | null;
  readonly reject: string | null;
  /** Took effect, Approve again, Withdraw: a run whose outcome is unknown. */
  readonly undecided: string | null;
}

/**
 * What the decision route would refuse this viewer, said before they try (E-56, SF-admin-032):
 * every decision without the hold's permission; approving — or any decision on an undecided run —
 * on one's own request (rejecting one's own request is allowed); every decision on a hold that
 * acts on one's own account; approving a role change whose account's role changed since. The
 * route checks each itself whatever this says (approval-decision.ts).
 */
export function decisionGate(
  a: PendingApproval,
  viewerId: string | undefined,
  hasPermission: (code: string) => boolean
): DecisionGate {
  if (!hasPermission(a.requiredPermission)) {
    const why = needsPermission(a.requiredPermission);
    return { approve: why, reject: why, undecided: why };
  }
  if (same(a.summary?.target?.id, viewerId)) {
    const why = t("gate_own_account");
    return { approve: why, reject: why, undecided: why };
  }
  const own = same(a.requester, viewerId) ? t("gate_own_request") : null;
  return {
    approve: own ?? (a.summary?.roleChangedSince ? t("gate_role_changed") : null),
    reject: null,
    undecided: own,
  };
}

/** Each decision's words: its button, its button's name, its confirm step's title and button. */
const DECISION_WORDS: Record<
  Decision,
  { button: string; label: string; title: string; confirm: string; action: string }
> = {
  approve: {
    button: "approve",
    label: "approve_label",
    title: "confirm_approve_title",
    confirm: "confirm_approve",
    action: "approvals.approve",
  },
  reject: {
    button: "reject",
    label: "reject_label",
    title: "confirm_reject_title",
    confirm: "confirm_reject",
    action: "approvals.reject",
  },
  mark_executed: {
    button: "mark_executed",
    label: "mark_executed_label",
    title: "confirm_mark_executed_title",
    confirm: "confirm_mark_executed",
    action: "approvals.mark_executed",
  },
  reapprove: {
    button: "reapprove",
    label: "reapprove_label",
    title: "confirm_reapprove_title",
    confirm: "confirm_reapprove",
    action: "approvals.reapprove",
  },
  withdraw: {
    button: "withdraw",
    label: "withdraw_label",
    title: "confirm_withdraw_title",
    confirm: "confirm_withdraw",
    action: "approvals.withdraw",
  },
};

/**
 * One held change's card: what it is, who asked and why, and the decisions this viewer has. The
 * operators' view of a tenant's held changes shows the same card (TASK-221, SF-admin-111).
 */
export function HoldCard({
  a,
  gate,
  busy,
  showIds,
  onDecide,
}: {
  readonly a: PendingApproval;
  readonly gate: DecisionGate;
  readonly busy: boolean;
  readonly showIds: boolean;
  readonly onDecide: (decision: Decision, note: string) => Promise<void>;
}) {
  const [asking, setAsking] = useState<Decision | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const what = describeWhat(a);
  const decisions: Decision[] = a.undecided
    ? ["mark_executed", "reapprove", "withdraw"]
    : ["approve", "reject"];
  const reasonFor = (d: Decision) =>
    d === "approve" ? gate.approve : d === "reject" ? gate.reject : gate.undecided;
  return (
    <li data-approval={a.id} data-source={a.source} className={`${SURFACE.panel} p-4`}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <WhatItChanges a={a} />
          <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-[8rem_1fr]">
            <dt className={TEXT.faint}>{t("who")}</dt>
            <dd className={`min-w-0 break-words ${TEXT.body}`} data-requester="true">
              {requesterText(a)}
            </dd>
            <dt className={TEXT.faint}>{t("when")}</dt>
            <dd className={TEXT.body}>
              <time dateTime={a.createdAt} title={fullTimestamp(a.createdAt)}>
                {formatDateTime(a.createdAt)}
              </time>
            </dd>
            <dt className={TEXT.faint}>{t("comment")}</dt>
            <dd className={`min-w-0 break-words ${TEXT.body}`}>
              {a.comment ? (
                <ExpandableText text={a.comment} column={t("comment")} />
              ) : a.commentShown ? (
                <ExpandableText
                  text={renderShown(a.commentShown)}
                  column={t("comment")}
                />
              ) : (
                (erasureReason(a) ?? t("no_comment"))
              )}
            </dd>
            <dt className={TEXT.faint}>{t("approver")}</dt>
            <dd className={TEXT.body}>{approverText(a.requiredPermission)}</dd>
            <dt className={TEXT.faint}>{t("why")}</dt>
            <dd className={`min-w-0 break-words ${TEXT.body}`}>
              {whyHeld(a)}
              {a.state === "held" ? null : (
                // A failed or undecided run: the server's detail, behind Details.
                <details className={`mt-1 ${TEXT.faint}`}>
                  <summary className="cursor-pointer text-blue-300">
                    {t("details")}
                  </summary>
                  <span className="break-words">{renderShown(a.reason)}</span>
                </details>
              )}
            </dd>
            {showIds ? (
              <>
                <dt className={TEXT.faint}>{t("reference")}</dt>
                <dd>
                  <IdDetail id={a.id} show />
                </dd>
              </>
            ) : null}
          </dl>
          {a.undecided && a.noEligibleDecider && (
            <span className="block text-xs text-amber-200">
              {t("no_eligible_decider", {
                permission: permissionLabel(a.requiredPermission),
              })}
            </span>
          )}
        </div>
        {
          // Kept while a decision is being confirmed (disabled): focus comes back to its button.
          <div className="flex shrink-0 flex-wrap gap-2">
            {decisions.map((d) => (
              <GatedButton
                key={d}
                allowed={reasonFor(d) === null}
                reason={reasonFor(d)}
                disabled={busy || asking !== null}
                data-decision={d}
                aria-label={t(DECISION_WORDS[d].label, { what, label: what })}
                className={
                  d === "approve" || d === "reapprove" || d === "mark_executed"
                    ? BUTTON.primary
                    : BUTTON.quiet
                }
                onClick={(e) => {
                  opener.current = e.currentTarget;
                  setAsking(d);
                }}
              >
                {t(DECISION_WORDS[d].button)}
              </GatedButton>
            ))}
          </div>
        }
      </div>
      {asking ? (
        <div className="mt-4">
          <ConfirmStep
            action={DECISION_WORDS[asking].action}
            heldTool={a.label}
            title={t(DECISION_WORDS[asking].title)}
            confirmLabel={t(DECISION_WORDS[asking].confirm)}
            returnFocus={opener}
            busy={busy}
            onCancel={() => setAsking(null)}
            onConfirm={(given) =>
              void onDecide(asking, given.reason).then(() => setAsking(null))
            }
          >
            <WhatItChanges a={a} />
            <p className="text-xs">
              {t("who")}: {requesterText(a)}
            </p>
            <p className="text-xs">{t(`confirm_note_${asking}`)}</p>
          </ConfirmStep>
        </div>
      ) : null}
    </li>
  );
}

/**
 * One decision on a held change, sent to `url` (the admin's decision route, or an operator's for a
 * tenant's change): what became of it, as an outcome naming the change — and whether the listing
 * should be read again (decided, or no longer what it was).
 */
export async function decideHeld(
  url: string,
  row: PendingApproval,
  decision: Decision,
  note: string
): Promise<{
  readonly entry: OutcomeEntry;
  readonly accepted: boolean;
  readonly reload: boolean;
}> {
  const answer = await adminCall(url, {
    method: "POST",
    json: { decision, source: row.source, ...(note ? { note } : {}) },
  });
  const what = describeWhat(row);
  if (!answer.ok) {
    // What became of the approval (round 15, I-1; round 16), from the refusal's own body.
    const kept = answer.body as DecisionOutcome;
    const text = refusedDecisionText(row.label, answer.refusal, kept, what);
    return {
      entry: text
        ? outcome("refused", text, { refusal: answer.refusal })
        : outcome("refused", answer.refusal.message, {
            action: what,
            refusal: answer.refusal,
          }),
      accepted: false,
      // Withdrawn, settling or not kept: the row is no longer what it was — read the list again.
      reload: changesTheList(kept),
    };
  }
  const shown = acceptedResult(decision, row, answer.body);
  return { entry: outcome(shown.kind, shown.text), accepted: true, reload: true };
}

export function HeldActionsPanel({
  data,
  hasPermission = () => false,
  onReload,
  viewerId,
  showIds = false,
}: Partial<SectionViewProps> & {
  data?: { approvals?: PendingApproval[]; unreadable?: unknown };
}) {
  const [rows, setRows] = useState<PendingApproval[]>(data?.approvals ?? []);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const { add, list } = useOutcomes(t("results_label"));

  // Fresh data from the page replaces the rows, adjusted during render (React's pattern for
  // state that follows a prop) rather than in an effect, which rendered the stale rows first.
  const [shownData, setShownData] = useState(data);
  if (data !== shownData) {
    setShownData(data);
    setRows(data?.approvals ?? []);
  }

  async function decide(row: PendingApproval, decision: Decision, note: string) {
    const key = `${row.source}:${row.id}`;
    setBusyKey(key);
    const decided = await decideHeld(
      `/api/admin/approvals/${encodeURIComponent(row.id)}`,
      row,
      decision,
      note
    );
    setBusyKey(null);
    add(decided.entry);
    if (decided.accepted)
      setRows((rs) => rs.filter((r) => !(r.id === row.id && r.source === row.source)));
    if (decided.reload) onReload?.();
  }

  // A body without its list is not an empty list (review 14 L-1): said as a failed read.
  if (!Array.isArray(data?.approvals))
    return <ListUnreadable panel={sectionTitle("approvals")} onRetry={onReload} />;
  // A source the listing could not read (TASK-220, SF-admin-004): said, so what is listed is
  // never taken for all that waits — and an empty list never for "nothing waits".
  const unreadable = Array.isArray(data?.unreadable)
    ? (data.unreadable as string[]).filter(
        (u) => u === "runtime" || u === "config-approval"
      )
    : [];
  return (
    <div>
      {list}
      {unreadable.length ? (
        <ReadFailed
          panel={sectionTitle("approvals")}
          refusal={handleRefusal("service.unavailable", {
            message: t("unreadable", {
              sources: unreadable.map((u) => t(`unreadable_${u.replace("-", "_")}`)),
            }),
          })}
          onRetry={onReload}
        />
      ) : null}
      {rows.length === 0 && unreadable.length === 0 ? (
        <div className={`${SURFACE.panel} overflow-hidden`}>
          <p className={`px-4 py-8 text-center text-sm ${TEXT.faint}`}>{t("empty")}</p>
        </div>
      ) : rows.length === 0 ? null : (
        <ul aria-label={t("caption")} className="space-y-3">
          {rows.map((a) => {
            const key = `${a.source}:${a.id}`;
            return (
              <HoldCard
                key={key}
                a={a}
                gate={decisionGate(a, viewerId, hasPermission)}
                busy={busyKey === key}
                showIds={showIds}
                onDecide={(decision, note) => decide(a, decision, note)}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}
