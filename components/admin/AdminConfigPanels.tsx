"use client";

import React, { useState } from "react";

const thClass =
  "text-xs text-gray-400 uppercase tracking-wider py-3 px-4 border-b border-gray-800";
const tdClass = "py-3 px-4 text-gray-300 border-b border-gray-800/50";
const inputClass =
  "bg-[#0a0f1e] border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500";
const btnSecondary =
  "bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm font-medium px-4 py-2 rounded-lg transition";

// ── Audit Trail Panel ───────────────────────────────────────────────────

export interface AuditRow {
  id: string;
  action: string;
  actorId: string | null;
  targetId: string | null;
  details: string;
  createdAt: string;
}

interface AuditPanelProps {
  entries: AuditRow[];
  onSearch: (query: string) => void;
  onLoadMore: () => void;
  hasMore: boolean;
}

export function AuditPanel({ entries, onSearch, onLoadMore, hasMore }: AuditPanelProps) {
  const [search, setSearch] = useState("");

  return (
    <div>
      <h2 className="text-xl font-bold text-white mb-6">Audit Trail</h2>
      <div className="mb-4">
        <input
          type="text"
          placeholder="Search by action, actor, or target..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            onSearch(e.target.value);
          }}
          className={`${inputClass} w-full max-w-md`}
        />
      </div>
      <div className="bg-[#111827] rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full text-sm text-left border-collapse">
          <thead>
            <tr>
              <th className={thClass}>Time</th>
              <th className={thClass}>Action</th>
              <th className={thClass}>Actor</th>
              <th className={thClass}>Target</th>
              <th className={thClass}>Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className={tdClass}>{new Date(e.createdAt).toLocaleString()}</td>
                <td className={tdClass}>
                  <code className="text-xs">{e.action}</code>
                </td>
                <td className={tdClass}>
                  <code className="text-xs">{e.actorId?.slice(0, 8) || "—"}</code>
                </td>
                <td className={tdClass}>
                  <code className="text-xs">{e.targetId?.slice(0, 8) || "—"}</code>
                </td>
                <td className={tdClass}>
                  <span className="text-xs text-gray-500 max-w-xs truncate block">
                    {e.details}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length === 0 && (
          <p className="text-center text-gray-500 py-8 text-sm">
            No audit entries found.
          </p>
        )}
        {hasMore && (
          <div className="p-4 text-center">
            <button onClick={onLoadMore} className={btnSecondary}>
              Load More
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
