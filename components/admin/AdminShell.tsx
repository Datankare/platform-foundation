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
  | "moderation"
  | "erasures"
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
    // The human review queue — escalations, ban reviews and appeals (TASK-210, N-117): the
    // permission every moderation route checks, which the moderator role holds (migration 018).
    section: "moderation",
    label: section("moderation"),
    icon: "⚖️",
    permission: "can_moderate",
  },
  {
    // The open erasures and their two-operator attestation (TASK-202, S3-E19): operators only, as
    // the read and the attestation route.
    section: "erasures",
    label: section("erasures"),
    icon: "🧹",
    permission: "platform_operate",
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

  const choose = (next: AdminSection) => {
    setActiveSection(next);
    onSectionChange?.(next);
  };

  // One layout from a phone to a desktop (TASK-202, N-64): the sections in a sidebar from md up,
  // and in a picker above the content on a narrow screen; the content never widens the page —
  // a wide table scrolls inside its own panel.
  return (
    <div className="min-h-screen bg-[#0a0f1e] flex flex-col md:flex-row">
      {/* Sidebar */}
      <aside className="w-full md:w-64 md:shrink-0 bg-[#111827] border-b md:border-b-0 md:border-r border-gray-800 flex flex-col">
        <div className="p-4 md:p-6 border-b border-gray-800 flex items-center justify-between gap-3 md:block">
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-white">
              {renderMessage("screens.admin_console.panel_title")}
            </h1>
            <p className="text-xs text-gray-400 mt-1 truncate">{adminName}</p>
          </div>
          <button
            onClick={onSignOut}
            className="shrink-0 text-sm text-gray-400 hover:text-gray-200 transition md:mt-3"
          >
            {renderMessage("screens.admin_console.sign_out")}
          </button>
        </div>

        <div className="p-4 md:hidden">
          <label htmlFor="admin-section-picker" className="sr-only">
            {renderMessage("screens.admin_console.nav_label")}
          </label>
          <select
            id="admin-section-picker"
            value={activeSection ?? ""}
            onChange={(e) => choose(e.target.value as AdminSection)}
            className="w-full rounded border border-gray-700 bg-[#0a0f1e] px-3 py-2 text-sm text-gray-100"
          >
            {visibleItems.map((item) => (
              <option key={item.section} value={item.section}>
                {item.label}
              </option>
            ))}
          </select>
        </div>

        <nav
          aria-label={renderMessage("screens.admin_console.nav_label")}
          className="hidden md:block flex-1 p-4 space-y-1"
        >
          {visibleItems.map((item) => (
            <button
              key={item.section}
              onClick={() => choose(item.section)}
              aria-current={activeSection === item.section ? "page" : undefined}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition ${
                activeSection === item.section
                  ? "bg-blue-600/20 text-blue-400"
                  : "text-gray-400 hover:text-gray-300 hover:bg-gray-800/50"
              }`}
            >
              <span aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0 p-4 md:p-8">
        {activeSection !== null && children(activeSection)}
      </main>
    </div>
  );
}
