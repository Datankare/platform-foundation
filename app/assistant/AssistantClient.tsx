/**
 * app/assistant/AssistantClient.tsx — the assistant page (TASK-211, N-118), in the app's frame
 *
 * Where a signed-in user asks the assistant and reads its answer as it is written
 * (components/assistant/AssistantPanel.tsx over /api/stream). Reached from the app's header
 * ("Assistant", components/app/ui/AppShell.tsx — TASK-224: the page had its own "Back to home"
 * link and no header).
 *
 * Signed out: to sign-in and back here (the shell, E-113). A guest is told the assistant is for
 * accounts — the route serves signed-in users only (TASK-133) — and offered sign-in; no question
 * is sent.
 */

"use client";

import { useAuth } from "@/platform/auth/context";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { signInPath } from "@/platform/auth/return-path";
import AssistantPanel from "@/components/assistant/AssistantPanel";
import { AppShell } from "@/components/app/ui/AppShell";
import { BUTTON, SURFACE } from "@/components/admin/ui/tokens";

/** This screen's text, from the message catalog (ADR-051 D4). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.assistant.${key}`, values);

export default function AssistantClient() {
  const { isGuest } = useAuth();
  return (
    <AppShell>
      <h1 className="mb-2 text-2xl font-bold text-white">{t("title")}</h1>
      <p className="mb-6 text-sm text-gray-300">{t("intro")}</p>
      {isGuest ? (
        <section className={`${SURFACE.panel} p-6`}>
          <p className="text-sm text-gray-300">{t("guest")}</p>
          <a
            href={signInPath("/assistant")}
            className={`${BUTTON.link} mt-3 inline-block`}
          >
            {t("sign_in")}
          </a>
        </section>
      ) : (
        <AssistantPanel />
      )}
    </AppShell>
  );
}
