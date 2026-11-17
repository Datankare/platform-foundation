/**
 * platform/modules/app-account.tsx — the app's own sections of the account page (CONSUMER SEAM,
 * ADR-054; TASK-225, SF-app-073)
 *
 * The account page (app/account/AccountClient.tsx) is the person's one place for their account:
 * how they sign in, their data, the decisions about their content and their devices. An app adds
 * its own sections there — a profile, say — through this file, so the core page imports no
 * module's UI. A consumer owns this file (the sync excludes it). Platform Foundation adds none.
 *
 *   APP_ACCOUNT_SECTIONS   the sections' ids and titles, in order, for the page's "On this page"
 *                          links (each section's own heading has the same title);
 *   AppAccountSections     the sections themselves, each a `section` with that id.
 *
 * A composition root, with ./app-modules.ts and ./app-home.tsx: the only core files allowed to
 * import a module (eslint.config.mjs, import/no-restricted-paths).
 */

"use client";

/** An app section of the account page: its anchor and its title. */
export interface AccountSection {
  readonly id: string;
  readonly title: string;
}

export const APP_ACCOUNT_SECTIONS: readonly AccountSection[] = [];

export default function AppAccountSections() {
  return null;
}
