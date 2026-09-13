"use client";

/**
 * components/admin/HeldActionsPanel.tsx — the pending-approvals surface (ADR-040, 040a read +
 * 040c decision). One row per held change; Approve / Reject clear it through the deterministic
 * decision route (POST /api/admin/approvals/[id]). Self-approval is enforced server-side (409);
 * the panel surfaces that (and any 403) inline rather than pre-disabling, since the acting
 * admin's identity is not available client-side.
 */

import React, { useEffect, useState } from "react";
import type { PendingApproval } from "@/platform/admin/pending-approvals";

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

  useEffect(() => {
    setRows(data?.approvals ?? []);
  }, [data]);

  async function decide(row: PendingApproval, decision: "approve" | "reject") {
    setBusyId(row.id);
    setErrors((e) => ({ ...e, [row.id]: "" }));
    try {
      const res = await fetch(`/api/admin/approvals/${encodeURIComponent(row.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, source: row.source }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErrors((e) => ({ ...e, [row.id]: body.error ?? `Failed (${res.status})` }));
        return;
      }
      setRows((rs) => rs.filter((r) => !(r.id === row.id && r.source === row.source)));
    } catch {
      setErrors((e) => ({ ...e, [row.id]: "Network error — please retry." }));
    } finally {
      setBusyId(null);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="bg-[#111827] rounded-xl border border-gray-800 overflow-hidden">
        <p className="text-center text-gray-500 py-8 text-sm">
          No pending approvals. Held changes appear here for an independent reviewer.
        </p>
      </div>
    );
  }

  return (
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
                <span className="block text-xs text-gray-500">
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
  );
}
