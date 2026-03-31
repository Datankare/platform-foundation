"use client";

import React, { useState } from "react";

const thClass =
  "text-xs text-gray-400 uppercase tracking-wider py-3 px-4 border-b border-gray-800";
const tdClass = "py-3 px-4 text-gray-300 border-b border-gray-800/50";
const inputClass =
  "bg-[#0a0f1e] border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500";
const btnPrimary =
  "bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition";
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

// ── Guest Config Panel ──────────────────────────────────────────────────

interface GuestConfigPanelProps {
  nudgeAfterSessions: number;
  graceAfterSessions: number;
  lockoutAfterSessions: number;
  guestTokenTtlHours: number;
  onSave: (config: {
    nudgeAfterSessions: number;
    graceAfterSessions: number;
    lockoutAfterSessions: number;
    guestTokenTtlHours: number;
  }) => void;
  isSaving: boolean;
}

export function GuestConfigPanel({
  nudgeAfterSessions: initialNudge,
  graceAfterSessions: initialGrace,
  lockoutAfterSessions: initialLockout,
  guestTokenTtlHours: initialTtl,
  onSave,
  isSaving,
}: GuestConfigPanelProps) {
  const [nudge, setNudge] = useState(initialNudge);
  const [grace, setGrace] = useState(initialGrace);
  const [lockout, setLockout] = useState(initialLockout);
  const [ttl, setTtl] = useState(initialTtl);

  return (
    <div>
      <h2 className="text-xl font-bold text-white mb-6">Guest Configuration</h2>
      <div className="bg-[#111827] rounded-xl border border-gray-800 p-6 max-w-lg space-y-4">
        <div>
          <label htmlFor="gc-nudge" className="block text-sm text-gray-400 mb-1">
            Nudge after sessions
          </label>
          <input
            id="gc-nudge"
            type="number"
            min={1}
            value={nudge}
            onChange={(e) => setNudge(Number(e.target.value))}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="gc-grace" className="block text-sm text-gray-400 mb-1">
            Grace after sessions
          </label>
          <input
            id="gc-grace"
            type="number"
            min={1}
            value={grace}
            onChange={(e) => setGrace(Number(e.target.value))}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="gc-lockout" className="block text-sm text-gray-400 mb-1">
            Lockout after sessions
          </label>
          <input
            id="gc-lockout"
            type="number"
            min={1}
            value={lockout}
            onChange={(e) => setLockout(Number(e.target.value))}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="gc-ttl" className="block text-sm text-gray-400 mb-1">
            Guest token TTL (hours)
          </label>
          <input
            id="gc-ttl"
            type="number"
            min={1}
            value={ttl}
            onChange={(e) => setTtl(Number(e.target.value))}
            className={inputClass}
          />
        </div>
        <button
          onClick={() =>
            onSave({
              nudgeAfterSessions: nudge,
              graceAfterSessions: grace,
              lockoutAfterSessions: lockout,
              guestTokenTtlHours: ttl,
            })
          }
          disabled={isSaving}
          className={btnPrimary}
        >
          {isSaving ? "Saving..." : "Save Configuration"}
        </button>
      </div>
    </div>
  );
}
