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
 * effect — approves it again (a fresh approval). Both are recorded.
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

/** How long a decision's result stays on screen unless dismissed. */
export const RESULT_MS = 6000;

type Decision = "approve" | "reject" | "mark_executed" | "reapprove";
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
        // Approved, and the run failed: the approval stands (approving again retries it).
        if (refused.code === "approvals.run_failed") {
          setResult({
            ok: false,
            text: t("result_approved_failed", {
              label: row.label,
              reason: refused.message,
            }),
          });
        }
        setErrors((e) => ({ ...e, [row.id]: refused.message }));
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
                  <span className="text-xs text-gray-400">{a.reason}</span>
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
