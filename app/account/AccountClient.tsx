/**
 * app/account/AccountClient.tsx — the signed-in user's account page (TASK-210, N-117)
 *
 * Where a user sees the decisions made about their own content and appeals one
 * (components/account/ModerationDecisions.tsx), and signs out of every device at once
 * (components/account/SignOutEverywhere.tsx; ADR-057 D6). Reached from the home page's bar ("Your account"),
 * and from the refusal that tells a user their content was rejected or their account restricted
 * (components/refusal/RefusalNotice.tsx, the translate screen) — the places a decision is seen.
 *
 * Signed out: to sign-in (the proxy sends a request without a session there first; this is the
 * client's fallback, as the home page's). A guest has no account to appeal for: told so, with
 * sign-in.
 */

"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/platform/auth/context";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import ModerationDecisions from "@/components/account/ModerationDecisions";
import SignOutEverywhere from "@/components/account/SignOutEverywhere";

/** This screen's text, from the message catalog (ADR-051 D4). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.account.${key}`, values);

const LINK = "text-sm text-blue-400 hover:text-blue-300 hover:underline";

export default function AccountClient() {
  const router = useRouter();
  const { user, isLoading, isAuthenticated, isGuest } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/auth");
  }, [isAuthenticated, isLoading, router]);

  if (isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#0a0f1e]">
        <p role="status" className="text-gray-400">
          {t("loading")}
        </p>
      </main>
    );
  }
  if (!isAuthenticated) return null;

  return (
    <main className="min-h-screen bg-[#0a0f1e] px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-2xl">
        <nav className="mb-6 flex flex-wrap items-center justify-between gap-2">
          <Link href="/" className={LINK}>
            {t("back_home")}
          </Link>
          {!isGuest && user?.email && (
            <span className="break-all text-sm text-gray-400">{user.email}</span>
          )}
        </nav>
        <h1 className="mb-6 text-2xl font-bold text-white">{t("title")}</h1>
        {isGuest ? (
          <section className="rounded-2xl border border-gray-800 bg-[#111827] p-6">
            <p className="text-sm text-gray-300">{t("guest")}</p>
            <Link href="/auth" className={`${LINK} mt-3 inline-block`}>
              {t("sign_in")}
            </Link>
          </section>
        ) : (
          <section
            aria-labelledby="account-decisions"
            className="rounded-2xl border border-gray-800 bg-[#111827] p-4 sm:p-6"
          >
            <h2 id="account-decisions" className="mb-2 text-lg font-semibold text-white">
              {t("decisions.title")}
            </h2>
            <ModerationDecisions />
          </section>
        )}
        {!isGuest && (
          <section
            aria-labelledby="account-sessions"
            className="mt-6 rounded-2xl border border-gray-800 bg-[#111827] p-4 sm:p-6"
          >
            <h2 id="account-sessions" className="mb-2 text-lg font-semibold text-white">
              {t("sessions.title")}
            </h2>
            <SignOutEverywhere />
          </section>
        )}
      </div>
    </main>
  );
}
