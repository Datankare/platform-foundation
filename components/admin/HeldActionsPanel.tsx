"use client";

/**
 * components/admin/HeldActionsPanel.tsx — the pending-approvals surface (ADR-040, 040a read +
 * 040c decision). One row per held change; Approve / Reject clear it through the deterministic
 * decision route (POST /api/admin/approvals/[id]). Self-approval is enforced server-side (409);
 * the panel surfaces that (and any 403) inline rather than pre-disabling, since the acting
 * admin's identity is not available client-side.
 *
 * An approved run whose outcome is unknown (review 11 H-1: it did not end within its lease) is
 * not approved or rejected: after verifying, an admin marks it executed, or — when it did not take
 * effect — approves it again (a fresh approval) or withdraws it (closed, never run: TASK-194 round
 * 5). Each is recorded.
 *
 * After a decision the panel says what happened (TASK-186, the owner's ask) — "Approved: <label>
 * took effect", "<label>: <reason>", "Rejected: <label>" — in a status
 * region (announced) above the refreshed list or its empty message, for a few seconds or until
 * dismissed. A refusal goes through the shared handler (readRefusal): its catalog message, and an
 * erased session ends.
 */

import React, { useEffect, useState } from "react";
import type { PendingApproval } from "@/platform/admin/pending-approvals";
import { apiFetch } from "@/platform/auth/api-fetch";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { announceSessionEnd, readRefusal } from "@/platform/errors/refusal";
import {
  changesTheList,
  refusedDecisionText,
  type DecisionOutcome,
} from "./decision-outcome";

/** How long a decision's result stays on screen unless dismissed. */
export const RESULT_MS = 6000;

type Decision = "approve" | "reject" | "mark_executed" | "reapprove" | "withdraw";
interface DecisionResult {
  readonly ok: boolean;
  readonly text: string;
}

/** What a decision the server accepted did, in words (its 200 body). */
function acceptedText(
  decision: Decision,
  label: string,
  body: Record<string, unknown>
): string {
  if (decision === "reject") return t("result_rejected", { label });
  if (decision === "mark_executed") return t("result_marked_executed", { label });
  if (decision === "withdraw") return t("result_withdrawn", { label });
  if (body.pendingApproval) return t("result_approved_pending", { label });
  if (body.recorded === false) return t("result_approved_unrecorded", { label });
  return t("result_approved", { label });
}

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.held.${key}`, values);

const thClass =
  "text-xs text-gray-400 uppercase tracking-wider py-3 px-4 border-b border-gray-800";
const tdClass = "py-3 px-4 text-gray-300 border-b border-gray-800/50 align-top";

function approverHint(permission: string): string {
  switch (permission) {
    case "config_manage_safety":
      return "Safety approver or super admin";
    case "config_manage_standard":
      return "Admin or super admin";
    default:
      return permission;
  }
}

/**
 * What the held action would do (TASK-194 round 1, A1): the server's allowlisted summary — the
 * account it acts on, and an erasure's reason, a role change's roles, a restriction's feature.
 */
function summaryLines(summary: PendingApproval["summary"]): string[] {
  if (!summary) return [];
  const lines: string[] = [];
  if (summary.target) {
    lines.push(
      summary.target.notFound
        ? t("summary_target_missing")
        : t("summary_target", { account: summary.target.email ?? summary.target.id })
    );
  }
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
              // Each effect in the catalog's words (round 13, nit 6), listed as the locale lists.
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
    // What the rules do not change (round 13, I-A; ADR-030/ADR-040 addendum): every hold is
    // restricted while the gating threshold is, and a restricted action is always a person's.
    lines.push(t("summary_policy_restricted"));
  }
  return lines;
}

function sourceLabel(source: PendingApproval["source"]): string {
  return source === "config-approval" ? "Config approval" : "Runtime hold";
}

export function HeldActionsPanel({ data }: { data?: { approvals?: PendingApproval[] } }) {
  const [rows, setRows] = useState<PendingApproval[]>(data?.approvals ?? []);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<DecisionResult | null>(null);

  // A result stays a few seconds, then goes (or at once, by Dismiss).
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), RESULT_MS);
    return () => clearTimeout(timer);
  }, [result]);

  // Fresh data from the page replaces the rows, adjusted during render (React's pattern for
  // state that follows a prop) rather than in an effect, which rendered the stale rows first.
  const [shownData, setShownData] = useState(data);
  if (data !== shownData) {
    setShownData(data);
    setRows(data?.approvals ?? []);
  }

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
    setBusyId(row.id);
    setResult(null);
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
        const text = refusedDecisionText(row.label, refused, outcome);
        if (text) setResult({ ok: false, text });
        setErrors((e) => ({ ...e, [row.id]: refused.message }));
        // Withdrawn, settling or not kept: the row is no longer what it was — read the list again.
        if (changesTheList(outcome)) await reloadRows();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setResult({ ok: true, text: acceptedText(decision, row.label, body) });
      setRows((rs) => rs.filter((r) => !(r.id === row.id && r.source === row.source)));
    } catch {
      setErrors((e) => ({ ...e, [row.id]: "Network error — please retry." }));
    } finally {
      setBusyId(null);
    }
  }

  // Always rendered, so a screen reader hears each result as it is set (a live region must exist
  // before its text changes).
  const status = (
    <div role="status" aria-live="polite" className="mb-3">
      {result ? (
        <div
          className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${
            result.ok
              ? "border-green-700 bg-green-900/20 text-green-200"
              : "border-amber-700 bg-amber-900/20 text-amber-200"
          }`}
        >
          <span>{result.text}</span>
          <button
            type="button"
            onClick={() => setResult(null)}
            className="text-xs underline text-gray-300"
          >
            {t("result_dismiss")}
          </button>
        </div>
      ) : null}
    </div>
  );

  if (rows.length === 0) {
    return (
      <div>
        {status}
        <div className="bg-[#111827] rounded-xl border border-gray-800 overflow-hidden">
          <p className="text-center text-gray-400 py-8 text-sm">
            No pending approvals. Held changes appear here for an independent reviewer.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {status}
      <div className="bg-[#111827] rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full text-sm text-left border-collapse">
          <caption className="sr-only">
            Pending approvals awaiting an independent reviewer
          </caption>
          <thead>
            <tr>
              <th scope="col" className={thClass}>
                What
              </th>
              <th scope="col" className={thClass}>
                Why held
              </th>
              <th scope="col" className={thClass}>
                Who can approve
              </th>
              <th scope="col" className={thClass}>
                Requested by
              </th>
              <th scope="col" className={thClass}>
                Decision
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={`${a.source}:${a.id}`}>
                <td className={tdClass}>
                  <code className="text-xs text-gray-200">{a.label}</code>
                  <span className="block text-xs text-gray-400">
                    {sourceLabel(a.source)}
                  </span>
                </td>
                <td className={tdClass}>
                  {summaryLines(a.summary).map((line) => (
                    <span
                      key={line}
                      data-summary="true"
                      className="block text-xs text-gray-200"
                    >
                      {line}
                    </span>
                  ))}
                  <span className="text-xs text-gray-400">{a.reason}</span>
                  {a.undecided && a.noEligibleDecider && (
                    <span className="block text-xs text-amber-200 mt-1">
                      {t("no_eligible_decider", { permission: a.requiredPermission })}
                    </span>
                  )}
                </td>
                <td className={tdClass}>
                  <span className="text-xs">{approverHint(a.requiredPermission)}</span>
                </td>
                <td className={tdClass}>
                  <code className="text-xs">{a.requester.slice(0, 12)}</code>
                </td>
                <td className={tdClass}>
                  {a.undecided ? (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busyId === a.id}
                        onClick={() => decide(a, "mark_executed")}
                        aria-label={t("mark_executed_label", { label: a.label })}
                        className="px-2 py-1 text-xs rounded bg-blue-900/40 border border-blue-700 text-blue-200 disabled:opacity-50"
                      >
                        {t("mark_executed")}
                      </button>
                      <button
                        type="button"
                        disabled={busyId === a.id}
                        onClick={() => decide(a, "reapprove")}
                        aria-label={t("reapprove_label", { label: a.label })}
                        className="px-2 py-1 text-xs rounded bg-amber-900/40 border border-amber-700 text-amber-200 disabled:opacity-50"
                      >
                        {t("reapprove")}
                      </button>
                      <button
                        type="button"
                        disabled={busyId === a.id}
                        onClick={() => decide(a, "withdraw")}
                        aria-label={t("withdraw_label", { label: a.label })}
                        className="px-2 py-1 text-xs rounded bg-red-900/40 border border-red-700 text-red-200 disabled:opacity-50"
                      >
                        {t("withdraw")}
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busyId === a.id}
                        onClick={() => decide(a, "approve")}
                        aria-label={`Approve ${a.label}`}
                        className="px-2 py-1 text-xs rounded bg-green-800/40 border border-green-700 text-green-200 disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={busyId === a.id}
                        onClick={() => decide(a, "reject")}
                        aria-label={`Reject ${a.label}`}
                        className="px-2 py-1 text-xs rounded bg-gray-800 border border-gray-700 text-gray-300 disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </div>
                  )}
                  {errors[a.id] ? (
                    <p className="text-xs text-amber-400 mt-1" role="alert">
                      {errors[a.id]}
                    </p>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
