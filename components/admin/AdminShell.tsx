"use client";

import React, { useEffect, useRef, useState } from "react";
import { renderMessage } from "@/platform/errors/messages";
import {
  SECTIONS,
  SECTION_GROUPS,
  SECTION_PARAM,
  groupTitle,
  permittedSections,
  sectionFromSearch,
  sectionTitle,
  type AdminSection,
} from "@/components/admin/ui/sections";
import { Field, Select } from "@/components/admin/ui/Field";
import { BUTTON, FOCUS_RING, FOCUS_TARGET, TEXT } from "@/components/admin/ui/tokens";

// The registry is the one source (TASK-216); these names are where callers have always found them.
export { permittedSections, sectionTitle };
export type { AdminSection };

interface AdminShellProps {
  /** Who is signed in: their name, else their address. */
  adminName: string;
  /** Their role, readable ("Super admin"), shown after who they are. */
  adminRole?: string;
  /** Callback to verify admin has required permission */
  hasPermission: (code: string) => boolean;
  /** "Sign out": must end the session, not only leave the console (the page signs out first). */
  onSignOut: () => void;
  /** Render the active section's content */
  children: (activeSection: AdminSection) => React.ReactNode;
  onSectionChange?: (section: AdminSection) => void;
}

/** The id of the open section's heading: the shell moves focus to it when the section changes. */
export const SECTION_HEADING_ID = "admin-section-heading";

/**
 * The open section's heading (the registry's one title for it), with what belongs beside it.
 * It takes focus when the section changes, so the new section is announced and the keyboard
 * starts at its top (SF-admin-007).
 */
export function SectionHeading({
  section,
  children,
}: {
  readonly section: AdminSection;
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2
        id={SECTION_HEADING_ID}
        tabIndex={-1}
        className={`min-w-0 break-words text-xl font-bold ${TEXT.strong} ${FOCUS_TARGET}`}
      >
        {sectionTitle(section)}
      </h2>
      {children}
    </div>
  );
}

/** The section the address names, when the admin may open it. */
function sectionInAddress(permitted: readonly AdminSection[]): AdminSection | null {
  if (typeof window === "undefined") return null;
  const named = sectionFromSearch(window.location.search);
  return named && permitted.includes(named) ? named : null;
}

/**
 * Admin shell — the console's frame: who is signed in, the sections in their groups, and the
 * open section. Role-gated: only the sections the admin's permissions allow are offered. Every
 * section comes from the one registry (components/admin/ui/sections.ts).
 *
 * The open section is in the address (`?section=`): a reload stays on it, Back returns to the
 * section before, and a link can point to one (SF-admin-006).
 */
export default function AdminShell({
  adminName,
  adminRole,
  hasPermission,
  onSignOut,
  onSectionChange,
  children,
}: AdminShellProps) {
  const permitted = permittedSections(hasPermission);
  const visible = SECTIONS.filter((s) => permitted.includes(s.id));
  const groups = SECTION_GROUPS.map((group) => ({
    group,
    items: visible.filter((s) => s.group === group),
  })).filter((g) => g.items.length > 0);

  // The section the address names, else the first permitted one, or none: never a section the
  // admin may not open (TASK-184).
  const [activeSection, setActiveSection] = useState<AdminSection | null>(
    () => sectionInAddress(permitted) ?? permitted[0] ?? null
  );
  // Set when the admin changes section: the new heading then takes focus. Not on the first
  // render — opening the console does not move focus.
  const focusHeading = useRef(false);

  // The section shown first is reported too (review 14 L-1): the page reads the data of the
  // section it is told is open.
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current || activeSection === null) return;
    reported.current = true;
    onSectionChange?.(activeSection);
  }, [activeSection, onSectionChange]);

  useEffect(() => {
    if (!focusHeading.current) return;
    focusHeading.current = false;
    document.getElementById(SECTION_HEADING_ID)?.focus();
  }, [activeSection]);

  // Back and Forward: the address is the section.
  useEffect(() => {
    const onPop = () => {
      const allowed = permittedSections(hasPermission);
      const next = sectionInAddress(allowed) ?? allowed[0] ?? null;
      if (next === null) return;
      focusHeading.current = true;
      setActiveSection(next);
      onSectionChange?.(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [hasPermission, onSectionChange]);

  const choose = (next: AdminSection) => {
    if (next === activeSection) return;
    const url = new URL(window.location.href);
    url.searchParams.set(SECTION_PARAM, next);
    window.history.pushState(null, "", `${url.pathname}${url.search}`);
    focusHeading.current = true;
    setActiveSection(next);
    onSectionChange?.(next);
  };

  // One layout from a phone to a desktop (TASK-202, N-64): the sections in a sidebar from md up,
  // and in a picker above the content on a narrow screen; the content never widens the page —
  // a wide table scrolls inside its own panel.
  return (
    <div className="min-h-screen bg-[#0a0f1e] flex flex-col md:flex-row">
      <aside className="w-full md:w-64 md:shrink-0 bg-[#111827] border-b md:border-b-0 md:border-r border-gray-800 flex flex-col">
        <div className="p-4 md:p-6 border-b border-gray-800 flex items-center justify-between gap-3 md:block">
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-white">
              {renderMessage("screens.admin_console.panel_title")}
            </h1>
            <p
              className={`mt-1 break-words text-sm ${TEXT.body}`}
              data-signed-in-as="true"
            >
              {adminName}
            </p>
            {adminRole ? (
              <p className={`text-xs ${TEXT.faint}`} data-signed-in-role="true">
                {adminRole}
              </p>
            ) : null}
          </div>
          <button onClick={onSignOut} className={`shrink-0 md:mt-3 ${BUTTON.quiet}`}>
            {renderMessage("screens.admin_console.sign_out")}
          </button>
        </div>

        <div className="p-4 md:hidden">
          <Field label={renderMessage("screens.admin_console.nav_label")}>
            {(control) => (
              <Select
                {...control}
                value={activeSection ?? ""}
                onChange={(e) => choose(e.target.value as AdminSection)}
              >
                {groups.map(({ group, items }) => (
                  <optgroup key={group} label={groupTitle(group)}>
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {sectionTitle(item.id)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <nav
          aria-label={renderMessage("screens.admin_console.nav_label")}
          className="hidden md:block flex-1 p-4 space-y-4"
        >
          {groups.map(({ group, items }) => (
            <div key={group}>
              <p
                id={`admin-nav-${group}`}
                className={`px-3 pb-1 text-xs font-semibold uppercase tracking-wider ${TEXT.faint}`}
              >
                {groupTitle(group)}
              </p>
              <ul aria-labelledby={`admin-nav-${group}`} className="space-y-1">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      onClick={() => choose(item.id)}
                      aria-current={activeSection === item.id ? "page" : undefined}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-left transition ${FOCUS_RING} ${
                        activeSection === item.id
                          ? "bg-blue-600/20 text-blue-200"
                          : "text-gray-300 hover:text-white hover:bg-gray-800/50"
                      }`}
                    >
                      <span aria-hidden="true">{item.icon}</span>
                      <span>{sectionTitle(item.id)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <main className="flex-1 min-w-0 p-4 md:p-8">
        {activeSection !== null && children(activeSection)}
      </main>
    </div>
  );
}
