/**
 * app/account/AccountClient.tsx — the signed-in person's one account page (TASK-210, TASK-225)
 *
 * Everything about the account, in sections, in the app's frame (components/app/ui/AppShell.tsx):
 *
 *   the app's own        a consumer's sections (platform/modules/app-account.tsx — Playform's
 *                        profile, SF-app-073: it had a page of its own, with its own header and
 *                        no way between the two)
 *   Sign-in and security change the password; two-step verification on or off (E-126)
 *   Your data            a copy of it; deleting the account (E-126)
 *   Decisions            the decisions about the person's content, and their appeals (TASK-210)
 *   Signed-in devices    sign out everywhere (ADR-057 D6)
 *
 * "On this page" links to each. A guest has no account: told so, with sign-in. Signed out: to
 * sign-in and back here (the shell, E-113). A deleted account: the page says what was done, and
 * nothing of the account is shown again.
 */

"use client";

import { useState } from "react";
import { useAuth } from "@/platform/auth/context";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { signInPath } from "@/platform/auth/return-path";
import { AppShell } from "@/components/app/ui/AppShell";
import { BUTTON, SURFACE, TEXT } from "@/components/admin/ui/tokens";
import AppAccountSections, { APP_ACCOUNT_SECTIONS } from "@/platform/modules/app-account";
import ModerationDecisions from "@/components/account/ModerationDecisions";
import SignOutEverywhere from "@/components/account/SignOutEverywhere";
import SignInSecurity from "@/components/account/SignInSecurity";
import YourData, { type Deleted } from "@/components/account/YourData";

/** This screen's text, from the message catalog (ADR-051 D4). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.account.${key}`, values);

/** The platform's sections, in order: their anchors and their catalogue titles. */
export const ACCOUNT_SECTIONS: readonly { readonly id: string; readonly key: string }[] =
  [
    { id: "security", key: "security.title" },
    { id: "data", key: "data.title" },
    { id: "decisions", key: "decisions.title" },
    { id: "sessions", key: "sessions.title" },
  ];

const SECTION = `${SURFACE.panel} scroll-mt-4 p-4 sm:p-6`;

function Section({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`account-${id}`} className={SECTION}>
      <h2 id={`account-${id}`} className="mb-3 text-lg font-semibold text-white">
        {title}
      </h2>
      {children}
    </section>
  );
}

function AccountDeleted({ deleted }: { readonly deleted: Deleted }) {
  return (
    <section aria-labelledby="account-deleted" className={`${SECTION} space-y-3`}>
      <h2 id="account-deleted" className="text-lg font-semibold text-white">
        {t("data.deleted_title")}
      </h2>
      <p role="status" className={`text-sm ${TEXT.quiet}`}>
        {t("data.deleted_body")}
      </p>
      {!deleted.identityDeleted && (
        <p className={`text-sm ${TEXT.quiet}`}>{t("data.deleted_identity_pending")}</p>
      )}
      {/* A full navigation: the session's cookies were cleared by the server. */}
      <a href="/auth" className={BUTTON.primary}>
        {t("data.deleted_leave")}
      </a>
    </section>
  );
}

export default function AccountClient() {
  const { user, isGuest } = useAuth();
  const [deleted, setDeleted] = useState<Deleted | null>(null);

  const links = [
    ...APP_ACCOUNT_SECTIONS.map((s) => ({ id: s.id, title: s.title })),
    ...ACCOUNT_SECTIONS.map((s) => ({ id: s.id, title: t(s.key) })),
  ];

  return (
    <AppShell>
      <h1 className="mb-6 text-2xl font-bold text-white">{t("title")}</h1>
      {deleted ? (
        <AccountDeleted deleted={deleted} />
      ) : isGuest ? (
        <section className={SECTION}>
          <p className="text-sm text-gray-300">{t("guest")}</p>
          <a href={signInPath("/account")} className={`${BUTTON.link} mt-3 inline-block`}>
            {t("sign_in")}
          </a>
        </section>
      ) : (
        <div className="space-y-6">
          <nav aria-label={t("on_this_page")}>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {links.map((l) => (
                <li key={l.id}>
                  <a href={`#${l.id}`} className={BUTTON.link}>
                    {l.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <AppAccountSections />
          <Section id="security" title={t("security.title")}>
            <SignInSecurity />
          </Section>
          <Section id="data" title={t("data.title")}>
            <YourData email={user?.email ?? ""} onDeleted={setDeleted} />
          </Section>
          <Section id="decisions" title={t("decisions.title")}>
            <ModerationDecisions />
          </Section>
          <Section id="sessions" title={t("sessions.title")}>
            <SignOutEverywhere />
          </Section>
        </div>
      )}
    </AppShell>
  );
}
