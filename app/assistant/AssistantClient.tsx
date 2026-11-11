/**
 * app/assistant/AssistantClient.tsx — the assistant page (TASK-211, N-118)
 *
 * Where a signed-in user asks the assistant and reads its answer as it is written
 * (components/assistant/AssistantPanel.tsx over /api/stream). Reached from the home page's bar
 * ("Assistant").
 *
 * Signed out: to sign-in (the proxy sends a request without a session there first; this is the
 * client's fallback, as the home page's). A guest is told the assistant is for accounts — the
 * route serves signed-in users only (TASK-133) — and offered sign-in; no question is sent.
 */

"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/platform/auth/context";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import AssistantPanel from "@/components/assistant/AssistantPanel";

/** This screen's text, from the message catalog (ADR-051 D4). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.assistant.${key}`, values);

const LINK = "text-sm text-blue-400 hover:text-blue-300 hover:underline";

export default function AssistantClient() {
  const router = useRouter();
  const { isLoading, isAuthenticated, isGuest } = useAuth();

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
        </nav>
        <h1 className="mb-2 text-2xl font-bold text-white">{t("title")}</h1>
        <p className="mb-6 text-sm text-gray-400">{t("intro")}</p>
        {isGuest ? (
          <section className="rounded-2xl border border-gray-800 bg-[#111827] p-6">
            <p className="text-sm text-gray-300">{t("guest")}</p>
            <Link href="/auth" className={`${LINK} mt-3 inline-block`}>
              {t("sign_in")}
            </Link>
          </section>
        ) : (
          <AssistantPanel />
        )}
      </div>
    </main>
  );
}
