"use client";

import React, { useState } from "react";

const thClass =
  "text-xs text-gray-400 uppercase tracking-wider py-3 px-4 border-b border-gray-800";
const tdClass = "py-3 px-4 text-gray-300 border-b border-gray-800/50";
const inputClass =
  "bg-[#0a0f1e] border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500";
const btnSecondary =
  "bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm font-medium px-4 py-2 rounded-lg transition";

// ── Players Panel ───────────────────────────────────────────────────────

export interface PlayerRow {
  id: string;
  email: string | null;
  displayName: string | null;
  roleName: string;
  createdAt: string;
  isDeleted: boolean;
}

interface PlayersPanelProps {
  players: PlayerRow[];
  onSearch: (query: string) => void;
  onChangeRole: (playerId: string, newRoleId: string) => void;
  onViewProfile: (playerId: string) => void;
  roles: { id: string; name: string }[];
}

export function PlayersPanel({
  players,
  onSearch,
  onChangeRole,
  onViewProfile,
  roles,
}: PlayersPanelProps) {
  const [search, setSearch] = useState("");

  return (
    <div>
      <h2 className="text-xl font-bold text-white mb-6">Player Management</h2>
      <div className="mb-4">
        <input
          type="text"
          placeholder="Search by email or display name..."
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
              <th className={thClass}>Email</th>
              <th className={thClass}>Display Name</th>
              <th className={thClass}>Role</th>
              <th className={thClass}>Created</th>
              <th className={thClass}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.id}>
                <td className={tdClass}>{p.email || "—"}</td>
                <td className={tdClass}>{p.displayName || "—"}</td>
                <td className={tdClass}>
                  <select
                    value={p.roleName}
                    onChange={(e) => onChangeRole(p.id, e.target.value)}
                    className={`${inputClass} py-1`}
                  >
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className={tdClass}>{new Date(p.createdAt).toLocaleDateString()}</td>
                <td className={tdClass}>
                  <button
                    onClick={() => onViewProfile(p.id)}
                    className="text-blue-400 hover:text-blue-300 text-sm"
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {players.length === 0 && (
          <p className="text-center text-gray-500 py-8 text-sm">No players found.</p>
        )}
      </div>
    </div>
  );
}

// ── Roles Panel ─────────────────────────────────────────────────────────

export interface RoleRow {
  id: string;
  name: string;
  displayName: string;
  permissionCount: number;
}

interface RolesPanelProps {
  roles: RoleRow[];
  onEditPermissions: (roleId: string) => void;
}

export function RolesPanel({ roles, onEditPermissions }: RolesPanelProps) {
  return (
    <div>
      <h2 className="text-xl font-bold text-white mb-6">Role Management</h2>
      <div className="bg-[#111827] rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full text-sm text-left border-collapse">
          <thead>
            <tr>
              <th className={thClass}>Role</th>
              <th className={thClass}>Display Name</th>
              <th className={thClass}>Permissions</th>
              <th className={thClass}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id}>
                <td className={tdClass}>{r.name}</td>
                <td className={tdClass}>{r.displayName}</td>
                <td className={tdClass}>{r.permissionCount}</td>
                <td className={tdClass}>
                  <button
                    onClick={() => onEditPermissions(r.id)}
                    className="text-blue-400 hover:text-blue-300 text-sm"
                  >
                    Edit Permissions
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Entitlements Panel ──────────────────────────────────────────────────

export interface EntitlementGroupRow {
  id: string;
  code: string;
  displayName: string;
  isActive: boolean;
  playerCount: number;
}

interface EntitlementsPanelProps {
  groups: EntitlementGroupRow[];
  onToggleActive: (groupId: string) => void;
  onManagePlayers: (groupId: string) => void;
}

export function EntitlementsPanel({
  groups,
  onToggleActive,
  onManagePlayers,
}: EntitlementsPanelProps) {
  return (
    <div>
      <h2 className="text-xl font-bold text-white mb-6">Entitlement Management</h2>
      <div className="bg-[#111827] rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full text-sm text-left border-collapse">
          <thead>
            <tr>
              <th className={thClass}>Code</th>
              <th className={thClass}>Name</th>
              <th className={thClass}>Players</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id}>
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
                <td className={tdClass}>
                  <button
                    onClick={() => onToggleActive(g.id)}
                    className={`${btnSecondary} mr-2 py-1 px-2`}
                  >
                    {g.isActive ? "Deactivate" : "Activate"}
                  </button>
                  <button
                    onClick={() => onManagePlayers(g.id)}
                    className="text-blue-400 hover:text-blue-300 text-sm"
                  >
                    Players
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
