"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  ADMIN_HIGHLIGHT_DURATION_SECONDS,
  ADMIN_HIGHLIGHT_MIN_SECONDS,
  ADMIN_HIGHLIGHT_MAX_SECONDS,
} from "@/shared/config/limits";

const thClass =
  "text-xs text-gray-400 uppercase tracking-wider py-3 px-4 border-b border-gray-800";
const tdClass = "py-3 px-4 text-gray-300 border-b border-gray-800/50";

function clampHighlight(seconds: number): number {
  return Math.max(
    ADMIN_HIGHLIGHT_MIN_SECONDS,
    Math.min(ADMIN_HIGHLIGHT_MAX_SECONDS, seconds)
  );
}

function DataTable({
  headers,
  children,
  emptyMessage,
  isEmpty,
}: {
  headers: string[];
  children: React.ReactNode;
  emptyMessage: string;
  isEmpty: boolean;
}) {
  return (
    <div className="bg-[#111827] rounded-xl border border-gray-800 overflow-hidden">
      <table className="w-full text-sm text-left border-collapse">
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} className={thClass}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {isEmpty && (
        <p className="text-center text-gray-500 py-8 text-sm">{emptyMessage}</p>
      )}
    </div>
  );
}

function useHighlight(
  ids: string[],
  durationSeconds: number = ADMIN_HIGHLIGHT_DURATION_SECONDS
): Set<string> {
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  const prevIdsRef = useRef<string | null>(null);
  const clamped = clampHighlight(durationSeconds);

  const idsKey = ids.join(",");

  useEffect(() => {
    // First render: record IDs without highlighting
    if (prevIdsRef.current === null) {
      prevIdsRef.current = idsKey;
      return;
    }

    // No change
    if (idsKey === prevIdsRef.current) return;

    const prevSet = new Set(prevIdsRef.current.split(",").filter(Boolean));
    const newIds = ids.filter((id) => !prevSet.has(id));
    prevIdsRef.current = idsKey;

    if (newIds.length > 0) {
      setHighlighted(new Set(newIds));
      const timer = setTimeout(() => setHighlighted(new Set()), clamped * 1000);
      return () => clearTimeout(timer);
    }
  }, [idsKey, ids, clamped]);

  return highlighted;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Roles Data View with Drill-Down ─────────────────────────────────────

interface RolePermission {
  code: string;
  displayName: string;
  category: string;
}

export function RolesDataView({ data }: { data: any }) {
  const roles = data?.roles || [];
  const [expandedRole, setExpandedRole] = useState<string | null>(null);
  const highlighted = useHighlight(roles.map((r: any) => r.id));

  if (roles.length === 0) {
    return (
      <p className="text-gray-500 text-sm">
        No roles found. Use the command bar to create one.
      </p>
    );
  }

  return (
    <div className="bg-[#111827] rounded-xl border border-gray-800 overflow-hidden">
      <table className="w-full text-sm text-left border-collapse">
        <thead>
          <tr>
            <th className={thClass}>Role</th>
            <th className={thClass}>Display Name</th>
            <th className={thClass}>Permissions</th>
            <th className={thClass}>Created</th>
            <th className={thClass}>Modified</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((r: any) => {
            const isExpanded = expandedRole === r.id;
            const isHighlighted = highlighted.has(r.id);
            return (
              <React.Fragment key={r.id}>
                <tr
                  onClick={() => setExpandedRole(isExpanded ? null : r.id)}
                  className={`cursor-pointer transition-colors ${
                    isHighlighted
                      ? "bg-green-900/30"
                      : isExpanded
                        ? "bg-blue-900/10"
                        : "hover:bg-gray-800/30"
                  }`}
                >
                  <td className={tdClass}>
                    <code className="text-xs">{r.name}</code>
                  </td>
                  <td className={tdClass}>{r.displayName}</td>
                  <td className={tdClass}>
                    <span className="text-blue-400 cursor-pointer">
                      {r.permissionCount}{" "}
                      <span className="text-xs text-gray-500">
                        {isExpanded ? "▲" : "▼"}
                      </span>
                    </span>
                  </td>
                  <td className={`${tdClass} text-xs text-gray-500`}>
                    {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "—"}
                  </td>
                  <td className={`${tdClass} text-xs text-gray-500`}>
                    {r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : "—"}
                  </td>
                </tr>
                {isExpanded && (
                  <tr>
                    <td colSpan={5} className="px-4 py-3 bg-[#0d1320]">
                      {r.description && (
                        <p className="text-xs text-gray-500 mb-3">{r.description}</p>
                      )}
                      {r.permissions && r.permissions.length > 0 ? (
                        <div className="grid grid-cols-2 gap-2">
                          {r.permissions.map((p: RolePermission) => (
                            <div key={p.code} className="flex items-center gap-2 text-xs">
                              <span className="text-green-400">✓</span>
                              <code className="text-gray-400">{p.code}</code>
                              <span className="text-gray-600">{p.displayName}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-gray-600">No permissions assigned.</p>
                      )}
                      <div className="mt-3 text-xs text-gray-600 flex gap-4">
                        <span>
                          Created:{" "}
                          {r.createdAt ? new Date(r.createdAt).toLocaleString() : "—"}
                        </span>
                        <span>
                          Modified:{" "}
                          {r.updatedAt ? new Date(r.updatedAt).toLocaleString() : "—"}
                        </span>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Players Data View ───────────────────────────────────────────────────

export function PlayersDataView({ data }: { data: any }) {
  const players = data?.players || [];
  const highlighted = useHighlight(players.map((p: any) => p.id));

  return (
    <DataTable
      headers={["Email", "Display Name", "Role", "Created"]}
      isEmpty={players.length === 0}
      emptyMessage="No players found."
    >
      {players.map((p: any) => (
        <tr
          key={p.id}
          className={highlighted.has(p.id) ? "bg-green-900/30 transition-colors" : ""}
        >
          <td className={tdClass}>{p.email || "—"}</td>
          <td className={tdClass}>{p.displayName || "—"}</td>
          <td className={tdClass}>{p.roleName}</td>
          <td className={tdClass}>{new Date(p.createdAt).toLocaleDateString()}</td>
        </tr>
      ))}
    </DataTable>
  );
}

// ── Entitlements Data View ──────────────────────────────────────────────

export function EntitlementsDataView({ data }: { data: any }) {
  const groups = data?.groups || [];
  const highlighted = useHighlight(groups.map((g: any) => g.id));

  return (
    <DataTable
      headers={["Code", "Name", "Players", "Status"]}
      isEmpty={groups.length === 0}
      emptyMessage="No entitlement groups. Use the command bar to create one."
    >
      {groups.map((g: any) => (
        <tr
          key={g.id}
          className={highlighted.has(g.id) ? "bg-green-900/30 transition-colors" : ""}
        >
          <td className={tdClass}>
            <code className="text-xs">{g.code}</code>
          </td>
          <td className={tdClass}>{g.displayName}</td>
          <td className={tdClass}>{g.playerCount}</td>
          <td className={tdClass}>
            <span
              className={`text-xs px-2 py-0.5 rounded ${
                g.isActive
                  ? "bg-green-900/30 text-green-400"
                  : "bg-gray-700 text-gray-400"
              }`}
            >
              {g.isActive ? "Active" : "Inactive"}
            </span>
          </td>
        </tr>
      ))}
    </DataTable>
  );
}

// ── Audit Data View ─────────────────────────────────────────────────────

export function AuditDataView({ data }: { data: any }) {
  const entries = data?.entries || [];
  return (
    <DataTable
      headers={["Time", "Action", "Actor", "Details"]}
      isEmpty={entries.length === 0}
      emptyMessage="No audit entries found."
    >
      {entries.map((e: any) => (
        <tr key={e.id}>
          <td className={`${tdClass} text-xs`}>
            {new Date(e.createdAt).toLocaleString()}
          </td>
          <td className={tdClass}>
            <code className="text-xs">{e.action}</code>
          </td>
          <td className={`${tdClass} text-xs`}>{e.actorId?.slice(0, 8) || "—"}</td>
          <td className={`${tdClass} text-xs text-gray-500 max-w-xs truncate`}>
            {e.details}
          </td>
        </tr>
      ))}
    </DataTable>
  );
}

// ── Config Views ────────────────────────────────────────────────────────

function ConfigRow({
  label,
  value,
}: {
  label: string;
  value: string | number | boolean;
}) {
  const display = typeof value === "boolean" ? (value ? "✓" : "✕") : String(value);
  return (
    <div className="flex justify-between">
      <span className="text-gray-400">{label}</span>
      <span className="text-white font-mono">{display}</span>
    </div>
  );
}

export function GuestConfigDataView({ data }: { data: any }) {
  const config = data?.config;
  if (!config) return <p className="text-gray-500 text-sm">Loading...</p>;
  return (
    <div className="bg-[#111827] rounded-xl border border-gray-800 p-5 max-w-lg">
      <div className="space-y-3 text-sm">
        <ConfigRow label="Nudge after sessions" value={config.nudgeAfterSessions} />
        <ConfigRow label="Grace after sessions" value={config.graceAfterSessions} />
        <ConfigRow label="Lockout after sessions" value={config.lockoutAfterSessions} />
        <ConfigRow label="Guest token TTL (hours)" value={config.guestTokenTtlHours} />
      </div>
    </div>
  );
}

export function PasswordPolicyDataView({ data }: { data: any }) {
  const policy = data?.policy;
  if (!policy) return <p className="text-gray-500 text-sm">Loading...</p>;
  return (
    <div className="bg-[#111827] rounded-xl border border-gray-800 p-5 max-w-lg">
      <div className="space-y-3 text-sm">
        <ConfigRow label="Min length" value={policy.minLength} />
        <ConfigRow label="Rotation (days)" value={policy.rotationDays} />
        <ConfigRow label="History count" value={policy.passwordHistoryCount} />
        <ConfigRow label="Uppercase" value={policy.requireUppercase} />
        <ConfigRow label="Lowercase" value={policy.requireLowercase} />
        <ConfigRow label="Number" value={policy.requireNumber} />
        <ConfigRow label="Special char" value={policy.requireSpecial} />
      </div>
    </div>
  );
}
