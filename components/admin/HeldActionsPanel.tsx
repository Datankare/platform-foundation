"use client";

/**
 * components/admin/HeldActionsPanel.tsx — the pending-approvals surface (ADR-040, 040a read +
 * 040c decision). One card per held change; Approve / Reject clear it through the deterministic
 * decision route (POST /api/admin/approvals/[id]). Self-approval is enforced server-side (409);
 * the panel surfaces that (and any 403) inline rather than pre-disabling, since the acting
 * admin's identity is not available client-side.
 *
 * What the approver decides, in full (TASK-202, N-61 — the owner approved blind: the row showed
 * the tool's name and a requester's id): each card says what the change is — a setting's key with
 * its value now and after (a list's items added and removed), an account by address with its
 * role from → to and the permissions it grants, an erasure's account — who asked (address and
 * role, resolved on the server, never an id), when, and their reason. The route gives what a hold
 * changes only to a viewer who could decide it (round 2, N2); anyone else sees what kind of change
 * it is. Approve and Reject each ask once more, repeating what is decided.
 *
 * An approved run whose outcome is unknown (review 11 H-1: it did not end within its lease) is
 * not approved or rejected: after verifying, an admin marks it executed, or — when it did not take
 * effect — approves it again (a fresh approval) or withdraws it (closed, never run: TASK-194 round
 * 5). Each is recorded.
 *
 * After a decision the panel says what happened, naming the change (TASK-202, N-62) — applied,
 * waiting for a second approval, rejected, or why not — and the result stays until dismissed
 * (ResultList). A refusal goes through the shared handler (readRefusal): its catalog message, and
 * an erased session ends.
 */

import { renderShown } from "@/platform/errors/shown-text";
import React, { useState } from "react";
import type { PendingApproval } from "@/platform/admin/pending-approvals";
import { apiFetch } from "@/platform/auth/api-fetch";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { announceSessionEnd, readRefusal } from "@/platform/errors/refusal";
import {
  changesTheList,
  refusedDecisionText,
  type DecisionOutcome,
} from "./decision-outcome";
import { ResultList, result, type ShownResult } from "./ResultList";
import { ExpandableText } from "./ExpandableText";
import { listChange, sameValue, shownValue } from "./config-value";
import { formatDateTime, fullTimestamp, readableRole } from "./admin-format";

type Decision = "approve" | "reject" | "mark_executed" | "reapprove" | "withdraw";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.held.${key}`, values);

/** Who may approve a hold, in words (its required permission). */
export function approverText(permission: string): string {
  switch (permission) {
    case "config_manage_safety":
      return t("approver_safety");
    case "config_manage_standard":
      return t("approver_standard");
    default:
      return t("approver_other", { permission });
  }
}

/** The account a hold acts on, by address (never its id). */
function accountText(summary: PendingApproval["summary"]): string | undefined {
  const target = summary?.target;
  if (!target) return undefined;
  if (target.notFound) return t("account_missing");
  return target.email ?? t("requester_no_email");
}

/** A tool's name in words (the catalog's), for a hold whose details the viewer does not see. */
function toolText(label: string): string {
  const key = `screens.admin_console.tools.${label}`;
  const text = renderMessage(key);
  return text === key ? t("what_tool", { tool: label }) : text;
}

/**
 * What a hold is, in one line — the result texts name it too (N-62): a setting by its key, an
 * account's change by its address, a role or group by its name; else the kind of change.
 */
export function describeWhat(
  a: Pick<PendingApproval, "change" | "summary" | "label" | "configKey">
): string {
  if (a.change)
    return a.change.action === "reset"
      ? t("what_config_reset", { key: a.change.key })
      : t("what_config", { key: a.change.key });
  const s = a.summary;
  const account = accountText(s);
  switch (a.label) {
    case "change_user_role":
      return account ? t("what_role_change", { account }) : toolText(a.label);
    case "purge_user_data":
      return account ? t("what_erasure", { account }) : toolText(a.label);
    case "block_user_feature":
      return account && s?.feature
        ? t("what_block", { account, feature: s.feature })
        : toolText(a.label);
    case "unblock_user_feature":
      return account && s?.feature
        ? t("what_unblock", { account, feature: s.feature })
        : toolText(a.label);
    case "create_role":
      return s?.role ? t("what_create_role", { role: s.role }) : toolText(a.label);
    case "delete_role":
      return s?.role ? t("what_delete_role", { role: s.role }) : toolText(a.label);
    case "duplicate_role":
      return s?.role && s.fromRole
        ? t("what_duplicate_role", { role: s.role, from: s.fromRole })
        : toolText(a.label);
    case "assign_permissions":
      return s?.role ? t("what_assign_permissions", { role: s.role }) : toolText(a.label);
    case "create_entitlement_group":
      return s?.group ? t("what_create_group", { group: s.group }) : toolText(a.label);
    case "set_entitlement_group_active":
      return s?.group
        ? t("what_group_active", { group: s.group, active: String(s.active === true) })
        : toolText(a.label);
    case "set_approval_policy":
      return t("what_policy");
    default:
      // A config hold the viewer may not decide: its key, which the listing gives everyone.
      return a.configKey ? t("what_config", { key: a.configKey }) : toolText(a.label);
  }
}

/** The lines of a hold's summary beyond its one-line what (role, permissions, reason, policy). */
export function summaryLines(summary: PendingApproval["summary"]): string[] {
  if (!summary) return [];
  const lines: string[] = [];
  if (summary.fromRole || summary.toRole) {
    lines.push(
      t("summary_role", {
        from: summary.fromRole ?? t("summary_role_unknown"),
        to: summary.toRole ?? t("summary_role_unknown"),
      })
    );
  }
  if (summary.roleChangedSince) {
    lines.push(
      t("summary_role_changed", {
        role: summary.roleChangedSince.now ?? t("summary_role_unknown"),
      })
    );
  }
  if (summary.permissionsGranted?.length)
    lines.push(t("summary_granted", { permissions: [...summary.permissionsGranted] }));
  if (summary.permissionsRemoved?.length)
    lines.push(t("summary_removed", { permissions: [...summary.permissionsRemoved] }));
  if (summary.feature) lines.push(t("summary_feature", { feature: summary.feature }));
  if (summary.reason) lines.push(t("summary_reason", { reason: summary.reason }));
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
  const items = listChange(change.before, change.after);
  return (
    <div className="mt-2 space-y-1 text-xs" data-diff="true">
      {change.scope ? (
        <p className="text-gray-400">
          {change.scope === "platform"
            ? t("diff_scope_platform")
            : t("diff_scope_tenant")}
        </p>
      ) : null}
      {sameValue(change.before, change.after) ? (
        <p className="text-gray-400">{t("diff_unchanged")}</p>
      ) : items && (items.added.length > 0 || items.removed.length > 0) ? (
        <>
          {items.added.map((x) => (
            <p key={`+${x}`} className="break-all font-mono text-green-300">
              <span className="sr-only">{t("diff_added")}: </span>+ {x}
            </p>
          ))}
          {items.removed.map((x) => (
            <p key={`-${x}`} className="break-all font-mono text-red-300">
              <span className="sr-only">{t("diff_removed")}: </span>− {x}
            </p>
          ))}
        </>
      ) : (
        <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
          <span className="text-gray-400">{t("diff_before")}</span>
          <span className="min-w-0 font-mono text-red-200">
            <ExpandableText
              text={shownValue(change.before)}
              column={t("diff_before")}
              mono
            />
          </span>
          <span className="text-gray-400">{t("diff_after")}</span>
          <span className="min-w-0 font-mono text-green-200">
            <ExpandableText
              text={shownValue(change.after)}
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
  const lines = summaryLines(a.summary);
  return (
    <div>
      <p className="break-words text-sm font-semibold text-white">{describeWhat(a)}</p>
      {a.change ? <ChangeDiff change={a.change} /> : null}
      {lines.map((line) => (
        <span
          key={line}
          data-summary="true"
          className="block break-words text-xs text-gray-200"
        >
          {line}
        </span>
      ))}
      {!a.change && !a.summary ? (
        <span className="block text-xs text-gray-400">{t("hidden")}</span>
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
      t("result_applied_config", { what, value: shownValue(a.change.after) })
    );
  return result("applied", t("result_applied", { what }));
}

/**
 * Why a hold waits, in the catalog's words (N-61: the server's "Held at effectiveRisk
 * "restricted" (effects: stateWrite)" meant nothing to an approver): a two-person approval of a
 * setting, a change under dual control, or a run to retry or verify.
 */
export function whyHeld(a: PendingApproval): string {
  if (a.state === "undecided" || a.undecided) return t("why_undecided");
  if (a.state === "retry") return t("why_retry");
  return a.source === "config-approval" ? t("why_two_person") : t("why_dual_control");
}

const button = "px-3 py-1.5 text-xs rounded border disabled:opacity-50 whitespace-nowrap";

export function HeldActionsPanel({ data }: { data?: { approvals?: PendingApproval[] } }) {
  const [rows, setRows] = useState<PendingApproval[]>(data?.approvals ?? []);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [results, setResults] = useState<ShownResult[]>([]);
  const [confirming, setConfirming] = useState<{
    readonly key: string;
    readonly decision: "approve" | "reject";
  } | null>(null);

  // Fresh data from the page replaces the rows, adjusted during render (React's pattern for
  // state that follows a prop) rather than in an effect, which rendered the stale rows first.
  const [shownData, setShownData] = useState(data);
  if (data !== shownData) {
    setShownData(data);
    setRows(data?.approvals ?? []);
  }

  const show = (r: ShownResult) => setResults((rs) => [r, ...rs]);

  /** The list as the server has it now (round 16): best effort — the rows stay on a failure. */
  async function reloadRows() {
    try {
      const res = await apiFetch("/api/admin/approvals");
      if (!res.ok) return;
      const body = (await res.json()) as { approvals?: PendingApproval[] };
      if (Array.isArray(body.approvals)) setRows(body.approvals);
    } catch {
      // Unreachable: the rows stay; the result above says what happened.
    }
  }

  async function decide(row: PendingApproval, decision: Decision) {
    setConfirming(null);
    setBusyId(row.id);
    setErrors((e) => ({ ...e, [row.id]: "" }));
    try {
      const res = await apiFetch(`/api/admin/approvals/${encodeURIComponent(row.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, source: row.source }),
      });
      if (!res.ok) {
        const refused = await readRefusal(res);
        if (refused.kind === "signed-out-erased") announceSessionEnd(refused.code);
        // What became of the approval (round 15, I-1; round 16), read as readRefusal reads the
        // body.
        const copy = typeof res.clone === "function" ? res.clone() : res;
        const outcome = (await copy.json().catch(() => ({}))) as DecisionOutcome;
        const text = refusedDecisionText(row.label, refused, outcome, describeWhat(row));
        show(result("refused", text ?? `${describeWhat(row)}: ${refused.message}`));
        setErrors((e) => ({ ...e, [row.id]: refused.message }));
        // Withdrawn, settling or not kept: the row is no longer what it was — read the list again.
        if (changesTheList(outcome)) await reloadRows();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      show(acceptedResult(decision, row, body));
      setRows((rs) => rs.filter((r) => !(r.id === row.id && r.source === row.source)));
    } catch {
      setErrors((e) => ({ ...e, [row.id]: t("network_error") }));
    } finally {
      setBusyId(null);
    }
  }

  const status = (
    <ResultList
      results={results}
      label={t("results_label")}
      onDismiss={(id) => setResults((rs) => rs.filter((r) => r.id !== id))}
    />
  );

  if (rows.length === 0) {
    return (
      <div>
        {status}
        <div className="bg-[#111827] rounded-xl border border-gray-800 overflow-hidden">
          <p className="text-center text-gray-400 py-8 px-4 text-sm">{t("empty")}</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {status}
      <ul aria-label={t("caption")} className="space-y-3">
        {rows.map((a) => {
          const key = `${a.source}:${a.id}`;
          const what = describeWhat(a);
          const asking = confirming?.key === key ? confirming.decision : null;
          return (
            <li
              key={key}
              data-approval={a.id}
              className="rounded-xl border border-gray-800 bg-[#111827] p-4"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1 space-y-2">
                  <WhatItChanges a={a} />
                  <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-[8rem_1fr]">
                    <dt className="text-gray-400">{t("who")}</dt>
                    <dd
                      className="min-w-0 break-words text-gray-200"
                      data-requester="true"
                    >
                      {requesterText(a)}
                    </dd>
                    <dt className="text-gray-400">{t("when")}</dt>
                    <dd className="text-gray-200">
                      <time dateTime={a.createdAt} title={fullTimestamp(a.createdAt)}>
                        {formatDateTime(a.createdAt)}
                      </time>
                    </dd>
                    <dt className="text-gray-400">{t("comment")}</dt>
                    <dd className="min-w-0 break-words text-gray-200">
                      {a.comment ? (
                        <ExpandableText text={a.comment} column={t("comment")} />
                      ) : (
                        t("no_comment")
                      )}
                    </dd>
                    <dt className="text-gray-400">{t("approver")}</dt>
                    <dd className="text-gray-200">
                      {approverText(a.requiredPermission)}
                    </dd>
                    <dt className="text-gray-400">{t("why")}</dt>
                    <dd className="min-w-0 break-words text-gray-200">
                      {whyHeld(a)}
                      {a.state === "held" ? null : (
                        // A failed or undecided run: the server's detail, behind Show all.
                        <details className="mt-1 text-gray-400">
                          <summary className="cursor-pointer text-blue-300">
                            {t("details")}
                          </summary>
                          <span className="break-words">{renderShown(a.reason)}</span>
                        </details>
                      )}
                    </dd>
                  </dl>
                  {a.undecided && a.noEligibleDecider && (
                    <span className="block text-xs text-amber-200">
                      {t("no_eligible_decider", { permission: a.requiredPermission })}
                    </span>
                  )}
                </div>
                <div className="shrink-0">
                  {a.undecided ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busyId === a.id}
                        onClick={() => decide(a, "mark_executed")}
                        aria-label={t("mark_executed_label", { label: what })}
                        className={`${button} bg-blue-900/40 border-blue-700 text-blue-200`}
                      >
                        {t("mark_executed")}
                      </button>
                      <button
                        type="button"
                        disabled={busyId === a.id}
                        onClick={() => decide(a, "reapprove")}
                        aria-label={t("reapprove_label", { label: what })}
                        className={`${button} bg-amber-900/40 border-amber-700 text-amber-200`}
                      >
                        {t("reapprove")}
                      </button>
                      <button
                        type="button"
                        disabled={busyId === a.id}
                        onClick={() => decide(a, "withdraw")}
                        aria-label={t("withdraw_label", { label: what })}
                        className={`${button} bg-red-900/40 border-red-700 text-red-200`}
                      >
                        {t("withdraw")}
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busyId === a.id || asking !== null}
                        onClick={() => setConfirming({ key, decision: "approve" })}
                        aria-label={t("approve_label", { what })}
                        className={`${button} bg-green-800/40 border-green-700 text-green-200`}
                      >
                        {t("approve")}
                      </button>
                      <button
                        type="button"
                        disabled={busyId === a.id || asking !== null}
                        onClick={() => setConfirming({ key, decision: "reject" })}
                        aria-label={t("reject_label", { what })}
                        className={`${button} bg-gray-800 border-gray-700 text-gray-300`}
                      >
                        {t("reject")}
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {asking ? (
                <div
                  role="group"
                  aria-label={
                    asking === "approve"
                      ? t("confirm_approve_title")
                      : t("confirm_reject_title")
                  }
                  data-confirm={asking}
                  className={`mt-4 rounded-lg border p-3 ${
                    asking === "approve"
                      ? "border-green-800 bg-green-950/40"
                      : "border-gray-700 bg-gray-900"
                  }`}
                >
                  <p className="mb-2 text-sm font-semibold text-white">
                    {asking === "approve"
                      ? t("confirm_approve_title")
                      : t("confirm_reject_title")}
                  </p>
                  <WhatItChanges a={a} />
                  <p className="mt-2 text-xs text-gray-300">
                    {t("who")}: {requesterText(a)}
                  </p>
                  <p className="mt-2 text-xs text-gray-400">
                    {asking === "approve"
                      ? t("confirm_note_approve")
                      : t("confirm_note_reject")}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busyId === a.id}
                      onClick={() => decide(a, asking)}
                      className={`${button} ${
                        asking === "approve"
                          ? "bg-green-700 border-green-600 text-white"
                          : "bg-red-800 border-red-700 text-white"
                      }`}
                    >
                      {asking === "approve" ? t("confirm_approve") : t("confirm_reject")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(null)}
                      className={`${button} bg-gray-800 border-gray-700 text-gray-300`}
                    >
                      {t("confirm_cancel")}
                    </button>
                  </div>
                </div>
              ) : null}
              {errors[a.id] ? (
                <p className="mt-2 text-xs text-amber-400" role="alert">
                  {errors[a.id]}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
