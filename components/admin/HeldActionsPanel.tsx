/**
 * components/admin/HeldActionsPanel.tsx — the pending-approvals surface (ADR-040, 040a).
 *
 * Read-only view of every held change awaiting an independent approver, unified across the
 * runtime dual-control and config-approval mechanisms (platform/admin/pending-approvals).
 * Each row names what is held, why, who may clear it, who requested it, and when.
 * Approve/reject arrives in 040b.
 */

import React from "react";
import type { PendingApproval } from "@/platform/admin/pending-approvals";

const thClass =
  "text-xs text-gray-400 uppercase tracking-wider py-3 px-4 border-b border-gray-800";
const tdClass = "py-3 px-4 text-gray-300 border-b border-gray-800/50";

/** Plain-language approver hint from the required permission. */
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
  const approvals = data?.approvals ?? [];
  const isEmpty = approvals.length === 0;

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
              When
            </th>
          </tr>
        </thead>
        <tbody>
          {approvals.map((a) => (
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
              <td className={tdClass}>{new Date(a.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {isEmpty && (
        <p className="text-center text-gray-500 py-8 text-sm">
          No pending approvals. Held changes appear here for an independent reviewer.
        </p>
      )}
    </div>
  );
}
