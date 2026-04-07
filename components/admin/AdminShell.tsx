"use client";

import React, { useState } from "react";

export type AdminSection =
  | "users"
  | "roles"
  | "entitlements"
  | "audit"
  | "guest-config"
  | "password-policy"
  | "platform-config";

interface AdminShellProps {
  /** Current admin's display name */
  adminName: string;
  /** Callback to verify admin has required permission */
  hasPermission: (code: string) => boolean;
  /** Sign out callback */
  onSignOut: () => void;
  /** Render the active section's content */
  children: (activeSection: AdminSection) => React.ReactNode;
  onSectionChange?: (section: AdminSection) => void;
}

const NAV_ITEMS: {
  section: AdminSection;
  label: string;
  icon: string;
  permission: string;
}[] = [
  {
    section: "users",
    label: "Users",
    icon: "👥",
    permission: "admin_manage_users",
  },
  {
    section: "roles",
    label: "Roles",
    icon: "🛡️",
    permission: "admin_manage_roles",
  },
  {
    section: "entitlements",
    label: "Entitlements",
    icon: "🎫",
    permission: "admin_manage_entitlements",
  },
  {
    section: "audit",
    label: "Audit Log",
    icon: "📋",
    permission: "admin_view_audit",
  },
  {
    section: "guest-config",
    label: "Guest Config",
    icon: "⚙️",
    permission: "admin_manage_config",
  },
  {
    section: "password-policy",
    label: "Password Policy",
    icon: "🔑",
    permission: "admin_manage_config",
  },
  {
    section: "platform-config",
    label: "Platform Config",
    icon: "⚡",
    permission: "admin_manage_config",
  },
];

/**
 * Admin shell — extensible layout with sidebar navigation.
 * Role-gated: only renders sections the admin has permission for.
 * The children render prop receives the active section.
 */
export default function AdminShell({
  adminName,
  hasPermission,
  onSignOut,
  onSectionChange,
  children,
}: AdminShellProps) {
  const visibleItems = NAV_ITEMS.filter((item) => hasPermission(item.permission));

  const [activeSection, setActiveSection] = useState<AdminSection>(
    visibleItems[0]?.section || "users"
  );

  return (
    <div className="min-h-screen bg-[#0a0f1e] flex">
      {/* Sidebar */}
      <aside className="w-64 bg-[#111827] border-r border-gray-800 flex flex-col">
        <div className="p-6 border-b border-gray-800">
          <h1 className="text-lg font-bold text-white">Admin Panel</h1>
          <p className="text-xs text-gray-500 mt-1">{adminName}</p>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          {visibleItems.map((item) => (
            <button
              key={item.section}
              onClick={() => {
                setActiveSection(item.section);
                onSectionChange?.(item.section);
              }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition ${
                activeSection === item.section
                  ? "bg-blue-600/20 text-blue-400"
                  : "text-gray-400 hover:text-gray-300 hover:bg-gray-800/50"
              }`}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="p-4 border-t border-gray-800">
          <button
            onClick={onSignOut}
            className="w-full text-sm text-gray-500 hover:text-gray-400 transition"
          >
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 p-8">{children(activeSection)}</main>
    </div>
  );
}
