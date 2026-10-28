"use client";

import React, { useEffect, useRef, useState } from "react";
import { renderMessage } from "@/platform/errors/messages";

export type AdminSection =
  | "users"
  | "roles"
  | "entitlements"
  | "audit"
  | "password-policy"
  | "platform-config"
  | "agent-registry"
  | "per-account"
  | "approval-policy"
  | "capabilities"
  | "capability-mapping"
  | "approvals"
  | "dual-control"
  | "tenant"
  | "tenants"
  | "jobs"
  | "kill-switch";

interface AdminShellProps {
  /** Current admin's display name */
  adminName: string;
  /** Callback to verify admin has required permission */
  hasPermission: (code: string) => boolean;
  /** "Sign Out": must end the session, not only leave the console (the page signs out first). */
  onSignOut: () => void;
  /** Render the active section's content */
  children: (activeSection: AdminSection) => React.ReactNode;
  onSectionChange?: (section: AdminSection) => void;
}

/** A section's title from the catalog (screens.admin_console.sections). */
const section = (id: string) => renderMessage(`screens.admin_console.sections.${id}`);

const NAV_ITEMS: {
  section: AdminSection;
  label: string;
  icon: string;
  permission: string;
}[] = [
  {
    section: "users",
    label: section("users"),
    icon: "👥",
    permission: "admin_manage_users",
  },
  {
    section: "roles",
    label: section("roles"),
    icon: "🛡️",
    permission: "admin_manage_roles",
  },
  {
    section: "entitlements",
    label: section("entitlements"),
    icon: "🎫",
    permission: "admin_manage_entitlements",
  },
  {
    section: "audit",
    label: section("audit"),
    icon: "📋",
    permission: "admin_view_audit",
  },
  {
    section: "approvals",
    label: section("approvals"),
    icon: "✅",
    permission: "can_access_admin",
  },
  {
    section: "dual-control",
    label: section("dual-control"),
    icon: "🔒",
    permission: "config_view",
  },
  {
    section: "password-policy",
    label: section("password-policy"),
    icon: "🔑",
    permission: "admin_manage_config",
  },
  {
    section: "platform-config",
    label: section("platform-config"),
    icon: "⚡",
    permission: "admin_manage_config",
  },
  {
    section: "agent-registry",
    label: section("agent-registry"),
    icon: "🤖",
    permission: "admin_manage_agents",
  },
  {
    // The single-tenant kill switch (TASK-172): the registry's own tier permission, as the route.
    section: "kill-switch",
    label: renderMessage("screens.kill_switch.nav"),
    icon: "🛑",
    permission: "config_manage_safety",
  },
  {
    section: "per-account",
    label: section("per-account"),
    icon: "🔒",
    permission: "admin_manage_account_restrictions",
  },
  {
    section: "approval-policy",
    label: section("approval-policy"),
    icon: "🤝",
    permission: "admin_manage_approval_policy",
  },
  {
    section: "capabilities",
    label: section("capabilities"),
    icon: "🧩",
    permission: "admin_view_audit",
  },
  {
    section: "capability-mapping",
    label: section("capability-mapping"),
    icon: "🗺️",
    permission: "admin_manage_config",
  },
  {
    section: "tenant",
    label: section("tenant"),
    icon: "🏢",
    permission: "can_access_admin",
  },
  {
    section: "tenants",
    label: section("tenants"),
    icon: "🌐",
    permission: "platform_operate",
  },
  {
    section: "jobs",
    label: renderMessage("screens.jobs.nav"),
    icon: "⏱️",
    permission: "platform_operate",
  },
];

/**
 * A section's title: the one source for the shell's navigation and the section's heading
 * (TASK-185 — the heading fell back to the raw section id, "approvals", for every section the
 * page's own title table did not list).
 */
export function sectionTitle(id: AdminSection): string {
  return NAV_ITEMS.find((item) => item.section === id)?.label ?? id;
}

/**
 * The sections `hasPermission` allows, in the console's order: the one mapping from section to
 * permission (audit B-14). The shell shows these; the page opens the first and reads no other
 * (TASK-184). Display only — each section's route checks its own permission.
 */
export function permittedSections(
  hasPermission: (code: string) => boolean
): AdminSection[] {
  return NAV_ITEMS.filter((item) => hasPermission(item.permission)).map(
    (item) => item.section
  );
}

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
  const permitted = permittedSections(hasPermission);
  const visibleItems = NAV_ITEMS.filter((item) => permitted.includes(item.section));

  // The first permitted section, or none: never a section the admin may not open (TASK-184 — it
  // fell back to "users", whose data read is refused to anyone without admin_manage_users).
  const [activeSection, setActiveSection] = useState<AdminSection | null>(
    permitted[0] ?? null
  );

  // The section shown first is reported too (review 14 L-1): the page loads the data of the
  // section it is told is open, and before this it was never told of the first one — which was
  // then shown with no data read, as if empty.
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current || activeSection === null) return;
    reported.current = true;
    onSectionChange?.(activeSection);
  }, [activeSection, onSectionChange]);

  return (
    <div className="min-h-screen bg-[#0a0f1e] flex">
      {/* Sidebar */}
      <aside className="w-64 bg-[#111827] border-r border-gray-800 flex flex-col">
        <div className="p-6 border-b border-gray-800">
          <h1 className="text-lg font-bold text-white">Admin Panel</h1>
          <p className="text-xs text-gray-400 mt-1">{adminName}</p>
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
            className="w-full text-sm text-gray-400 hover:text-gray-200 transition"
          >
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 p-8">
        {activeSection !== null && children(activeSection)}
      </main>
    </div>
  );
}
