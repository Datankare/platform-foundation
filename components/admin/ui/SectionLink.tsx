"use client";

/**
 * components/admin/ui/SectionLink.tsx — a link from one console section to another (TASK-220,
 * SF-admin-082)
 *
 * A held change said "an independent approver must clear it in Approvals" with no way there. A
 * section is in the console's address (`?section=`, SF-admin-006), so this is a real link: it can
 * be opened in a new tab or copied, and a plain click switches the section in place — the shell
 * reads the address on popstate, as it does for Back — moving focus to the new heading.
 *
 * @module components/admin/ui
 */

import React from "react";
import { SECTION_PARAM, sectionTitle, type AdminSection } from "./sections";
import { BUTTON } from "./tokens";

export function SectionLink({
  section,
  children,
}: {
  readonly section: AdminSection;
  /** The link's words; the section's title when none. */
  readonly children?: React.ReactNode;
}) {
  const href = `?${SECTION_PARAM}=${encodeURIComponent(section)}`;
  return (
    <a
      href={href}
      data-section-link={section}
      className={BUTTON.link}
      onClick={(e) => {
        // A new tab, a new window or a download: the browser's own.
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        const url = new URL(window.location.href);
        url.searchParams.set(SECTION_PARAM, section);
        window.history.pushState(null, "", `${url.pathname}${url.search}`);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }}
    >
      {children ?? sectionTitle(section)}
    </a>
  );
}
